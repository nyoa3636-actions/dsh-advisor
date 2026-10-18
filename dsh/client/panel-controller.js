/** Advisor Settings page controller: settings namespace, catalog, budget, and history. */
import {
  ADVANCED_FIELDS,
  BASIC_FIELDS,
  coerce,
  diffPatch,
  valuesFrom,
  validationErrors,
} from "./settings-fields.js";
import { catalogFailures, effectiveEffort, modelRows, resolveNamespace } from "./catalog.js";

const DEFAULT_NS = "dsh-advisor";

/**
 * Read a Remote namespace the safe way.
 *
 * Cordis throws when a plugin reads a context property it did not inject, so a
 * dotted Remote such as `remote.session` is looked up with `get()` instead;
 * a deployment that serves no such namespace reports that through the page
 * rather than taking the whole web boot down.
 */
export function remoteApi(ctx, key) {
  try {
    const direct = ctx.get?.(key);
    if (direct) return direct;
  } catch {
    // Fall through to the namespace root below.
  }
  const leaf = key.slice("remote.".length);
  try {
    return ctx.remote?.[leaf];
  } catch {
    return undefined;
  }
}

export class AdvisorPanelController {
  constructor(ctx) {
    this.ctx = ctx;
    this.listeners = new Set();
    this.snapshot = {
      advancedOpen: false,
      catalog: null,
      config: null,
      draft: null,
      error: null,
      history: null,
      initial: null,
      loading: true,
      message: null,
      models: [],
      namespace: null,
      namespaceCandidates: [],
      payload: null,
      saving: false,
      status: null,
      statusError: null,
      tab: "settings",
      testResult: null,
      testing: false,
      writable: false,
    };
    this.form = null;
    this.formRevision = -1;
    this.formUnwatch = null;
    this.disposers = [];
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot() {
    return this.snapshot;
  }

  set(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  start() {
    if (this.started) return () => {};
    this.started = true;
    const unsubscribe = this.ctx.configForms.describe().subscribe(() => this.syncNamespace());
    this.disposers.push(unsubscribe);
    this.syncNamespace();
    void this.loadCatalog();
    void this.refreshBudget();
    return () => {
      this.started = false;
      for (const dispose of this.disposers) {
        try {
          dispose?.();
        } catch {
          // A failed unsubscribe must not block the remaining cleanup.
        }
      }
      this.disposers = [];
      this.formUnwatch?.();
      this.formUnwatch = null;
      this.form = null;
    };
  }

  /** Bind the form for the Advisor settings namespace as soon as the Host serves it. */
  syncNamespace() {
    const describe = this.ctx.configForms.describe().getSnapshot();
    // The shared mirror wraps the document: `{ status, view: { namespaces } }`.
    const namespaces = describe?.view?.namespaces ?? describe?.namespaces ?? [];
    const view = resolveNamespace(namespaces, DEFAULT_NS);
    if (!view) {
      if (!this.snapshot.namespace) {
        const served = namespaces.map((entry) => entry?.ns).filter(Boolean).slice(0, 12);
        this.set({
          error: served.length
            ? `This deployment does not serve a dsh-advisor settings namespace. Served: ${served.join(", ")}.`
            : "This deployment does not serve a dsh-advisor settings namespace yet. Confirm the plugin is enabled in the profile and reopen Settings.",
          loading: false,
          namespaceCandidates: served,
        });
      }
      return;
    }
    if (this.form && view.ns === this.snapshot.namespace) return;
    this.formUnwatch?.();
    this.form = this.ctx.configForms.get(view.ns);
    this.formNamespace = view.ns;
    this.formUnwatch = this.form.subscribe((state) => this.acceptView(state));
    this.acceptView(this.form.getSnapshot());
  }

  acceptView(state) {
    if (!state) return;
    const values = valuesFrom(state);
    const draft = this.snapshot.dirty === true ? this.snapshot.draft : values;
    this.set({
      config: state.value ?? {},
      draft,
      error: null,
      initial: values,
      loading: state.status === "loading",
      namespace: this.formNamespace ?? this.snapshot.namespace,
      revision: state.revision,
      writable: state.writable !== false,
    });
  }

  get(path) {
    return this.snapshot.draft?.[path];
  }

  edit(path, raw) {
    const value = coerce(path, raw);
    const draft = { ...(this.snapshot.draft ?? {}) };
    draft[path] = value;
    if (path === "executor" && !String(value ?? "").trim()) draft.executorPinned = false;
    if (path === "executorPinned") {
      draft.executorPinned = value === true;
      if (value === true && !String(draft.executor ?? "").trim()) {
        draft.executor = this.snapshot.initial?.executor ?? "";
      }
    }
    if (path === "advisorEnabled" && value === true && !String(draft.advisor ?? "").trim()) {
      draft.advisor = this.snapshot.initial?.advisor ?? "";
    }
    // A model change or a new effort can both name an effort the model rejects.
    if (path === "advisor" || path === "advisorEffort") {
      draft.advisorEffort = effectiveEffort(this.snapshot.models, draft.advisor, draft.advisorEffort);
    }
    if (path === "executor" || path === "executorEffort") {
      draft.executorEffort = effectiveEffort(this.snapshot.models, draft.executor, draft.executorEffort);
    }
    this.set({ dirty: true, draft });
  }

  resetField(path) {
    const draft = { ...(this.snapshot.draft ?? {}) };
    draft[path] = this.snapshot.initial?.[path];
    if (path === "executor") draft.executorPinned = false;
    this.set({ dirty: true, draft });
  }

  async save() {
    const { draft, initial } = this.snapshot;
    if (!this.form || !draft) return;
    const errors = validationErrors(draft);
    if (errors.length) {
      this.set({ error: errors[0][1], message: null });
      return;
    }
    const patch = diffPatch(initial, draft);
    if (!Object.keys(patch).length) {
      this.set({ dirty: false, message: "Nothing to save." });
      return;
    }
    this.set({ error: null, message: null, saving: true });
    try {
      if (typeof this.form.mutate !== "function") {
        throw new Error("This deployment does not expose an editable Advisor configuration form.");
      }
      const ops = Object.entries(patch).map(([key, value]) => ({ op: "set", path: [key], value }));
      const accepted = await this.form.mutate(ops);
      if (!accepted) throw new Error("The Harness did not accept these values. Reload the page and try again.");
      this.set({ dirty: false, message: "Advisor settings saved.", saving: false });
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error), saving: false });
    }
  }

  discard() {
    this.set({ dirty: false, draft: this.snapshot.initial, error: null, message: "Changes discarded." });
  }

  toggleAdvanced() {
    this.set({ advancedOpen: !this.snapshot.advancedOpen });
  }

  async loadCatalog() {
    if (this.catalogLoaded) return;
    this.catalogLoaded = true;
    try {
      const sessionApi = remoteApi(this.ctx, "remote.session");
      if (!sessionApi?.modelCatalog) throw new Error("This deployment does not expose the session Remote, so the model catalog cannot be read.");
      const response = await sessionApi.modelCatalog();
      if (response?.ok === false) throw new Error(response.error?.message ?? "The model catalog is unavailable.");
      const catalog = response?.value ?? response;
      const models = modelRows(catalog);
      const draft = { ...(this.snapshot.draft ?? {}) };
      for (const key of ["advisorEffort", "executorEffort"]) {
        const ref = key === "advisorEffort" ? draft.advisor : draft.executor;
        const reduced = effectiveEffort(models, ref, draft[key]);
        if (reduced !== draft[key]) draft[key] = reduced;
      }
      this.set({
        catalog: { failures: catalogFailures(catalog), routableProviders: catalog?.routableProviders ?? [] },
        draft,
        models,
      });
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Run one /advisor command against the live Session Agent and read its payload. */
  async runCommand(line, { quiet = false } = {}) {
    try {
      const sessionId = await this.currentSessionId();
      if (!sessionId) throw new Error("No Session is available for Advisor commands yet. Open a Session and retry.");
      const commandsApi = remoteApi(this.ctx, "remote.commands");
      if (!commandsApi?.execute) throw new Error("This deployment does not expose the commands Remote, so Advisor status cannot be read.");
      const response = await commandsApi.execute(sessionId, line);
      if (response?.ok === false) throw new Error(response.error?.message ?? "The command was refused.");
      const value = response?.value ?? response;
      if (value === undefined) throw new Error(`/${line.replace(/^\//u, "").split(" ")[0]} is not registered.`);
      const result = value.result ?? value;
      const text = result.text ?? "";
      const payload = extractPayload(text);
      if (result.kind === "error" && !quiet) this.set({ message: text });
      return { ok: result.kind !== "error", payload, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!quiet) this.set({ message });
      return { ok: false, error: message };
    }
  }

  async currentSessionId() {
    if (this.sessionId) return this.sessionId;
    try {
      const sessionApi = remoteApi(this.ctx, "remote.session");
      if (!sessionApi?.list) return undefined;
      const response = await sessionApi.list({});
      const items = (response?.value ?? response)?.items ?? [];
      const chosen = items.find((item) => item.running) ?? items.find((item) => item.agentAvailable) ?? items[0];
      this.sessionId = chosen?.sessionId ?? undefined;
      return this.sessionId;
    } catch {
      return undefined;
    }
  }

  async refreshBudget() {
    this.set({ statusError: null });
    const outcome = await this.runCommand("/advisor status", { quiet: true });
    if (outcome.ok && outcome.payload?.kind === "status") this.set({ status: outcome.payload });
    else this.set({ statusError: outcome.error ?? "The Advisor status could not be read." });
  }

  async refreshHistory(limit = 10) {
    const outcome = await this.runCommand(`/advisor-history ${limit}`, { quiet: true });
    if (outcome.ok && outcome.payload?.kind === "history") this.set({ history: outcome.payload });
    else this.set({ statusError: outcome.error ?? "The Advisor history could not be read." });
  }

  async resetBudget() {
    const outcome = await this.runCommand("/advisor reset-budget", { quiet: true });
    this.set({ message: outcome.text ?? "Advisor budget reset." });
    await this.refreshBudget();
    await this.refreshHistory();
  }

  async testConnection() {
    this.set({ testResult: null, testing: true });
    const outcome = await this.runCommand("/advisor-test", { quiet: true });
    this.set({ testResult: outcome.payload ?? { ok: false, reason: outcome.text ?? outcome.error }, testing: false });
    await this.refreshBudget();
  }

  setTab(tab) {
    this.set({ tab });
    if (tab === "history") void this.refreshHistory();
    if (tab === "budget") void this.refreshBudget();
  }
}

/** Read the machine-readable block a `/advisor*` command appends. */
export function extractPayload(text) {
  const open = "```dsh-advisor-json";
  const start = String(text ?? "").indexOf(open);
  if (start === -1) return undefined;
  const body = String(text).slice(start + open.length);
  const end = body.indexOf("```");
  try {
    return JSON.parse((end === -1 ? body : body.slice(0, end)).trim());
  } catch {
    return undefined;
  }
}

export { ADVANCED_FIELDS, BASIC_FIELDS };
