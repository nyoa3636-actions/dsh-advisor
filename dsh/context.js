import { capToolResult, selectRecentEntries } from "./core.js";
import { capRepositoryContext, clampGitContextLevel, collectGitContext, escapeRepositoryText, gitContextNote } from "./git.js";

const REDACTION_MARKER = "[REDACTED SECRET]";
const PEM_BEGIN_PATTERN = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/gi;
const PEM_END_PATTERN = /-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/i;
const SECRET_PATTERNS = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"'&,;)}\]]+)/gi,
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:aws_secret_access_key|aws_session_token)\s*[:=]\s*[^\s"'&,;)}\]]+/gi,
];

function redactUnterminatedPem(value) {
  const begins = [...String(value).matchAll(PEM_BEGIN_PATTERN)];
  const lastBegin = begins.at(-1);
  if (lastBegin?.index === undefined) return String(value);
  const hasEnd = PEM_END_PATTERN.test(
    String(value).slice(lastBegin.index + lastBegin[0].length),
  );
  return hasEnd
    ? String(value)
    : `${String(value).slice(0, lastBegin.index)}${REDACTION_MARKER}`;
}

export function redactSecrets(value) {
  let output = redactUnterminatedPem(String(value));
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, scheme) => typeof scheme === "string" ? `${scheme}${REDACTION_MARKER}@` : REDACTION_MARKER);
  }
  return output;
}

function textFromBlocks(blocks) {
  return (blocks ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function sourceText(value, redact) {
  return redact ? redactSecrets(value) : value;
}

function conversationEntries(agent, config) {
  const messages = agent.session.deriveMessages();
  const toolNames = new Map();
  const entries = [];
  for (const message of messages) {
    if (!message || message.role === "system") continue;
    if (message.role === "assistant") {
      const parts = [];
      const text = textFromBlocks(message.content);
      if (text) parts.push(sourceText(text, config.advisorRedactSecrets));
      for (const block of message.content ?? []) {
        if (block?.type !== "tool-call") continue;
        const toolName = typeof block.name === "string" ? block.name : "unknown";
        toolNames.set(String(block.id), toolName);
        const policy = config.advisorToolPolicies[toolName] ?? "full";
        if (policy === "exclude") {
          parts.push(`[Tool Call: ${toolName}] (excluded by Advisor tool policy)`);
        } else if (policy === "summary") {
          parts.push(`[Tool Call: ${toolName}] (arguments omitted by Advisor tool policy: summary)`);
        } else {
          parts.push(`[Tool Call: ${toolName}(${sourceText(String(block.arguments ?? ""), config.advisorRedactSecrets)})]`);
        }
      }
      if (parts.length > 0) entries.push(`Executor: ${parts.join("\n")}`);
      continue;
    }
    if (message.role === "user" && message.source?.kind === "tool") {
      const resultBlock = message.content?.find((block) => block?.type === "tool-result");
      const callId = String(message.source.callId ?? resultBlock?.toolCallId ?? "");
      const toolName = toolNames.get(callId) ?? "unknown";
      const policy = config.advisorToolPolicies[toolName] ?? "full";
      const source = textFromBlocks(resultBlock?.content ?? []);
      const status = resultBlock?.isError ? "error" : "success";
      if (policy === "exclude") {
        entries.push(`[Tool Result for ${toolName}] (excluded by Advisor tool policy)`);
      } else if (policy === "summary") {
        const capped = capToolResult(source, config.advisorToolResultMaxLines, config.advisorToolResultMaxBytes);
        entries.push(`[Tool Result for ${toolName}] (output omitted by Advisor tool policy: summary; status: ${status}; ${capped.totalLines} lines, ${capped.totalBytes} bytes; source output was${capped.truncated ? "" : " not"} truncated)`);
      } else {
        const disclosed = sourceText(source, config.advisorRedactSecrets);
        const capped = capToolResult(disclosed, config.advisorToolResultMaxLines, config.advisorToolResultMaxBytes);
        entries.push(`[Tool Result for ${toolName}] (${resultBlock?.isError ? "Error " : ""}output):\n${capped.content}`);
      }
      continue;
    }
    if (message.role === "user") {
      const text = textFromBlocks(message.content);
      if (text) entries.push(`User: ${sourceText(text, config.advisorRedactSecrets)}`);
    }
  }
  return entries;
}

export function recentConversation(agent, config) {
  return selectRecentEntries(conversationEntries(agent, config), config.contextMaxChars);
}

function advisorGitContextBudget(contextMaxChars, gitContextMaxChars) {
  return Math.min(gitContextMaxChars, Math.floor(contextMaxChars / 2));
}

export function assembleAdvisorContext(agent, config, options = {}) {
  const conversation = escapeRepositoryText(recentConversation(agent, config));
  const requested = options.gitContext === "none" ? "off" : (options.gitContext ?? config.advisorGitContext);
  const allowed = config.advisorGitContext;
  const effective = clampGitContextLevel(requested, allowed);
  const budget = advisorGitContextBudget(config.contextMaxChars, config.advisorGitContextMaxChars);
  const cwd = agent.session.header.cwd;
  let changes = "";
  if (cwd) {
    const result = collectGitContext(
      cwd,
      effective,
      budget,
      config.advisorRedactSecrets ? redactSecrets : (value) => value,
    );
    const note = gitContextNote(result, requested, allowed);
    const payload = capRepositoryContext(escapeRepositoryText(result.text), budget).text;
    changes = [note, payload].filter(Boolean).join("\n\n");
  } else if (effective !== "off") {
    changes = "No working directory is available for this session. Repository context was not collected.";
  }
  return {
    conversation,
    changes,
    draft: options.draft ? escapeRepositoryText(sourceText(String(options.draft), config.advisorRedactSecrets)) : undefined,
    question: options.question ? sourceText(String(options.question), config.advisorRedactSecrets) : undefined,
  };
}
