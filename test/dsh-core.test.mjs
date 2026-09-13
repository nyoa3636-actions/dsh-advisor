import assert from "node:assert/strict";
import test from "node:test";
import {
  AdvisorSessionState,
  capToolResult,
  normalizedToolSignature,
  parseAutomaticDecision,
  parseModelRef,
  selectRecentEntries,
} from "../dsh/core.js";
import { recentConversation, redactSecrets } from "../dsh/context.js";
import { gitContextNote } from "../dsh/git.js";

test("parseModelRef requires provider/model", () => {
  assert.deepEqual(parseModelRef("openai-codex/gpt-5.6-sol"), {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  });
  assert.throws(() => parseModelRef("gpt-5.6-sol"), /provider\/model/);
});

test("tool signatures ignore key order and shell whitespace", () => {
  assert.equal(
    normalizedToolSignature("bash", { command: "git   status", z: 1, a: 2 }),
    normalizedToolSignature("bash", { a: 2, z: 1, command: "git status" }),
  );
});

test("session repetition gate triggers at threshold and can reset", () => {
  const state = new AdvisorSessionState();
  assert.equal(state.recordToolCall("read", { file_path: "a.ts" }, 3), false);
  assert.equal(state.recordToolCall("read", { file_path: "a.ts" }, 3), false);
  assert.equal(state.recordToolCall("read", { file_path: "a.ts" }, 3), true);
  state.resetRepetition();
  assert.equal(state.recordToolCall("read", { file_path: "a.ts" }, 3), false);
  assert.equal(state.repetition.interventions, 1);
});

test("automatic decision requires an exact first non-empty header", () => {
  assert.deepEqual(parseAutomaticDecision("\nDecision: proceed\nLooks fine."), {
    ok: true,
    decision: "proceed",
  });
  assert.equal(parseAutomaticDecision("Looks fine").category, "missing-decision");
  assert.equal(parseAutomaticDecision("Decision: proceed now").category, "malformed-decision");
  assert.equal(parseAutomaticDecision("   ").category, "empty-response");
});

test("automatic decision fails closed on duplicate or contradictory verdicts", () => {
  assert.equal(
    parseAutomaticDecision("Decision: proceed\nDecision: proceed").category,
    "duplicate-decision",
  );
  assert.equal(
    parseAutomaticDecision("Decision: proceed\nDecision: blocked").category,
    "contradictory-decision",
  );
});

test("automatic decision ignores balanced fenced examples but not malformed fences", () => {
  assert.deepEqual(
    parseAutomaticDecision("Decision: proceed\n```text\nDecision: blocked\n```\nContinue."),
    { ok: true, decision: "proceed" },
  );
  assert.equal(
    parseAutomaticDecision("Decision: proceed\n```text\nDecision: blocked").category,
    "contradictory-decision",
  );
});

test("tool result cap retains both ends", () => {
  const source = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
  const capped = capToolResult(source, 5, 1024);
  assert.equal(capped.truncated, true);
  assert.match(capped.content, /line-0/);
  assert.match(capped.content, /omitted tool-result section/);
  assert.match(capped.content, /line-19/);
});

test("recent-entry selection preserves newest complete entries", () => {
  const result = selectRecentEntries(["one", "two", "three"], 50);
  assert.equal(result, "one\n\ntwo\n\nthree");
  const small = selectRecentEntries(["old-entry-".repeat(20), "new-entry"], 60);
  assert.match(small, /new-entry/);
  assert.match(small, /Older context omitted/);
});

test("conversation reconstruction preserves DSH plugin provenance", () => {
  const messages = [
    { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "normal user" }] },
    { role: "user", source: { kind: "plugin", plugin: "compact", compactionId: "x" }, content: [{ type: "text", text: "checkpoint" }] },
    { role: "user", source: { kind: "plugin", plugin: "workspace", form: "instructions" }, content: [{ type: "text", text: "workspace context" }] },
  ];
  const agent = { session: { deriveMessages: () => messages } };
  const config = {
    advisorRedactSecrets: false,
    advisorToolPolicies: {},
    advisorToolResultMaxLines: 2000,
    advisorToolResultMaxBytes: 51200,
    contextMaxChars: 5000,
  };
  const conversation = recentConversation(agent, config);
  assert.match(conversation, /User: normal user/);
  assert.match(conversation, /\[System Compaction Summary\]: checkpoint/);
  assert.match(conversation, /\[Context from DSH plugin workspace; form=instructions\]: workspace context/);
  assert.doesNotMatch(conversation, /User: checkpoint/);
});

test("repository disclosure note only reports an actually narrowed request", () => {
  assert.equal(
    gitContextNote({ level: "summary", status: "no-changes", text: "" }, "full", "summary"),
    "The working tree has no uncommitted changes.",
  );
  assert.match(
    gitContextNote({ level: "summary", status: "collected", text: "changed" }, "full", "summary"),
    /fuller view was requested but withheld/,
  );
  assert.equal(
    gitContextNote({ level: "summary", status: "collected", text: "changed" }, "summary", "full"),
    undefined,
  );
});

test("secret redaction removes terminated and unterminated private keys", () => {
  const terminated = "before\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\nafter";
  const terminatedRedacted = redactSecrets(terminated);
  assert.doesNotMatch(terminatedRedacted, /secret/);
  assert.match(terminatedRedacted, /\[REDACTED SECRET\]/);
  assert.match(terminatedRedacted, /after/);

  const unterminated = "before\n-----BEGIN PRIVATE KEY-----\nsecret-tail";
  assert.equal(redactSecrets(unterminated), "before\n[REDACTED SECRET]");
});

test("session summary counts failed Advisor invocations", () => {
  const state = new AdvisorSessionState();
  state.consumeCall();
  state.recordInvocation({
    trigger: "executor-requested",
    model: "openai-codex/gpt-5.6-sol",
    failure: "provider-error",
    executionEffect: "continued",
  });
  assert.match(state.summary(5), /Calls: 1/);
  assert.match(state.summary(5), /Budget: 1 \/ 5 used; 4 remaining/);
});
