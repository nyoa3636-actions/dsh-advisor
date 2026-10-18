import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdvisorStore, gitRootOf, normalizeProjectPath, projectKeyFor } from "../dsh/advisor-store.js";
import { ledgerPathFor } from "../dsh/advisor-budget.js";
import { approximateInputTokens, buildAdvisorRequest } from "../dsh/advisor-request.js";
import { normalizeConfig } from "../dsh/config.js";

function agentFor(cwd, id = "session-a") {
  return { session: { header: { cwd }, id }, status: "running" };
}

test("session identity is stable and independent of the workspace", () => {
  const config = normalizeConfig({});
  const first = AdvisorStore.identity(agentFor("C:/work/demo"), config);
  const second = AdvisorStore.identity(agentFor("C:/work/demo"), config);
  assert.deepEqual(first, second);
  assert.equal(first.sessionId, "session-a");
  assert.equal(first.projectKey, normalizeProjectPath("C:/work/demo"));
});

test("an explicit project key overrides workspace detection", () => {
  const config = normalizeConfig({ advisorProjectKey: "my-project" });
  assert.equal(projectKeyFor(agentFor("C:/work/demo"), config), "my-project");
});

test("the git work tree root becomes the project identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-advisor-project-"));
  try {
    const nested = join(root, "packages", "app");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    assert.equal(normalizeProjectPath(gitRootOf(nested)), normalizeProjectPath(root));
    const config = normalizeConfig({});
    assert.equal(projectKeyFor(agentFor(nested), config), normalizeProjectPath(root));
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a session without a workspace still gets a deterministic project key", () => {
  const config = normalizeConfig({});
  assert.equal(projectKeyFor(agentFor(""), config), "unknown-project");
  assert.equal(projectKeyFor(undefined, config), "unknown-project");
});

test("the ledger path defaults under the harness home and honours an override", () => {
  assert.equal(ledgerPathFor("C:/dsh-home", ""), join("C:/dsh-home", "dsh-advisor", "budget-ledger.json"));
  assert.equal(ledgerPathFor("C:/dsh-home", "D:/custom/ledger.json"), "D:/dsh-home".replace("D:/dsh-home", "D:/custom/ledger.json"));
  assert.equal(ledgerPathFor("", ""), "");
});

test("the store reserves, settles, and reports one consultation", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-store-"));
  try {
    const store = new AdvisorStore({ home });
    const config = normalizeConfig({
      advisor: "provider/model",
      advisorBudgetEnabled: true,
      advisorBudgetMaxCalls: 2,
      advisorBudgetMaxUsd: 0.5,
      advisorPricing: { "provider/model": { input: 0.000001, output: 0.000002 } },
    });
    store.configure(config);
    const identity = AdvisorStore.identity(agentFor(""), config);

    const reserved = await store.reserve(config, identity, { modelRef: config.advisor });
    assert.equal(reserved.ok, true);
    assert.equal(reserved.plan.maxCalls, 2);
    const settled = await store.settle(config, identity, reserved, {
      model: "provider/model",
      outcome: "success",
      trigger: "executor-requested",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    assert.equal(settled.costMicro, Math.round(100 * 0.000001 * 1e6 + 50 * 0.000002 * 1e6));
    const summary = await store.summary(config, identity);
    assert.equal(summary.counter.calls, 1);
    assert.equal(summary.standing.callsRemaining, 1);
    assert.equal(summary.standing.exact, true);

    const history = await store.history(config, identity, 5);
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].trigger, "executor-requested");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("the store keeps a shared budget across two sessions in one process", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-store-"));
  try {
    const config = normalizeConfig({
      advisor: "provider/model",
      advisorBudgetEnabled: true,
      advisorBudgetMaxCalls: 1,
      advisorBudgetScope: "project",
    });
    const first = new AdvisorStore({ home });
    const second = new AdvisorStore({ home });
    first.configure(config);
    second.configure(config);
    const workspace = join(home, "project");
    await mkdir(workspace, { recursive: true });
    const a = AdvisorStore.identity(agentFor(workspace, "session-a"), config);
    const b = AdvisorStore.identity(agentFor(workspace, "session-b"), config);
    assert.equal(a.projectKey, b.projectKey);

    const reserved = await first.reserve(config, a, { modelRef: config.advisor });
    await first.settle(config, a, reserved, { model: config.advisor, outcome: "success", trigger: "executor-requested", usage: { inputTokens: 1, outputTokens: 1 } });
    const refused = await second.reserve(config, b, { modelRef: config.advisor });
    assert.equal(refused.ok, false, "the second session sees the shared project budget");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("the store reports an unknown model price instead of inventing one", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-store-"));
  try {
    const config = normalizeConfig({ advisor: "provider/unpriced", advisorBudgetEnabled: true, advisorBudgetMaxUsd: 1 });
    const store = new AdvisorStore({ home });
    store.configure(config);
    const identity = AdvisorStore.identity(agentFor(""), config);
    const reserved = await store.reserve(config, identity, { modelRef: config.advisor });
    assert.equal(reserved.ok, true);
    const settled = await store.settle(config, identity, reserved, {
      model: config.advisor,
      outcome: "success",
      trigger: "executor-requested",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    assert.equal(settled.costMicro, undefined);
    const summary = await store.summary(config, identity);
    assert.equal(summary.standing.exact, false);
    assert.equal(summary.standing.unknownCostCalls, 1);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("the request builder returns the Advisor system prompt and message text", () => {
  const messages = [{
    content: [{ text: "hello", type: "text" }],
    role: "user",
    source: { kind: "user" },
  }];
  const agent = { session: { deriveMessages: () => messages, header: { cwd: "" }, id: "s" } };
  const config = normalizeConfig({ advisorGitContext: "off" });
  const normal = buildAdvisorRequest(agent, config, { question: "focus" });
  assert.match(normal.call.system, /You are the Advisor/);
  assert.match(normal.call.userText, /<conversation>\nUser: hello/);
  assert.match(normal.call.userText, /Targeted focus:\nfocus/);
  assert.equal(normal.call.decision, false);

  const gate = buildAdvisorRequest(agent, config, { decision: true });
  assert.match(gate.call.system, /automatic safety gate/);
  assert.equal(gate.call.decision, true);
});

test("input tokens are approximated from the assembled prompt", () => {
  assert.equal(approximateInputTokens("abcd"), 1);
  assert.equal(approximateInputTokens("a".repeat(400)), 100);
  assert.equal(approximateInputTokens(undefined), 1);
});

test("usage from a failed call still records tokens without inventing a price", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-store-"));
  try {
    const config = normalizeConfig({
      advisor: "provider/model",
      advisorBudgetEnabled: true,
      advisorBudgetMaxUsd: 1,
      advisorPricing: { "provider/model": { input: 0.000001, output: 0.000002 } },
    });
    const store = new AdvisorStore({ home });
    store.configure(config);
    const identity = AdvisorStore.identity(agentFor(""), config);
    const reserved = await store.reserve(config, identity, { modelRef: config.advisor });
    await store.settle(config, identity, reserved, {
      model: config.advisor,
      outcome: "failed",
      trigger: "repeated-tool-call",
      usage: { inputTokens: 40, outputTokens: 0 },
    });
    const summary = await store.summary(config, identity);
    assert.equal(summary.counter.failedCalls, 1);
    assert.equal(summary.standing.exact, true);
    assert.equal(summary.standing.settledMicro, 40 * 0.000001 * 1e6);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("the ledger file is created next to the harness home", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-store-"));
  try {
    const config = normalizeConfig({ advisor: "provider/model" });
    const store = new AdvisorStore({ home, ledgerPath: join(home, "custom.json") });
    store.configure(config);
    const identity = AdvisorStore.identity(agentFor(""), config);
    const reserved = await store.reserve(config, identity, { modelRef: config.advisor });
    await store.settle(config, identity, reserved, { model: config.advisor, outcome: "success", trigger: "executor-requested", usage: null });
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(join(home, "custom.json"), "utf8"));
    assert.match(raw, /"sessions"/);
    await writeFile(join(home, "sentinel.txt"), "ok", "utf8");
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});
