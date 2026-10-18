import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdvisorBudgetLedger,
  evaluateBudget,
  resolveBudgetPlan,
} from "../dsh/advisor-budget.js";
import { estimateCostMicro, formatUsd, reserveCostMicro } from "../dsh/advisor-cost.js";

const PRICING = { input: 0.000002, output: 0.00001, cacheRead: 0.0000002 };

function plan(overrides = {}) {
  return resolveBudgetPlan({
    advisorBudgetEnabled: true,
    advisorBudgetLimitMode: "stop-advisor",
    advisorBudgetMaxCalls: -1,
    advisorBudgetMaxUsd: 0,
    advisorBudgetScope: "session",
    advisorBudgetUnknownCost: "allow",
    ...overrides,
  });
}

async function withLedger(run, options = {}) {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-budget-"));
  try {
    const ledger = new AdvisorBudgetLedger({
      historyLimit: 50,
      instanceId: "test-instance",
      now: options.now,
      path: join(home, "ledger.json"),
    });
    await run(ledger, home);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}

test("cost estimation prices every token class and honours cache rates", () => {
  const micro = estimateCostMicro(
    { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 10000, cacheWriteTokens: 0 },
    PRICING,
  );
  assert.equal(micro, 1000 * 0.000002 * 1e6 + 500 * 0.00001 * 1e6 + 10000 * 0.0000002 * 1e6);
  assert.equal(formatUsd(micro), "$0.0090");
});

test("cost estimation never invents a price for an unpriced model", () => {
  assert.equal(estimateCostMicro({ inputTokens: 1000, outputTokens: 10 }, undefined), undefined);
  assert.equal(estimateCostMicro({ inputTokens: 1000, outputTokens: 10 }, { input: 0.000001 }), undefined);
  assert.equal(estimateCostMicro({ inputTokens: 0, outputTokens: 0 }, { input: 0.000001 }), 0);
});

test("reservation uses the ceiling the user configured, not a guess", () => {
  assert.equal(reserveCostMicro(PRICING, { inputTokens: 1000, maxOutputTokens: 100 }), 1000 * 0.000002 * 1e6 + 100 * 0.00001 * 1e6);
  assert.equal(reserveCostMicro({ input: 0.000002 }, { inputTokens: 1000, maxOutputTokens: 100 }), undefined);
});

test("a call ceiling stops consultations without stopping anything else", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetMaxCalls: 2 });
    const identity = { projectKey: "/work/demo", sessionId: "s1" };

    for (let index = 0; index < 2; index += 1) {
      const reserved = await ledger.reserve(budget, identity, { costMicro: 0 });
      assert.equal(reserved.ok, true);
      await ledger.settle(reserved.reservation, { costMicro: 10, identity, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });
    }
    const refused = await ledger.reserve(budget, identity, { costMicro: 0 });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /2 of 2 consultations/);
    assert.equal(refused.standing.blockedByCalls, true);
  });
});

test("concurrent reservations cannot overshoot a cash ceiling", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetMaxUsd: 0.06 });
    const identity = { projectKey: "/work/demo", sessionId: "s1" };
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => ledger.reserve(budget, identity, { costMicro: 20000 })),
    );
    const granted = attempts.filter((attempt) => attempt.ok);
    assert.equal(granted.length, 3, "only the reservations that fit the ceiling are granted");
    const summary = await ledger.summary(budget, identity);
    assert.equal(summary.counter.reservedCalls, 3);
    assert.equal(summary.counter.reservedMicro, 60000);
    assert.equal(summary.standing.blocked, true);
  });
});

test("an exact ceiling is only claimed while every call is priced", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetMaxUsd: 1 });
    const identity = { projectKey: "/work/demo", sessionId: "s1" };
    const first = await ledger.reserve(budget, identity, { costMicro: undefined });
    await ledger.settle(first.reservation, { costMicro: undefined, identity, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });
    const summary = await ledger.summary(budget, identity);
    assert.equal(summary.standing.exact, false);
    assert.equal(summary.standing.unknownCostCalls, 1);

    const stopUnknown = plan({ advisorBudgetMaxUsd: 1, advisorBudgetUnknownCost: "stop-advisor" });
    const summaryStop = await ledger.summary(stopUnknown, identity);
    assert.equal(summaryStop.standing.blockedByUnknownCost, true);
  });
});

test("project scope shares one budget across concurrent sessions", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetMaxCalls: 2, advisorBudgetScope: "project" });
    const first = { projectKey: "/work/demo", sessionId: "session-a" };
    const second = { projectKey: "/work/demo", sessionId: "session-b" };
    const other = { projectKey: "/work/other", sessionId: "session-c" };

    const a = await ledger.reserve(budget, first, { costMicro: 0 });
    const b = await ledger.reserve(budget, second, { costMicro: 0 });
    assert.equal(a.ok && b.ok, true);
    await ledger.settle(a.reservation, { costMicro: 0, identity: first, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });
    await ledger.settle(b.reservation, { costMicro: 0, identity: second, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });

    assert.equal((await ledger.reserve(budget, second, { costMicro: 0 })).ok, false);
    assert.equal((await ledger.reserve(budget, other, { costMicro: 0 })).ok, true, "another project keeps its own budget");
  });
});

test("session scope keeps two sessions independent", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetMaxCalls: 1 });
    const first = { projectKey: "/work/demo", sessionId: "session-a" };
    const second = { projectKey: "/work/demo", sessionId: "session-b" };
    const a = await ledger.reserve(budget, first, { costMicro: 0 });
    await ledger.settle(a.reservation, { costMicro: 0, identity: first, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });
    assert.equal((await ledger.reserve(budget, first, { costMicro: 0 })).ok, false);
    assert.equal((await ledger.reserve(budget, second, { costMicro: 0 })).ok, true);
  });
});

test("the ledger survives a restart and keeps counting", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-budget-"));
  const path = join(home, "ledger.json");
  const budget = plan({ advisorBudgetMaxCalls: 2 });
  const identity = { projectKey: "/work/demo", sessionId: "s1" };
  try {
    const first = new AdvisorBudgetLedger({ path });
    const reserved = await first.reserve(budget, identity, { costMicro: 0 });
    await first.settle(reserved.reservation, { costMicro: 42, identity, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });

    const second = new AdvisorBudgetLedger({ path });
    const summary = await second.summary(budget, identity);
    assert.equal(summary.counter.calls, 1);
    assert.equal(summary.counter.costMicro, 42);
    const next = await second.reserve(budget, identity, { costMicro: 0 });
    assert.equal(next.ok, true);
    const history = await second.history(budget, identity, 5);
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].costMicro, 42);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("two ledger instances in one process share one document", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-advisor-budget-"));
  const path = join(home, "ledger.json");
  const budget = plan({ advisorBudgetMaxCalls: 2 });
  const identity = { projectKey: "/work/demo", sessionId: "s1" };
  try {
    const first = new AdvisorBudgetLedger({ path, instanceId: "a" });
    const second = new AdvisorBudgetLedger({ path, instanceId: "b" });
    const one = await first.reserve(budget, identity, { costMicro: 0 });
    const two = await second.reserve(budget, identity, { costMicro: 0 });
    assert.equal(one.ok && two.ok, true);
    await first.settle(one.reservation, { costMicro: 0, identity, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });
    await second.settle(two.reservation, { costMicro: 0, identity, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });
    assert.equal((await first.reserve(budget, identity, { costMicro: 0 })).ok, false);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test("a disabled budget never blocks and never charges the cash ceiling", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetEnabled: false, advisorBudgetMaxCalls: 1, advisorBudgetMaxUsd: 0.000001 });
    assert.equal(budget.maxCallMicro, 1, "the configured ceiling is retained even while the budget is off");
    assert.equal(budget.maxCalls, 1);
    const identity = { projectKey: "/work/demo", sessionId: "s1" };
    for (let index = 0; index < 5; index += 1) {
      const reserved = await ledger.reserve(budget, identity, { costMicro: 500 });
      assert.equal(reserved.ok, true);
      await ledger.settle(reserved.reservation, { costMicro: 999999, identity, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });
    }
    const summary = await ledger.summary(budget, identity);
    assert.equal(summary.standing.blocked, false);
    assert.equal(summary.standing.costRemainingMicro, undefined);
    assert.equal(summary.counter.calls, 5);
    assert.equal(summary.counter.costMicro, 5 * 999999);
    assert.equal(summary.counter.reservedCalls, 0);
    assert.equal(summary.counter.reservedMicro, 0);
    assert.equal(summary.plan.maxCallMicro, 1, "the reported plan still shows the configured ceiling");
  });
});

test("failures consume a consultation and are recorded", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetMaxCalls: 3 });
    const identity = { projectKey: "/work/demo", sessionId: "s1" };
    const reserved = await ledger.reserve(budget, identity, { costMicro: 500 });
    await ledger.settle(reserved.reservation, { costMicro: undefined, identity, model: "p/m", outcome: "failed", plan: budget, trigger: "repeated-tool-call" });
    const summary = await ledger.summary(budget, identity);
    assert.equal(summary.counter.calls, 1);
    assert.equal(summary.counter.failedCalls, 1);
    assert.equal(summary.counter.reservedMicro, 0);
    assert.equal(summary.standing.exact, false);
  });
});

test("releasing an abandoned reservation returns the held slot and cost", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetMaxCalls: 1, advisorBudgetMaxUsd: 1 });
    const identity = { projectKey: "/work/demo", sessionId: "s1" };
    const reserved = await ledger.reserve(budget, identity, { costMicro: 5000 });
    assert.equal(reserved.ok, true);
    await ledger.release(reserved.reservation, { identity, plan: budget });
    const summary = await ledger.summary(budget, identity);
    assert.equal(summary.counter.reservedCalls, 0);
    assert.equal(summary.counter.reservedMicro, 0);
    assert.equal((await ledger.reserve(budget, identity, { costMicro: 5000 })).ok, true);
  });
});

test("reset clears only the addressed scope", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetScope: "project" });
    const identity = { projectKey: "/work/demo", sessionId: "s1" };
    const reserved = await ledger.reserve(budget, identity, { costMicro: 100 });
    await ledger.settle(reserved.reservation, { costMicro: 100, identity, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });
    await ledger.reset("session", identity);
    assert.equal((await ledger.summary(budget, identity)).counter.calls, 1, "project scope survives a session reset");
    await ledger.reset("project", identity);
    assert.equal((await ledger.summary(budget, identity)).counter.calls, 0);
  });
});

test("warning ratio is reported at the configured threshold", async () => {
  await withLedger(async (ledger) => {
    const budget = plan({ advisorBudgetMaxUsd: 0.001 });
    const identity = { projectKey: "/work/demo", sessionId: "s1" };
    const reserved = await ledger.reserve(budget, identity, { costMicro: 800 });
    await ledger.settle(reserved.reservation, { costMicro: 800, identity, model: "p/m", outcome: "success", plan: budget, trigger: "executor-requested" });
    const summary = await ledger.summary(budget, identity);
    assert.equal(summary.standing.warn, true);
    assert.equal(summary.standing.exact, true);
  });
});

test("evaluateBudget reports an unbounded plan without invented limits", () => {
  const unbounded = evaluateBudget(
    { calls: 3, costMicro: 5, failedCalls: 0, lastAt: 0, lastModel: "", lastOutcome: "", reservedCalls: 0, reservedMicro: 0, unknownCostCalls: 0 },
    plan(),
  );
  assert.equal(unbounded.blocked, false);
  assert.equal(unbounded.callsRemaining, undefined);
  assert.equal(unbounded.costRemainingMicro, undefined);
  assert.equal(unbounded.warn, false);
});
