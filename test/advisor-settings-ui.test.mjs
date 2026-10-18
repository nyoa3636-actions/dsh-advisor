import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveEffort,
  findRow,
  modelRows,
  resolveNamespace,
} from "../dsh/client/catalog.js";
import {
  coerce,
  diffPatch,
  fieldDefaults,
  validationErrors,
  valuesFrom,
} from "../dsh/client/settings-fields.js";
import { AdvisorPanelController, remoteApi } from "../dsh/client/panel-controller.js";

const CATALOG = {
  groups: [{
    id: "provider",
    models: [
      { id: "advisor-model", name: "Advisor", reasoning: { defaultEffort: "high", efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] } },
      { id: "plain-model", name: "Plain" },
    ],
    name: "Provider",
  }],
};

test("the model catalog flattens into pickable rows", () => {
  const rows = modelRows(CATALOG);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ref, "provider/advisor-model");
  assert.equal(rows[0].groupName, "Provider");
  assert.equal(rows[0].efforts.length, 2);
  assert.equal(rows[1].efforts.length, 0);
  assert.equal(findRow(rows, "PROVIDER/ADVISOR-MODEL")?.id, "advisor-model");
  assert.equal(findRow(rows, "missing/model"), undefined);
});

test("an effort the model does not advertise is never sent", () => {
  const rows = modelRows(CATALOG);
  assert.equal(effectiveEffort(rows, "provider/advisor-model", "high"), "high");
  assert.equal(effectiveEffort(rows, "provider/advisor-model", "max"), "");
  assert.equal(effectiveEffort(rows, "provider/plain-model", "high"), "");
  assert.equal(effectiveEffort(rows, "", "high"), "");
  assert.equal(effectiveEffort(rows, "provider/advisor-model", ""), "");
});

test("the settings namespace is resolved by id, then by its Advisor field", () => {
  assert.equal(resolveNamespace([{ ns: "dsh-advisor" }]).ns, "dsh-advisor");
  assert.equal(resolveNamespace([{ ns: "other", schema: { dict: { advisor: {} } } }]).ns, "other");
  assert.equal(resolveNamespace([{ ns: "other", schema: { dict: { unrelated: {} } } }]), undefined);
  assert.equal(resolveNamespace([]), undefined);
});

test("field values are read from the layered mirror with canonical defaults", () => {
  const values = valuesFrom({ base: { advisorBudgetMaxCalls: -1 }, value: { advisor: "p/m", executor: "p/e" }, ns: "dsh-advisor" });
  assert.equal(values.advisor, "p/m");
  assert.equal(values.executor, "p/e");
  assert.equal(values.executorPinned, true);
  assert.equal(values.advisorEffort, "");
  assert.equal(values.advisorBudgetEnabled, false);
  const empty = valuesFrom(undefined);
  assert.deepEqual(empty, { ...fieldDefaults(), executorPinned: false });
});

test("coercion validates numbers and switches", () => {
  assert.equal(coerce("advisorLoopThreshold", "4"), 4);
  assert.equal(coerce("advisorLoopThreshold", "abc"), undefined);
  assert.equal(coerce("contextMaxChars", ""), undefined);
  assert.equal(coerce("advisorBudgetEnabled", true), true);
  assert.equal(coerce("advisorBudgetEnabled", "true"), true);
  assert.equal(coerce("advisorBudgetEnabled", false), false);
  assert.equal(coerce("advisor", 12), "12");
});

test("only changed fields become a settings patch", () => {
  const initial = valuesFrom({ value: { advisor: "p/m", advisorBudgetEnabled: false } });
  const draft = { ...initial, advisorBudgetEnabled: true };
  assert.deepEqual(diffPatch(initial, draft), { advisorBudgetEnabled: true });
  assert.deepEqual(diffPatch(initial, { ...initial }), {}, "an untouched form writes nothing");
});

test("clearing the Executor model also clears the pin", () => {
  const initial = valuesFrom({ value: { executor: "p/e" } });
  const draft = { ...initial, executor: "", executorPinned: false };
  assert.deepEqual(diffPatch(initial, draft), { executor: "" });
});

test("invalid values are rejected before a write", () => {
  const errors = validationErrors({
    ...fieldDefaults(),
    advisorBudgetMaxCalls: -2,
    advisorBudgetMaxUsd: -1,
    advisorLoopThreshold: 1,
    contextMaxChars: -5,
  });
  const keys = errors.map(([key]) => key);
  assert.deepEqual(keys.sort(), ["advisorBudgetMaxCalls", "advisorBudgetMaxUsd", "advisorLoopThreshold", "contextMaxChars"]);
  assert.equal(validationErrors({ ...fieldDefaults(), advisorBudgetMaxCalls: -1 }).length, 0);
  assert.equal(validationErrors({ ...fieldDefaults(), advisorBudgetMaxUsd: 0 }).length, 0);
});

/** Minimal config-forms + remote doubles for controller-level behaviour. */
function createController(options = {}) {
  const writes = [];
  const commands = [];
  const listeners = new Set();
  const mutations = [];
  // The DSH ConfigFormController snapshot: values under `value`/`base` and an
  // explicit status; `mutate` is the write path.
  let view = {
    base: { advisorBudgetMaxCalls: -1, advisorBudgetMaxUsd: 0, advisorEnabled: true, executor: "" },
    revision: 7,
    status: "ready",
    value: { advisor: "provider/advisor-model" },
    writable: true,
  };
  const form = {
    getSnapshot: () => view,
    mutations,
    async mutate(ops) {
      mutations.push(ops);
      if (options.acceptWrite === false) return false;
      for (const op of ops) view = { ...view, base: { ...view.base, [op.path[0]]: op.value } };
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const namespaces = options.namespaces ?? [{ ns: "dsh-advisor" }];
  const ctx = {
    get: (name) => (name.startsWith("remote.") ? ctx.remote?.[name.slice("remote.".length)] : undefined),
    configForms: {
      describe: () => ({
        getSnapshot: () => ({ status: "ready", view: { namespaces } }),
        subscribe: () => () => {},
      }),
      get: () => form,
    },
    remote: {
      commands: {
        async execute(agentId, line) {
          commands.push([agentId, line]);
          return options.command?.(line) ?? { ok: true, value: { commandId: "c", result: { kind: "success", text: "ok" } } };
        },
      },
      session: {
        async list() {
          return options.list?.() ?? { ok: true, value: { items: [{ running: true, sessionId: "session-a" }] } };
        },
        async modelCatalog() {
          return options.catalog?.() ?? { ok: true, value: CATALOG };
        },
      },
      settings: {
        async update(...args) {
          writes.push(args);
          return options.update?.(...args) ?? { ok: true, value: {} };
        },
      },
    },
  };
  const controller = new AdvisorPanelController(ctx);
  return { commands, controller, form, writes };
}

test("starting the controller loads the catalog once and reads the budget", async () => {
  const { commands, controller } = createController();
  const stop = controller.start();
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getSnapshot().models.length, 2);
  assert.deepEqual(commands, [["session-a", "/advisor status"]]);
  stop();
  assert.equal(controller.getSnapshot().loading, false);
});

test("a deployment without the settings namespace reports why", async () => {
  const { controller } = createController({ namespaces: [] });
  controller.start();
  assert.match(controller.getSnapshot().error, /does not serve a dsh-advisor settings namespace/);
});

test("the controller clamps a stored effort when the model changes", async () => {
  const { controller } = createController();
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  controller.edit("advisorEffort", "max");
  assert.equal(controller.get("advisorEffort"), "");
  controller.edit("advisorEffort", "high");
  assert.equal(controller.get("advisorEffort"), "high");
  controller.edit("advisor", "provider/plain-model");
  assert.equal(controller.get("advisorEffort"), "", "the new model advertises no effort");
});

test("the controller refuses an invalid draft before writing", async () => {
  const { controller, form } = createController();
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  controller.edit("advisorLoopThreshold", 1);
  await controller.save();
  assert.equal(form.mutations.length, 0);
  assert.match(controller.getSnapshot().error, /at least 2/);
});

test("the controller writes only the changed fields and reports success", async () => {
  const { controller, form } = createController();
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  controller.edit("advisorBudgetEnabled", true);
  controller.edit("advisorBudgetMaxUsd", "2.5");
  await controller.save();
  assert.deepEqual(form.mutations, [[
    { op: "set", path: ["advisorBudgetEnabled"], value: true },
    { op: "set", path: ["advisorBudgetMaxUsd"], value: 2.5 },
  ]]);
  assert.equal(controller.getSnapshot().message, "Advisor settings saved.");
  assert.equal(controller.getSnapshot().dirty, false);
});

test("a refused write keeps the draft for correction", async () => {
  const { controller } = createController({ acceptWrite: false });
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  controller.edit("advisor", "provider/plain-model");
  await controller.save();
  assert.match(controller.getSnapshot().error, /did not accept/);
  assert.equal(controller.getSnapshot().dirty, true);
});

test("the controller parses a command payload and reports a missing session", async () => {
  const { controller } = createController({
    command: (line) => (line === "/advisor status"
      ? { ok: true, value: { commandId: "c", result: { kind: "success", text: 'report\n```dsh-advisor-json\n{"kind":"status","standing":{"settledCalls":2}}\n```' } } }
      : undefined),
  });
  controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getSnapshot().status.standing.settledCalls, 2);

  const missing = createController({ list: () => ({ ok: true, value: { items: [] } }) });
  missing.controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(missing.controller.getSnapshot().statusError ?? "", /No Session is available/);
});

test("a dotted Remote is looked up without throwing on an undeclared property", () => {
  const session = { list: async () => ({}) };
  assert.equal(remoteApi({ get: (key) => (key === "remote.session" ? session : undefined) }, "remote.session"), session);

  const throwing = {
    get() {
      throw new Error('cannot get property "remote.session" without inject');
    },
    get remote() {
      throw new Error('cannot get property "remote" without inject');
    },
  };
  assert.doesNotThrow(() => remoteApi(throwing, "remote.session"));
  assert.equal(remoteApi(throwing, "remote.session"), undefined);
  assert.equal(remoteApi({}, "remote.session"), undefined);
});
