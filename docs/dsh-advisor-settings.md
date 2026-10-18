# Advisor Settings reference

Everything on this page lives inside DeepSeek Harness. The page is a
`settings.section` contribution of `dsh-advisor`, it reads DSH's own model
catalog through the Client Remote, and it reads and writes the plugin's own
configuration entry through DSH's settings service. No external web server,
companion application, or separate management UI is involved.

## How the page is wired

| Concern | DSH mechanism |
| --- | --- |
| Page placement | `ctx.slots.register({ name: "settings.section", id: "advisor", ... })` |
| Model list | `ctx.remote.session.modelCatalog()` — the providers and models DSH registered |
| Reasoning efforts | the selected model's `reasoning.efforts` from the same catalog |
| Reading current values | `ctx.configForms.get(ns)` over the shared settings mirror |
| Writing values | `ctx.remote.settings.update(ns, patch, revision)` |
| Live budget, history, connection test | `/advisor*` session commands through `ctx.remote.commands.execute()` |
| Persistence | the plugin's `dsh-advisor` configuration entry in the profile patch |
| Localization | `ctx.locale.register("settings.advisor", { en, ja })` |

The page never invents a model id, never sends a reasoning effort the model does
not advertise, and never modifies anything outside its own configuration entry.

## Settings tab

### Advisor and Executor

| Field | Key | Notes |
| --- | --- | --- |
| Advisor | `advisorEnabled` | Master switch for every Advisor consultation |
| Advisor model | `advisor` | Chosen from the registered providers/models |
| Advisor reasoning effort | `advisorEffort` | Only the model's advertised efforts; empty = model default |
| Pin the Executor model | — | Page-only switch; off clears `executor` |
| Executor model | `executor` | Empty means DSH's model picker decides |
| Executor reasoning effort | `executorEffort` | Only used while pinning is on |

The Advisor never promotes itself to Executor and never changes the main model.
With pinning off, DSH's own model selection is passed through untouched.

### When to consult

| Field | Key |
| --- | --- |
| Consult before important design decisions | `advisorPlanGate` |
| Consult after repeated failure | `advisorFailureGate` |
| Review before completion | `advisorCompletionGate` |
| Repeated tool-call loop gate | `advisorAutoLoopGate` |
| Loop detection threshold | `advisorLoopThreshold` (2–10, slider) |
| Legacy per-session call limit | `advisorMaxCallsPerSession` |
| Custom consultation condition | `advisorCustomInvocation` |

### Consultation budget

| Field | Key | Notes |
| --- | --- | --- |
| Consultation budget | `advisorBudgetEnabled` | Master switch for tracking and enforcement |
| Cash ceiling (USD) | `advisorBudgetMaxUsd` | `0` = no cash ceiling |
| Maximum consultations | `advisorBudgetMaxCalls` | `-1` = no call ceiling |
| Budget scope | `advisorBudgetScope` | `session` or `project` |
| When the budget is used up | `advisorBudgetLimitMode` | `stop-advisor` or `confirm` |
| When a price is unknown | `advisorBudgetUnknownCost` | `allow`, `count-only`, or `stop-advisor` |
| Model rates | `advisorPricing` | Edited as one row per model |
| Project key override | `advisorProjectKey` | Overrides workspace/Git-root detection |

## Budget tab

Shows the configured ceiling, spend, remaining budget, a usage progress bar, the
consultation count, remaining consultations, the last Advisor model, the last
consultation time, and the last result.

- Amounts are displayed in USD.
- A total that includes an unpriced call is labelled `Estimated`, and the same
  note explains that the cash ceiling is an estimate rather than an exact limit.
- `Reset budget` clears the active scope only.

## History tab

Shows the recorded consultations newest first: time, trigger, model, token
count, estimated cost, and outcome. A <code>dsh-advisor-json</code> payload
appended to the command result carries the same records for the page, so the
page and the chat report never disagree.

Adoption of the Advisor's advice by the Executor is deliberately **not** shown:
DSH records no reliable signal for it, and the page does not guess.

## Connection test tab

`Test Advisor` sends one short message to the configured Advisor model and
reports connection success/failure, the provider/model actually used, the
Advisor's reply, the response time, the tokens, the estimated cost, and the
reasons to check when it fails.

The test:

- runs through the same `ctx.llm.stream()` path as a real consultation;
- writes nothing to the workspace and touches no project file;
- **counts against the Advisor consultation budget**, because it consumes real
  tokens.

## Advanced settings

`Advanced settings` folds out of the way by default and exposes:
`contextMaxChars`, `advisorGitContext`, `advisorGitContextMaxChars`,
`advisorToolResultMaxLines`, `advisorToolResultMaxBytes`,
`advisorToolPolicies`, `advisorRedactSecrets`, `gateFailureMode`,
`advisorBlockOnBlocked`, `advisorSessionSummary`, and `simpleMode`.

`advisorGitContext` is `off` / `summary` / `full`. `gateFailureMode` is
`block-session` / `block-tool` / `warn-and-continue`, with `block-tool`
recommended for new installs. Secret redaction is recommended on for new
installs; a profile that already pins either key keeps its value.

## Commands

The same page operations are available as session commands:

```text
/advisor [status|settings|off|on|model <provider/model>|effort <name|default>|budget <on|off>|scope <session|project>|limit <stop-advisor|confirm>|unknown-cost <allow|count-only|stop-advisor>|reset-budget]
/advisor-budget
/advisor-history [count]
/advisor-test
/advisor-log [on|off|git <off|summary|full>|policy <tool> <full|summary|exclude>|policies]
```

Each command returns a readable report plus a machine-readable
<code>dsh-advisor-json</code> block, which is how the Settings page reads live
state without a private network path.

## Privacy

- Secrets are never written to the ledger, the history, or the page.
- The ledger stores token counts, model ids, costs, times, triggers, and the
  first 240 characters of a consultation question.
- Advisor context is built by the existing context assembly and is subject to
  `advisorRedactSecrets` and the per-tool disclosure policies.
