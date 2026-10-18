import { consultAdvisor } from "./advisor.js";
import { approximateInputTokens, buildAdvisorRequest } from "./advisor-request.js";
import { formatUsd, usageTokenTotal } from "./advisor-cost.js";
import { BUDGET_LIMIT_MODES, BUDGET_SCOPES, UNKNOWN_COST_MODES } from "./advisor-budget.js";
import { parseToolPolicies } from "./config.js";

export const ADVISOR_TEST_SYSTEM = [
  "You are the Advisor being connectivity-tested from the DeepSeek Harness Settings page.",
  "Answer with one short sentence that names yourself as the Advisor and confirms the route works.",
].join(" ");

const COMMAND_NAMES = [
  "advisor",
  "advisor-budget",
  "advisor-history",
  "advisor-log",
  "advisor-test",
];

function success(text) {
  return { kind: "success", text };
}

function failure(text) {
  return { kind: "error", text };
}

/** Machine-readable block the Advisor Settings page reads back out of a command result. */
export const PAYLOAD_OPEN = "```dsh-advisor-json";
export const PAYLOAD_CLOSE = "```";

export function withPayload(report, payload) {
  return `${report}\n\nAdvisor Settings payload (machine readable):\n${PAYLOAD_OPEN}\n${JSON.stringify(payload)}\n${PAYLOAD_CLOSE}`;
}

export function extractPayload(text) {
  const start = String(text ?? "").indexOf(PAYLOAD_OPEN);
  if (start === -1) return undefined;
  const body = String(text).slice(start + PAYLOAD_OPEN.length);
  const end = body.indexOf(PAYLOAD_CLOSE);
  const json = (end === -1 ? body : body.slice(0, end)).trim();
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function flag(args, ...names) {
  return names.some((name) => args.includes(name));
}

function positional(args) {
  return args.filter((value) => !value.startsWith("-"));
}

function yesNo(value) {
  return value ? "on" : "off";
}

export function formatStatusReport({ agent, config, identity: providedIdentity, reservation, store, summary, warnings = [] }) {
  const identity = providedIdentity ?? store.identity(agent, config);
  const plan = store.plan(config);
  const standing = summary?.standing ?? {};
  const lines = [
    `Advisor: ${config.advisorEnabled ? "on" : "off"}${config.advisor ? ` · ${config.advisor}` : " · no model configured"}`,
    `Consultation budget: ${plan.enabled ? "on" : "off"} · scope ${plan.scope === "project" ? `project (${identity.projectKey})` : `session (${identity.sessionId})`}`,
    `Calls: ${standing.settledCalls ?? 0} used${plan.maxCalls === undefined ? " · no call ceiling" : ` / ${plan.maxCalls}`}${
      standing.callsRemaining === undefined ? "" : ` · ${standing.callsRemaining} remaining`
    }`,
    `Spend: ${formatUsd(standing.settledMicro)}${plan.maxCallMicro === undefined ? " · no cash ceiling" : ` / ${formatUsd(plan.maxCallMicro)}`}${
      standing.costRemainingMicro === undefined ? "" : ` · ${formatUsd(standing.costRemainingMicro)} remaining`
    }`,
    `Price coverage: ${standing.unknownCostCalls ? `${standing.unknownCostCalls} call(s) with unknown price` : "every call priced"}${
      standing.costRemainingMicro !== undefined && !standing.exact ? " · the cash ceiling is an estimate, not an exact limit" : ""
    }`,
    `Over-limit behaviour: ${plan.limitMode === "confirm" ? "ask before an extra consultation" : "stop Advisor consultations only"}`,
    `Unknown-price behaviour: ${describeUnknownCost(plan.unknownCost)}`,
    `Last consultation: ${standing.lastAt ? `${new Date(standing.lastAt).toISOString()} · ${standing.lastModel || "unknown model"} · ${standing.lastOutcome || "unknown"}` : "none"}`,
  ];
  if (reservation) lines.push(`Reserved now: ${formatUsd(reservation.reservedMicro)} · 1 call`);
  for (const warning of warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

export function describeUnknownCost(mode) {
  if (mode === "stop-advisor") return "stop Advisor consultations";
  if (mode === "count-only") return "count the call but never treat the cash ceiling as exact";
  return "allow and mark the cash figure as estimated";
}

/** Settings values the page renders back; never includes credentials or secret paths. */
export function publicConfig(config) {
  return {
    advisor: config.advisor ?? "",
    advisorAutoLoopGate: config.advisorAutoLoopGate === true,
    advisorBlockOnBlocked: config.advisorBlockOnBlocked === true,
    advisorBudgetEnabled: config.advisorBudgetEnabled === true,
    advisorBudgetLimitMode: config.advisorBudgetLimitMode,
    advisorBudgetMaxCalls: config.advisorBudgetMaxCalls ?? -1,
    advisorBudgetMaxUsd: config.advisorBudgetMaxUsd ?? 0,
    advisorBudgetScope: config.advisorBudgetScope,
    advisorBudgetUnknownCost: config.advisorBudgetUnknownCost,
    advisorCompletionGate: config.advisorCompletionGate === true,
    advisorCustomInvocation: config.advisorCustomInvocation ?? "",
    advisorEffort: config.advisorEffort ?? "",
    advisorEnabled: config.advisorEnabled !== false,
    advisorFailureGate: config.advisorFailureGate === true,
    advisorGitContext: config.advisorGitContext,
    advisorGitContextMaxChars: config.advisorGitContextMaxChars,
    advisorLoopThreshold: config.advisorLoopThreshold,
    advisorMaxCallsPerSession: config.advisorMaxCallsPerSession ?? -1,
    advisorPlanGate: config.advisorPlanGate === true,
    advisorPricingJson: config.advisorPricingJson ?? "",
    advisorProjectKey: config.advisorProjectKey ?? "",
    advisorRedactSecrets: config.advisorRedactSecrets === true,
    advisorSessionSummary: config.advisorSessionSummary === true,
    advisorToolPoliciesJson: config.advisorToolPoliciesJson ?? "",
    advisorToolResultMaxBytes: config.advisorToolResultMaxBytes,
    advisorToolResultMaxLines: config.advisorToolResultMaxLines,
    contextMaxChars: config.contextMaxChars,
    executor: config.executor ?? "",
    executorEffort: config.executorEffort ?? "",
    gateFailureMode: config.gateFailureMode,
    simpleMode: config.simpleMode === true,
  };
}

export function statusPayload(config, runtime, agent, summary) {
  const identity = runtime.identityFor(agent, config);
  const plan = runtime.store.plan(config);
  const counter = summary?.counter ?? {};
  const standing = summary?.standing ?? {};
  const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    bucket: summary?.bucket ?? null,
    kind: "status",
    lastAt: number(counter.lastAt),
    lastModel: counter.lastModel || "",
    lastOutcome: counter.lastOutcome || "",
    limitMode: plan.limitMode,
    plan: {
      enabled: plan.enabled,
      maxCallMicro: plan.maxCallMicro ?? null,
      maxCalls: plan.maxCalls ?? null,
      scope: plan.scope,
      unknownCost: plan.unknownCost,
      useMicro: plan.maxCallMicro ?? null,
    },
    projectKey: identity.projectKey,
    sessionId: identity.sessionId,
    standing: {
      blocked: standing.blocked === true,
      blockedByCalls: standing.blockedByCalls === true,
      blockedByCost: standing.blockedByCost === true,
      blockedByUnknownCost: standing.blockedByUnknownCost === true,
      callRatio: number(standing.callRatio),
      callsRemaining: number(standing.callsRemaining),
      committedCalls: number(standing.committedCalls),
      committedMicro: number(standing.committedMicro),
      costRatio: number(standing.costRatio),
      costRemainingMicro: number(standing.costRemainingMicro),
      exact: standing.exact !== false,
      failedCalls: number(counter.failedCalls),
      lastAt: number(counter.lastAt),
      lastModel: counter.lastModel || "",
      lastOutcome: counter.lastOutcome || "",
      ratio: number(standing.ratio),
      reservedCalls: number(counter.reservedCalls),
      reservedMicro: number(counter.reservedMicro),
      settledCalls: number(standing.settledCalls),
      settledMicro: number(standing.settledMicro),
      unknownCostCalls: number(standing.unknownCostCalls),
      warn: standing.warn === true,
    },
    version: 1,
  };
}

export function formatHistoryReport(entries, { limit } = {}) {
  if (!entries.length) return "No Advisor consultations are recorded for this budget scope yet.";
  const ceiling = Number.isSafeInteger(limit) ? limit : 200;
  const lines = [`Last ${entries.length} of at most ${ceiling} recorded consultations (newest first):`];
  for (const entry of entries) {
    const when = entry.at ? new Date(entry.at).toISOString() : "unknown time";
    const cost = entry.costKnown ? formatUsd(entry.costMicro) : "unknown price";
    const tokens = usageTokenTotal(entry.usage);
    lines.push(
      `- ${when} · ${entry.trigger ?? "unknown"} · ${entry.model || "unknown model"} · ${cost} · ${tokens} tokens · ${entry.outcome ?? "unknown"}`,
    );
    if (entry.question) lines.push(`  ${entry.question}`);
  }
  return lines.join("\n");
}

export function formatSettingsReport(config) {
  const policies = Object.entries(config.advisorToolPolicies ?? {});
  return [
    "Advisor connection",
    `  Advisor model: ${config.advisor || "(unset)"} · effort ${config.advisorEffort || "model default"}`,
    `  Executor: ${config.executor || "(follows the DSH model picker)"}${config.executorEffort ? ` · effort ${config.executorEffort}` : ""}`,
    "Gates",
    `  Plan review: ${yesNo(config.advisorPlanGate)} · repeated failure: ${yesNo(config.advisorFailureGate)} · completion review: ${yesNo(config.advisorCompletionGate)}`,
    `  Repeated-tool loop gate: ${yesNo(config.advisorAutoLoopGate)} · threshold ${config.advisorLoopThreshold} · on block ${config.gateFailureMode}`,
    "Budget",
    `  Enabled: ${yesNo(config.advisorBudgetEnabled)} · scope ${config.advisorBudgetScope} · limit action ${config.advisorBudgetLimitMode}`,
    `  Cash ceiling: ${config.advisorBudgetMaxUsd > 0 ? `$${config.advisorBudgetMaxUsd.toFixed(4)}` : "none"} · call ceiling ${config.advisorBudgetMaxCalls ?? "none"}`,
    `  Unknown price: ${config.advisorBudgetUnknownCost}`,
    "Advanced",
    `  contextMaxChars ${config.contextMaxChars} · git context ${config.advisorGitContext} (${config.advisorGitContextMaxChars} chars)`,
    `  Tool result caps ${config.advisorToolResultMaxLines} lines / ${config.advisorToolResultMaxBytes} bytes · redact secrets ${yesNo(config.advisorRedactSecrets)}`,
    `  Tool policies: ${policies.length ? policies.map(([key, value]) => `${key}=${value}`).join(", ") : "all tools full"}`,
    `  simpleMode ${yesNo(config.simpleMode)} · session summary ${yesNo(config.advisorSessionSummary)} · block-on-blocked ${yesNo(config.advisorBlockOnBlocked)}`,
  ].join("\n");
}

/**
 * Register the `/advisor` command family.
 *
 * These commands are the UI's data path: the DSH Client can run a session
 * command through the standard commands Remote, so the Settings page reads the
 * budget ledger and triggers a connection test without a private web server.
 */
export function registerAdvisorCommands(ctx, runtime) {
  // `commands` is optional: a deployment without it keeps the tool and gates.
  const commands = ctx.get?.("commands");
  if (!commands?.register) return;

  const define = (spec) => {
    try {
      commands.register(spec);
    } catch (error) {
      runtime.logger()?.warn?.(`dsh-advisor: could not register /${spec.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runConsultation = async ({ agent, config, question, trigger }) => {
    const request = buildAdvisorRequest(agent, config, { question });
    const reservation = await runtime.reserve(config, agent, request);
    if (!reservation.ok) {
      return { ok: false, reason: reservation.reason, reservation };
    }
    try {
      const result = await consultAdvisor(
        ctx,
        agent,
        config,
        {
          decision: false,
          system: request.call.system,
          userText: request.call.userText,
        },
        undefined,
      );
      const settled = await runtime.settle(config, agent, reservation, {
        model: result.model,
        outcome: "success",
        question,
        trigger,
        usage: result.usage,
      });
      return { ok: true, reservation, result, settled };
    } catch (error) {
      await runtime.settle(config, agent, reservation, {
        model: config.advisor,
        outcome: "failed",
        question,
        trigger,
        usage: null,
      });
      return { ok: false, reason: error instanceof Error ? error.message : String(error), reservation };
    }
  };

  define({
    name: "advisor",
    description: "Show or change Advisor settings, budget, and connection state",
    input: { hint: "[status|settings|off|on|model <provider/model>|effort <name|default>|budget <on|off>|scope <session|project>|limit <stop-advisor|confirm>|unknown-cost <allow|count-only|stop-advisor>|reset-budget]" },
    async handler({ agent, rawInput }) {
      const config = runtime.config();
      const args = String(rawInput ?? "").trim().split(/\s+/u).filter(Boolean);
      const action = (args.shift() ?? "status").toLowerCase();
      if (action === "off" || action === "on") {
        const enabled = action === "on";
        const written = await runtime.writeSettings({ advisorEnabled: enabled });
        return written.ok
          ? success(`Advisor ${enabled ? "enabled" : "disabled"}.`)
          : failure(written.reason);
      }
      if (action === "model") {
        const value = args.join(" ").trim();
        if (!value) return failure("Usage: /advisor model <provider>/<model>");
        const written = await runtime.writeSettings({ advisor: value });
        return written.ok ? success(`Advisor model set to ${value}.`) : failure(written.reason);
      }
      if (action === "effort") {
        const value = args.join(" ").trim();
        const effort = !value || value === "default" ? "" : value;
        const written = await runtime.writeSettings({ advisorEffort: effort });
        return written.ok
          ? success(`Advisor reasoning effort ${effort || "reset to the model default"}.`)
          : failure(written.reason);
      }
      if (action === "budget") {
        const value = (args[0] ?? "on").toLowerCase();
        if (!["on", "off"].includes(value)) return failure("Usage: /advisor budget <on|off>");
        const written = await runtime.writeSettings({ advisorBudgetEnabled: value === "on" });
        return written.ok ? success(`Consultation budget ${value}.`) : failure(written.reason);
      }
      if (action === "scope") {
        const value = (args[0] ?? "").toLowerCase();
        if (!BUDGET_SCOPES.includes(value)) return failure(`Usage: /advisor scope <${BUDGET_SCOPES.join("|")}>`);
        const written = await runtime.writeSettings({ advisorBudgetScope: value });
        return written.ok ? success(`Budget scope set to ${value}.`) : failure(written.reason);
      }
      if (action === "limit") {
        const value = (args[0] ?? "").toLowerCase();
        if (!BUDGET_LIMIT_MODES.includes(value)) return failure(`Usage: /advisor limit <${BUDGET_LIMIT_MODES.join("|")}>`);
        const written = await runtime.writeSettings({ advisorBudgetLimitMode: value });
        return written.ok ? success(`Over-limit behaviour set to ${value}.`) : failure(written.reason);
      }
      if (action === "unknown-cost") {
        const value = (args[0] ?? "").toLowerCase();
        if (!UNKNOWN_COST_MODES.includes(value)) return failure(`Usage: /advisor unknown-cost <${UNKNOWN_COST_MODES.join("|")}>`);
        const written = await runtime.writeSettings({ advisorBudgetUnknownCost: value });
        return written.ok ? success(`Unknown-price behaviour set to ${value}.`) : failure(written.reason);
      }
      if (action === "reset-budget") {
        const reset = await runtime.resetBudget(agent);
        return success(withPayload(`Advisor budget reset for ${reset.scope} scope (${reset.bucket}).`, {
          bucket: reset.bucket,
          kind: "reset",
          scope: reset.scope,
          version: 1,
        }));
      }
      if (action === "settings") {
        return success(withPayload(formatSettingsReport(config), {
          config: publicConfig(config),
          kind: "settings",
        }));
      }
      const summary = await runtime.store.summary(config, runtime.identityFor(agent, config));
      const report = formatStatusReport({ agent, config, identity: runtime.identityFor(agent, config), store: runtime.store, summary });
      return success(withPayload(report, statusPayload(config, runtime, agent, summary)));
    },
  });

  define({
    name: "advisor-history",
    description: "Show recent Advisor consultations for the active budget scope",
    input: { hint: "[count]" },
    async handler({ agent, rawInput }) {
      const config = runtime.config();
      const identity = runtime.identityFor(agent, config);
      const requested = Number.parseInt(String(rawInput ?? "").trim(), 10);
      const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 50) : 10;
      const history = await runtime.store.history(config, identity, limit);
      const report = formatHistoryReport(history.entries, { limit: config.advisorHistoryLimit });
      return success(withPayload(report, {
        bucket: history.bucket,
        entries: history.entries,
        kind: "history",
        limit: config.advisorHistoryLimit,
        scope: runtime.store.plan(config).scope,
      }));
    },
  });

  define({
    name: "advisor-test",
    description: "Send one short test message to the configured Advisor and report the result",
    async handler({ agent }) {
      const config = runtime.config();
      if (!config.advisor) return failure("No Advisor model is configured. Set one on the Advisor Settings page first.");
      const outcome = await runtime.runConnectionTest({ agent, config });
      const report = formatTestReport(outcome);
      const payload = {
        costMicro: outcome.costMicro ?? null,
        elapsedMs: outcome.elapsedMs,
        hints: outcome.hints ?? [],
        kind: "test",
        markdown: outcome.markdown ?? "",
        model: outcome.model ?? "",
        ok: outcome.ok === true,
        reason: outcome.reason ?? null,
        usage: outcome.usage ?? null,
      };
      return outcome.ok ? success(withPayload(report, payload)) : failure(withPayload(report, payload));
    },
  });

  define({
    name: "advisor-budget",
    description: "Show the Advisor consultation budget for the active scope",
    async handler({ agent }) {
      const config = runtime.config();
      const summary = await runtime.store.summary(config, runtime.identityFor(agent, config));
      const report = formatStatusReport({ agent, config, identity: runtime.identityFor(agent, config), store: runtime.store, summary });
      return success(withPayload(report, statusPayload(config, runtime, agent, summary)));
    },
  });

  define({
    name: "advisor-log",
    description: "Show or change what the Advisor is allowed to disclose",
    input: { hint: "on|off | git <off|summary|full> | policy <tool> <full|summary|exclude> | policies" },
    async handler({ rawInput }) {
      const config = runtime.config();
      const args = String(rawInput ?? "").trim().split(/\s+/u).filter(Boolean);
      const action = (args.shift() ?? "").toLowerCase();
      if (!action || action === "status") return success(formatSettingsReport(config));
      if (action === "on" || action === "off") {
        const written = await runtime.writeSettings({ advisorRedactSecrets: action === "on" });
        return written.ok ? success(`Secret redaction ${action}.`) : failure(written.reason);
      }
      if (action === "git") {
        const value = (args[0] ?? "").toLowerCase();
        if (!["off", "summary", "full"].includes(value)) return failure("Usage: /advisor-log git <off|summary|full>");
        const written = await runtime.writeSettings({ advisorGitContext: value });
        return written.ok ? success(`Advisor git context set to ${value}.`) : failure(written.reason);
      }
      if (action === "policies") {
        const table = Object.entries(config.advisorToolPolicies ?? {});
        return success(table.length
          ? table.map(([key, value]) => `${key}: ${value}`).join("\n")
          : "No per-tool Advisor policies are configured; every tool result is disclosed in full.");
      }
      if (action === "policy") {
        const [tool, policy] = args;
        if (!tool || !["full", "summary", "exclude"].includes((policy ?? "").toLowerCase())) {
          return failure("Usage: /advisor-log policy <tool> <full|summary|exclude>");
        }
        const current = Object.entries(config.advisorToolPolicies ?? {})
          .filter(([key]) => key !== tool)
          .map(([key, value]) => `${key}: ${value}`);
        current.push(`${tool}: ${policy.toLowerCase()}`);
        const written = await runtime.writeSettings({ advisorToolPoliciesJson: current.join("\n") });
        return written.ok ? success(`Advisor tool policy for ${tool} set to ${policy.toLowerCase()}.`) : failure(written.reason);
      }
      return failure("Usage: /advisor-log [on|off|git <level>|policy <tool> <policy>|policies]");
    },
  });

  runtime.logger()?.debug?.(`dsh-advisor registered ${COMMAND_NAMES.length} commands.`);
}

export function formatTestReport(outcome) {
  const lines = [
    outcome.ok ? "Advisor connection: OK" : "Advisor connection: FAILED",
    `Model: ${outcome.model || "(unset)"}`,
    `Elapsed: ${outcome.elapsedMs} ms`,
  ];
  if (outcome.usage) {
    lines.push(`Tokens: ${usageTokenTotal(outcome.usage)} (in ${outcome.usage.inputTokens ?? 0} / out ${outcome.usage.outputTokens ?? 0})`);
  } else {
    lines.push("Tokens: unavailable");
  }
  lines.push(`Estimated cost: ${outcome.costMicro === undefined ? "unknown price (no rate configured for this model)" : formatUsd(outcome.costMicro)}`);
  if (outcome.ok) lines.push("", outcome.markdown);
  else lines.push("", `Reason: ${outcome.reason}`, ...outcome.hints.map((hint) => `- ${hint}`));
  return lines.join("\n");
}

export function connectionTestHints({ config, reason }) {
  const hints = [];
  if (!/\/.+/u.test(config.advisor ?? "")) hints.push('Set the Advisor model as "provider/model" on the Advisor Settings page.');
  if (/NO_ADAPTER|not registered|no adapter/iu.test(reason)) {
    hints.push("The provider route is not registered. Check the provider entry in the DSH Models page.");
  }
  if (/MISSING_CREDENTIAL|INVALID_CREDENTIAL|AUTH/iu.test(reason)) {
    hints.push("The provider credential is missing or rejected. Check Messages/Models credentials for this provider.");
  }
  if (/UNSUPPORTED_REASONING_EFFORT/iu.test(reason)) {
    hints.push("The configured reasoning effort is not supported by this model. Pick an effort the model lists.");
  }
  if (/RATE_LIMIT|QUOTA/iu.test(reason)) hints.push("The provider reports quota or rate limiting. Retry later or use another model.");
  if (/CONTEXT_WINDOW_EXCEEDED/iu.test(reason)) hints.push("The test request exceeded the model context window.");
  if (!hints.length) hints.push("Check the model id, the provider, and the network path to the provider.");
  return hints;
}
