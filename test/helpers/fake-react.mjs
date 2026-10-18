/**
 * Tiny React stand-in for exercising the Advisor Settings panel without a DOM.
 * It implements exactly the hooks the panel uses, re-renders when an external
 * store notifies, and exposes the rendered element tree for assertions.
 */
export function createFakeReact() {
  const React = {
    createElement(name, props, ...children) {
      return { children, name, props: props ?? {} };
    },
    useEffect(factory, deps) {
      const frame = React.__current;
      const record = React.__hook({ deps, kind: "effect" });
      // No dependency array means once per mount, exactly as React documents.
      const shouldRun = deps === undefined
        ? !record.initialized
        : !record.initialized || changed(record.deps, deps);
      if (shouldRun) {
        record.cleanup?.();
        record.cleanup = factory();
        record.deps = deps;
        record.initialized = true;
      }
      frame.effects.push(record);
    },
    useMemo(factory, deps) {
      const record = React.__hook({ deps, kind: "memo" });
      if (!record.initialized || changed(record.deps, deps)) {
        record.value = factory();
        record.deps = deps;
        record.initialized = true;
      }
      return record.value;
    },
    useRef(initial) {
      const record = React.__hook({ kind: "ref" });
      if (!record.initialized) {
        record.value = { current: initial };
        record.initialized = true;
      }
      return record.value;
    },
    useState(initial) {
      const frame = React.__current;
      const record = React.__hook({ kind: "state" });
      if (!record.initialized) {
        record.value = typeof initial === "function" ? initial() : initial;
        record.set = (next) => {
          const value = typeof next === "function" ? next(record.value) : next;
          if (Object.is(value, record.value)) return;
          record.value = value;
          React.__schedule(frame);
        };
        record.initialized = true;
      }
      return [record.value, record.set];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const record = React.__hook({ deps: [], kind: "store" });
      if (!record.initialized) {
        record.initialized = true;
        record.unsubscribe = subscribe(() => React.__schedule(React.__frame));
      }
      record.value = getSnapshot();
      return record.value;
    },
    __current: null,
    __trace: false,
    __hook(seed) {
      const frame = React.__current;
      const index = frame.hooks.length;
      // Hook identity is positional; a re-render reuses the same record, and a
      // caller asking for a different kind at one position gets a fresh record.
      const previous = (frame.previous ?? [])[index];
      const record = previous && previous.kind === seed.kind ? previous : seed;
      frame.hooks.push(record);
      return record;
    },
    /** Re-render the mounted component after an external store notification. */
    __schedule(frame) {
      if (React.__trace) console.error("[fake-react] notify pending=", frame.pending, "disposed=", frame.disposed);
      if (frame.disposed || frame.pending) return;
      frame.pending = true;
      queueMicrotask(() => {
        frame.pending = false;
        if (frame.disposed) return;
        if (React.__trace) console.error("[fake-react] rerender");
        React.__render(frame);
      });
    },
    __render(frame) {
      const previousContext = React.__current;
      React.__current = frame;
      const previousHooks = frame.hooks ?? [];
      frame.hooks = [];
      frame.effects = [];
      try {
        frame.tree = { children: [frame.Component(frame.props)], name: "root", props: {} };
      } finally {
        frame.previous = previousHooks;
        React.__current = previousContext;
      }
    },  };
  return React;
}

function changed(previous, next) {
  if (previous === undefined || next === undefined) return true;
  if (previous.length !== next.length) return true;
  return previous.some((value, index) => !Object.is(value, next[index]));
}

/**
 * Mount a component tree once and return its rendered element tree.
 * Effects run in order; an external-store notification re-renders the same
 * component instance with its hook state preserved, so read the latest tree
 * through `React.__tree()` after awaiting asynchronous work.
 */
export function renderToTree(React, Component, props = {}) {
  if (typeof Component !== "function") {
    let label = "unknown";
    try {
      label = JSON.stringify(Component, (key, value) => (typeof value === "function" ? "[fn]" : value)).slice(0, 240);
    } catch {
      label = String(Component);
    }
    throw new TypeError(`renderToTree expected a component function, received ${typeof Component}: ${label}`);
  }
  const frame = { Component, disposed: false, effects: [], hooks: [], pending: false, props, tree: null };
  React.__frame = frame;
  React.__tree = () => frame.tree;
  React.__dispose = () => {
    frame.disposed = true;
    for (const record of frame.effects) record.cleanup?.();
  };
  React.__render(frame);
  return frame.tree;
}

export function controllerOf(tree) {
  return treeFind(tree, (node) => node.props?.ref && typeof node.props.ref.getSnapshot === "function")[0]?.props.ref;
}

export function walk(node, visit) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === "string" || typeof node === "number") {
    visit(node);
    return;
  }
  if (typeof node.name === "function") {
    // A component element still carries its children in the rendered tree.
    visit(node);
    walk(node.children, visit);
    return;
  }
  visit(node);
  walk(node.children, visit);
}

export function treeText(node) {
  const parts = [];
  walk(node, (entry) => {
    if (typeof entry === "string" || typeof entry === "number") parts.push(String(entry));
  });
  return parts.join(" ");
}

export function treeFind(node, predicate) {
  const found = [];
  walk(node, (entry) => {
    if (typeof entry === "object" && predicate(entry)) found.push(entry);
  });
  return found;
}
