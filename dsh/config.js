import Schema from "@deepseek-ai/schemastery";
import { BUDGET_LIMIT_MODES, BUDGET_SCOPES, UNKNOWN_COST_MODES } from "./advisor-budget.js";
import { normalizePricingTable } from "./advisor-cost.js";

export const name = "dsh-advisor";
export const ADVISOR_ENTRY_ID = "dsh-advisor";

/**
 * Keys whose absent value means "a fresh install" rather than "the user turned
 * this off". They receive the recommended value only when the profile never
 * named them, so an existing explicit choice is never overwritten.
 */
const RECOMMENDED_WHEN_ABSENT = {
  advisorRedactSecrets: true,
  gateFailureMode: "block-tool",
};

/** Advisor settings the page always shows. */
export const PAGE_FIELDS = {
  advisorBudgetEnabled: Schema.boolean().default(false),
  advisorBudgetLimitMode: Schema.union(BUDGET_LIMIT_MODES).default("stop-advisor"),
  advisorBudgetMaxCalls: Schema.number().default(-1),
  advisorBudgetMaxUsd: Schema.number().default(0),
  advisorBudgetScope: Schema.union(BUDGET_SCOPES).default("session"),
  advisorBudgetUnknownCost: Schema.union(UNKNOWN_COST_MODES).default("allow"),
  advisorEnabled: Schema.boolean().default(true),
  advisorPricingJson: Schema.string().default(""),
  advisorProjectKey: Schema.string().default(""),
};

/**
 * The page stores per-model rates as `provider/model: input, output, cacheRead,
 * cacheWrite`, one row per line, because a nested map cannot be a volatile field.
 */
export function parsePricingLines(text) {
  const table = {};
  const issues = [];
  for (const [index, raw] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      issues.push(`Line ${index + 1}: expected "<provider>/<model>: <input>, <output>[, <cacheRead>[, <cacheWrite>]]".`);
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const rates = line.slice(separator + 1).split(",").map((value) => Number(value.trim()));
    if (!key.includes("/")) {
      issues.push(`Line ${index + 1}: model key must include the provider, for example "openai-codex/gpt-6.1-sol".`);
      continue;
    }
    if (rates.some((rate) => !Number.isFinite(rate) || rate < 0)) {
      issues.push(`Line ${index + 1}: every rate must be a non-negative number of USD per token.`);
      continue;
    }
    const [input, output, cacheRead, cacheWrite] = rates;
    if (input === undefined || output === undefined) {
      issues.push(`Line ${index + 1}: input and output rates are required.`);
      continue;
    }
    table[key] = {
      input,
      output,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
    };
  }
  return { issues, table };
}

export function formatPricingLines(table) {
  return Object.entries(table ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, rates]) => `${key}: ${rates.input}, ${rates.output}, ${rates.cacheRead ?? 0}, ${rates.cacheWrite ?? 0}`)
    .join("\n");
}

export const RuntimeConfig = Schema.object({
  advisor: Schema.string().default(""),
  advisorAutoLoopGate: Schema.boolean().default(true),
  advisorBlockOnBlocked: Schema.boolean().default(true),
  advisorCompletionGate: Schema.boolean().default(true),
  advisorCustomInvocation: Schema.string().default(""),
  advisorEffort: Schema.string().default(""),
  advisorFailureGate: Schema.boolean().default(true),
  advisorGitContext: Schema.union(["off", "summary", "full"]).default("summary"),
  advisorGitContextMaxChars: Schema.number().default(20000),
  advisorHistoryLimit: Schema.number().default(200),
  advisorLedgerPath: Schema.string().default(""),
  advisorLoopThreshold: Schema.number().default(3),
  advisorMaxCallsPerSession: Schema.number().default(-1),
  advisorPlanGate: Schema.boolean().default(true),
  advisorPricing: Schema.dict(Schema.object({
    cacheRead: Schema.number().default(0),
    cacheWrite: Schema.number().default(0),
    input: Schema.number().default(0),
    output: Schema.number().default(0),
  })).default({}),
  advisorRedactSecrets: Schema.boolean().default(false),
  advisorSessionSummary: Schema.boolean().default(false),
  advisorToolPolicies: Schema.dict(Schema.union(["full", "summary", "exclude"])).default({}),
  advisorToolPoliciesJson: Schema.string().default(""),
  advisorToolResultMaxBytes: Schema.number().default(51200),
  advisorToolResultMaxLines: Schema.number().default(2000),
  contextMaxChars: Schema.number().default(15000),
  executor: Schema.string().default(""),
  executorEffort: Schema.string().default(""),
  gateFailureMode: Schema.union(["block-session", "block-tool", "warn-and-continue"]).default("block-session"),
  simpleMode: Schema.boolean().default(false),
});

/**
 * The one schema the Loader validates this plugin's row against. The root is
 * volatile so DSH's own settings service can expose and persist these fields;
 * `apply` unwraps it with `.get()` before reading anything.
 */
export const Config = Schema.object({
  ...PAGE_FIELDS,
  ...RuntimeConfig.dict,
}).volatile();

/** Runtime-only fields the page never renders; they follow their page-owned form. */
export const HIDDEN_FROM_PAGE = new Set(["advisorLedgerPath", "advisorPricing", "advisorToolPolicies"]);

/** The Advisor Settings page renders exactly these fields. */
export const advisorFormSchema = Schema.object({
  ...PAGE_FIELDS,
  ...Object.fromEntries(Object.entries(RuntimeConfig.dict)
    .filter(([key]) => !HIDDEN_FROM_PAGE.has(key))
    .map(([key, value]) => [key, value.volatile()])),
});

export const ADVANCED_FIELDS = Object.keys(RuntimeConfig.dict);

function recommendedValue(key, rawConfig) {
  if (!Object.hasOwn(RECOMMENDED_WHEN_ABSENT, key)) return undefined;
  return rawConfig?.[key] === undefined ? RECOMMENDED_WHEN_ABSENT[key] : undefined;
}

export function parseToolPolicies(text) {
  const issues = [];
  const table = {};
  for (const [index, raw] of String(text ?? "").split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      issues.push(`Line ${index + 1}: expected "<tool name>: full | summary | exclude".`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().toLowerCase();
    if (!["full", "summary", "exclude"].includes(value)) {
      issues.push(`Line ${index + 1}: policy must be full, summary, or exclude.`);
      continue;
    }
    table[key] = value;
  }
  return { issues, table };
}

export function formatToolPolicies(table) {
  return Object.entries(table ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/**
 * Defaults applied before validation, so `normalizeConfig` is also usable on a
 * partial patch without depending on DSH's schema resolution.
 */
export const CONFIG_DEFAULTS = Object.freeze({
  advisor: "",
  advisorAutoLoopGate: true,
  advisorBlockOnBlocked: true,
  advisorBudgetEnabled: false,
  advisorBudgetLimitMode: "stop-advisor",
  advisorBudgetMaxCalls: -1,
  advisorBudgetMaxUsd: 0,
  advisorBudgetScope: "session",
  advisorBudgetUnknownCost: "allow",
  advisorCompletionGate: true,
  advisorCustomInvocation: "",
  advisorEffort: "",
  advisorEnabled: true,
  advisorFailureGate: true,
  advisorGitContext: "summary",
  advisorGitContextMaxChars: 20000,
  advisorHistoryLimit: 200,
  advisorLedgerPath: "",
  advisorLoopThreshold: 3,
  advisorMaxCallsPerSession: -1,
  advisorPlanGate: true,
  advisorPricing: {},
  advisorPricingJson: "",
  advisorProjectKey: "",
  advisorRedactSecrets: false,
  advisorSessionSummary: false,
  advisorToolPolicies: {},
  advisorToolPoliciesJson: "",
  advisorToolResultMaxBytes: 51200,
  advisorToolResultMaxLines: 2000,
  contextMaxChars: 15000,
  executor: "",
  executorEffort: "",
  gateFailureMode: "block-session",
  simpleMode: false,
});

export function normalizeConfig(config) {
  const raw = config ?? {};
  // A raw partial patch (tests, programmatic callers) gets the documented
  // defaults here, so the runtime never depends on schema resolution having run.
  const settings = { ...CONFIG_DEFAULTS, ...raw };
  for (const key of Object.keys(RECOMMENDED_WHEN_ABSENT)) {
    const recommended = recommendedValue(key, raw);
    if (recommended !== undefined) settings[key] = recommended;
  }
  const normalized = {
    ...settings,
    advisor: String(settings.advisor ?? "").trim(),
    advisorBudgetLimitMode: BUDGET_LIMIT_MODES.includes(settings.advisorBudgetLimitMode)
      ? settings.advisorBudgetLimitMode
      : "stop-advisor",
    advisorBudgetMaxUsd: Number(settings.advisorBudgetMaxUsd ?? 0),
    advisorBudgetScope: BUDGET_SCOPES.includes(settings.advisorBudgetScope) ? settings.advisorBudgetScope : "session",
    advisorBudgetUnknownCost: UNKNOWN_COST_MODES.includes(settings.advisorBudgetUnknownCost)
      ? settings.advisorBudgetUnknownCost
      : "allow",
    advisorCustomInvocation: String(settings.advisorCustomInvocation ?? "").trim(),
    advisorEffort: String(settings.advisorEffort ?? "").trim(),
    advisorLedgerPath: String(settings.advisorLedgerPath ?? "").trim(),
    advisorPricing: normalizePricingTable(settings.advisorPricing ?? {}),
    advisorProjectKey: String(settings.advisorProjectKey ?? "").trim(),
    advisorToolPolicies: { ...(settings.advisorToolPolicies ?? {}) },
    executor: String(settings.executor ?? "").trim(),
    executorEffort: String(settings.executorEffort ?? "").trim(),
  };
  // The Settings page owns these two rows once they hold content; while they are
  // empty the legacy object form stays authoritative, so an existing profile is
  // never silently reset by the newer page.
  const pricingRows = String(settings.advisorPricingJson ?? "").trim();
  if (pricingRows) {
    const parsed = parsePricingLines(pricingRows);
    if (Object.keys(parsed.table).length > 0) normalized.advisorPricing = { ...normalized.advisorPricing, ...parsed.table };
  }
  const policyRows = String(settings.advisorToolPoliciesJson ?? "").trim();
  if (policyRows) normalized.advisorToolPolicies = parseToolPolicies(policyRows).table;
  for (const key of Object.keys(RECOMMENDED_WHEN_ABSENT)) {
    if (settings[key] !== undefined) continue;
    const recommended = recommendedValue(key, raw);
    if (recommended !== undefined) normalized[key] = recommended;
  }
  for (const [key, value] of [
    ["contextMaxChars", normalized.contextMaxChars],
    ["advisorGitContextMaxChars", normalized.advisorGitContextMaxChars],
    ["advisorToolResultMaxLines", normalized.advisorToolResultMaxLines],
    ["advisorToolResultMaxBytes", normalized.advisorToolResultMaxBytes],
    ["advisorHistoryLimit", normalized.advisorHistoryLimit],
  ]) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative safe integer.`);
  }
  if (normalized.advisorLoopThreshold !== undefined
    && (!Number.isSafeInteger(normalized.advisorLoopThreshold) || normalized.advisorLoopThreshold < 2)) {
    throw new Error("advisorLoopThreshold must be a safe integer of at least 2.");
  }
  for (const key of ["advisorMaxCallsPerSession", "advisorBudgetMaxCalls"]) {
    const value = normalized[key];
    if (value === undefined || value === -1) continue;
    if (!Number.isSafeInteger(value) || value < -1) {
      throw new Error(`${key} must be -1 (unlimited) or a non-negative safe integer.`);
    }
  }
  if (!Number.isFinite(normalized.advisorBudgetMaxUsd) || normalized.advisorBudgetMaxUsd < 0) {
    throw new Error("advisorBudgetMaxUsd must be 0 (unlimited) or a positive amount in USD.");
  }
  normalized.advisorBudgetMaxUsd = normalized.advisorBudgetMaxUsd > 0
    ? Number(normalized.advisorBudgetMaxUsd.toFixed(6))
    : 0;
  if (typeof normalized.advisorEnabled !== "boolean") {
    throw new Error("advisorEnabled must be a boolean.");
  }
  // The legacy per-session limit and the consultation budget share one ceiling.
  // An absent value means unlimited, so this function stays idempotent.
  for (const key of ["advisorMaxCallsPerSession", "advisorBudgetMaxCalls"]) {
    normalized[key] = normalized[key] === -1 || normalized[key] === undefined ? undefined : normalized[key];
  }
  if (normalized.advisorBudgetMaxCalls === undefined) {
    normalized.advisorBudgetMaxCalls = normalized.advisorMaxCallsPerSession;
  }
  if (normalized.advisorMaxCallsPerSession === undefined && normalized.advisorBudgetEnabled) {
    normalized.advisorMaxCallsPerSession = normalized.advisorBudgetMaxCalls;
  }
  return normalized;
}
