const WHITESPACE = /\s/;
const TIMESTAMP_KEYS = new Set(["createdat", "date", "datetime", "time", "timestamp", "updatedat"]);
const REQUEST_ID_KEYS = new Set(["correlationid", "requestid", "traceid"]);

const normalizedKey = (key) => key.replace(/[-_]/g, "").toLowerCase();
const isVolatileKey = (key, keys) => keys.has(normalizedKey(key));

export function parseModelRef(ref, label = "model") {
  const value = String(ref ?? "").trim();
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    throw new Error(`${label} must be configured as provider/model (received ${JSON.stringify(value)}).`);
  }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

function normalizeShellWhitespace(command) {
  let result = "";
  let quote;
  let pendingSpace = false;
  for (const char of command.trim()) {
    if (quote) {
      result += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      if (pendingSpace && result) result += " ";
      pendingSpace = false;
      quote = char;
      result += char;
    } else if (WHITESPACE.test(char)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && result) result += " ";
      pendingSpace = false;
      result += char;
    }
  }
  return result;
}

function normalizeString(value) {
  return value
    .replace(/\/(?:private\/)?tmp\/[^\s/]+/g, "/tmp/<temporary>")
    .replace(/\/var\/folders\/[^\s/]+/g, "/var/folders/<temporary>");
}

export function normalizeToolInput(toolName, input) {
  const visit = (value, key) => {
    if (typeof value === "string") {
      if (key && isVolatileKey(key, TIMESTAMP_KEYS)) return "<timestamp>";
      if (key && isVolatileKey(key, REQUEST_ID_KEYS)) return "<request-id>";
      const normalized = normalizeString(value);
      return (toolName === "bash" || toolName === "pwsh") && key === "command"
        ? normalizeShellWhitespace(normalized)
        : normalized;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((childKey) => [childKey, visit(value[childKey], childKey)]),
      );
    }
    return value;
  };
  return visit(input);
}

export function normalizedToolSignature(toolName, input) {
  return `${toolName}:${JSON.stringify(normalizeToolInput(toolName, input))}`;
}

export function capUtf8Bytes(value, maxBytes) {
  if (maxBytes <= 0) return "";
  const source = Buffer.from(value, "utf8");
  if (source.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return source.subarray(0, end).toString("utf8");
}

const OMITTED_MARKER = "[... omitted tool-result section ...]";

export function capToolResult(value, maxLines = 2000, maxBytes = 50 * 1024) {
  const lines = value.split("\n");
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(value, "utf8");
  if ((maxLines === 0 || maxBytes === 0) && value.length > 0) {
    return {
      content: "[Tool result omitted: configured limit is zero]",
      omittedLines: totalLines,
      totalBytes,
      totalLines,
      truncated: true,
    };
  }
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content: value, omittedLines: 0, totalBytes, totalLines, truncated: false };
  }
  const markerBytes = Buffer.byteLength(OMITTED_MARKER, "utf8");
  if (maxBytes < markerBytes || maxLines === 1) {
    return {
      content: capUtf8Bytes(OMITTED_MARKER, maxBytes),
      omittedLines: totalLines,
      totalBytes,
      totalLines,
      truncated: true,
    };
  }
  const headCount = Math.floor((maxLines - 1) / 2);
  const tailCount = maxLines - 1 - headCount;
  const collect = (candidates, maxEntries, maxContentBytes) => {
    const selected = [];
    let used = 0;
    for (const line of candidates.slice(0, maxEntries)) {
      const next = used + Buffer.byteLength(line, "utf8") + (selected.length ? 1 : 0);
      if (next > maxContentBytes) break;
      selected.push(line);
      used = next;
    }
    return selected;
  };
  const availableBytes = Math.max(0, maxBytes - markerBytes - 2);
  const head = collect(lines, headCount, Math.floor(availableBytes / 2));
  const tailCandidates = lines.slice(Math.max(head.length, lines.length - tailCount)).toReversed();
  const tail = collect(tailCandidates, tailCount, availableBytes - Buffer.byteLength(head.join("\n"), "utf8")).toReversed();
  return {
    content: [...head, OMITTED_MARKER, ...tail].join("\n"),
    omittedLines: Math.max(0, totalLines - head.length - tail.length),
    totalBytes,
    totalLines,
    truncated: true,
  };
}

export function selectRecentEntries(entries, maxChars) {
  if (maxChars === 0) return "";
  const separator = "\n\n";
  const joined = entries.join(separator);
  if (joined.length <= maxChars || maxChars === Number.MAX_SAFE_INTEGER) return joined;
  const omissionMarker = (omitted) => `[Older context omitted: ${omitted} complete entr${omitted === 1 ? "y" : "ies"}]`;
  const newestTruncated = "[Newest entry truncated]";
  if (entries.length === 1) {
    const prefix = `${newestTruncated}${separator}`;
    return `${prefix}${entries[0].slice(0, Math.max(0, maxChars - prefix.length))}`.slice(0, maxChars);
  }
  const selected = [];
  let selectedLength = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const candidateCount = selected.length + 1;
    const omitted = entries.length - candidateCount;
    const candidateLength = selectedLength + entry.length + (selected.length > 0 ? separator.length : 0);
    if (omissionMarker(omitted).length + separator.length + candidateLength > maxChars) break;
    selected.unshift(entry);
    selectedLength = candidateLength;
  }
  const omitted = entries.length - Math.max(1, selected.length);
  const marker = omissionMarker(omitted);
  if (selected.length > 0) return `${marker}${separator}${selected.join(separator)}`;
  const prefix = `${marker}${separator}${newestTruncated}${separator}`;
  return `${prefix}${entries.at(-1)?.slice(0, Math.max(0, maxChars - prefix.length)) ?? ""}`.slice(0, maxChars);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function snapshotUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const result = {
    inputTokens: finite(usage.inputTokens),
    outputTokens: finite(usage.outputTokens),
    cacheReadTokens: finite(usage.cacheReadTokens),
    cacheWriteTokens: finite(usage.cacheWriteTokens),
    reasoningTokens: finite(usage.reasoningTokens),
    totalTokens: finite(usage.totalTokens),
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

function add(left, right) {
  if (right === undefined) return left;
  return (left ?? 0) + right;
}

export class AdvisorSessionState {
  constructor() {
    this.reset();
  }

  reset() {
    this.repetition = { count: 0, interventions: 0, previousSignature: undefined };
    this.blockedReason = undefined;
    this.consumedCalls = 0;
    this.invocations = [];
    this.usage = { calls: 0, knownCalls: 0 };
  }

  get blocked() {
    return this.blockedReason !== undefined;
  }

  block(reason) {
    this.blockedReason ??= reason;
  }

  clearBlocked() {
    this.blockedReason = undefined;
  }

  resetRepetition() {
    this.repetition.count = 0;
    this.repetition.previousSignature = undefined;
  }

  recordToolCall(toolName, input, threshold) {
    if (toolName === "ask_advisor") return false;
    const signature = normalizedToolSignature(toolName, input);
    this.repetition.count = signature === this.repetition.previousSignature ? this.repetition.count + 1 : 1;
    this.repetition.previousSignature = signature;
    if (this.repetition.count < threshold) return false;
    this.repetition.interventions += 1;
    return true;
  }

  canConsult(limit) {
    return limit === undefined || this.consumedCalls < limit;
  }

  consumeCall() {
    this.consumedCalls += 1;
  }

  remainingCalls(limit) {
    return limit === undefined ? undefined : Math.max(0, limit - this.consumedCalls);
  }

  recordInvocation(record) {
    this.invocations.push(record);
    this.usage.calls += 1;
    const usage = snapshotUsage(record.usage);
    if (!usage) return;
    this.usage.knownCalls += 1;
    for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"]) {
      this.usage[key] = add(this.usage[key], usage[key]);
    }
  }

  summary(limit) {
    if (this.invocations.length === 0 && this.repetition.interventions === 0) return undefined;
    const budget = limit === undefined
      ? `${this.consumedCalls} used; unlimited remaining`
      : `${this.consumedCalls} / ${limit} used; ${Math.max(0, limit - this.consumedCalls)} remaining`;
    const usage = [
      this.usage.inputTokens === undefined ? undefined : `input ${this.usage.inputTokens}`,
      this.usage.outputTokens === undefined ? undefined : `output ${this.usage.outputTokens}`,
      this.usage.cacheReadTokens === undefined ? undefined : `cache-read ${this.usage.cacheReadTokens}`,
    ].filter(Boolean).join(", ") || "unavailable";
    return [
      "[DSH Advisor Summary]",
      `Calls: ${this.invocations.length}`,
      `Budget: ${budget}`,
      `Usage: ${usage}`,
      `Loop interventions: ${this.repetition.interventions}`,
    ].join("\n");
  }
}

export function parseAutomaticDecision(markdown) {
  const first = markdown.split(/\r?\n/).find((line) => line.trim())?.trim().toLowerCase();
  if (first === "decision: proceed") return { ok: true, decision: "proceed" };
  if (first === "decision: revise") return { ok: true, decision: "revise" };
  if (first === "decision: blocked") return { ok: true, decision: "blocked" };
  return { ok: false, category: "invalid-decision", message: "Advisor gate response did not begin with a valid Decision header." };
}
