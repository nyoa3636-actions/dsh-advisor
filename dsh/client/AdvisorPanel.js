/** Advisor Settings page: one section of the DSH Settings surface. */
import {
  ADVANCED_FIELDS,
  BASIC_FIELDS,
} from "./settings-fields.js";
import { effortsFor } from "./catalog.js";
import { AdvisorPanelController } from "./panel-controller.js";

const TABS = ["settings", "budget", "history", "test"];

function tag(name, props, ...children) {
  return { children, name, props: props ?? {} };
}

export function createPanel(React, t, ctx) {
  const h = React.createElement;
  const { useEffect, useRef, useState } = React;
  const controller = new AdvisorPanelController(ctx);

  const element = (name, props, ...children) => h(name, props ?? {}, ...children.flat().filter((child) => child !== false && child !== null && child !== undefined));

  function useController(controller) {
    // A plain state subscription keeps updates in the normal lane: a snapshot that
    // drifts between reads becomes a render-phase update under
    // useSyncExternalStore, which React aborts as "Too many re-renders" (#290).
    const [snapshot, setSnapshot] = useState(() => controller.getSnapshot());
    useEffect(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), []);
    return snapshot;
  }

  function formatMicro(micro) {
    if (micro === null || micro === undefined) return t("value.unknown");
    const value = micro / 1e6;
    if (value === 0) return "$0.00";
    if (value < 0.01) return `$${value.toFixed(4)}`;
    return `$${value.toFixed(2)}`;
  }

  function formatTime(value) {
    if (!value) return t("value.none");
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value);
    }
  }

  function FieldRow(props) {
    const { children, hint, label, overridden, onReset, resetLabel } = props;
    return element("div", { className: "dsha-row" },
      element("div", { className: "dsha-rowHead" },
        element("div", { className: "dsha-rowLabel" }, label, overridden ? element("span", { className: "dsha-badge" }, t("field.overridden")) : null),
        overridden && onReset ? element("button", { className: "dsha-link", onClick: onReset, type: "button" }, resetLabel ?? t("field.reset")) : null),
      hint ? element("div", { className: "dsha-hint" }, hint) : null,
      element("div", { className: "dsha-control" }, children));
  }

  function Switch(props) {
    const { checked, disabled, id, onChange } = props;
    return element("button", {
      "aria-checked": checked === true,
      className: `dsha-switch${checked ? " dsha-switchOn" : ""}`,
      disabled,
      id,
      onClick: () => onChange(!checked),
      role: "switch",
      type: "button",
    }, element("span", { className: "dsha-switchKnob" }));
  }

  function Slider(props) {
    const { max, min, onChange, step, value } = props;
    const current = typeof value === "number" ? value : min;
    return element("div", { className: "dsha-slider" },
      element("input", {
        "aria-label": props.label,
        max, min, onChange: (event) => onChange(Number(event.target.value)),
        step, type: "range", value: current,
      }),
      element("span", { className: "dsha-sliderValue" }, String(current)));
  }

  function TextInput(props) {
    const { onChange, placeholder, value, type } = props;
    return element("input", {
      className: "dsha-input",
      onChange: (event) => onChange(event.target.value),
      placeholder,
      type: type ?? "text",
      value: value === undefined || value === null ? "" : String(value),
    });
  }

  function TextArea(props) {
    return element("textarea", {
      className: "dsha-textarea",
      onChange: (event) => props.onChange(event.target.value),
      placeholder: props.placeholder,
      rows: props.rows ?? 3,
      spellCheck: false,
      value: props.value === undefined || props.value === null ? "" : String(props.value),
    });
  }

  function Choice(props) {
    return element("select", {
      className: "dsha-select",
      onChange: (event) => props.onChange(event.target.value),
      value: props.value ?? "",
    }, ...props.options.map(([value, label]) => element("option", { key: value, value }, label)));
  }

  function ModelSelect(props) {
    const rows = props.rows ?? [];
    if (!rows.length) {
      return element("div", { className: "dsha-empty" },
        element(TextInput, { onChange: props.onChange, placeholder: "provider/model", value: props.value }),
        element("div", { className: "dsha-hint dsha-hintWarn" }, t("model.catalogEmpty")));
    }
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.groupName)) groups.set(row.groupName, []);
      groups.get(row.groupName).push(row);
    }
    return element("select", {
      className: "dsha-select",
      onChange: (event) => props.onChange(event.target.value),
      value: props.value ?? "",
    },
      element("option", { value: "" }, t("model.none")),
      ...[...groups.entries()].map(([name, entries]) =>
        element("optgroup", { key: name, label: name },
          ...entries.map((row) => element("option", { key: row.ref, value: row.ref }, `${row.name} · ${row.id}`)))));
  }

  function EffortSelect(props) {
    const rows = props.rows ?? [];
    const efforts = props.modelRef ? effortsFor(rows, props.modelRef) : [];
    if (!props.modelRef) return element("div", { className: "dsha-hint" }, t("model.pickFirst"));
    if (!efforts.length) return element("div", { className: "dsha-hint" }, t("model.noEfforts"));
    return element("select", {
      className: "dsha-select",
      onChange: (event) => props.onChange(event.target.value),
      value: props.value ?? "",
    },
      element("option", { value: "" }, t("model.defaultEffort")),
      ...efforts.map((effort) => element("option", { key: effort.id, value: effort.id }, effort.name || effort.id)));
  }

  function TabButton(props) {
    return element("button", {
      className: `dsha-tab${props.active ? " dsha-tabActive" : ""}`,
      onClick: props.onClick,
      role: "tab",
      type: "button",
    }, props.label);
  }

  function formField(field, controller, snapshot) {
    const key = field.key;
    const value = snapshot.draft?.[key];
    const onChange = (next) => controller.edit(key, next);
    const overridden = snapshot.initial && JSON.stringify(snapshot.initial[key]) !== JSON.stringify(value);
    const common = {
      hint: t(`field.${key}.hint`, { default: undefined }) || undefined,
      key,
      label: t(`field.${key}.label`),
      onReset: () => controller.resetField(key),
      overridden: Boolean(overridden),
    };
    if (field.showIf && !field.showIf(snapshot.draft ?? {})) return null;
    if (field.kind === "switch") {
      return element(FieldRow, { ...common, key },
        element(Switch, { checked: value === true, id: `advisor-${key}`, onChange }));
    }
    if (field.kind === "slider") {
      return element(FieldRow, { ...common, key },
        element(Slider, { ...field, label: t(`field.${key}.label`), onChange, value }));
    }
    if (field.kind === "model") {
      return element(FieldRow, { ...common, key }, element(ModelSelect, { onChange, rows: snapshot.models, value }));
    }
    if (field.kind === "effort") {
      return element(FieldRow, { ...common, key },
        element(EffortSelect, { modelRef: key === "executorEffort" ? snapshot.draft?.executor : snapshot.draft?.advisor, onChange, rows: snapshot.models, value }));
    }
    if (field.kind === "choice") {
      return element(FieldRow, { ...common, key }, element(Choice, { onChange, options: field.options, value }));
    }
    if (field.kind === "textarea") {
      return element(FieldRow, { ...common, key },
        element(TextArea, { onChange, placeholder: t(`field.${key}.placeholder`, { default: "" }), value }));
    }
    if (field.kind === "number") {
      return element(FieldRow, { ...common, key },
        element(TextInput, { onChange, placeholder: field.placeholder, type: "number", value }));
    }
    return element(FieldRow, { ...common, key },
      element(TextInput, { onChange, placeholder: t(`field.${key}.placeholder`, { default: "" }), value }));
  }

  function ProgressBar(props) {
    const ratio = Math.max(0, Math.min(1, Number(props.ratio ?? 0)));
    const tone = ratio >= 1 ? "dsha-barFull" : ratio >= 0.8 ? "dsha-barWarn" : "dsha-barOk";
    return element("div", { className: "dsha-bar" },
      element("div", { className: `dsha-barFill ${tone}`, style: { width: `${Math.round(ratio * 100)}%` } }));
  }

  function SettingsTab({ controller, snapshot }) {
    return element("div", { className: "dsha-stack" },
      element("div", { className: "dsha-group" }, element("div", { className: "dsha-groupTitle" }, t("group.general")),
        ...BASIC_FIELDS.filter((field) => field.group === "general").map((field) => formField(field, controller, snapshot))),
      element("div", { className: "dsha-group" }, element("div", { className: "dsha-groupTitle" }, t("group.gates")),
        ...BASIC_FIELDS.filter((field) => field.group === "gates").map((field) => formField(field, controller, snapshot))),
      element("div", { className: "dsha-group" }, element("div", { className: "dsha-groupTitle" }, t("group.budget")),
        ...BASIC_FIELDS.filter((field) => field.group === "budget").map((field) => formField(field, controller, snapshot))),
      element("div", { className: "dsha-disclosure" },
        element("button", {
          className: "dsha-link",
          onClick: () => controller.toggleAdvanced(),
          type: "button",
        }, snapshot.advancedOpen ? t("advanced.hide") : t("advanced.show")),
        snapshot.advancedOpen
          ? element("div", { className: "dsha-group" },
            ...ADVANCED_FIELDS.map((field) => formField(field, controller, snapshot)))
          : null));
  }

  function BudgetTab({ controller, snapshot }) {
    const status = snapshot.status;
    const standing = status?.standing;
    if (!status) {
      return element("div", { className: "dsha-stack" },
        element("div", { className: "dsha-empty" }, snapshot.statusError ?? t("budget.loading")),
        element("button", { className: "dsha-button", onClick: () => controller.refreshBudget(), type: "button" }, t("action.refresh")));
    }
    const costRatio = standing?.costRatio ?? (status.plan.maxCallMicro ? (standing?.committedMicro ?? 0) / status.plan.maxCallMicro : 0);
    const callRatio = standing?.callRatio ?? (status.plan.maxCalls ? (standing?.committedCalls ?? 0) / status.plan.maxCalls : 0);
    return element("div", { className: "dsha-stack" },
      element("div", { className: "dsha-cards" },
        element("div", { className: "dsha-card" },
          element("div", { className: "dsha-cardLabel" }, t("budget.scope")),
          element("div", { className: "dsha-cardValue" }, status.plan.scope === "project" ? t("budget.scopeProject") : t("budget.scopeSession")),
          element("div", { className: "dsha-hint" }, status.plan.scope === "project" ? status.projectKey : status.sessionId)),
        element("div", { className: "dsha-card" },
          element("div", { className: "dsha-cardLabel" }, t("budget.calls")),
          element("div", { className: "dsha-cardValue" }, `${standing?.settledCalls ?? 0}${status.plan.maxCalls === null ? "" : ` / ${status.plan.maxCalls}`}`),
          element("div", { className: "dsha-hint" }, standing?.callsRemaining === null || standing?.callsRemaining === undefined
            ? t("budget.unlimited")
            : t("budget.remaining", { count: standing.callsRemaining })))),
      element("div", { className: "dsha-card" },
        element("div", { className: "dsha-cardLabel" }, t("budget.spend")),
        element("div", { className: "dsha-cardValue" }, `${formatMicro(standing?.settledMicro ?? 0)}${standing?.exact === false ? ` · ${t("budget.estimated")}` : ""}`),
        element("div", { className: "dsha-hint" }, status.plan.maxCallMicro === null
          ? t("budget.noCeiling")
          : t("budget.ceiling", { limit: formatMicro(status.plan.maxCallMicro) })),
        element(ProgressBar, { ratio: costRatio })),
      element("div", { className: "dsha-card" },
        element("div", { className: "dsha-cardLabel" }, t("budget.callUsage")),
        element(ProgressBar, { ratio: callRatio })),
      standing?.blocked
        ? element("div", { className: "dsha-note dsha-noteWarn" }, t("budget.blocked"), " ", t("budget.blockedDetail"))
        : null,
      standing?.warn && !standing?.blocked
        ? element("div", { className: "dsha-note dsha-noteWarn" }, t("budget.warning"))
        : null,
      standing?.blockedByUnknownCost
        ? element("div", { className: "dsha-note dsha-noteWarn" }, t("budget.unknownCostBlocked"))
        : null,
      (standing?.unknownCostCalls ?? 0) > 0
        ? element("div", { className: "dsha-note" }, t("budget.unknownCalls", { count: standing.unknownCostCalls }))
        : null,
      element("div", { className: "dsha-rows" },
        element("div", { className: "dsha-rowStatic" }, t("budget.lastModel"), element("span", null, status.standing?.lastModel || t("value.none"))),
        element("div", { className: "dsha-rowStatic" }, t("budget.lastAt"), element("span", null, formatTime(standing?.lastAt))),
        element("div", { className: "dsha-rowStatic" }, t("budget.lastOutcome"), element("span", null, t(`outcome.${standing?.lastOutcome || "none"}`, { default: standing?.lastOutcome || t("value.none") }))),
        element("div", { className: "dsha-rowStatic" }, t("budget.reserved"), element("span", null, `${standing?.reservedCalls ?? 0} · ${formatMicro(standing?.reservedMicro ?? 0)}`)),
        element("div", { className: "dsha-rowStatic" }, t("budget.limitMode"), element("span", null, status.limitMode === "confirm" ? t("budget.modeConfirm") : t("budget.modeStop")))),
      element("div", { className: "dsha-actions" },
        element("button", { className: "dsha-button", onClick: () => controller.refreshBudget(), type: "button" }, t("action.refresh")),
        element("button", { className: "dsha-button dsha-buttonDanger", onClick: () => controller.resetBudget(), type: "button" }, t("action.resetBudget"))));
  }

  function HistoryTab({ controller, snapshot }) {
    const entries = snapshot.history?.entries ?? [];
    return element("div", { className: "dsha-stack" },
      element("div", { className: "dsha-actions" },
        element("button", { className: "dsha-button", onClick: () => controller.refreshHistory(), type: "button" }, t("action.refresh"))),
      entries.length === 0
        ? element("div", { className: "dsha-empty" }, t("history.empty"))
        : element("div", { className: "dsha-history" },
          ...entries.map((entry, index) => element("details", { className: "dsha-historyRow", key: entry.id ?? `${entry.at}-${index}` },
            element("summary", null,
              element("span", { className: `dsha-dot dsha-dot${entry.outcome === "failed" ? "Bad" : "Good"}` }),
              element("span", { className: "dsha-historyWhen" }, formatTime(entry.at)),
              element("span", { className: "dsha-historyTrigger" }, t(`trigger.${entry.trigger}`, { default: entry.trigger })),
              element("span", { className: "dsha-historyModel" }, entry.model || t("value.unknown")),
              element("span", { className: "dsha-historyCost" }, entry.costKnown ? formatMicro(entry.costMicro) : t("history.unknownPrice"))),
            element("div", { className: "dsha-historyBody" },
              entry.question ? element("div", { className: "dsha-rowStatic" }, t("history.reason"), element("span", null, entry.question)) : null,
              element("div", { className: "dsha-rowStatic" }, t("history.tokens"), element("span", null, String((entry.usage?.inputTokens ?? 0) + (entry.usage?.outputTokens ?? 0)))),
              entry.usage?.cacheReadTokens
                ? element("div", { className: "dsha-rowStatic" }, t("history.cacheRead"), element("span", null, String(entry.usage.cacheReadTokens)))
                : null,
              element("div", { className: "dsha-rowStatic" }, t("history.outcome"), element("span", null, t(`outcome.${entry.outcome}`, { default: entry.outcome }))))))));
  }

  function TestTab({ controller, snapshot }) {
    const result = snapshot.testResult;
    return element("div", { className: "dsha-stack" },
      element("div", { className: "dsha-hint" }, t("test.hint")),
      element("div", { className: "dsha-actions" },
        element("button", {
          className: "dsha-button dsha-buttonPrimary",
          disabled: snapshot.testing,
          onClick: () => controller.testConnection(),
          type: "button",
        }, snapshot.testing ? t("test.running") : t("test.run"))),
      result
        ? element("div", { className: `dsha-note ${result.ok ? "dsha-noteOk" : "dsha-noteError"}` },
          result.ok ? t("test.ok") : t("test.failed"))
        : null,
      result
        ? element("div", { className: "dsha-rows" },
          element("div", { className: "dsha-rowStatic" }, t("test.model"), element("span", null, result.model || t("value.unknown"))),
          element("div", { className: "dsha-rowStatic" }, t("test.elapsed"), element("span", null, `${result.elapsedMs ?? 0} ms`)),
          element("div", { className: "dsha-rowStatic" }, t("test.tokens"), element("span", null, String((result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0)))),
          element("div", { className: "dsha-rowStatic" }, t("test.cost"), element("span", null, result.costMicro === null || result.costMicro === undefined ? t("history.unknownPrice") : formatMicro(result.costMicro))))
        : null,
      result?.ok ? element("pre", { className: "dsha-pre" }, result.markdown) : null,
      result && !result.ok
        ? element("div", { className: "dsha-stack" },
          element("div", { className: "dsha-note dsha-noteError" }, result.reason ?? t("test.failed")),
          ...(result.hints ?? []).map((hint, index) => element("div", { className: "dsha-hint", key: index }, `· ${hint}`)))
        : null);
  }

  function AdvisorPanel() {
    const snapshot = useController(controller);
    useEffect(() => controller.start(), []);
    const styleRef = useRef(null);    useEffect(() => {
      // A non-browser renderer (tests, SSR) simply skips the stylesheet.
      if (typeof document === "undefined") return undefined;
      if (styleRef.current) styleRef.current.remove();
      const style = document.createElement("style");
      style.dataset.plugin = "dsh-advisor";
      style.dataset.pluginCss = "dsh-advisor/AdvisorPanel.css";
      style.textContent = PANEL_CSS;
      document.head.appendChild(style);
      styleRef.current = style;
      return () => style.remove();
    }, []);
    const tab = snapshot.tab ?? "settings";
    return element("div", { className: "dsha-root" },
      element("div", { className: "dsha-header" },
        element("div", null,
          element("div", { className: "dsha-title" }, t("title")),
          element("div", { className: "dsha-subtitle" }, t("description"))),
        element("div", { className: "dsha-headerRight" },
          snapshot.dirty ? element("span", { className: "dsha-badge" }, t("state.unsaved")) : null,
          snapshot.saving ? element("span", { className: "dsha-badge" }, t("state.saving")) : null,
          element("button", { className: "dsha-button", disabled: !snapshot.dirty || snapshot.saving, onClick: () => controller.discard(), type: "button" }, t("action.discard")),
          element("button", { className: "dsha-button dsha-buttonPrimary", disabled: !snapshot.dirty || snapshot.saving || snapshot.loading, onClick: () => controller.save(), type: "button" }, t("action.save")))),
      snapshot.error ? element("div", { className: "dsha-note dsha-noteError" }, snapshot.error) : null,
      snapshot.message ? element("div", { className: "dsha-note dsha-noteOk" }, snapshot.message) : null,
      snapshot.loading ? element("div", { className: "dsha-empty" }, t("state.loading")) : null,
      snapshot.loading ? null : element("div", { "data-advisor-body": "1" },
        element("div", { className: "dsha-tabs", role: "tablist" },
          ...TABS.map((name) => element(TabButton, { active: tab === name, key: name, label: t(`tab.${name}`), onClick: () => controller.setTab(name) }))),
        element("div", { className: "dsha-body" },
          tab === "settings" ? element(SettingsTab, { controller, snapshot })
            : tab === "budget" ? element(BudgetTab, { controller, snapshot })
              : tab === "history" ? element(HistoryTab, { controller, snapshot })
                : element(TestTab, { controller, snapshot }))));
  }

  // Tests reach the same controller instance the page renders with; the tree
  // itself carries no ref, because a non-ref object is invalid on a DOM node.
  AdvisorPanel.controller = controller;
  return AdvisorPanel;
}

export const PANEL_CSS = `
.dsha-root{color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px;padding:4px 0 32px}
.dsha-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap}
.dsha-title{font-size:16px;line-height:24px;font-weight:600}
.dsha-subtitle{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:4px;max-width:52ch}
.dsha-headerRight{display:flex;align-items:center;gap:8px}
.dsha-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:16px}
.dsha-tab{background:none;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;padding:8px 12px}
.dsha-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-sm) var(--dsw-radius-sm) 0 0}
.dsha-tabActive{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:600}
.dsha-body{display:flex;flex-direction:column;gap:8px}
.dsha-stack{display:flex;flex-direction:column;gap:12px}
.dsha-group{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg);padding:8px 16px;display:flex;flex-direction:column}
.dsha-groupTitle{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.06em;padding:12px 0 4px;text-transform:uppercase}
.dsha-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:14px 0}
.dsha-group>.dsha-row:last-child{border-bottom:none}
.dsha-rowHead{display:flex;align-items:center;justify-content:space-between;gap:16px}
.dsha-rowLabel{font-size:13px;line-height:20px;display:flex;align-items:center;gap:8px}
.dsha-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:4px}
.dsha-hintWarn{color:var(--dsw-alias-state-warn-label)}
.dsha-control{margin-top:8px;display:flex;align-items:center;gap:8px}
.dsha-input,.dsha-select,.dsha-textarea{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 10px;width:100%;max-width:520px}
.dsha-input:focus,.dsha-select:focus,.dsha-textarea:focus{border-color:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,transparent)}
.dsha-textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}
.dsha-switch{align-items:center;background:var(--dsw-alias-border-l3);border:none;border-radius:999px;cursor:pointer;display:inline-flex;flex:0 0 auto;height:22px;padding:2px;transition:background .15s ease;width:40px}
.dsha-switchOn{background:var(--dsw-alias-state-business-primary)}
.dsha-switchKnob{background:var(--dsw-alias-label-primary-foreground,#fff);border-radius:50%;height:18px;transition:transform .15s ease;width:18px}
.dsha-switchOn .dsha-switchKnob{transform:translateX(18px)}
.dsha-link{background:none;border:none;color:var(--dsw-alias-state-business-primary);cursor:pointer;font:inherit;font-size:12px;padding:0;text-decoration:underline}
.dsha-slider{display:flex;align-items:center;gap:12px;width:100%;max-width:420px}
.dsha-slider input{flex:1 1 auto}
.dsha-sliderValue{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-size:12px;min-width:2ch;text-align:right}
.dsha-button{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;padding:6px 14px}
.dsha-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsha-button:disabled{cursor:default;opacity:.5}
.dsha-buttonPrimary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dsha-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dsha-buttonDanger{color:var(--dsw-alias-state-error-primary)}
.dsha-buttonDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsha-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.dsha-card{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg);display:flex;flex-direction:column;gap:4px;padding:12px 14px}
.dsha-cardLabel{color:var(--dsw-alias-label-secondary);font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.dsha-cardValue{font-size:18px;font-variant-numeric:tabular-nums;line-height:26px}
.dsha-bar{background:var(--dsw-alias-bg-skeleton);border-radius:999px;height:6px;margin-top:6px;overflow:hidden}
.dsha-barFill{height:100%;transition:width .25s ease}
.dsha-barOk{background:var(--dsw-alias-state-success-primary)}
.dsha-barWarn{background:var(--dsw-alias-state-warn-label)}
.dsha-barFull{background:var(--dsw-alias-state-error-primary)}
.dsha-note{border-radius:var(--dsw-radius-md);font-size:12px;line-height:18px;padding:8px 12px}
.dsha-noteOk{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsha-noteWarn{background:color-mix(in srgb,var(--dsw-alias-state-warn-label) 14%,transparent);color:var(--dsw-alias-state-warn-label)}
.dsha-noteError{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsha-rows{display:flex;flex-direction:column}
.dsha-rowStatic{border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);display:flex;font-size:12px;gap:16px;justify-content:space-between;padding:8px 0}
.dsha-rowStatic>span{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsha-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsha-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:16px 0}
.dsha-badge{background:var(--dsw-alias-bg-skeleton);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px;padding:2px 8px}
.dsha-disclosure{display:flex;flex-direction:column;gap:12px}
.dsha-history{display:flex;flex-direction:column;gap:4px}
.dsha-historyRow{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md);padding:8px 12px}
.dsha-historyRow summary{align-items:center;cursor:pointer;display:flex;font-size:12px;gap:12px}
.dsha-historyWhen{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;min-width:15ch}
.dsha-historyTrigger{min-width:14ch}
.dsha-historyModel{color:var(--dsw-alias-label-secondary);flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-historyCost{font-variant-numeric:tabular-nums}
.dsha-historyBody{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:8px;padding-top:4px}
.dsha-dot{border-radius:50%;display:inline-block;height:8px;width:8px}
.dsha-dotGood{background:var(--dsw-alias-state-success-primary)}
.dsha-dotBad{background:var(--dsw-alias-state-error-primary)}
.dsha-pre{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;margin:0;max-height:280px;overflow:auto;padding:12px;white-space:pre-wrap}
`;
