# dsh-advisor

A configurable **Executor / Advisor workflow for DeepSeek Harness (DSH)**.

`dsh-advisor` is a DSH port/adaptation of [philipbrembeck/pi-advisor](https://github.com/philipbrembeck/pi-advisor). The upstream project is MIT-licensed and remains the design reference for this fork.

The core idea is simple:

- Use a cheap/fast model such as GPT-5.6 Luna or DeepSeek V4.1 Flash as the normal **Executor**.
- Let the Executor read files, search, edit, run tests, and own the task.
- Call a stronger model such as GPT-5.6 Sol or another premium model only as an **Advisor** for consequential plans, repeated failures, or final review.
- The Advisor gives advice only. **There is no automatic takeover.**

## Status

Early DSH port. The first implementation preserves the central flow semantics from `pi-advisor`:

- `ask_advisor` tool for voluntary second opinions
- plan / failure / completion consultation rules injected into the Executor prompt
- automatic repeated-tool loop gate
- shared Advisor-call budget per session
- bounded reconstructed conversation context
- configurable tool-result disclosure (`full`, `summary`, `exclude`)
- optional Git working-tree context (`off`, `summary`, `full`)
- optional local secret redaction
- Advisor token-usage accounting and optional session summaries
- optional Executor pinning

Not yet ported from Pi-specific UX: interactive settings/model pickers, Advisor Scout, Herdr integration, tracked/untracked file-content consent handoff, Pi UI cards, and outcome logging. These are deliberately outside the first DSH runtime port.

## Installation

Install the GitHub checkout into a DSH profile:

While PR #1 is open, install the tested branch explicitly:

```sh
dsh plugin --profile default add github:nyoa3636-actions/dsh-advisor#dsh-port
```

After `dsh-port` is merged into `main`, the `#dsh-port` suffix may be omitted. This package ships runnable JavaScript, so a Git install does **not** need a `prepare` build step or pnpm `allowBuilds` permission.

Verify the layer:

```sh
dsh --profile default --dump-config
```

## Configuration

The bundle inserts a `dsh-advisor` row. Configure it in the profile's `cordis.patch.yml` or in `$DSH_HOME/cordis.patch.yml` by overriding that row id. Do **not** insert a second row with the same id.

```yaml
- id: dsh-advisor
  config:
    advisor: openai-codex/gpt-5.6-sol
    advisorEffort: high

    # Leave executor empty to follow the DSH model picker.
    # This is recommended if you want to switch to Sol/Astra manually.
    executor: ''
    executorEffort: ''

    contextMaxChars: 15000
    advisorPlanGate: true
    advisorFailureGate: true
    advisorCompletionGate: true
    advisorAutoLoopGate: true
    advisorLoopThreshold: 3
    advisorMaxCallsPerSession: -1

    # Automatic loop-gate failure/block behavior.
    gateFailureMode: block-session
    advisorBlockOnBlocked: true

    advisorGitContext: summary
    advisorGitContextMaxChars: 20000
    advisorToolResultMaxLines: 2000
    advisorToolResultMaxBytes: 51200
    advisorRedactSecrets: false
```

DSH applies profile/home patches after bundle layers. A later row with the same `id` overrides the bundle row's configuration; its `config` value is replaced as a whole rather than deep-merged.

Model references use `provider/model` because DSH routes models through provider registrations. Replace the examples with routes that exist in your DSH model picker.

### Executor selection and manual takeover

For the intended workflow, leave `executor` empty and select Luna / DeepSeek V4.1 Flash normally in DSH. `dsh-advisor` then leaves DSH's model selection untouched.

If `executor` is set, the plugin pins every Executor request to that provider/model. That is useful for a fully automatic cheap-Executor setup, but it also means a manual model-picker switch will be overridden on the next request. Therefore **leave `executor` empty when you want to decide takeover yourself**.

## What the Executor sees

When an Advisor is configured, DSH receives the same central guidance used by upstream `pi-advisor`:

- consult before committing to a materially consequential plan;
- consult after two materially equivalent failed attempts, a recreated failure, or two actions with no measurable progress;
- consult before declaring success for non-trivial work;
- use `ask_advisor` with an empty object for a normal contextual review, or attach a concise `draft` / specific `question` when useful.

Example tool call conceptually:

```json
{
  "question": "Is this state-management change safe across process restart?",
  "draft": "Move the cache ownership into Repository; validate with existing integration tests.",
  "gitContext": "summary"
}
```

The Advisor response is returned to the Executor as a normal tool result. The Advisor has no mutation tools and does not take over the session.

## Automatic loop gate

By default, after three consecutive calls with the same normalized tool signature, `dsh-advisor` asks the Advisor whether the Executor should continue.

The Advisor must begin with one of:

```text
Decision: proceed
Decision: revise
Decision: blocked
```

- `proceed` — reset the repeat counter and allow the tool call.
- `revise` — deny that repeated call and return the Advisor feedback to the Executor.
- `blocked` — apply `gateFailureMode`.

`gateFailureMode` can be:

- `block-session` (default): deny this and subsequent tool calls in the session. With `advisorBlockOnBlocked: true` (default), the active turn is also cancelled while queued future input is preserved.
- `block-tool`: deny only the current repeated tool call.
- `warn-and-continue`: log the warning and allow execution.

No case automatically switches the Executor to the Advisor model.

A `block-session` decision remains sticky for the current live Agent. Recover by starting a new session or by resuming the persisted session into a new live Agent. A DSH `clear` lifecycle edge also resets the state when a surface emits it. Compaction deliberately does **not** reset blocked state, call budget, repetition tracking, or usage accounting. No separate `/advisor-reset` command is added in this port.

## Context sent to the Advisor

The plugin reconstructs the model-visible DSH conversation from `agent.session.deriveMessages()` and keeps recent complete entries up to `contextMaxChars`.

It follows upstream's disclosure shape:

- ordinary user text
- Executor visible text
- Executor tool calls
- tool results, capped at 2,000 lines / 50 KiB by default
- optional working-tree summary or patch
- optional Executor `draft`
- optional targeted `question`

Reasoning blocks are not forwarded. Conversation, draft, and repository regions are escaped before tagged prompt insertion. Repository text is explicitly labelled as untrusted data. Optional secret redaction runs locally before disclosure.

## Tool-result policies

Per-tool policies can be configured:

```yaml
advisorToolPolicies:
  bash: summary
  read: full
  deploy: exclude
```

- `full`: include bounded output.
- `summary`: include only status / size metadata.
- `exclude`: withhold the tool call/result content from Advisor context.

## Call budget

`advisorMaxCallsPerSession` is shared by manual `ask_advisor` calls and automatic loop-gate consultations.

- `-1`: unlimited (default)
- `0`: disable advanced Advisor calls
- positive integer: hard per-session limit

`simpleMode: true` leaves voluntary `ask_advisor` available and disables the automatic/guideline-heavy flow, mirroring the upstream concept.

## Why this fork exists

The original experiment behind this fork tried to keep a premium model as the main agent and semantically compress large tool results before returning them. In testing, when the premium model needed exact/full content it often re-read the source, causing the worker call plus summary plus full premium read — sometimes consuming more tokens than a normal read.

`dsh-advisor` reverses the architecture: a cheap model owns the large-context implementation work, while the premium model receives only bounded context for high-value judgment.

## Upstream and license

This repository was forked from `philipbrembeck/pi-advisor` and preserves its MIT license and copyright notice. The original Pi implementation remains in Git history/source as the upstream reference; the active DSH runtime lives under `dsh/`.

Upstream:

- https://github.com/philipbrembeck/pi-advisor
- Pi package: `pi-advisor-flow`

DSH port:

- https://github.com/nyoa3636-actions/dsh-advisor
