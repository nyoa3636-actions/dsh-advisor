import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { apply, inject, NS } from "../dsh/client/index.js";
import { createPanel } from "../dsh/client/AdvisorPanel.js";
import { createFakeReact, renderToTree, treeText, treeFind } from "./helpers/fake-react.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, "..", "dsh", "client");

function createRemote(handlers = {}) {
  const calls = { commands: [], modelCatalog: 0, sessionList: 0, settings: [] };
  return {
    calls,
    remote: {
      commands: {
        async execute(agentId, line) {
          calls.commands.push([agentId, line]);
          const handler = handlers.command?.(line);
          return handler ?? { ok: true, value: { commandId: "c1", result: { kind: "success", text: "ok" } } };
        },
      },
      session: {
        async list(request) {
          calls.sessionList += 1;
          return handlers.list?.(request) ?? { ok: true, value: { items: [{ agentAvailable: true, running: true, sessionId: "session-a" }] } };
        },
        async modelCatalog() {
          calls.modelCatalog += 1;
          return handlers.catalog?.() ?? {
            ok: true,
            value: {
              groups: [{
                id: "provider",
                models: [{ id: "advisor-model", name: "Advisor Model", reasoning: { defaultEffort: "high", efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] } }],
                name: "Provider",
              }],
              routableProviders: ["provider"],
            },
          };
        },
      },
      settings: {
        async update(...args) {
          calls.settings.push(args);
          return handlers.update?.(...args) ?? { ok: true, value: {} };
        },
      },
    },
  };
}

function createForm(initial = {}) {
  const listeners = new Set();
  const mutations = [];
  // Mirrors the DSH ConfigFormController snapshot: no `ns`, values under
  // `value`/`base`, and writes go through `mutate`.
  let view = {
    base: { advisorBudgetMaxCalls: -1, advisorBudgetMaxUsd: 0, advisorEnabled: true, executor: "" },
    revision: 3,
    status: "ready",
    value: { advisor: "provider/advisor-model", ...initial },
    writable: true,
  };
  return {
    getSnapshot: () => view,
    mutations,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async mutate(ops) {
      mutations.push(ops);
      for (const op of ops) view = { ...view, base: { ...view.base, [op.path[0]]: op.value } };
      return true;
    },
    emit(next) {
      view = { ...view, ...next };
      for (const listener of listeners) listener(view);
    },
  };
}

function createClientContext({ form = createForm(), remote, React = createFakeReact(), sections = [], dictionaries = [] } = {}) {
  const handlers = new Map();
  const locale = {
    bind: () => (key, params) => {
      const override = dictionaries.find((entry) => entry.ns === NS)?.values?.[key];
      if (override !== undefined) return override;
      return params?.default ?? key;
    },
    register(ns, values) {
      dictionaries.push({ ns, values });
      return () => {};
    },
  };
  const context = {
    React,
    get: (name) => (name.startsWith("remote.") ? remote?.[name.slice("remote.".length)] : undefined),
    configForms: {
      describe: () => ({
        getSnapshot: () => ({ status: "ready", view: { namespaces: [{ ns: "dsh-advisor" }] } }),
        subscribe: () => () => {},
      }),
      get: () => form,
    },
    effect(factory) {
      return factory();
    },
    locale,
    remote,
    slots: {
      inject(key, register) {
        handlers.set(key, register);
        return () => handlers.delete(key);
      },
      register(descriptor, Component) {
        sections.push({ Component, descriptor });
        return () => {};
      },
    },
  };
  return { context, dictionaries, form, handlers, React, sections };
}

/**
 * Apply the plugin and render the section it registered, which is exactly the
 * path the Harness takes when it mounts a `settings.section` contribution.
 */
function renderRegistered(harness) {
  // A plain host exposes React globally; the DSH loader supplies it through the
  // module table instead, which the emitted-bundle suite covers.
  const previous = globalThis.React;
  globalThis.React = harness.React;
  try {
    apply(harness.context);
  } finally {
    globalThis.React = previous;
  }
  const register = harness.handlers.get("settings.section");
  register();
  const wrapper = harness.sections.at(-1).Component;
  // The declared section is a thin wrapper; materializing it is its element.
  const Panel = wrapper().name;
  renderToTree(harness.React, Panel);
  return Panel;
}

function controllerOf(panel) {
  return panel.__controller ?? panel.controller;
}

function tabLabels(tree) {
  return treeFind(tree, (node) => typeof node.props?.label === "string").map((node) => node.props.label);
}

test("the client plugin declares the DSH settings extension points", () => {
  assert.equal(NS, "settings.advisor");
  assert.deepEqual([...inject].sort(), ["configForms", "locale", "remote", "slots"]);
});

test("applying the client plugin registers its dictionary and one settings section", () => {
  const harness = createClientContext();
  const previous = globalThis.React;
  globalThis.React = harness.React;
  try {
    apply(harness.context);
  } finally {
    globalThis.React = previous;
  }
  assert.equal(harness.dictionaries.length, 1);
  assert.equal(harness.dictionaries[0].ns, NS);
  assert.equal(typeof harness.dictionaries[0].values.ja["tab.budget"], "string");
  assert.ok(harness.handlers.has("settings.section"), "the settings.section contribution is declared");
  harness.handlers.get("settings.section")();
  assert.equal(harness.sections.length, 1);
  assert.equal(harness.sections[0].descriptor.name, "settings.section");
  assert.equal(harness.sections[0].descriptor.id, "advisor");
  assert.equal(harness.sections[0].descriptor.locale, NS);
  assert.equal(harness.sections[0].descriptor.order, 40);
  assert.equal(harness.sections[0].descriptor.label(), "title");
});

test("the panel renders every tab without crashing", async () => {
  const { calls, remote } = createRemote();
  const harness = createClientContext({ remote });
  const React = harness.React;
  const panel = renderRegistered(harness);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(tabLabels(React.__tree()), ["tab.settings", "tab.budget", "tab.history", "tab.test"]);
  assert.equal(calls.modelCatalog, 1, "the model catalog is read once");
  assert.deepEqual(calls.commands, [["session-a", "/advisor status"]], "the budget is read through the session command");
});

test("the panel reports a missing settings namespace instead of rendering nothing", async () => {
  const form = createForm();
  const { remote } = createRemote();
  const harness = createClientContext({ form, remote });
  harness.context.configForms.describe = () => ({
    getSnapshot: () => ({ namespaces: [] }),
    subscribe: () => () => {},
  });
  const React = harness.React;
  const panel = renderRegistered(harness);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(treeText(React.__tree()), /does not serve a dsh-advisor settings namespace/);
});

test("the panel handles a deployment with no registered models", async () => {
  const { calls, remote } = createRemote({ catalog: () => ({ ok: true, value: { groups: [], routableProviders: [] } }) });
  const harness = createClientContext({ remote });
  const React = harness.React;
  const panel = renderRegistered(harness);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tabLabels(React.__tree()).length, 4, "the page still renders when no model is registered");
  assert.equal(controllerOf(panel).getSnapshot().models.length, 0);
});

test("the panel surfaces a refused settings write", async () => {
  const { remote } = createRemote();
  const form = createForm();
  form.mutate = async () => false;
  const harness = createClientContext({ form, remote });
  const React = harness.React;
  const panel = renderRegistered(harness);
  await new Promise((resolve) => setImmediate(resolve));
  const controller = controllerOf(panel);
  controller.edit("advisor", "provider/other");
  await controller.save();
  const snapshot = controller.getSnapshot();
  assert.match(snapshot.error, /did not accept/);
  assert.equal(snapshot.dirty, true, "a refused write keeps the user's draft");
});

test("saving sends only the changed fields to the settings namespace", async () => {
  const { remote } = createRemote();
  const form = createForm();
  const harness = createClientContext({ form, remote });
  const React = harness.React;
  const panel = renderRegistered(harness);
  await new Promise((resolve) => setImmediate(resolve));
  const controller = controllerOf(panel);
  controller.edit("advisorBudgetEnabled", true);
  controller.edit("advisorBudgetMaxUsd", "1.25");
  await controller.save();
  assert.deepEqual(form.mutations, [[
    { op: "set", path: ["advisorBudgetEnabled"], value: true },
    { op: "set", path: ["advisorBudgetMaxUsd"], value: 1.25 },
  ]]);
  assert.equal(controller.getSnapshot().message, "Advisor settings saved.");
});

test("changing the Advisor model drops an effort the new model does not offer", async () => {
  const { calls, remote } = createRemote();
  const harness = createClientContext({ remote });
  const React = harness.React;
  const panel = renderRegistered(harness);
  await new Promise((resolve) => setImmediate(resolve));
  const controller = controllerOf(panel);
  controller.edit("advisorEffort", "max");
  assert.equal(controller.get("advisorEffort"), "");
  controller.edit("advisorEffort", "low");
  assert.equal(controller.get("advisorEffort"), "low");
});

test("the panel rejects invalid numeric input before writing", async () => {
  const { remote } = createRemote();
  const form = createForm();
  const harness = createClientContext({ form, remote });
  const React = harness.React;
  const panel = renderRegistered(harness);
  await new Promise((resolve) => setImmediate(resolve));
  const controller = controllerOf(panel);
  controller.edit("contextMaxChars", "-5");
  await controller.save();
  assert.equal(form.mutations.length, 0);
  assert.match(controller.getSnapshot().error, /whole number/);
});

test("the connection test reads its structured payload", async () => {
  const payload = {
    costMicro: 12,
    elapsedMs: 34,
    hints: [],
    kind: "test",
    markdown: "Advisor ready.",
    model: "provider/advisor-model",
    ok: true,
    usage: { inputTokens: 5, outputTokens: 7 },
  };
  const { calls, remote } = createRemote({
    command: (line) => (line === "/advisor-test"
      ? { ok: true, value: { commandId: "c2", result: { kind: "success", text: `Advisor connection: OK\n\`\`\`dsh-advisor-json\n${JSON.stringify(payload)}\n\`\`\`` } } }
      : undefined),
  });
  const harness = createClientContext({ remote });
  const React = harness.React;
  const panel = renderRegistered(harness);
  await new Promise((resolve) => setImmediate(resolve));
  const controller = controllerOf(panel);
  await controller.testConnection();
  assert.equal(controller.getSnapshot().testResult.ok, true);
  assert.equal(controller.getSnapshot().testResult.elapsedMs, 34);
});

test("the browser entry registers one lazy factory under the package id", async () => {
  const source = await readFile(join(clientDir, "index.js"), "utf8");
  assert.match(source, /export function apply\(ctx\)/);
  assert.match(source, /ctx\.slots\.inject\("settings\.section"/);
  const manifest = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
  assert.equal(manifest.exports["./client"], "./dsh/client.js", "the served bundle is the standalone artifact");
  assert.equal(manifest.exports["./client/source"], "./dsh/client/index.js");
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"));
  assert.ok(manifest.files.includes("dsh/"));
  assert.ok(manifest.files.includes("locale/*.json"));
  assert.ok(manifest.files.includes("icon.svg"));
});
