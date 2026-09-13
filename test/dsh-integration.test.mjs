import assert from "node:assert/strict";
import test from "node:test";
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
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

function createAgent(messages = []) {
  const cancellations = [];
  const agent = {
    status: "running",
    session: {
      id: "sentinel-session",
      header: { cwd: "" },
      deriveMessages: () => messages,
    },
    cancel(reason, options) {
      cancellations.push({ reason, options });
    },
  };
  return { agent, cancellations };
}

async function createHarness(config = {}, responses = []) {
  const ctx = new Context();
  const systemPrompt = new SystemPrompt(ctx, {});
  const llm = new LlmRuntime(ctx);
  const tools = new ToolRuntime(ctx);
  const adapter = new ScriptedAdapter(responses);
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
  return { adapter, ctx, fiber, llm, systemPrompt, tools };
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
  assert.equal(result.isError, true);
  assert.match(failureText(result), /Advisor model is not configured/);
  assert.equal(harness.adapter.requests.length, 0);
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
