import { existsSync } from "node:fs";
import { join } from "node:path";
import { AdvisorBudgetLedger, ledgerPathFor, resolveBudgetPlan } from "./advisor-budget.js";
import { estimateCostMicro, pricingFor, reserveCostMicro } from "./advisor-cost.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_CONTEXT_TOKENS = 32000;

/**
 * Per-process Advisor accounting. One ledger instance serves every Agent in the
 * process, so project-scoped budgets stay consistent across concurrent sessions.
 */
export class AdvisorStore {
  constructor(options = {}) {
    this.home = options.home ?? "";
    this.explicitPath = options.ledgerPath ?? "";
    this.ledger = new AdvisorBudgetLedger({ historyLimit: options.historyLimit ?? 200 });
    this.ledger.setPath(ledgerPathFor(this.home, this.explicitPath));
    this.modelInfoResolver = options.modelInfoResolver;
  }

  configure(config) {
    this.ledger.historyLimit = Number.isSafeInteger(config.advisorHistoryLimit) && config.advisorHistoryLimit > 0
      ? config.advisorHistoryLimit
      : 200;
    this.ledger.setPath(ledgerPathFor(this.home, config.advisorLedgerPath || this.explicitPath));
  }

  plan(config) {
    return resolveBudgetPlan(config);
  }

  /** Stable identity for one Agent's session and its project. */
  static identity(agent, config) {
    const sessionId = agent?.session?.id ? String(agent.session.id) : "unknown-session";
    return { projectKey: projectKeyFor(agent, config), sessionId };
  }

  async modelBudget(provider, model) {
    if (!this.modelInfoResolver) return undefined;
    try {
      const info = await this.modelInfoResolver(provider, model);
      return {
        contextTokens: info?.context?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxOutputTokens: info?.defaultMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Reserve budget for one Advisor call. When the model's price is unknown the
   * reservation still holds a consultation slot, but no cash ceiling is claimed.
   */
  async reserve(config, identity, { modelRef, estimatedInputTokens, modelBudget }) {
    const plan = this.plan(config);
    const pricing = pricingFor(config.advisorPricing, modelRef);
    const reserve = reserveCostMicro(pricing, {
      inputTokens: estimatedInputTokens ?? modelBudget?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
      maxOutputTokens: modelBudget?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    });
    const outcome = await this.ledger.reserve(plan, identity, { costMicro: reserve });
    return { ...outcome, plan, pricing, reservedMicro: reserve };
  }

  async settle(config, identity, reservation, { usage, model, outcome, trigger, question }) {
    const pricing = reservation?.pricing ?? pricingFor(config.advisorPricing, model);
    const costMicro = usage === null || usage === undefined ? undefined : estimateCostMicro(usage, pricing);
    const result = await this.ledger.settle(reservation?.reservation ?? reservation, {
      costMicro,
      identity,
      model,
      outcome,
      plan: reservation?.plan ?? this.plan(config),
      question,
      trigger,
      usage: usage ?? null,
    });
    return { ...result, costMicro, pricing };
  }

  async abandon(config, identity, reservation, options = {}) {
    await this.ledger.release(reservation?.reservation ?? reservation, {
      countAsCall: options.countAsCall === true,
      failure: options.failure === true,
      identity,
    });
  }

  async summary(config, identity) {
    return this.ledger.summary(this.plan(config), identity);
  }

  async history(config, identity, limit) {
    return this.ledger.history(this.plan(config), identity, limit);
  }

  async reset(scope, identity) {
    return this.ledger.reset(scope, identity);
  }

  async resetAll() {
    return this.ledger.resetAll();
  }
}

/**
 * Project identity for project-scoped budgets: an explicit configuration wins,
 * then the DSH Session workspace, then the Git work tree root of the session cwd.
 */
export function projectKeyFor(agent, config) {
  const configured = String(config?.advisorProjectKey ?? "").trim();
  if (configured) return configured;
  const header = agent?.session?.header;
  const cwd = header?.cwd ? String(header.cwd) : "";
  const gitRoot = cwd ? gitRootOf(cwd) : "";
  const base = gitRoot || cwd || "unknown-project";
  return normalizeProjectPath(base);
}

const gitRootCache = new Map();

export function gitRootOf(cwd) {
  if (gitRootCache.has(cwd)) return gitRootCache.get(cwd);
  let root = "";
  try {
    // Walking the tree keeps project identity synchronous and dependency-free;
    // a linked work tree writes `.git` as a file, so existence is the test.
    let current = cwd;
    for (let depth = 0; depth < 24; depth += 1) {
      if (existsSync(join(current, ".git"))) {
        root = current;
        break;
      }
      const parent = join(current, "..");
      if (parent === current) break;
      current = parent;
    }
  } catch {
    root = "";
  }
  gitRootCache.set(cwd, root);
  return root;
}

export function normalizeProjectPath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase();
}
