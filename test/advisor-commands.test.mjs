import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerAdvisorCommands, extractPayload, withPayload } from "../dsh/advisor-commands.js";
import { AdvisorStore } from "../dsh/advisor-store.js";
import { normalizeConfig } from "../dsh/config.js";

function createAgent(overrides = {}) {
  return {
    cancel() {},
    session: { header: { cwd: "" }, id: "session-a", deriveMessages: () => [] },
    status: "running",
    ...overrides,
  };
}

/** Minimal command registry that captures handlers the way DSH's service does. */
function createCommandService() {
  const registered = new Map();
  return {
    find(name) {
      return registered.get(name);
    },
    list() {
      return [...registered.values()].map(({ name, description }) => ({ name, description }));
    },
    register(spec) {
      if (registered.has(spec.name)) throw new Error(`duplicate command ${spec.name}`);
      registered.set(spec.name, spec);
    },
    registered,
  };
}

async function createRuntime(overrides = {}) {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-commands-"));
  const commands = createCommandService();
  const settingsWrites = [];
  const errors = [];
  const warnings = [];
  const store = new AdvisorStore({ home });
  const config = normalizeConfig({
    advisor: "provider/advisor-model",
    advisorBudgetEnabled: true,
    advisorBudgetMaxCalls: 5,
    advisorBudgetMaxUsd: 1,
    advisorGitContext: "off",
    advisorPricing: { "provider/advisor-model": { input: 0.000001, output: 0.000002 } },
    ...overrides,
  });
  store.configure(config);
  const responses = [];
  const runtime = {
    config: () => config,
    identityFor: (agent) => AdvisorStore.identity(agent, config),
    logger: () => ({ debug() {}, info() {}, warn: (message) => warnings.push(message) }),
    resetBudget: async (agent) => {
      const identity = AdvisorStore.identity(agent, config);
      const scope = store.plan(config).scope;
      const result = await store.reset(scope, identity);
      return { ...result, scope };
    },
    runConnectionTest: async ({ agent }) => {
      const reservation = await store.reserve(config, AdvisorStore.identity(agent, config), { costMicro: 100 });
      const settled = await store.settle(config, AdvisorStore.identity(agent, config), reservation, {
        model: "provider/advisor-model",
        outcome: "success",
        trigger: "settings-test",
        usage: { inputTokens: 20, outputTokens: 10 },
      });
      return {
        costMicro: settled.costMicro,
        elapsedMs: 12,
        markdown: "Advisor ready.",
        model: "provider/advisor-model",
        ok: true,
        usage: { inputTokens: 20, outputTokens: 10 },
      };
    },
    reserve: async (activeConfig, agent, request, options = {}) => store.reserve(
      activeConfig,
      AdvisorStore.identity(agent, activeConfig),
      { costMicro: 100, modelRef: options.modelRef ?? activeConfig.advisor },
    ),
    settle: (activeConfig, agent, reservation, options) => store.settle(
      activeConfig,
      AdvisorStore.identity(agent, activeConfig),
      reservation,
      options,
    ),
    store,
    writeSettings: async (patch) => {
      settingsWrites.push(patch);
      return { ok: true };
    },
  };
  const ctx = {
    get: (name) => (name === "commands" ? commands : undefined),
    logger: { error: (message) => errors.push(String(message)), warn: (message) => warnings.push(String(message)) },
    llm: {
      async *stream(request) {
        responses.push(request);
        yield { type: "text-delta", index: 0, text: "Advisor answer." };
        yield { index: 0, type: "usage", usage: { inputTokens: 30, outputTokens: 12 } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  };
  registerAdvisorCommands(ctx, runtime);
  return { commands, config, ctx, errors, home, responses, runtime, settingsWrites, store, warnings };
}

async function withRuntime(run, overrides) {
  const harness = await createRuntime(overrides);
  try {
    await run(harness);
  } finally {
    await rm(harness.home, { force: true, recursive: true });
  }
}

test("the full command family registers exactly once", async () => {
  await withRuntime(async ({ commands }) => {
    assert.deepEqual([...commands.registered.keys()].sort(), [
      "advisor",
      "advisor-budget",
      "advisor-history",
      "advisor-log",
      "advisor-test",
    ]);
  });
});

test("/advisor status reports the budget without inventing figures", async () => {
  await withRuntime(async ({ commands, config, runtime }) => {
    const result = await commands.registered.get("advisor").handler({ agent: createAgent(), rawInput: "" });
    assert.equal(result.kind, "success");
    const payload = extractPayload(result.text);
    assert.equal(payload.kind, "status");
    assert.equal(payload.plan.maxCalls, 5);
    assert.equal(payload.plan.maxCallMicro, 1e6);
    assert.equal(payload.standing.settledCalls, 0);
    assert.equal(payload.standing.exact, true);
    assert.match(result.text, /Consultation budget: on/);
    assert.match(result.text, /no cash ceiling|1\.00|0\.0000/u);
    assert.equal(runtime.store.plan(config).scope, "session");
  });
});

test("/advisor status counts a consultation and marks unpriced calls as estimated", async () => {
  await withRuntime(async ({ commands, config, runtime }) => {
    const agent = createAgent();
    const identity = runtime.identityFor(agent);
    const reservation = await runtime.store.reserve(config, identity, { costMicro: 100 });
    await runtime.store.settle(config, identity, reservation, {
      costMicro: undefined,
      model: "provider/advisor-model",
      outcome: "success",
      trigger: "executor-requested",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const result = await commands.registered.get("advisor").handler({ agent, rawInput: "" });
    const payload = extractPayload(result.text);
    assert.equal(payload.standing.settledCalls, 1);
    assert.equal(payload.standing.unknownCostCalls, 1);
    assert.equal(payload.standing.exact, false);
    assert.match(result.text, /unknown price/);
    assert.match(result.text, /estimate, not an exact limit/);
  }, { advisorPricing: {} });
});

test("/advisor-history lists the recorded consultations", async () => {
  await withRuntime(async ({ commands, config, runtime }) => {
    const agent = createAgent();
    const identity = runtime.identityFor(agent);
    const reservation = await runtime.store.reserve(config, identity, { costMicro: 100 });
    await runtime.store.settle(config, identity, reservation, {
      costMicro: 42,
      model: "provider/advisor-model",
      outcome: "failed",
      question: "Should we split the module?",
      trigger: "repeated-tool-call",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const result = await commands.registered.get("advisor-history").handler({ agent, rawInput: "5" });
    const payload = extractPayload(result.text);
    assert.equal(payload.kind, "history");
    assert.equal(payload.entries.length, 1);
    assert.equal(payload.entries[0].outcome, "failed");
    assert.equal(payload.entries[0].costMicro, 20, "the ledger prices the recorded usage");
    assert.match(result.text, /repeated-tool-call/);
    assert.match(result.text, /at most 200 recorded consultations/);
    assert.match(result.text, /Should we split the module\?/);
  });
});

test("/advisor-test spends the Advisor budget and reports every field", async () => {
  await withRuntime(async ({ commands, config, runtime }) => {
    const agent = createAgent();
    const result = await commands.registered.get("advisor-test").handler({ agent });
    assert.equal(result.kind, "success");
    const payload = extractPayload(result.text);
    assert.equal(payload.ok, true);
    assert.equal(payload.model, "provider/advisor-model");
    assert.equal(payload.elapsedMs, 12);
    assert.equal(payload.costMicro, 20 * 0.000001 * 1e6 + 10 * 0.000002 * 1e6);
    const summary = await runtime.store.summary(config, runtime.identityFor(agent));
    assert.equal(summary.counter.calls, 1, "the connection test counts against the budget");
    assert.match(result.text, /Advisor connection: OK/);
    assert.match(result.text, /Advisor ready\./);
  });
});

test("/advisor-test explains what to check when the Advisor model is unset", async () => {
  await withRuntime(async ({ commands }) => {
    const result = await commands.registered.get("advisor-test").handler({ agent: createAgent() });
    assert.equal(result.kind, "error");
    assert.match(result.text, /No Advisor model is configured/);
  }, { advisor: "" });
});

test("/advisor writes the settings it owns through the settings service", async () => {
  await withRuntime(async ({ commands, settingsWrites }) => {
    const advisor = commands.registered.get("advisor");
    const agent = createAgent();
    assert.equal((await advisor.handler({ agent, rawInput: "off" })).kind, "success");
    assert.equal((await advisor.handler({ agent, rawInput: "on" })).kind, "success");
    assert.equal((await advisor.handler({ agent, rawInput: "model provider/other" })).kind, "success");
    assert.equal((await advisor.handler({ agent, rawInput: "effort high" })).kind, "success");
    assert.equal((await advisor.handler({ agent, rawInput: "effort default" })).kind, "success");
    assert.equal((await advisor.handler({ agent, rawInput: "budget on" })).kind, "success");
    assert.equal((await advisor.handler({ agent, rawInput: "scope project" })).kind, "success");
    assert.equal((await advisor.handler({ agent, rawInput: "limit confirm" })).kind, "success");
    assert.equal((await advisor.handler({ agent, rawInput: "unknown-cost count-only" })).kind, "success");
    assert.deepEqual(settingsWrites, [
      { advisorEnabled: false },
      { advisorEnabled: true },
      { advisor: "provider/other" },
      { advisorEffort: "high" },
      { advisorEffort: "" },
      { advisorBudgetEnabled: true },
      { advisorBudgetScope: "project" },
      { advisorBudgetLimitMode: "confirm" },
      { advisorBudgetUnknownCost: "count-only" },
    ]);
    assert.equal((await advisor.handler({ agent, rawInput: "scope nonsense" })).kind, "error");
    assert.equal((await advisor.handler({ agent, rawInput: "limit nonsense" })).kind, "error");
    assert.equal((await advisor.handler({ agent, rawInput: "unknown-cost nonsense" })).kind, "error");
  });
});

test("/advisor reset-budget clears the active scope", async () => {
  await withRuntime(async ({ commands, config, runtime }) => {
    const agent = createAgent();
    const identity = runtime.identityFor(agent);
    const reservation = await runtime.store.reserve(config, identity, { costMicro: 100 });
    await runtime.store.settle(config, identity, reservation, {
      costMicro: 10,
      model: "provider/advisor-model",
      outcome: "success",
      trigger: "executor-requested",
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const result = await commands.registered.get("advisor").handler({ agent, rawInput: "reset-budget" });
    assert.equal(result.kind, "success");
    const payload = extractPayload(result.text);
    assert.equal(payload.kind, "reset");
    assert.equal(payload.scope, "session");
    const summary = await runtime.store.summary(config, identity);
    assert.equal(summary.counter.calls, 0);
  });
});

test("/advisor-log controls disclosure settings", async () => {
  await withRuntime(async ({ commands, settingsWrites }) => {
    const log = commands.registered.get("advisor-log");
    assert.equal((await log.handler({ rawInput: "on" })).kind, "success");
    assert.equal((await log.handler({ rawInput: "off" })).kind, "success");
    assert.equal((await log.handler({ rawInput: "git full" })).kind, "success");
    assert.equal((await log.handler({ rawInput: "policy read_file summary" })).kind, "success");
    assert.equal((await log.handler({ rawInput: "policies" })).kind, "success");
    assert.equal((await log.handler({ rawInput: "git nonsense" })).kind, "error");
    assert.deepEqual(settingsWrites[0], { advisorRedactSecrets: true });
    assert.deepEqual(settingsWrites[1], { advisorRedactSecrets: false });
    assert.deepEqual(settingsWrites[2], { advisorGitContext: "full" });
    assert.deepEqual(settingsWrites[3], { advisorToolPoliciesJson: "read_file: summary" });
  });
});

test("a deployment without the commands service still loads", async () => {
  const ctx = { get: () => undefined, logger: { warn() {} } };
  assert.doesNotThrow(() => registerAdvisorCommands(ctx, { logger: () => undefined }));
});

test("the machine-readable payload survives text around it", () => {
  const text = withPayload("Report line", { kind: "status", version: 1 });
  assert.deepEqual(extractPayload(text), { kind: "status", version: 1 });
  assert.equal(extractPayload("no payload here"), undefined);
  assert.equal(extractPayload("```dsh-advisor-json\nnot json\n```"), undefined);
});
