import { defineTool } from "@deepseek-ai/dsh-tools";
import { Config as ConfigSchema, name, normalizeConfig } from "./config.js";
import { AdvisorSessionState, parseAutomaticDecision, parseModelRef } from "./core.js";
import { consultAdvisor } from "./advisor.js";
import { advisorInvocationGuidelines } from "./prompts.js";

export { name };
export const Config = ConfigSchema;
export const inject = ["tools", "llm", "systemPrompt"];

const states = new WeakMap();

function stateFor(agent) {
  let state = states.get(agent);
  if (!state) {
    state = new AdvisorSessionState();
    states.set(agent, state);
  }
  return state;
}

function logger(ctx) {
  return ctx.logger?.child ? ctx.logger.child("dsh-advisor") : ctx.logger;
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
    logger(ctx)?.warn?.(message);
    state.resetRepetition();
    return { kind: "allow" };
  }
  if (config.gateFailureMode === "block-session") blockSession(agent, state, config, message);
  return { kind: "deny", reason: message };
}

function recordAdvisorInvocation(state, result, trigger, effect = "continued") {
  state.recordInvocation({
    trigger,
    model: result.model,
    usage: result.usage,
    executionEffect: effect,
  });
}

async function runLoopGate(ctx, exec, state, config) {
  if (!state.canConsult(config.advisorMaxCallsPerSession)) {
    return gateFailure(ctx, exec.agent, state, config, "Advisor call budget exhausted.");
  }
  state.consumeCall();
  try {
    const result = await consultAdvisor(
      ctx,
      exec.agent,
      config,
      {
        decision: true,
        question: `The Executor is about to repeat the same normalized ${exec.name} tool call for the ${state.repetition.count}th consecutive time. Decide whether it should proceed, revise its approach, or stop for the user.`,
        gitContext: "summary",
      },
      exec.signal,
    );
    const parsed = parseAutomaticDecision(result.markdown);
    recordAdvisorInvocation(state, result, "repeated-tool-call", parsed.ok ? parsed.decision : "invalid-decision");
    if (!parsed.ok) return gateFailure(ctx, exec.agent, state, config, parsed.message);
    if (parsed.decision === "proceed") {
      state.resetRepetition();
      return { kind: "allow" };
    }
    if (parsed.decision === "revise") {
      return { kind: "deny", reason: `Advisor requested a revised approach before repeating this tool call.\n\n${result.markdown}` };
    }
    if (config.gateFailureMode === "warn-and-continue") {
      logger(ctx)?.warn?.(`Advisor blocked repeated tool call but gateFailureMode=warn-and-continue.\n${result.markdown}`);
      state.resetRepetition();
      return { kind: "allow" };
    }
    if (config.gateFailureMode === "block-session") blockSession(exec.agent, state, config, result.markdown);
    return { kind: "deny", reason: `Advisor blocked this repeated tool call.\n\n${result.markdown}` };
  } catch (error) {
    return gateFailure(ctx, exec.agent, state, config, error instanceof Error ? error.message : String(error));
  }
}

function registerAskAdvisor(ctx, config) {
  ctx.tools.register(defineTool({
    name: "ask_advisor",
    description: "Consult the configured Advisor model for a strategic second opinion. Call with an empty object for contextual review; attach an optional draft for concrete plan or completion review. The Advisor advises only and never takes over execution.",
    parameters: {
      question: { type: "string", description: "Specific decision or assumption to review. Omit for a normal contextual review." },
      draft: { type: "string", description: "Concise untrusted draft of a plan or completion claim for critique." },
      gitContext: { type: "string", description: "Repository disclosure for this call: none, summary, or full. The configured allowance remains the ceiling." },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error("ask_advisor requires an active DSH agent session.");
      const state = stateFor(exec.agent);
      if (state.blocked) throw new Error(state.blockedReason ?? "Advisor session is blocked.");
      if (!(config.simpleMode || state.canConsult(config.advisorMaxCallsPerSession))) {
        throw new Error("Advisor call budget exhausted for this session.");
      }
      const gitContext = args.gitContext?.trim();
      if (gitContext && !["none", "summary", "full"].includes(gitContext)) {
        throw new Error("gitContext must be one of: none, summary, full.");
      }
      if (!config.simpleMode) state.consumeCall();
      const result = await consultAdvisor(
        ctx,
        exec.agent,
        config,
        {
          question: args.question?.trim() || undefined,
          draft: args.draft?.trim() || undefined,
          gitContext: gitContext || undefined,
        },
        exec.signal,
      );
      recordAdvisorInvocation(state, result, "executor-requested");
      logger(ctx)?.info?.(`Advisor call completed via ${result.model}.`);
      return `Advisor (${result.model})\n\n${result.markdown}`;
    },
  }));
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const log = logger(ctx);

  registerAskAdvisor(ctx, config);

  ctx.systemPrompt.section({
    name: "dsh-advisor:guidance",
    order: 9300,
    text: ({ agent }) => {
      if (!config.advisor) return "";
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
    if (config.simpleMode || !config.advisorAutoLoopGate || !config.advisor) return next();
    const repeated = state.recordToolCall(exec.name, exec.arguments, config.advisorLoopThreshold);
    if (!repeated) return next();
    const decision = await runLoopGate(ctx, exec, state, config);
    return decision.kind === "allow" ? next() : decision;
  });

  ctx.on("agent/status", ({ agent, status }) => {
    if (status !== "idle" || !config.advisorSessionSummary) return;
    const summary = stateFor(agent).summary(config.advisorMaxCallsPerSession);
    if (summary) log?.info?.(summary);
  });

  if (!config.advisor) {
    log?.warn?.("dsh-advisor loaded without an Advisor model. Configure advisor: provider/model before using ask_advisor.");
  } else {
    log?.info?.(`dsh-advisor active. Advisor=${config.advisor}${config.executor ? ` Executor pinned=${config.executor}` : " Executor follows DSH model selection"}.`);
  }
}
