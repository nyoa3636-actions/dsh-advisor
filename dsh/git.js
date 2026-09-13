import { execFileSync } from "node:child_process";

export const GIT_CONTEXT_LEVELS = ["off", "summary", "full"];
const LEVEL_RANK = { off: 0, summary: 1, full: 2 };
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_TOTAL_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export function escapeRepositoryText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function clampGitContextLevel(requested, allowed) {
  return LEVEL_RANK[requested] <= LEVEL_RANK[allowed] ? requested : allowed;
}

export function capRepositoryContext(value, maxChars) {
  const notice = "\n[Repository context truncated: it exceeded the configured limit.]";
  if (value.length <= maxChars) return { text: value, truncated: false };
  const contentChars = Math.max(0, maxChars - notice.length);
  return {
    text: maxChars < notice.length ? notice.slice(0, maxChars) : `${value.slice(0, contentChars)}${notice}`,
    truncated: true,
  };
}

function deadlineRunner() {
  const expiresAt = Date.now() + GIT_TOTAL_TIMEOUT_MS;
  return (args, cwd) => {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) throw new Error("Git context collection exceeded its time budget.");
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: remaining,
      windowsHide: true,
    });
  };
}

function diffBase(run, cwd) {
  try {
    run(["rev-parse", "--verify", "--quiet", "HEAD"], cwd);
    return "HEAD";
  } catch {
    return EMPTY_TREE;
  }
}

export function collectGitContext(cwd, level, maxChars, redact = (value) => value, run = deadlineRunner()) {
  if (level === "off" || maxChars <= 0) return { level: "off", status: "disabled", text: "" };
  try {
    run(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error), level, status: "not-a-repository", text: "" };
  }
  try {
    const base = diffBase(run, cwd);
    const nameStatus = run(["diff", "--name-status", base], cwd).trim();
    const shortstat = run(["diff", "--shortstat", base], cwd).trim();
    const untracked = run(["ls-files", "--others", "--exclude-standard"], cwd).trim();
    if (!(nameStatus || untracked)) return { level, status: "no-changes", text: "" };
    const sections = [
      "Working-tree changes against the last commit (staged and unstaged).",
      nameStatus ? `Changed files:\n${nameStatus}` : "",
      shortstat ? `Totals: ${shortstat}` : "",
      untracked ? `Untracked files (names only, contents withheld):\n${untracked}` : "",
    ];
    if (level === "full") {
      const patch = run(["diff", base], cwd);
      sections.push(patch.trim() ? `Patch:\n${patch}` : "Patch: (no tracked-file content changes)");
    } else {
      sections.push("Full patch withheld by configuration; file contents were not disclosed.");
    }
    return { level, status: "collected", text: redact(sections.filter(Boolean).join("\n\n")) };
  } catch (error) {
    return { detail: error instanceof Error ? error.message : String(error), level, status: "failed", text: "" };
  }
}

export function gitContextNote(result, requested, allowed) {
  if (requested !== allowed && result.status === "collected") {
    return `Repository context was limited to "${allowed}" by user configuration; a fuller view was requested but withheld.`;
  }
  switch (result.status) {
    case "disabled": return "Repository context was disabled or had no disclosure budget; it was withheld. Do not assume the working tree is clean.";
    case "no-changes": return "The working tree has no uncommitted changes.";
    case "not-a-repository": return "No Git repository is available for this session.";
    case "failed": return "Repository context could not be collected. Do not assume the working tree is clean.";
    default: return undefined;
  }
}
