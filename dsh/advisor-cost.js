const USD_SCALE = 1e6;
const MICRO_RE = /^\d+(?:\.\d+)?$/;

export function microFromUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return Math.round(numeric * USD_SCALE);
}

export function usdFromMicro(value) {
  return Number((Number(value ?? 0) / USD_SCALE).toFixed(6));
}

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

export function normalizePricing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pricing = {};
  for (const key of RATE_KEYS) {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    pricing[key] = numeric;
  }
  return Object.keys(pricing).length > 0 ? pricing : undefined;
}

export function normalizePricingTable(value) {
  const table = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    const id = String(key).trim().toLowerCase();
    if (!id) continue;
    const pricing = normalizePricing(entry);
    if (pricing) table[id] = pricing;
  }
  return table;
}

export function pricingKey(provider, model) {
  return `${String(provider).trim()}/${String(model).trim()}`.toLowerCase();
}

export function pricingFor(pricingTable, modelRef) {
  if (!pricingTable || !modelRef) return undefined;
  const key = String(modelRef).trim().toLowerCase();
  if (!key) return undefined;
  const direct = normalizePricing(pricingTable[key]);
  if (direct) return direct;
  const model = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  return normalizePricing(pricingTable[model]);
}

function tokens(usage, key) {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Estimate the cost of one Advisor call in micro-USD.
 * Returns undefined when any consumed token class has no configured rate, so a
 * partially priced model never yields a plausible-looking invented charge.
 */
export function estimateCostMicro(usage, pricing) {
  if (!usage) return undefined;
  const rates = normalizePricing(pricing);
  if (!rates) return undefined;
  const input = tokens(usage, "inputTokens");
  const output = tokens(usage, "outputTokens");
  const cacheRead = tokens(usage, "cacheReadTokens");
  const cacheWrite = tokens(usage, "cacheWriteTokens");
  if (input + output + cacheRead + cacheWrite === 0) return 0;
  if (rates.input === undefined || rates.output === undefined) return undefined;
  if (cacheRead > 0 && rates.cacheRead === undefined) return undefined;
  if (cacheWrite > 0 && rates.cacheWrite === undefined) return undefined;
  const micro = (
    input * rates.input
    + output * rates.output
    + cacheRead * (rates.cacheRead ?? 0)
    + cacheWrite * (rates.cacheWrite ?? 0)
  ) * USD_SCALE;
  return Math.round(micro);
}

/**
 * Upper bound for one call, used to reserve budget before the provider answers.
 * Undefined whenever any consumed token class has no known rate.
 */
export function reserveCostMicro(pricing, { inputTokens, maxOutputTokens }) {
  const rates = normalizePricing(pricing);
  if (!rates || rates.input === undefined || rates.output === undefined) return undefined;
  const input = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const output = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 0;
  return Math.round((input * rates.input + output * rates.output) * USD_SCALE);
}

export function formatUsd(micro) {
  if (micro === undefined || micro === null) return "unavailable";
  const value = Number(micro) / USD_SCALE;
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function usageTokenTotal(usage) {
  if (!usage) return 0;
  let total = 0;
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    total += tokens(usage, key);
  }
  return total;
}

export { MICRO_RE };
