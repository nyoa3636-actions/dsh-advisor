/** Advisor Settings field model: groups, labels, and value coercion. */

export const BOOLEAN_PREFIX = "advisor";
export const VOLATILE_KEYS = [
  "advisor",
  "advisorAutoLoopGate",
  "advisorBlockOnBlocked",
  "advisorBudgetEnabled",
  "advisorBudgetLimitMode",
  "advisorBudgetMaxCalls",
  "advisorBudgetMaxUsd",
  "advisorBudgetScope",
  "advisorBudgetUnknownCost",
  "advisorCompletionGate",
  "advisorCustomInvocation",
  "advisorEffort",
  "advisorEnabled",
  "advisorFailureGate",
  "advisorGitContext",
  "advisorGitContextMaxChars",
  "advisorLoopThreshold",
  "advisorMaxCallsPerSession",
  "advisorPlanGate",
  "advisorPricingJson",
  "advisorProjectKey",
  "advisorRedactSecrets",
  "advisorSessionSummary",
  "advisorToolPoliciesJson",
  "advisorToolResultMaxBytes",
  "advisorToolResultMaxLines",
  "contextMaxChars",
  "executor",
  "executorEffort",
  "gateFailureMode",
  "simpleMode",
];

export const EFFORT_OPTIONS_HINT = "Model default";

/** Basic settings shown without expanding Advanced Settings. */
export const BASIC_FIELDS = [
  { group: "general", key: "advisorEnabled", kind: "switch" },
  { group: "general", key: "advisor", kind: "model" },
  { group: "general", key: "advisorEffort", kind: "effort" },
  { group: "general", key: "executorPinned", kind: "switch" },
  { group: "general", key: "executor", kind: "text", showIf: (values) => values.executorPinned !== false },
  { group: "general", key: "executorEffort", kind: "effort", showIf: (values) => values.executorPinned !== false },
  { group: "gates", key: "advisorPlanGate", kind: "switch" },
  { group: "gates", key: "advisorFailureGate", kind: "switch" },
  { group: "gates", key: "advisorCompletionGate", kind: "switch" },
  { group: "gates", key: "advisorAutoLoopGate", kind: "switch" },
  { group: "gates", key: "advisorLoopThreshold", kind: "slider", min: 2, max: 10, step: 1 },
  { group: "gates", key: "advisorMaxCallsPerSession", kind: "number", min: -1, placeholder: "-1 = unlimited" },
  { group: "gates", key: "advisorCustomInvocation", kind: "textarea" },
  { group: "budget", key: "advisorBudgetEnabled", kind: "switch" },
  { group: "budget", key: "advisorBudgetMaxUsd", kind: "number", min: 0, step: 0.01, placeholder: "0 = no cash ceiling" },
  { group: "budget", key: "advisorBudgetMaxCalls", kind: "number", min: -1, placeholder: "-1 = no call ceiling" },
  { group: "budget", key: "advisorBudgetScope", kind: "choice", options: [["session", "This session"], ["project", "Whole project"]] },
  { group: "budget", key: "advisorBudgetLimitMode", kind: "choice", options: [["stop-advisor", "Stop Advisor consultations only"], ["confirm", "Ask before an extra consultation"]] },
  { group: "budget", key: "advisorBudgetUnknownCost", kind: "choice", options: [["allow", "Allow and mark the total as estimated"], ["count-only", "Count the call but never claim an exact ceiling"], ["stop-advisor", "Stop Advisor consultations"]] },
  { group: "budget", key: "advisorPricingJson", kind: "textarea" },
  { group: "budget", key: "advisorProjectKey", kind: "text" },
];

/** Advanced settings, hidden behind one disclosure. */
export const ADVANCED_FIELDS = [
  { group: "advanced", key: "contextMaxChars", kind: "number", min: 0 },
  { group: "advanced", key: "advisorGitContext", kind: "choice", options: [["off", "off"], ["summary", "summary"], ["full", "full"]] },
  { group: "advanced", key: "advisorGitContextMaxChars", kind: "number", min: 0 },
  { group: "advanced", key: "advisorToolResultMaxLines", kind: "number", min: 0 },
  { group: "advanced", key: "advisorToolResultMaxBytes", kind: "number", min: 0 },
  { group: "advanced", key: "advisorToolPoliciesJson", kind: "textarea" },
  { group: "advanced", key: "advisorRedactSecrets", kind: "switch" },
  { group: "advanced", key: "gateFailureMode", kind: "choice", options: [["block-session", "block-session"], ["block-tool", "block-tool"], ["warn-and-continue", "warn-and-continue"]] },
  { group: "advanced", key: "advisorBlockOnBlocked", kind: "switch" },
  { group: "advanced", key: "advisorSessionSummary", kind: "switch" },
  { group: "advanced", key: "simpleMode", kind: "switch" },
];

export const ALL_FIELDS = [...BASIC_FIELDS, ...ADVANCED_FIELDS];

const NUMBER_KEYS = new Set(ALL_FIELDS.filter((field) => field.kind === "number" || field.kind === "slider").map((field) => field.key));
const SWITCH_KEYS = new Set(ALL_FIELDS.filter((field) => field.kind === "switch").map((field) => field.key));

export function isNumberKey(key) {
  return NUMBER_KEYS.has(key);
}

export function isSwitchKey(key) {
  return SWITCH_KEYS.has(key);
}

/** Coerce a text input into the value the setting expects. */
export function coerce(key, raw) {
  if (SWITCH_KEYS.has(key)) return raw === true || raw === "true";
  if (NUMBER_KEYS.has(key)) {
    if (raw === "" || raw === null || raw === undefined) return undefined;
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return raw === null || raw === undefined ? "" : String(raw);
}

/** Values a fresh form starts from, read out of the settings mirror. */
export function valuesFrom(view) {
  const source = { ...(view?.base ?? {}), ...(view?.value ?? {}) };
  const defaults = fieldDefaults();
  const values = {};
  for (const key of VOLATILE_KEYS) {
    values[key] = source[key] === undefined ? defaults[key] : source[key];
  }
  values.executorPinned = Boolean(String(values.executor ?? "").trim());
  return values;
}

/**
 * Canonical empty value per field. Both the baseline and the draft run through
 * this, so an untouched field never looks like a change.
 */
export function fieldDefaults() {
  const defaults = {};
  for (const field of ALL_FIELDS) {
    if (field.kind === "switch") defaults[field.key] = false;
    else if (field.kind === "number" || field.kind === "slider") defaults[field.key] = 0;
    else defaults[field.key] = "";
  }
  for (const key of VOLATILE_KEYS) {
    if (defaults[key] === undefined) defaults[key] = "";
  }
  defaults.advisorMaxCallsPerSession = -1;
  defaults.advisorBudgetMaxCalls = -1;
  defaults.advisorBudgetMaxUsd = 0;
  defaults.advisorLoopThreshold = 3;
  return defaults;
}

/** Build the settings patch for the fields the user actually changed. */
export function diffPatch(initial, values) {
  const patch = {};
  for (const key of VOLATILE_KEYS) {
    const next = values[key];
    const before = initial[key];
    if (key === "executor") {
      const wanted = values.executorPinned === false ? "" : String(next ?? "").trim();
      if (wanted !== String(before ?? "")) patch.executor = wanted;
      continue;
    }
    if (next === undefined) continue;
    if (JSON.stringify(next) !== JSON.stringify(before)) patch[key] = next;
  }
  return patch;
}

export function validationErrors(values) {
  const errors = [];
  const numeric = [
    ["contextMaxChars", 0],
    ["advisorGitContextMaxChars", 0],
    ["advisorToolResultMaxLines", 0],
    ["advisorToolResultMaxBytes", 0],
  ];
  for (const [key, min] of numeric) {
    const value = values[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < min) errors.push([key, `Enter a whole number of at least ${min}.`]);
  }
  if (values.advisorLoopThreshold !== undefined && (!Number.isSafeInteger(values.advisorLoopThreshold) || values.advisorLoopThreshold < 2)) {
    errors.push(["advisorLoopThreshold", "The loop threshold must be a whole number of at least 2."]);
  }
  for (const key of ["advisorMaxCallsPerSession", "advisorBudgetMaxCalls"]) {
    const value = values[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < -1) errors.push([key, "Use -1 for unlimited, or a whole number of consultations."]);
  }
  if (values.advisorBudgetMaxUsd !== undefined && (!Number.isFinite(values.advisorBudgetMaxUsd) || values.advisorBudgetMaxUsd < 0)) {
    errors.push(["advisorBudgetMaxUsd", "Enter 0 for no cash ceiling, or a positive amount in USD."]);
  }
  return errors;
}

export function parseUsd(text) {
  const value = Number(String(text ?? "").replace(/[^0-9.]/gu, ""));
  return Number.isFinite(value) ? value : 0;
}

export function formatUsdValue(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return String(value);
}
