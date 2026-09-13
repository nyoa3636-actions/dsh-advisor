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
});

test("automatic decision requires exact first non-empty header", () => {
  assert.deepEqual(parseAutomaticDecision("\nDecision: proceed\nLooks fine."), {
    ok: true,
    decision: "proceed",
  });
  assert.equal(parseAutomaticDecision("Looks fine").ok, false);
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

test("no-changes repository state is not misreported as withheld", () => {
  assert.equal(
    gitContextNote({ level: "summary", status: "no-changes", text: "" }, "full", "summary"),
    "The working tree has no uncommitted changes.",
  );
  assert.match(
    gitContextNote({ level: "summary", status: "collected", text: "changed" }, "full", "summary"),
    /fuller view was requested but withheld/,
  );
});
