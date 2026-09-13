import { createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { parseModelRef } from "./core.js";
import { assembleAdvisorContext } from "./context.js";
import { ADVISOR_DECISION_SYSTEM, ADVISOR_SYSTEM, advisorMessageText } from "./prompts.js";

function failureMessage(reason) {
  const failure = reason?.failure;
  if (failure?.message) return failure.message;
  return reason?.kind ? `Advisor request finished with ${reason.kind}.` : "Advisor request failed.";
}

export async function consultAdvisor(ctx, agent, config, options = {}, signal) {
  if (!config.advisor) throw new Error("Advisor model is not configured. Set advisor to provider/model in the dsh-advisor plugin config.");
  const route = parseModelRef(config.advisor, "advisor");
  const assembled = assembleAdvisorContext(agent, config, options);
  const system = options.decision ? ADVISOR_DECISION_SYSTEM : ADVISOR_SYSTEM;
  const userText = advisorMessageText(assembled);
  const messages = [
    createSystemMessage(system, "dsh-advisor"),
    createUserMessage({
      content: [{ type: "text", text: userText }],
      source: { kind: "plugin", plugin: "dsh-advisor", form: "recall" },
    }),
  ];
  let markdown = "";
  let thinkingText = "";
  let usage;
  let finish;
  for await (const chunk of ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    ...(config.advisorEffort ? { reasoningEffort: config.advisorEffort } : {}),
    messages,
    sessionId: agent.session.id,
    signal,
  })) {
    if (chunk.type === "text-delta") markdown += chunk.text;
    else if (chunk.type === "reasoning-delta") thinkingText += chunk.text;
    else if (chunk.type === "usage") usage = chunk.usage;
    else if (chunk.type === "finish") finish = chunk.reason;
  }
  if (!finish) throw new Error("Advisor stream ended without a finish record.");
  if (finish.kind === "error" || finish.kind === "aborted") throw new Error(failureMessage(finish));
  const result = markdown.trim();
  if (!result) throw new Error("Advisor returned no visible answer.");
  return {
    markdown: result,
    thinkingText: thinkingText.trim(),
    usage,
    model: `${route.provider}/${route.model}`,
  };
}
