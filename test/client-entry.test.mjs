import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

function createContext(React, dictionaries, sections, handlers) {
  return {
    React,
    configForms: {
      describe: () => ({ getSnapshot: () => ({ namespaces: [] }), subscribe: () => () => {} }),
      get: () => ({ getSnapshot: () => ({}), subscribe: () => () => {} }),
    },
    effect: (factory) => factory(),
    locale: {
      bind: (ns) => (key, params) => {
        const entry = dictionaries.find((value) => value.ns === ns);
        return entry?.values?.ja?.[key] ?? entry?.values?.en?.[key] ?? params?.default ?? key;
      },
      register: (ns, values) => {
        dictionaries.push({ ns, values });
        return () => {};
      },
    },
    remote: {},
    slots: {
      inject: (key, register) => {
        handlers.set(key, register);
        return () => {};
      },
      register: (descriptor, Component) => {
        sections.push({ Component, descriptor });
        return () => {};
      },
    },
  };
}

/** Execute the emitted bundle the way the DSH browser module loader does. */
async function loadBundle() {
  const source = await readFile(join(root, "dsh", "client.js"), "utf8");
  const registrations = [];
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration);
        },
      },
    },
  };
  vm.createContext(sandbox);
  new vm.Script(source, { filename: "dsh/client.js" }).runInContext(sandbox);
  assert.equal(registrations.length, 1, "the bundle registers exactly one factory");
  const registration = registrations[0];
  assert.equal(registration.id, "dsh-advisor");
  return { registration, sandbox, source };
}

test("the emitted bundle is a standalone self-registering factory", async () => {
  const { registration, source } = await loadBundle();
  assert.equal(typeof registration.factory, "function");
  assert.ok(!/^\s*import\s/mu.test(source), "the served artifact carries no import statements");
  assert.ok(!/^\s*export\s/mu.test(source), "the served artifact carries no export statements");
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /id: "dsh-advisor"/);
});

test("the bundle factory resolves React from the module table and mounts the section", async () => {
  const { registration } = await loadBundle();
  const React = {
    createElement: (name, props, ...children) => ({ children, name, props: props ?? {} }),
  };
  const dictionaries = [];
  const sections = [];
  const handlers = new Map();
  const exports = registration.factory((specifier) => {
    assert.equal(specifier, "react");
    return React;
  });

  assert.equal(exports.NS, "settings.advisor");
  assert.deepEqual([...exports.inject].sort(), ["configForms", "locale", "remote", "slots"]);
  assert.equal(typeof exports.apply, "function");

  exports.apply(createContext(React, dictionaries, sections, handlers));
  assert.equal(dictionaries.length, 1);
  assert.equal(dictionaries[0].ns, "settings.advisor");
  assert.equal(dictionaries[0].values.en["tab.budget"], "Budget");
  assert.equal(dictionaries[0].values.ja["tab.budget"], "予算");
  assert.equal(dictionaries[0].values.ja["field.advisorBudgetEnabled.label"], "相談予算");
  assert.ok(handlers.has("settings.section"));
  handlers.get("settings.section")();
  assert.equal(sections.length, 1);
  assert.equal(sections[0].descriptor.id, "advisor");
  assert.equal(sections[0].descriptor.order, 40);
  assert.equal(sections[0].descriptor.name, "settings.section");
  assert.equal(sections[0].descriptor.label(), "Advisor", "the label routes through the ja/en copy");
  assert.equal(typeof sections[0].Component().name, "function", "the section materializes a panel component");
});

test("a missing React in the module table fails loudly instead of silently", async () => {
  const { registration } = await loadBundle();
  const exports = registration.factory(() => undefined);
  assert.throws(
    () => exports.apply(createContext(undefined, [], [], new Map())),
    /did not provide React/,
  );
});

test("a host that exposes React globally still mounts the section", async () => {
  const { registration, sandbox } = await loadBundle();
  const React = { createElement: (name, props, ...children) => ({ children, name, props: props ?? {} }) };
  const dictionaries = [];
  const sections = [];
  const handlers = new Map();
  const exports = registration.factory(() => undefined);
  // The factory runs in the page realm, so the global it reads is the sandbox.
  sandbox.React = React;
  exports.apply(createContext(undefined, dictionaries, sections, handlers));
  handlers.get("settings.section")();
  assert.equal(sections.length, 1);
});

test("apply never reads React off the Cordis context", async () => {
  const { registration, source } = await loadBundle();
  assert.ok(!/ctx\.React/u.test(source), "an undeclared context property throws in Cordis");
  // A context that would throw on any unknown property must still work.
  const React = { createElement: (name, props, ...children) => ({ children, name, props: props ?? {} }) };
  const strictContext = new Proxy(createContext(undefined, [], [], new Map()), {
    get(target, property) {
      if (!(property in target) && typeof property === "string" && !property.startsWith("__")) {
        throw new Error(`cannot get property "${String(property)}" without inject`);
      }
      return Reflect.get(target, property);
    },
  });
  const exports = registration.factory((name) => (name === "react" ? React : undefined));
  assert.doesNotThrow(() => exports.apply(strictContext));
});

test("the package manifest points DSH at the emitted bundle", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.exports["./client"], "./dsh/client.js");
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings"));
  assert.ok(manifest.files.includes("dsh/"), "the bundle ships with the package");
  assert.ok(manifest.scripts["build:client"].includes("build-client.mjs"));
});
