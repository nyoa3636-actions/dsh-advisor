import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import {
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
} from "@deepseek-ai/dsh-llm";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { defineTool, ToolRuntime } from "@deepseek-ai/dsh-tools";
import * as advisorModule from "../dsh/index.js";

const PROVIDER = "scripted";
let callSequence = 0;

class ScriptedAdapter extends LlmAdapter {
  constructor(responses) {
    super();
    this.responses = [...responses];
    this.requests = [];
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      reasoning: { efforts: [{ id: "high", name: "high" }] },
    };
  }

  async *stream(options) {
    this.requests.push(options);
    const text = this.responses.shift();
    if (text === undefined) throw new Error("No scripted response remains.");
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { index: 0, type: "usage", usage: this.usage ?? { inputTokens: 100, outputTokens: 20 } };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

function createAgent(messages = [], cwd = "") {
  const cancellations = [];
  const agent = {
    status: "running",
    session: {
      id: "sentinel-session",
      header: { cwd },
      deriveMessages: () => messages,
    },
    cancel(reason, options) {
      cancellations.push({ reason, options });
    },
  };
  return { agent, cancellations };
}

/** Command registry stub that captures handlers the way DSH's service does. */
function createCommands() {
  const registered = new Map();
  return {
    registered,
    find: (name) => registered.get(name),
    list: () => [...registered.values()].map(({ name, description }) => ({ name, description })),
    register(spec) {
      if (registered.has(spec.name)) throw new Error(`duplicate command ${spec.name}`);
      registered.set(spec.name, spec);
    },
  };
}

async function createHarness(config = {}, responses = [], options = {}) {
  const ctx = new Context();
  const systemPrompt = new SystemPrompt(ctx, {});
  const llm = new LlmRuntime(ctx);
  const tools = new ToolRuntime(ctx);
  const commands = createCommands();
  const settingsWrites = [];
  const asked = [];
  ctx.provide("commands", commands, true);
  ctx.provide("settings", {
    async configure() {},
    async update(ns, patch) {
      settingsWrites.push([ns, patch]);
    },
  }, true);
  ctx.provide("userQuestions", {
    async ask(request) {
      asked.push(request);
      return options.answer ?? { answers: [{ id: "advisor-budget-overrun", selected: ["Stop Advisor"] }] };
    },
  }, true);
  const adapter = new ScriptedAdapter(responses);
  if (options.usage) adapter.usage = options.usage;
  llm.registerAdapter([PROVIDER], adapter);
  tools.register(defineTool({
    name: "probe",
    description: "Return a deterministic probe value.",
    parameters: {
      value: { type: "string" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute({ value }) {
      return `probe:${value}`;
    },
  }));
  const fiber = ctx.plugin(advisorModule, {
    advisor: `${PROVIDER}/advisor-model`,
    advisorGitContext: "off",
    ...config,
  });
  await fiber;
  return { adapter, asked, commands, ctx, fiber, llm, settingsWrites, systemPrompt, tools };
}

function executeTool(harness, agent, name, arguments_, signal = new AbortController().signal) {
  callSequence += 1;
  return harness.tools.execute({
    callId: `call-${callSequence}`,
    name,
    arguments: arguments_,
    agent,
    signal,
  });
}

function failureText(result) {
  return result.error?.message ?? result.content.map((block) => block.text ?? "").join("\n");
}

test("ask_advisor crosses the real DSH runtimes without losing request identity", async (t) => {
  const markdown = "# Sentinel advice\n\n- deterministic";
  const sentinel = "SENTINEL_RECONSTRUCTED_CONVERSATION";
  const message = createUserMessage({
    source: { kind: "user" },
    content: [{ type: "text", text: sentinel }],
  });
  const harness = await createHarness({ advisorEffort: "high" }, [markdown]);
  t.after(() => harness.fiber.dispose());
  const { agent } = createAgent([message]);
  const signal = new AbortController().signal;

  assert.equal(typeof harness.ctx.llm.stream, "function");
  assert.equal(typeof harness.ctx.systemPrompt.section, "function");
  assert.equal(typeof harness.ctx.tools.execute, "function");

  const result = await executeTool(harness, agent, "ask_advisor", {}, signal);
  assert.equal(result.isError, false);
  assert.equal(result.value, `Advisor (${PROVIDER}/advisor-model)\n\n${markdown}`);
  assert.equal(harness.adapter.requests.length, 1);

  const request = harness.adapter.requests[0];
  assert.equal(request.provider, PROVIDER);
  assert.equal(request.model, "advisor-model");
  assert.equal(request.reasoningEffort, "high");
  assert.equal(request.sessionId, "sentinel-session");
  assert.equal(request.signal, signal);
  assert.match(request.messages[1].content[0].text, /User: SENTINEL_RECONSTRUCTED_CONVERSATION/);
});

test("executor routing preserves blank configuration and applies an explicit pin", async (t) => {
  const { agent } = createAgent();
  const base = {
    provider: "selected-provider",
    model: "selected-model",
    reasoningEffort: "medium",
    marker: "unchanged",
  };

  const unpinned = await createHarness({ executor: "" });
  t.after(() => unpinned.fiber.dispose());
  assert.deepEqual(
    await unpinned.ctx.waterfall("agent/request", { agent }, async () => base),
    base,
  );

  const pinned = await createHarness({
    executor: "executor-provider/executor-model",
    executorEffort: "low",
  });
  t.after(() => pinned.fiber.dispose());
  assert.deepEqual(
    await pinned.ctx.waterfall("agent/request", { agent }, async () => base),
    {
      provider: "executor-provider",
      model: "executor-model",
      reasoningEffort: "low",
      marker: "unchanged",
    },
  );
});

test("the repeated-call gate applies every verdict under every failure mode", async (t) => {
  const modes = ["block-tool", "warn-and-continue", "block-session"];
  const decisions = ["proceed", "revise", "blocked"];

  for (const mode of modes) {
    for (const decision of decisions) {
      await t.test(`${decision} with ${mode}`, async (t) => {
        const harness = await createHarness({
          advisorAutoLoopGate: true,
          advisorLoopThreshold: 2,
          gateFailureMode: mode,
        }, [`Decision: ${decision}\nSentinel gate rationale.`]);
        t.after(() => harness.fiber.dispose());
        const { agent, cancellations } = createAgent();

        const first = await executeTool(harness, agent, "probe", { value: "same" });
        assert.equal(first.isError, false);
        assert.equal(harness.adapter.requests.length, 0);

        const repeated = await executeTool(harness, agent, "probe", { value: "same" });
        const allowed = decision === "proceed"
          || (decision === "blocked" && mode === "warn-and-continue");
        assert.equal(repeated.isError, !allowed);
        assert.equal(harness.adapter.requests.length, 1);

        const sessionBlocked = decision === "blocked" && mode === "block-session";
        assert.equal(cancellations.length, sessionBlocked ? 1 : 0);
        if (sessionBlocked) {
          assert.deepEqual(cancellations[0].options, { keepInbox: true });
        }

        const followUp = await executeTool(harness, agent, "probe", { value: "different" });
        assert.equal(followUp.isError, sessionBlocked);
        assert.equal(harness.adapter.requests.length, 1);
      });
    }
  }
});

test("an unconfigured advisor fails only the advisor call", async (t) => {
  const harness = await createHarness({ advisor: "" }, []);
  t.after(() => harness.fiber.dispose());
  const { agent } = createAgent();

  assert.equal((await executeTool(harness, agent, "probe", { value: "same" })).isError, false);
  const result = await executeTool(harness, agent, "ask_advisor", {});
  // A refused consultation is a normal tool outcome so the Executor keeps working.
  assert.equal(result.isError, false);
  assert.match(String(result.value), /Advisor consultation failed/);
  assert.match(String(result.value), /Continue with your own judgement/);
  assert.equal(harness.adapter.requests.length, 0);
  assert.equal((await executeTool(harness, agent, "probe", { value: "other" })).isError, false);
});

test("session-start preserves compact state and resets on resume", async (t) => {
  const harness = await createHarness({
    advisorAutoLoopGate: true,
    advisorLoopThreshold: 2,
    advisorMaxCallsPerSession: 1,
    gateFailureMode: "block-session",
  }, ["Decision: blocked\nSentinel gate rationale.", "# Sentinel advice after resume"]);
  t.after(() => harness.fiber.dispose());
  const { agent } = createAgent();

  assert.equal((await executeTool(harness, agent, "probe", { value: "same" })).isError, false);
  assert.equal((await executeTool(harness, agent, "probe", { value: "same" })).isError, true);
  assert.equal((await executeTool(harness, agent, "probe", { value: "different" })).isError, true);

  await harness.ctx.emit("agent/session-start", { agent, source: "compact" });
  assert.equal((await executeTool(harness, agent, "probe", { value: "another" })).isError, true);
  assert.equal(harness.adapter.requests.length, 1);

  await harness.ctx.emit("agent/session-start", { agent, source: "resume" });
  const result = await executeTool(harness, agent, "ask_advisor", {});
  assert.equal(result.isError, false);
  assert.equal(harness.adapter.requests.length, 2);
});

test("a malformed repeated-call verdict fails closed without a parser matrix", async (t) => {
  const harness = await createHarness({
    advisorAutoLoopGate: true,
    advisorLoopThreshold: 2,
    gateFailureMode: "block-tool",
  }, ["Decision: maybe\nAmbiguous response."]);
  t.after(() => harness.fiber.dispose());
  const { agent, cancellations } = createAgent();

  assert.equal((await executeTool(harness, agent, "probe", { value: "same" })).isError, false);
  const result = await executeTool(harness, agent, "probe", { value: "same" });
  assert.equal(result.isError, true);
  assert.match(failureText(result), /must begin with Decision: proceed/);
  assert.equal(cancellations.length, 0);
  assert.equal(harness.adapter.requests.length, 1);
});

test("the consultation budget stops the Advisor while the Executor keeps working", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-integration-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const harness = await createHarness({
    advisorBudgetEnabled: true,
    advisorBudgetMaxCalls: 1,
    advisorLedgerPath: join(home, "ledger.json"),
  }, ["# First advice", "# Should never be reached"]);
  t.after(() => harness.fiber.dispose());
  const { agent } = createAgent();

  const first = await executeTool(harness, agent, "ask_advisor", {});
  assert.equal(first.isError, false);
  assert.match(String(first.value), /First advice/);
  assert.equal(harness.adapter.requests.length, 1);

  const second = await executeTool(harness, agent, "ask_advisor", {});
  assert.equal(second.isError, false, "a spent budget is not a tool failure");
  assert.match(String(second.value), /Advisor consultation budget reached/);
  assert.match(String(second.value), /Continue with your own judgement/);
  assert.equal(harness.adapter.requests.length, 1, "no second Advisor call is made");

  const work = await executeTool(harness, agent, "probe", { value: "continues" });
  assert.equal(work.isError, false, "Executor work is unaffected by the Advisor budget");
});

test("the loop gate never ends the session when the budget is spent", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-integration-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const harness = await createHarness({
    advisorAutoLoopGate: true,
    advisorBudgetEnabled: true,
    advisorBudgetMaxCalls: 0,
    advisorLedgerPath: join(home, "ledger.json"),
    advisorLoopThreshold: 2,
    gateFailureMode: "block-session",
  }, ["Decision: blocked\nSentinel gate rationale."]);
  t.after(() => harness.fiber.dispose());
  const { agent, cancellations } = createAgent();

  assert.equal((await executeTool(harness, agent, "probe", { value: "same" })).isError, false);
  const repeated = await executeTool(harness, agent, "probe", { value: "same" });
  assert.equal(repeated.isError, false, "the gate withdraws the Advisor instead of blocking");
  assert.equal(harness.adapter.requests.length, 0);
  assert.equal(cancellations.length, 0, "the session is not cancelled");
});

test("'ask before an extra consultation' asks the user and honours refusal", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-integration-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const harness = await createHarness({
    advisorBudgetEnabled: true,
    advisorBudgetLimitMode: "confirm",
    advisorBudgetMaxCalls: 0,
    advisorLedgerPath: join(home, "ledger.json"),
  }, ["# Never requested"]);
  t.after(() => harness.fiber.dispose());
  const { agent } = createAgent();

  const result = await executeTool(harness, agent, "ask_advisor", {});
  assert.equal(result.isError, false);
  assert.equal(harness.asked.length, 1, "the user is asked before spending past the budget");
  assert.match(harness.asked[0].questions[0].question, /Continue with one more Advisor consultation\?/);
  assert.match(String(result.value), /declined another consultation/);
  assert.equal(harness.adapter.requests.length, 0);
});

test("'ask before an extra consultation' proceeds when the user approves", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-integration-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const harness = await createHarness({
    advisorBudgetEnabled: true,
    advisorBudgetLimitMode: "confirm",
    advisorBudgetMaxCalls: 0,
    advisorLedgerPath: join(home, "ledger.json"),
  }, ["# Approved advice"], {
    answer: { answers: [{ id: "advisor-budget-overrun", selected: ["Continue consultation"] }] },
  });
  t.after(() => harness.fiber.dispose());
  const { agent } = createAgent();

  const result = await executeTool(harness, agent, "ask_advisor", {});
  assert.equal(result.isError, false);
  assert.match(String(result.value), /Approved advice/);
  assert.equal(harness.adapter.requests.length, 1);
  assert.equal(harness.asked.length, 1);
});

test("a priced Advisor call is recorded in the ledger the UI reads", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-integration-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const harness = await createHarness({
    advisorBudgetEnabled: true,
    advisorBudgetMaxUsd: 1,
    advisorLedgerPath: join(home, "ledger.json"),
    advisorPricing: { [`${PROVIDER}/advisor-model`]: { input: 0.000001, output: 0.000002 } },
  }, ["# Costed advice"], { usage: { inputTokens: 1000, outputTokens: 500 } });
  t.after(() => harness.fiber.dispose());
  const { agent } = createAgent();

  assert.equal((await executeTool(harness, agent, "ask_advisor", {})).isError, false);
  const ledger = JSON.parse(await readFile(join(home, "ledger.json"), "utf8"));
  const bucket = Object.values(ledger.sessions)[0];
  assert.equal(bucket.session.calls, 1);
  assert.equal(bucket.session.costMicro, 1000 * 0.000001 * 1e6 + 500 * 0.000002 * 1e6);
  assert.equal(bucket.session.unknownCostCalls, 0);
  assert.equal(bucket.history.length, 1);
  assert.equal(bucket.history[0].trigger, "executor-requested");
  assert.equal(bucket.history[0].costKnown, true);
});

test("the /advisor command family is available to the Settings page", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-integration-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const harness = await createHarness({
    advisorBudgetEnabled: true,
    advisorBudgetMaxUsd: 1,
    advisorLedgerPath: join(home, "ledger.json"),
  }, ["Advisor ready."]);
  t.after(() => harness.fiber.dispose());
  const { agent } = createAgent();

  assert.deepEqual([...harness.commands.registered.keys()].sort(), [
    "advisor",
    "advisor-budget",
    "advisor-history",
    "advisor-log",
    "advisor-test",
  ]);
  const status = await harness.commands.registered.get("advisor").handler({ agent, rawInput: "status" });
  assert.equal(status.kind, "success");
  assert.match(status.text, /Advisor Settings payload/);
  const test = await harness.commands.registered.get("advisor-test").handler({ agent });
  assert.equal(test.kind, "success");
  assert.match(test.text, /Advisor connection: OK/);
  assert.equal(harness.adapter.requests.length, 1, "the connection test uses the real provider route");

  const written = await harness.commands.registered.get("advisor").handler({ agent, rawInput: "off" });
  assert.equal(written.kind, "success");
  assert.deepEqual(harness.settingsWrites, [["dsh-advisor", { advisorEnabled: false }]]);
});

test("an Advisor provider error is reported as a tool outcome, not a session stop", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-integration-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const harness = await createHarness({
    advisorBudgetEnabled: true,
    advisorBudgetMaxUsd: 1,
    advisorLedgerPath: join(home, "ledger.json"),
  }, []);
  t.after(() => harness.fiber.dispose());
  const { agent } = createAgent();

  const result = await executeTool(harness, agent, "ask_advisor", {});
  assert.equal(result.isError, false);
  assert.match(String(result.value), /Advisor consultation failed/);
  assert.match(String(result.value), /Continue with your own judgement/);
  const ledger = JSON.parse(await readFile(join(home, "ledger.json"), "utf8"));
  const bucket = Object.values(ledger.sessions)[0];
  assert.equal(bucket.session.failedCalls, 1, "the failed call is still recorded");
  assert.equal(bucket.history[0].outcome, "failed");
});
