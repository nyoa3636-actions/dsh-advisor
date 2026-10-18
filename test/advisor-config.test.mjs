import assert from "node:assert/strict";
import test from "node:test";
import Schema from "@deepseek-ai/schemastery";
import { advisorFormSchema, CONFIG_DEFAULTS, Config, HIDDEN_FROM_PAGE, normalizeConfig, parsePricingLines, parseToolPolicies } from "../dsh/config.js";

/** Resolve the plugin Config the way DSH does, then unwrap the volatile reference. */
function resolved(overrides = {}) {
  const defaults = Config({});
  const raw = { ...(typeof defaults?.get === "function" ? defaults.get() : defaults), ...overrides };
  return normalizeConfig(raw);
}

test("a fresh install receives the recommended secret redaction and loop-gate default", () => {
  // DSH resolves the schema before `apply`, so the raw object is the evidence
  // that the profile never named these keys.
  const config = normalizeConfig({ advisor: "p/m" });
  assert.equal(config.advisorRedactSecrets, true);
  assert.equal(config.gateFailureMode, "block-tool");
});

test("an explicit existing choice is never overwritten", () => {
  const config = normalizeConfig({
    advisor: "p/m",
    advisorRedactSecrets: false,
    gateFailureMode: "block-session",
  });
  assert.equal(config.advisorRedactSecrets, false);
  assert.equal(config.gateFailureMode, "block-session");
});

test("a schema-resolved default keeps the documented legacy value", () => {
  const config = resolved({ advisorRedactSecrets: false, gateFailureMode: "block-session" });
  assert.equal(config.advisorRedactSecrets, false);
  assert.equal(config.gateFailureMode, "block-session");
});

test("legacy per-session call limits still bound the consultation budget", () => {
  const pinned = resolved({ advisorMaxCallsPerSession: 4 });
  assert.equal(pinned.advisorMaxCallsPerSession, 4);
  assert.equal(pinned.advisorBudgetMaxCalls, 4, "the legacy limit carries into the budget ceiling");

  const unlimited = resolved({ advisorMaxCallsPerSession: -1 });
  assert.equal(unlimited.advisorMaxCallsPerSession, undefined);
  assert.equal(unlimited.advisorBudgetMaxCalls, undefined);
});

test("the consultation budget ceiling is authoritative when it is set", () => {
  const config = resolved({ advisorMaxCallsPerSession: 3, advisorBudgetMaxCalls: 7 });
  assert.equal(config.advisorBudgetMaxCalls, 7);
  assert.equal(config.advisorMaxCallsPerSession, 3);
});

test("invalid numeric settings fail before they are stored", () => {
  assert.throws(() => normalizeConfig({ ...resolved({}), contextMaxChars: -1 }), /contextMaxChars/);
  assert.throws(() => normalizeConfig({ ...resolved({}), advisorLoopThreshold: 1 }), /advisorLoopThreshold/);
  assert.throws(() => normalizeConfig({ ...resolved({}), advisorMaxCallsPerSession: -2 }), /advisorMaxCallsPerSession/);
  assert.throws(() => normalizeConfig({ ...resolved({}), advisorBudgetMaxCalls: -2 }), /advisorBudgetMaxCalls/);
  assert.throws(() => normalizeConfig({ ...resolved({}), advisorBudgetMaxUsd: -1 }), /advisorBudgetMaxUsd/);
  assert.throws(() => normalizeConfig({ ...resolved({}), advisorEnabled: "yes" }), /advisorEnabled/);
  assert.throws(() => normalizeConfig({ ...resolved({}), advisorToolResultMaxBytes: 1.5 }), /advisorToolResultMaxBytes/);
});

test("normalizing an already normalized configuration is idempotent", () => {
  const once = resolved({ advisorBudgetEnabled: true, advisorBudgetMaxCalls: 5 });
  const twice = normalizeConfig(once);
  assert.equal(twice.advisorBudgetMaxCalls, 5);
  assert.equal(twice.advisorMaxCallsPerSession, 5);
  assert.deepEqual(normalizeConfig(twice), twice);
});

test("model rates parse from the settings page rows", () => {
  const parsed = parsePricingLines([
    "# rates in USD per token",
    "openai-codex/gpt-6.1-sol: 0.0000025, 0.00001, 0.00000025, 0.000003",
    "deepseek/deepseek-v4-pro: 0.0000005, 0.000002",
    "",
  ].join("\n"));
  assert.deepEqual(parsed.issues, []);
  assert.deepEqual(parsed.table["openai-codex/gpt-6.1-sol"], {
    cacheRead: 0.00000025,
    cacheWrite: 0.000003,
    input: 0.0000025,
    output: 0.00001,
  });
  assert.deepEqual(parsed.table["deepseek/deepseek-v4-pro"], { input: 0.0000005, output: 0.000002 });
});

test("bad rate rows are reported instead of silently accepted", () => {
  const parsed = parsePricingLines([
    "no-provider 1, 2",
    "p/m: 1, x",
    "p/m: 1",
  ].join("\n"));
  assert.equal(parsed.issues.length, 3);
  assert.equal(Object.keys(parsed.table).length, 0);
});

test("tool policies parse with validation", () => {
  const parsed = parseToolPolicies("read_file: summary\nexec: exclude\nwrite_file: bogus");
  assert.deepEqual(parsed.table, { read_file: "summary", exec: "exclude" });
  assert.equal(parsed.issues.length, 1);
});

test("the settings page rows drive the runtime maps", () => {
  const config = resolved({
    advisorPricingJson: "p/m: 0.000001, 0.000002",
    advisorToolPoliciesJson: "exec: exclude",
  });
  assert.deepEqual(config.advisorPricing, { "p/m": { input: 0.000001, output: 0.000002 } });
  assert.deepEqual(config.advisorToolPolicies, { exec: "exclude" });
});

test("an untouched settings page keeps the legacy object settings", () => {
  const config = normalizeConfig({
    ...resolved({}),
    advisorPricing: { "p/m": { input: 1e-6, output: 2e-6 } },
    advisorToolPolicies: { exec: "summary" },
  });
  assert.deepEqual(config.advisorPricing, { "p/m": { input: 1e-6, output: 2e-6 } });
  assert.deepEqual(config.advisorToolPolicies, { exec: "summary" });
});

test("the exported Config accepts every settings-page field", () => {
  const reference = Config({
    advisorBudgetEnabled: true,
    advisorBudgetMaxUsd: 1.5,
    advisorBudgetScope: "project",
    advisorPricingJson: "p/m: 1, 2",
    executor: "p/e",
  });
  const values = typeof reference?.get === "function" ? reference.get() : reference;
  assert.equal(values.advisorBudgetMaxUsd, 1.5);
  assert.equal(values.advisorBudgetScope, "project");
  assert.equal(values.executor, "p/e");
  assert.equal(values.advisorLoopThreshold, 3, "runtime defaults stay available");
  assert.equal(values.advisorRedactSecrets, false, "the schema default is the legacy value");
});

test("the exported Config is a volatile root the settings service can describe", () => {
  const json = new Schema(Config.toJSON());
  const form = new Schema(advisorFormSchema.toJSON());
  assert.equal(json.meta?.volatile, true, "dsh-settings only lists entries with a volatile form");
  assert.ok(json.dict.advisor, "the Advisor route is part of the form");
  assert.ok(json.dict.advisorBudgetMaxUsd, "the budget ceiling is part of the form");
  assert.ok(json.dict.advisorLoopThreshold, "the loop threshold is part of the form");

  const reference = Config({ advisor: "p/m", advisorBudgetMaxUsd: 2 });
  assert.equal(typeof reference.get, "function", "a volatile root resolves to a stable reference");
  const value = reference.get();
  assert.equal(value.advisor, "p/m");
  assert.equal(value.advisorBudgetMaxUsd, 2);
  assert.equal(value.advisorEnabled, true, "schema defaults ride along");
});

test("the page form exposes the editable fields and hides runtime-only ones", () => {
  const form = new Schema(advisorFormSchema.toJSON());
  assert.equal(form.type, "object");
  for (const key of [
    "advisor",
    "advisorBudgetEnabled",
    "advisorBudgetMaxUsd",
    "advisorBudgetScope",
    "advisorGitContext",
    "advisorToolPoliciesJson",
    "contextMaxChars",
    "simpleMode",
  ]) {
    assert.ok(form.dict[key], `${key} is on the page`);
  }
  for (const key of HIDDEN_FROM_PAGE) {
    assert.equal(form.dict[key], undefined, `${key} stays runtime-only`);
  }
});

test("every schema field has a documented runtime default", () => {
  const schema = new Schema(Config.toJSON());
  const schemaKeys = Object.keys(schema.dict).sort();
  const defaultKeys = Object.keys(CONFIG_DEFAULTS).sort();
  assert.deepEqual(schemaKeys, defaultKeys, "the schema and the runtime defaults cannot drift apart");
  for (const key of schemaKeys) {
    const resolved = Config({});
    const values = typeof resolved?.get === "function" ? resolved.get() : resolved;
    assert.notEqual(values[key], undefined, `${key} resolves to a value`);
  }
});
