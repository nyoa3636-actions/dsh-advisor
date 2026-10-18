import { createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { parseModelRef } from "./core.js";

export function failureMessage(reason) {
  const failure = reason?.failure;
  if (failure?.message) return failure.message;
  return reason?.kind ? `Advisor request finished with ${reason.kind}.` : "Advisor request failed.";
}

/**
 * Stream one Advisor answer from the configured route.
 *
 * The Advisor is advisory only: it receives no tools, and it never selects or
 * changes the Executor's model. `overrides` lets a caller substitute the route
 * for one call without mutating the persisted configuration.
 */
export async function consultAdvisor(ctx, agent, config, options = {}, signal, overrides = {}) {
  const modelRef = String(overrides.modelRef ?? config.advisor ?? "").trim();
  if (!modelRef) throw new Error("Advisor model is not configured. Set advisor to provider/model in the dsh-advisor plugin config.");
  const route = parseModelRef(modelRef, "advisor");
  const effort = overrides.effort !== undefined ? String(overrides.effort ?? "").trim() : config.advisorEffort;
  const assembled = options.assembled ?? options.assemble?.();
  const system = options.system;
  const userText = options.userText;
  const messages = [
    createSystemMessage(system, "dsh-advisor"),
    createUserMessage({
      content: [{ type: "text", text: userText }],
      source: { kind: "plugin", plugin: "dsh-advisor", form: "recall" },
    }),
  ];
  const startedAt = Date.now();
  let markdown = "";
  let thinkingText = "";
  let usage;
  let finish;
  const signalRef = overrides.signal ?? signal;
  for await (const chunk of ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    ...(effort ? { reasoningEffort: effort } : {}),
    messages,
    sessionId: overrides.sessionId ?? agent?.session?.id,
    signal: signalRef,
  })) {
    if (chunk.type === "text-delta") markdown += chunk.text;
    else if (chunk.type === "reasoning-delta") thinkingText += chunk.text;
    else if (chunk.type === "usage") usage = chunk.usage;
    else if (chunk.type === "finish") finish = chunk.reason;
  }
  const elapsedMs = Date.now() - startedAt;
  if (!finish) throw new Error("Advisor stream ended without a finish record.");
  if (finish.kind === "error" || finish.kind === "aborted") {
    const error = new Error(failureMessage(finish));
    error.usage = usage;
    error.elapsedMs = elapsedMs;
    error.model = `${route.provider}/${route.model}`;
    throw error;
  }
  const result = markdown.trim();
  if (!result) {
    const error = new Error("Advisor returned no visible answer.");
    error.usage = usage;
    error.elapsedMs = elapsedMs;
    error.model = `${route.provider}/${route.model}`;
    throw error;
  }
  return {
    elapsedMs,
    markdown: result,
    model: `${route.provider}/${route.model}`,
    provider: route.provider,
    modelId: route.model,
    thinkingText: thinkingText.trim(),
    usage,
    assembled,
  };
}
