import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  ADVISOR_TEST_SYSTEM,
  connectionTestHints,
  formatStatusReport,
  registerAdvisorCommands,
} from "./advisor-commands.js";
import { ADVISOR_DECISION_SYSTEM, ADVISOR_SYSTEM, advisorInvocationGuidelines, advisorMessageText } from "./prompts.js";
import { consultAdvisor } from "./advisor.js";
import { AdvisorStore, projectKeyFor } from "./advisor-store.js";
import { approximateInputTokens, buildAdvisorRequest } from "./advisor-request.js";
import { Config, name, normalizeConfig } from "./config.js";
import { AdvisorSessionState, parseAutomaticDecision, parseModelRef } from "./core.js";
import { evaluateBudget } from "./advisor-budget.js";
import { formatUsd } from "./advisor-cost.js";

export { name };
export { Config };
export const inject = ["tools", "llm", "systemPrompt"];

const states = new WeakMap();
const warnedScopes = new Set();

function stateFor(agent) {
  let state = states.get(agent);
  if (!state) {
    state = new AdvisorSessionState();
    states.set(agent, state);
  }
  return state;
}

export function apply(ctx, rawConfig) {
  // The Config root is volatile so DSH's settings service can expose it.
  const source = typeof rawConfig?.get === "function" ? rawConfig.get() : rawConfig;
  const config = normalizeConfig(source ?? {});
  const log = ctx.logger?.child ? ctx.logger.child("dsh-advisor") : ctx.logger;

  // This plugin ships its own page, so do not auto-generate a second form for it.
  ctx.inject(["settings"], (scope) => {
    scope.effect(() => {
      if (typeof scope.settings?.configure !== "function") return () => {};
      return scope.settings.configure({ auto: false }, ctx.fiber);
    });
  });

  const store = new AdvisorStore({
    home: ctx.root?.profileContext?.home ?? ctx.root?.configEditor?.home ?? "",
    ledgerPath: config.advisorLedgerPath,
    historyLimit: config.advisorHistoryLimit,
    modelInfoResolver: async (provider, model) => ctx.llm.resolveModelInfo(provider, model),
  });

  const runtime = {
    config: () => config,
    identityFor: (agent) => AdvisorStore.identity(agent, config),
    logger: () => log,
    resetBudget: async (agent) => {
      const identity = AdvisorStore.identity(agent, config);
      const scope = store.plan(config).scope;
      const result = await store.reset(scope, identity);
      warnedScopes.delete(`${scope}:${result.bucket}`);
      return { ...result, scope };
    },
    runConnectionTest: (options) => runConnectionTest(ctx, runtime, store, options),
    settle: (activeConfig, agent, reservation, options) =>
      store.settle(activeConfig, AdvisorStore.identity(agent, activeConfig), reservation, options),
    reserve: async (activeConfig, agent, request, overrides = {}) => {
      const identity = AdvisorStore.identity(agent, activeConfig);
      const modelRef = overrides.modelRef ?? activeConfig.advisor;
      const modelBudget = await store.modelBudget(...splitModelRef(modelRef));
      return store.reserve(activeConfig, identity, {
        estimatedInputTokens: approximateInputTokens(request?.call?.userText ?? request?.userText),
        modelBudget,
        modelRef,
      });
    },
    store,
    writeSettings,
  };

  async function writeSettings(patch) {
    const settings = ctx.get?.("settings");
    if (!settings?.update) {
      return {
        ok: false,
        reason: "This deployment does not mount the DSH settings service, so the plugin config cannot be changed from here. Edit the profile's cordis.patch.yml instead.",
      };
    }
    try {
      await settings.update(name, patch);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  registerAskAdvisor(ctx, config, runtime);
  registerAdvisorCommands(ctx, runtime);

  ctx.systemPrompt.section({
    name: "dsh-advisor:guidance",
    order: 9300,
    text: ({ agent }) => {
      if (!config.advisor || !config.advisorEnabled) return "";
      const remaining = !config.simpleMode && agent
        ? stateFor(agent).remainingCalls(config.advisorMaxCallsPerSession)
        : undefined;
      const rules = advisorInvocationGuidelines(config, remaining);
      return rules.length ? `## Advisor workflow\n\n${rules.map((rule) => `- ${rule}`).join("\n")}` : "";
    },
  });

  ctx.on("agent/session-start", ({ agent, source }) => {
    if (source !== "compact") stateFor(agent).reset();
  });

  ctx.on("agent/request", async ({ agent }, next) => {
    const resolved = await next();
    if (!config.executor) return resolved;
    const selected = parseModelRef(config.executor, "executor");
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(config.executorEffort ? { reasoningEffort: config.executorEffort } : {}),
    };
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    if (!exec.agent) return next();
    const state = stateFor(exec.agent);
    if (state.blocked) return { kind: "deny", reason: state.blockedReason ?? "Advisor session is blocked." };
    if (exec.name === "ask_advisor") return next();
    if (config.simpleMode || !config.advisorAutoLoopGate || !config.advisor || !config.advisorEnabled) return next();
    const repeated = state.recordToolCall(exec.name, exec.arguments, config.advisorLoopThreshold);
    if (!repeated) return next();
    const decision = await runLoopGate(ctx, exec, state, config, runtime);
    return decision.kind === "allow" ? next() : decision;
  });

  ctx.on("agent/status", ({ agent, status }) => {
    if (status !== "idle" || !config.advisorSessionSummary) return;
    const summary = stateFor(agent).summary(config.advisorMaxCallsPerSession);
    if (summary) log?.info?.(summary);
  });

  if (!config.advisor) {
    log?.warn?.("dsh-advisor loaded without an Advisor model. Configure advisor: provider/model before using ask_advisor.");
  } else if (!config.advisorEnabled) {
    log?.info?.("dsh-advisor is installed but disabled by advisorEnabled.");
  } else {
    log?.info?.(`dsh-advisor active. Advisor=${config.advisor}${config.executor ? ` Executor pinned=${config.executor}` : " Executor follows DSH model selection"}.`);
  }
}

function splitModelRef(modelRef) {
  try {
    const route = parseModelRef(modelRef, "advisor");
    return [route.provider, route.model];
  } catch {
    return [undefined, undefined];
  }
}

function gateEffectForMode(mode) {
  if (mode === "warn-and-continue") return "continued";
  return mode === "block-tool" ? "tool-blocked" : "session-blocked";
}

function blockSession(agent, state, config, reason) {
  state.block(reason);
  if (config.advisorBlockOnBlocked && agent?.status === "running") {
    agent.cancel({ kind: "hook", reason }, { keepInbox: true });
  }
}

function gateFailure(ctx, agent, state, config, reason) {
  const message = `Advisor loop gate failed: ${reason}`;
  if (config.gateFailureMode === "warn-and-continue") {
    ctx.logger?.warn?.(message);
    state.resetRepetition();
    return { kind: "allow" };
  }
  if (config.gateFailureMode === "block-session") blockSession(agent, state, config, message);
  return { kind: "deny", reason: message };
}

function recordAdvisorInvocation(state, result, trigger, extra = {}) {
  state.recordInvocation({
    trigger,
    model: result.model,
    usage: result.usage,
    executionEffect: "continued",
    ...extra,
  });
}

function warnOnce(ctx, scopeKey, message) {
  if (warnedScopes.has(scopeKey)) return;
  warnedScopes.add(scopeKey);
  ctx.logger?.warn?.(message);
}

/**
 * Ask the user whether to spend beyond the consultation budget. Returns true
 * only for the affirmative option; an unavailable answerer or any error keeps
 * the conservative default of not spending.
 */
async function confirmExtraConsultation(ctx, agent, config, reason) {
  const questions = ctx.get?.("userQuestions");
  if (!questions?.ask || !agent) return { approved: false, reason: `${reason} Confirm before continuing is configured, but no answer path is available.` };
  try {
    const answer = await questions.ask({
      agent,
      questions: [{
        id: "advisor-budget-overrun",
        header: "Advisor budget",
        options: [
          { label: "Continue consultation", description: "Spend past the configured Advisor budget for this consultation only." },
          { label: "Stop Advisor", description: "Keep working without Advisor input; the Executor continues normally." },
        ],
        question: `${reason}\n\nContinue with one more Advisor consultation? The Executor's own work is unaffected either way.`,
      }],
    });
    const selected = answer?.answers?.[0]?.selected ?? [];
    return { approved: selected.includes("Continue consultation") };
  } catch (error) {
    return { approved: false, reason: `${reason} Confirmation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Reserve budget, run one Advisor call, and settle the ledger.
 *
 * When configured to confirm, an exhausted budget asks the user instead of
 * silently stopping; the Advisor is the only thing that stops, never the
 * Executor's own work.
 */
async function consultWithBudget(ctx, agent, config, runtime, request, options = {}) {
  const identity = runtime.identityFor(agent);
  let reservation = await runtime.reserve(config, agent, request, options.overrides);
  let warning;
  if (reservation.standing?.warn) {
    warning = `Advisor consultation budget is at ${Math.round((reservation.standing.ratio ?? 0) * 100)}% for the ${reservation.plan.scope} scope.`;
    warnOnce(ctx, `warn:${reservation.plan.scope}:${identity.sessionId}:${identity.projectKey}`, warning);
  }
  if (!reservation.ok && reservation.plan.enabled && reservation.plan.limitMode === "confirm") {
    const confirmation = await confirmExtraConsultation(ctx, agent, config, reservation.reason);
    if (!confirmation.approved) {
      return { ok: false, reason: confirmation.reason ?? reservation.reason, reservation, denied: true };
    }
    reservation = { ...reservation, ok: true, reservation: { callReserved: false, costMicro: 0, scope: reservation.plan.scope, standalone: true } };
  }
  if (!reservation.ok) {
    return { blockedByBudget: true, ok: false, reason: reservation.reason, reservation };
  }

  const startedAt = Date.now();
  try {
    const result = await consultAdvisor(
      ctx,
      agent,
      config,
      {
        decision: options.decision === true,
        system: request.call.system,
        userText: request.call.userText,
      },
      options.signal,
      options.overrides,
    );
    const settled = await runtime.settle(config, agent, reservation, {
      model: result.model,
      outcome: "success",
      question: options.question,
      trigger: options.trigger,
      usage: result.usage,
    });
    return { ok: true, result, settled, warning };
  } catch (error) {
    const usage = error?.usage ?? null;
    const settled = await runtime.settle(config, agent, reservation, {
      model: error?.model ?? config.advisor,
      outcome: "failed",
      question: options.question,
      trigger: options.trigger,
      usage,
    });
    return {
      error,
      elapsedMs: error?.elapsedMs ?? Date.now() - startedAt,
      failedUsage: usage,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      reservation,
      settled,
      warning,
    };
  }
}

async function runConnectionTest(ctx, runtime, store, { agent, config }) {
  const request = {
    call: {
      decision: false,
      system: ADVISOR_TEST_SYSTEM,
      userText: "Connectivity test from the DeepSeek Harness Advisor Settings page. Reply in one short sentence.",
    },
  };
  const outcome = await consultWithBudget(ctx, agent, config, runtime, request, {
    question: "Connection test",
    trigger: "settings-test",
  });
  if (outcome.ok) {
    const { result } = outcome;
    return {
      costMicro: outcome.settled?.costMicro,
      elapsedMs: result.elapsedMs,
      markdown: result.markdown,
      model: result.model,
      ok: true,
      usage: result.usage,
    };
  }
  return {
    costMicro: outcome.settled?.costMicro,
    elapsedMs: outcome.elapsedMs ?? 0,
    hints: connectionTestHints({ config, reason: outcome.reason }),
    markdown: "",
    model: config.advisor,
    ok: false,
    reason: outcome.reason,
    usage: outcome.failedUsage ?? null,
  };
}

function registerAskAdvisor(ctx, config, runtime) {
  ctx.tools.register(defineTool({
    name: "ask_advisor",
    description: "Consult the configured Advisor model for a strategic second opinion. Call with an empty object for contextual review; attach an optional draft for concrete plan or completion review. The Advisor advises only and never takes over execution.",
    parameters: {
      question: { type: "string", description: "Specific decision or assumption to review. Omit for a normal contextual review." },
      draft: { type: "string", description: "Concise untrusted draft of a plan or completion claim for critique." },
      gitContext: {
        type: "string",
        enum: ["none", "summary", "full"],
        description: "How much of the working tree to include. Use full when the review depends on exact code changes, such as a completion review; summary for changed file names only; none when the question is unrelated to current changes. The configured allowance remains the ceiling.",
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error("ask_advisor requires an active DSH agent session.");
      const state = stateFor(exec.agent);
      if (state.blocked) throw new Error(state.blockedReason ?? "Advisor session is blocked.");
      if (!config.advisorEnabled) throw new Error("The Advisor is disabled in the Advisor Settings page.");
      const gitContext = args.gitContext?.trim();
      if (gitContext && !["none", "summary", "full"].includes(gitContext)) {
        throw new Error("gitContext must be one of: none, summary, full.");
      }
      // simpleMode keeps the legacy deterministic call counting only; the
      // consultation budget replaces it entirely when it is enabled.
      if (!config.simpleMode && !config.advisorBudgetEnabled && !(state.canConsult(config.advisorMaxCallsPerSession))) {
        throw new Error("Advisor call budget exhausted for this session.");
      }
      const request = buildAdvisorRequest(exec.agent, config, {
        draft: args.draft?.trim() || undefined,
        gitContext: gitContext || undefined,
        question: args.question?.trim() || undefined,
      });
      const outcome = await consultWithBudget(ctx, exec.agent, config, runtime, request, {
        question: args.question?.trim() || undefined,
        signal: exec.signal,
        trigger: "executor-requested",
      });
      if (!config.simpleMode && !config.advisorBudgetEnabled) state.consumeCall();
      if (!outcome.ok) {
        // A refused consultation is a normal tool outcome: the Executor keeps working.
        ctx.logger?.warn?.(`Advisor consultation was not performed: ${outcome.reason}`);
        const reason = outcome.denied
          ? "Advisor consultation budget is exhausted for this scope and the user declined another consultation."
          : `Advisor consultation failed: ${outcome.reason}`;
        return `${reason}\n\nContinue with your own judgement; the Advisor is unavailable for this call.`;
      }
      recordAdvisorInvocation(state, outcome.result, "executor-requested");
      if (outcome.warning) ctx.logger?.warn?.(outcome.warning);
      ctx.logger?.info?.(`Advisor call completed via ${outcome.result.model}.`);
      return `Advisor (${outcome.result.model})\n\n${outcome.result.markdown}`;
    },
  }));
}

async function runLoopGate(ctx, exec, state, config, runtime) {
  // With the budget enabled the ledger owns every ceiling; the legacy counter
  // stays untouched so the two can never disagree.
  if (!config.simpleMode && !config.advisorBudgetEnabled && !state.canConsult(config.advisorMaxCallsPerSession)) {
    return gateFailure(ctx, exec.agent, state, config, "Advisor call budget exhausted.");
  }
  const request = buildAdvisorRequest(exec.agent, config, {
    decision: true,
    gitContext: "summary",
    question: `The Executor is about to repeat the same normalized ${exec.name} tool call for the ${state.repetition.count}th consecutive time. Decide whether it should proceed, revise its approach, or stop for the user.`,
  });
  const outcome = await consultWithBudget(ctx, exec.agent, config, runtime, request, {
    decision: true,
    signal: exec.signal,
    trigger: "repeated-tool-call",
  });
  if (outcome.denied || outcome.blockedByBudget || !outcome.ok) {
    // A budget stop must never end the session; it only withdraws the Advisor.
    if (outcome.denied || outcome.blockedByBudget) {
      ctx.logger?.warn?.(`Advisor loop gate skipped: ${outcome.reason}`);
      state.resetRepetition();
      return { kind: "allow" };
    }
    state.recordInvocation({
      trigger: "repeated-tool-call",
      model: config.advisor,
      failure: "provider-error",
      executionEffect: gateEffectForMode(config.gateFailureMode),
    });
    if (!config.simpleMode && !config.advisorBudgetEnabled) state.consumeCall();
    return gateFailure(ctx, exec.agent, state, config, outcome.reason);
  }
  if (!config.simpleMode && !config.advisorBudgetEnabled) state.consumeCall();
  const result = outcome.result;
  const parsed = parseAutomaticDecision(result.markdown);
  if (!parsed.ok) {
    recordAdvisorInvocation(state, result, "repeated-tool-call", {
      executionEffect: gateEffectForMode(config.gateFailureMode),
      failure: parsed.category ?? "invalid-decision",
    });
    return gateFailure(ctx, exec.agent, state, config, parsed.message);
  }
  const executionEffect = parsed.decision === "proceed"
    ? "continued"
    : parsed.decision === "revise"
      ? "tool-blocked"
      : gateEffectForMode(config.gateFailureMode);
  recordAdvisorInvocation(state, result, "repeated-tool-call", {
    decision: parsed.decision,
    executionEffect,
  });
  if (parsed.decision === "proceed") {
    state.resetRepetition();
    return { kind: "allow" };
  }
  if (parsed.decision === "revise") {
    return { kind: "deny", reason: `Advisor requested a revised approach before repeating this tool call.\n\n${result.markdown}` };
  }
  if (config.gateFailureMode === "warn-and-continue") {
    ctx.logger?.warn?.(`Advisor blocked repeated tool call but gateFailureMode=warn-and-continue.\n${result.markdown}`);
    state.resetRepetition();
    return { kind: "allow" };
  }
  if (config.gateFailureMode === "block-session") blockSession(exec.agent, state, config, result.markdown);
  return { kind: "deny", reason: `Advisor blocked this repeated tool call.\n\n${result.markdown}` };
}

export {
  ADVISOR_DECISION_SYSTEM,
  ADVISOR_SYSTEM,
  advisorMessageText,
  buildAdvisorRequest,
  evaluateBudget,
  formatStatusReport,
  formatUsd,
  projectKeyFor,
};
