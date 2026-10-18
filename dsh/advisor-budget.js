import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { formatUsd, microFromUsd, usdFromMicro } from "./advisor-cost.js";

export const BUDGET_SCOPES = ["session", "project"];
export const BUDGET_LIMIT_MODES = ["stop-advisor", "confirm"];
export const UNKNOWN_COST_MODES = ["allow", "count-only", "stop-advisor"];
export const LEDGER_VERSION = 1;
export const WARN_THRESHOLD = 0.8;

export function resolveBudgetScope(config) {
  return config.advisorBudgetScope === "project" ? "project" : "session";
}

export function resolveBudgetPlan(config) {
  const maxUsd = Number.isFinite(config.advisorBudgetMaxUsd) && config.advisorBudgetMaxUsd > 0
    ? config.advisorBudgetMaxUsd
    : undefined;
  return {
    enabled: config.advisorBudgetEnabled === true,
    limitMode: BUDGET_LIMIT_MODES.includes(config.advisorBudgetLimitMode)
      ? config.advisorBudgetLimitMode
      : "stop-advisor",
    maxCallMicro: maxUsd === undefined ? undefined : microFromUsd(maxUsd),
    maxCalls: Number.isSafeInteger(config.advisorBudgetMaxCalls) && config.advisorBudgetMaxCalls >= 0
      ? config.advisorBudgetMaxCalls
      : undefined,
    scope: resolveBudgetScope(config),
    unknownCost: UNKNOWN_COST_MODES.includes(config.advisorBudgetUnknownCost)
      ? config.advisorBudgetUnknownCost
      : "allow",
    warnAt: WARN_THRESHOLD,
  };
}

function emptyCounter() {
  return {
    calls: 0,
    costMicro: 0,
    knownCostCalls: 0,
    reservedCalls: 0,
    reservedMicro: 0,
    failedCalls: 0,
    lastAt: 0,
    lastModel: "",
    lastOutcome: "",
    unknownCostCalls: 0,
  };
}

function normalizeCounter(value) {
  const base = emptyCounter();
  if (!value || typeof value !== "object") return base;
  const counter = { ...base };
  for (const key of Object.keys(base)) {
    if (typeof base[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0) counter[key] = value[key];
    else if (typeof base[key] === "string" && typeof value[key] === "string") counter[key] = value[key];
  }
  return counter;
}

function normalizeBucket(value, seed) {
  const bucket = {
    createdAt: typeof value?.createdAt === "number" ? value.createdAt : seed,
    updatedAt: typeof value?.updatedAt === "number" ? value.updatedAt : seed,
    history: Array.isArray(value?.history) ? value.history.filter((entry) => entry && typeof entry === "object").slice(-500) : [],
  };
  for (const key of ["session", "project"]) bucket[key] = normalizeCounter(value?.[key]);
  return bucket;
}

export function emptyLedger(seed = Date.now()) {
  return { version: LEDGER_VERSION, sessions: {}, projects: {}, updatedAt: seed };
}

export function normalizeLedger(value, seed = Date.now()) {
  const ledger = emptyLedger(seed);
  const sessions = value?.sessions && typeof value.sessions === "object" ? value.sessions : {};
  const projects = value?.projects && typeof value.projects === "object" ? value.projects : {};
  for (const [key, entry] of Object.entries(sessions)) {
    if (key) ledger.sessions[key] = normalizeBucket(entry, seed);
  }
  for (const [key, entry] of Object.entries(projects)) {
    if (key) ledger.projects[key] = normalizeBucket(entry, seed);
  }
  ledger.updatedAt = typeof value?.updatedAt === "number" ? value.updatedAt : seed;
  return ledger;
}

function pruneBucket(bucket, historyLimit) {
  if (bucket.history.length > historyLimit) bucket.history = bucket.history.slice(-historyLimit);
  return bucket;
}

function pruneLedger(ledger, historyLimit, maxBuckets = 100) {
  for (const collection of [ledger.sessions, ledger.projects]) {
    const keys = Object.keys(collection);
    if (keys.length > maxBuckets) {
      keys
        .sort((left, right) => (collection[left]?.updatedAt ?? 0) - (collection[right]?.updatedAt ?? 0))
        .slice(0, keys.length - maxBuckets)
        .forEach((key) => delete collection[key]);
    }
    for (const key of Object.keys(collection)) pruneBucket(collection[key], historyLimit);
  }
  return ledger;
}

export function idleCounter(counter) {
  return counter.calls === 0 && counter.reservedCalls === 0 && counter.costMicro === 0 && counter.reservedMicro === 0;
}

/** Compute the current standing of one scope against its plan. */
export function evaluateBudget(counter, plan) {
  const settledMicro = counter.costMicro;
  const committedMicro = settledMicro + counter.reservedMicro;
  const settledCalls = counter.calls;
  const committedCalls = settledCalls + counter.reservedCalls;
  const enforced = plan.enabled === true;
  const costLimited = enforced && plan.maxCallMicro !== undefined;
  const callLimited = enforced && plan.maxCalls !== undefined;
  const costRemainingMicro = costLimited ? Math.max(0, plan.maxCallMicro - committedMicro) : undefined;
  const callsRemaining = callLimited ? Math.max(0, plan.maxCalls - committedCalls) : undefined;
  const costRatio = costLimited && plan.maxCallMicro > 0 ? committedMicro / plan.maxCallMicro : 0;
  const callRatio = callLimited && plan.maxCalls > 0 ? committedCalls / plan.maxCalls : 0;
  const ratio = Math.max(costRatio, callRatio);
  const overCost = costLimited && committedMicro >= plan.maxCallMicro;
  const overCalls = callLimited && committedCalls >= plan.maxCalls;
  const enoughPriceData = counter.unknownCostCalls === 0;
  const unknownStop = enforced && plan.unknownCost === "stop-advisor";
  // A cash ceiling is only an exact limit while every settled call carries a price.
  const exact = enoughPriceData;
  return {
    blocked: overCost || overCalls || (unknownStop && !enoughPriceData),
    blockedByCost: overCost,
    blockedByCalls: overCalls,
    blockedByUnknownCost: unknownStop && !enoughPriceData,
    callRatio,
    callsRemaining,
    committedCalls,
    committedMicro,
    costRatio,
    costRemainingMicro,
    exact,
    ratio,
    settledCalls,
    settledMicro,
    unknownCostCalls: counter.unknownCostCalls,
    warn: plan.enabled && ratio >= plan.warnAt,
  };
}

function publicCounter(counter, plan) {
  const standing = evaluateBudget(counter, plan);
  return {
    calls: counter.calls,
    costMicro: counter.costMicro,
    costUsd: usdFromMicro(counter.costMicro),
    reservedCalls: counter.reservedCalls,
    reservedMicro: counter.reservedMicro,
    failedCalls: counter.failedCalls,
    lastAt: counter.lastAt || undefined,
    lastModel: counter.lastModel || undefined,
    lastOutcome: counter.lastOutcome || undefined,
    unknownCostCalls: counter.unknownCostCalls,
    ...standing,
    limitMicro: plan.maxCallMicro,
    limitUsd: plan.maxCallMicro === undefined ? undefined : usdFromMicro(plan.maxCallMicro),
    maxCalls: plan.maxCalls,
  };
}

/**
 * Cross-session Advisor budget ledger.
 *
 * The ledger is the durable projection of Advisor spending. Every mutation runs
 * through one per-instance promise chain, and reads the file fresh inside the
 * chain, so concurrent sessions in one process can never double-count a call.
 * Mirrored hosts additionally guard the read-modify-write window with a file
 * lock. A cash ceiling is reported as exact only while every settled call was
 * priced.
 */
export class AdvisorBudgetLedger {
  constructor(options = {}) {
    this.path = options.path ?? "";
    this.historyLimit = Number.isSafeInteger(options.historyLimit) ? options.historyLimit : 200;
    this.now = options.now ?? (() => Date.now());
    this.instanceId = options.instanceId ?? randomUUID();
    this.ledger = emptyLedger(this.now());
    this.loaded = false;
    this.queue = Promise.resolve();
  }

  setPath(path) {
    this.path = path ?? "";
  }

  bucketKey(scope, { sessionId, projectKey }) {
    return scope === "project"
      ? `project:${projectKey ?? "unknown"}`
      : `session:${sessionId ?? "unknown"}`;
  }

  /** Read the durable document once; a missing or unreadable file starts empty. */
  async load() {
    if (this.loaded) return this.ledger;
    this.loaded = true;
    if (!this.path) return this.ledger;
    try {
      const text = await readFile(this.path, "utf8");
      this.ledger = normalizeLedger(JSON.parse(text), this.now());
    } catch {
      this.ledger = emptyLedger(this.now());
    }
    return this.ledger;
  }

  async persist() {
    if (!this.path) return;
    const text = `${JSON.stringify(this.ledger)}\n`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.${this.instanceId.slice(0, 8)}.tmp`;
      await writeFile(temp, text, "utf8");
      await rename(temp, this.path);
    } catch {
      // A failed projection keeps in-memory accounting authoritative for this process.
    }
  }

  /**
   * Run one synchronous mutation over the freshest durable state, then persist.
   * Reads inside the chain pick up another writer's committed changes.
   */
  transact(mutate) {
    const run = async () => {
      await this.load();
      if (this.path) {
        try {
          const text = await readFile(this.path, "utf8");
          const onDisk = normalizeLedger(JSON.parse(text), this.now());
          if (onDisk.updatedAt > (this.ledger.updatedAt ?? 0)) this.ledger = onDisk;
        } catch {
          // Keep the in-memory state when the document is absent or unreadable.
        }
      }
      const result = mutate(this.ledger);
      this.ledger.updatedAt = this.now();
      pruneLedger(this.ledger, this.historyLimit);
      await this.persist();
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  bucket(scope, identity) {
    const collection = scope === "project" ? this.ledger.projects : this.ledger.sessions;
    const key = this.bucketKey(scope, identity);
    collection[key] ??= normalizeBucket(undefined, this.now());
    return { bucket: collection[key], key };
  }

  touch(bucket) {
    bucket.updatedAt = this.now();
  }

  /**
   * Reserve one Advisor call against the scope before the provider answers.
   * The returned handle records how much of the ceiling it actually took, so
   * concurrent reservations settle and release exactly once.
   * @returns a reservation handle, or a refusal describing the exhausted limit.
   */
  async reserve(plan, identity, request = {}) {
    const handle = {
      appliedCall: false,
      appliedMicro: 0,
      costMicro: request.costMicro ?? 0,
      scope: plan.scope,
      standalone: false,
    };
    return this.transact(() => {
      const { bucket, key } = this.bucket(plan.scope, identity);
      const counter = bucket[plan.scope];
      handle.key = key;
      if (!plan.enabled) {
        // The configured ceilings stay visible in the ledger; only enforcement is off.
        counter.reservedCalls += 1;
        handle.appliedCall = true;
        handle.costMicro = 0;
        handle.standalone = true;
        this.touch(bucket);
        return { ok: true, reservation: handle };
      }
      const standing = evaluateBudget(counter, plan);
      if (standing.blockedByCost || standing.blockedByCalls) {
        return {
          ok: false,
          reason: standing.blockedByCalls
            ? `Advisor consultation budget reached: ${counter.calls} of ${plan.maxCalls} consultations used.`
            : `Advisor consultation budget reached: ${formatUsd(counter.costMicro)} of ${formatUsd(plan.maxCallMicro)} used.`,
          standing,
        };
      }
      if (standing.blockedByUnknownCost) {
        return {
          ok: false,
          reason: "Advisor spending cannot be bounded: a previous consultation had no known price.",
          standing,
        };
      }
      const requested = request.costMicro ?? 0;
      const available = plan.maxCallMicro - counter.costMicro - counter.reservedMicro;
      if (requested > available) {
        return {
          ok: false,
          reason: `Advisor consultation budget cannot cover the next call (estimated ${formatUsd(requested)}, ${formatUsd(Math.max(0, available))} available).`,
          standing,
        };
      }
      counter.reservedCalls += 1;
      handle.appliedCall = true;
      if (plan.enabled && plan.maxCallMicro !== undefined) {
        counter.reservedMicro += request.costMicro ?? 0;
        handle.appliedMicro = request.costMicro ?? 0;
      } else {
        handle.costMicro = 0;
      }
      this.touch(bucket);
      return { ok: true, reservation: handle };
    });
  }

  /** Release a reservation whose call never produced usage. */
  async release(reservation, { countAsCall = false, failure = false, identity = {} } = {}) {
    if (!reservation) return;
    return this.transact(() => {
      const scope = reservation.scope ?? "session";
      const { bucket } = this.bucket(scope, identity);
      const counter = bucket[scope];
      counter.reservedCalls = Math.max(0, counter.reservedCalls - (reservation.appliedCall ? 1 : 0));
      counter.reservedMicro = Math.max(0, counter.reservedMicro - (reservation.appliedMicro ?? 0));
      if (countAsCall) {
        counter.calls += 1;
        if (failure) counter.failedCalls += 1;
        counter.lastAt = this.now();
        counter.lastOutcome = failure ? "failed" : "unknown";
      }
      this.touch(bucket);
    });
  }

  /**
   * Settle one reserved call with its observed usage and cost.
   * `costMicro` undefined means the price is unknown for that model.
   */
  async settle(reservation, { costMicro, identity = {}, plan, model, outcome, usage, trigger, question }) {
    const resolvedPlan = plan ?? { scope: "session" };
    const scope = reservation?.scope ?? resolvedPlan.scope;
    return this.transact(() => {
      const { bucket, key } = this.bucket(scope, identity);
      const counter = bucket[scope];
      counter.reservedCalls = Math.max(0, counter.reservedCalls - (reservation?.appliedCall ? 1 : 0));
      counter.reservedMicro = Math.max(0, counter.reservedMicro - (reservation?.appliedMicro ?? 0));
      counter.calls += 1;
      if (outcome === "failed") counter.failedCalls += 1;
      if (costMicro === undefined) counter.unknownCostCalls += 1;
      else {
        counter.costMicro += costMicro;
        counter.knownCostCalls += 1;
      }
      counter.lastAt = this.now();
      counter.lastModel = model ?? "";
      counter.lastOutcome = outcome ?? "";
      bucket.history.push({
        at: counter.lastAt,
        costKnown: costMicro !== undefined,
        costMicro: costMicro ?? null,
        id: randomUUID(),
        model: model ?? "",
        outcome: outcome ?? "unknown",
        question: question ? String(question).slice(0, 240) : undefined,
        trigger: trigger ?? "unknown",
        usage: usage ?? null,
      });
      this.touch(bucket);
      return { key, counter: publicCounter(counter, resolvedPlan) };
    });
  }

  /** Record an Advisor call whose token usage never arrived (provider error). */
  async recordFailure(reservation, { identity = {}, plan, model, trigger, question }) {
    return this.settle(reservation, {
      costMicro: undefined,
      identity,
      model,
      outcome: "failed",
      plan,
      question,
      trigger,
      usage: null,
    });
  }

  async summary(plan, identity) {
    await this.load();
    const { bucket, key } = this.bucket(plan.scope, identity);
    return { bucket: key, counter: bucket[plan.scope], standing: publicCounter(bucket[plan.scope], plan), plan };
  }

  async history(plan, identity, limit = 25) {
    await this.load();
    const { bucket, key } = this.bucket(plan.scope, identity);
    const entries = bucket.history.slice(-Math.max(1, Math.min(200, limit))).reverse();
    return { bucket: key, entries };
  }

  async reset(scope, identity) {
    return this.transact((ledger) => {
      const collection = scope === "project" ? ledger.projects : ledger.sessions;
      const key = this.bucketKey(scope, identity);
      delete collection[key];
      return { bucket: key, scope };
    });
  }

  async resetAll() {
    return this.transact((ledger) => {
      const sessions = Object.keys(ledger.sessions).length;
      const projects = Object.keys(ledger.projects).length;
      ledger.sessions = {};
      ledger.projects = {};
      return { projects, sessions };
    });
  }
}

export function ledgerPathFor(home, explicitPath) {
  if (explicitPath && String(explicitPath).trim()) return String(explicitPath).trim();
  if (!home) return "";
  return join(home, "dsh-advisor", "budget-ledger.json");
}
