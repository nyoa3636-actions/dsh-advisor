# DSH Advisor Port Handoff

## Current state

Working branch: `dsh-port`

Open PR: #1 (`feat: port Pi Advisor flow to DeepSeek Harness`)

Latest implementation commits include:

- `97db010` — align Advisor failure accounting and secret redaction with upstream
- `0a43477` — fail closed on ambiguous automatic Advisor gate decisions
- `2e700c7` — preserve DSH compaction provenance in reconstructed Advisor context

The port intentionally has **no automatic premium takeover**. The user decides manually when to switch the main DSH model.

## What is already implemented

The active DSH runtime lives in `dsh/`.

Implemented central `pi-advisor` semantics:

- `ask_advisor` DSH tool
- cheap/normal Executor + separate premium Advisor model
- optional Executor pinning; blank `executor` respects DSH model picker
- plan gate guidance in the Executor system prompt
- repeated-failure gate guidance in the Executor system prompt
- completion gate guidance in the Executor system prompt
- automatic repeated-tool loop gate
- shared per-session Advisor call budget
- automatic gate modes: `block-session`, `block-tool`, `warn-and-continue`
- `advisorBlockOnBlocked` cancellation behavior using DSH agent cancellation
- bounded conversation reconstruction from `agent.session.deriveMessages()`
- tool-result policies: `full`, `summary`, `exclude`
- tool-result line/byte caps
- Git context: `off`, `summary`, `full`
- Git context disclosure ceiling and explicit withheld/no-change messages
- optional local secret redaction, including unterminated PEM private-key protection
- prompt-region escaping for conversation/draft/repository content
- Advisor usage/accounting in session state
- session summaries
- provider-error accounting
- DSH compaction checkpoint recognition (`source.kind === "plugin" && source.plugin === "compact"`) so checkpoints are labelled system compaction context rather than ordinary user speech
- strict automatic gate parser copied conceptually from upstream 0.6.0:
  - exact first `Decision:` line required
  - duplicate/contradictory verdicts fail closed
  - balanced fenced examples are ignored
  - malformed/unclosed fences cannot hide a contradictory verdict
- DSH bundle manifest and GitHub-installable package shape
- README adapted for DSH installation/configuration

Pure/core tests were reconstructed and run outside GitHub Actions during development; the latest relevant set passed 11/11. GitHub Actions on the fork was not producing runs, so **do not treat CI as having validated DSH integration**.

## Important design constraints

1. **No automatic takeover.** Do not add it in this phase.
2. Advisor is advisory only and must not receive mutation tools.
3. Leave `executor` blank by default so the user can manually switch DSH main models.
4. Preserve upstream `pi-advisor` behavior where practical; isolate DSH-specific adaptation rather than redesigning the flow.
5. `agent.session.deriveMessages()` is the correct DSH source for current model-visible history. It reflects compaction surface replacements; do not rebuild history from raw log events.
6. Compaction should not reset the Advisor call budget. New/clear/resumed task semantics need deliberate verification.
7. Automatic gates must fail closed on malformed/ambiguous Advisor decisions.
8. Repository/tool content is untrusted data, not Advisor instructions.

## Work still required before merging PR #1

### 1. Run the plugin in a real local DSH profile

This is the highest priority. Install the branch itself, not `main`:

```sh
dsh plugin --profile <test-profile> add github:nyoa3636-actions/dsh-advisor#dsh-port
dsh --profile <test-profile> --dump-config
dsh --profile <test-profile>
```

Verify that the bundle contributes the `dsh-advisor` row and that the runtime loads without missing-service/schema errors.

### 2. Verify the actual DSH model/provider routes

Configure an Advisor route that exists in the local DSH model picker, then confirm `ask_advisor({})` calls it via `ctx.llm.stream()`.

Check:

- provider/model resolution
- `reasoningEffort`
- `sessionId`
- abort propagation
- provider errors
- usage fields returned by the concrete adapters

Do not assume every provider supports every effort name.

### 3. End-to-end `ask_advisor` smoke test

With a cheap Executor selected in DSH:

- send a short coding task
- confirm `ask_advisor` is visible to the Executor
- call `ask_advisor({})`
- confirm the Advisor sees recent conversation context
- confirm its Markdown returns as the normal tool result
- confirm the Executor continues with the same main model
- manually switch the DSH model afterwards and confirm the plugin does not switch it back when `executor: ''`

### 4. Test repeated-tool automatic loop gate end to end

Force the exact same normalized tool call three times (default threshold 3).

Test all decisions with a controllable/mock Advisor if possible:

- `Decision: proceed` => current tool call proceeds and repetition resets
- `Decision: revise` => current tool call is denied and Advisor feedback reaches Executor
- `Decision: blocked` + `block-tool` => only current tool call denied
- `Decision: blocked` + `warn-and-continue` => warning + tool proceeds
- `Decision: blocked` + `block-session` => tool denied; active turn cancellation behavior verified

Also verify malformed, duplicate, and contradictory `Decision:` responses fail according to `gateFailureMode`.

### 5. Resolve blocked-session recovery semantics

Current `block-session` stores blocked state in the per-Agent session state and subsequent tools are denied. Verify how the user should recover in real DSH.

Choose the smallest DSH-native behavior consistent with upstream semantics. Candidates:

- reset on an appropriate DSH lifecycle boundary (`clear`, new task/session)
- optionally add a direct human command such as `/advisor-reset` only if the DSH command service can be injected safely/optionally

Do not silently make `blocked` temporary without documenting it.

### 6. Verify lifecycle reset behavior

Current runtime deliberately does not reset state on `agent/session-start` source `compact`.

Test `startup`, `resume`, `clear`, and `compact` in a real DSH session and define desired semantics for:

- call budget
- blocked state
- repeated-tool signature state
- usage summary

Compare with upstream `advisorSessionState.resetTask()` behavior, but adapt to DSH session/task lifecycle rather than mechanically copying Pi events.

### 7. Check compaction-context reconstruction

After a real DSH compaction:

- call `ask_advisor`
- verify shadowed old messages are absent because `deriveMessages()` reflects the current surface
- verify the compacted checkpoint is labelled `[System Compaction Summary]` in Advisor context rather than `User:`
- verify subsequent real user messages remain `User:`

### 8. Verify system-prompt injection ordering

The port currently registers `dsh-advisor:guidance` at order `9300`.

Inspect the final `--dump-config` / rendered prompt behavior and make sure Advisor workflow guidance appears in a sensible late position without overriding more authoritative DSH instructions. Change the order only if real DSH composition shows a problem.

### 9. Validate config/schema edge cases

Exercise at least:

- missing `advisor`
- invalid `provider/model`
- `advisorMaxCallsPerSession: -1`, `0`, positive values
- invalid `advisorLoopThreshold`
- `simpleMode: true`
- Git context caps of zero
- tool-result caps of zero
- tool policy map
- `advisorRedactSecrets: true`
- `executor: ''` versus pinned Executor

The plugin should fail clearly at the relevant operation rather than making all of DSH unbootable when an Advisor route is merely unconfigured.

### 10. Add/repair CI once local runtime is proven

The fork's GitHub Actions did not produce runs during this porting session.

At minimum CI should run:

```sh
npm run check
npm test
```

Prefer an additional DSH integration smoke test if a lightweight supported harness exists.

### 11. Update repository metadata

The GitHub repository description still says it is a Pi Coding Agent plugin. Change it to DSH wording when convenient, for example:

`Fully customizable Advisor and Executor flow plugin for DeepSeek Harness (DSH), adapted from pi-advisor.`

### 12. Merge only after real DSH smoke tests

PR #1 is intentionally still open. Do not merge merely because pure tests pass. The remaining uncertainty is runtime/API integration on the user's actual DSH installation.

## Explicitly deferred features

These are not required for the first usable DSH port and should not block PR #1 unless the user changes scope:

- automatic premium takeover
- Advisor Scout
- Pi-style interactive settings/model picker UI
- `/advisor-manual` overlay
- Herdr integration
- tracked/untracked explicit file-content consent handoff
- Pi-specific cards/rendering
- outcome logging / `adviceId`

## Success criteria for PR #1

PR #1 is ready when all of the following are true:

1. plugin installs from `github:nyoa3636-actions/dsh-advisor#dsh-port`
2. DSH boots with the plugin
3. `ask_advisor({})` successfully calls the configured premium model
4. Advisor receives bounded current DSH context
5. cheap Executor resumes after Advisor advice
6. manual main-model switching remains possible when `executor` is blank
7. repeated-tool loop gate works for proceed/revise/blocked
8. malformed/ambiguous gate decisions fail closed
9. compaction does not break context reconstruction or unexpectedly reset budget
10. tests pass locally
11. README instructions match the tested installation/configuration path

## Suggested local workflow

Work directly on branch `dsh-port` until the runtime smoke tests pass. Keep commits small and descriptive. Do not rewrite the fork's upstream history. Once stable, merge PR #1 into `main`; after that, treat `philipbrembeck/pi-advisor` as upstream and port future upstream behavior selectively through the DSH adapter/runtime layer.
