import Schema from "@deepseek-ai/schemastery";

export const name = "dsh-advisor";

export const Config = Schema.object({
  executor: Schema.string().default(""),
  executorEffort: Schema.string().default(""),
  advisor: Schema.string().default(""),
  advisorEffort: Schema.string().default(""),
  contextMaxChars: Schema.number().default(15000),
  advisorPlanGate: Schema.boolean().default(true),
  advisorFailureGate: Schema.boolean().default(true),
  advisorCompletionGate: Schema.boolean().default(true),
  advisorCustomInvocation: Schema.string().default(""),
  advisorAutoLoopGate: Schema.boolean().default(true),
  advisorLoopThreshold: Schema.number().default(3),
  advisorMaxCallsPerSession: Schema.number().default(-1),
  advisorBlockOnBlocked: Schema.boolean().default(true),
  gateFailureMode: Schema.union(["block-session", "block-tool", "warn-and-continue"]).default("block-session"),
  advisorSessionSummary: Schema.boolean().default(false),
  advisorGitContext: Schema.union(["off", "summary", "full"]).default("summary"),
  advisorGitContextMaxChars: Schema.number().default(20000),
  advisorToolResultMaxLines: Schema.number().default(2000),
  advisorToolResultMaxBytes: Schema.number().default(51200),
  advisorToolPolicies: Schema.dict(Schema.union(["full", "summary", "exclude"])).default({}),
  advisorRedactSecrets: Schema.boolean().default(false),
  simpleMode: Schema.boolean().default(false),
});

export function normalizeConfig(config) {
  const normalized = {
    ...config,
    executor: String(config.executor ?? "").trim(),
    executorEffort: String(config.executorEffort ?? "").trim(),
    advisor: String(config.advisor ?? "").trim(),
    advisorEffort: String(config.advisorEffort ?? "").trim(),
    advisorCustomInvocation: String(config.advisorCustomInvocation ?? "").trim(),
    advisorToolPolicies: { ...(config.advisorToolPolicies ?? {}) },
  };
  for (const [key, value] of [
    ["contextMaxChars", normalized.contextMaxChars],
    ["advisorGitContextMaxChars", normalized.advisorGitContextMaxChars],
    ["advisorToolResultMaxLines", normalized.advisorToolResultMaxLines],
    ["advisorToolResultMaxBytes", normalized.advisorToolResultMaxBytes],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative safe integer.`);
  }
  if (!Number.isSafeInteger(normalized.advisorLoopThreshold) || normalized.advisorLoopThreshold < 2) {
    throw new Error("advisorLoopThreshold must be a safe integer of at least 2.");
  }
  if (!Number.isSafeInteger(normalized.advisorMaxCallsPerSession) || normalized.advisorMaxCallsPerSession < -1) {
    throw new Error("advisorMaxCallsPerSession must be -1 (unlimited) or a non-negative safe integer.");
  }
  normalized.advisorMaxCallsPerSession = normalized.advisorMaxCallsPerSession === -1
    ? undefined
    : normalized.advisorMaxCallsPerSession;
  return normalized;
}
