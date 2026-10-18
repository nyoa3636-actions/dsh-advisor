import { ADVISOR_DECISION_SYSTEM, ADVISOR_SYSTEM, advisorMessageText } from "./prompts.js";
import { assembleAdvisorContext } from "./context.js";

/**
 * Assemble one Advisor call input from the Executor's current DSH context.
 * Returns detached values so the caller can hand them to `consultAdvisor`
 * without the store or command layer reaching into Agent internals again.
 */
export function buildAdvisorRequest(agent, config, options = {}) {
  const assembled = assembleAdvisorContext(agent, config, options);
  const decision = options.decision === true;
  return {
    assembled,
    call: {
      decision,
      system: decision ? ADVISOR_DECISION_SYSTEM : ADVISOR_SYSTEM,
      userText: advisorMessageText(assembled),
    },
  };
}

const APPROX_CHARS_PER_TOKEN = 4;

export function approximateInputTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? "").length / APPROX_CHARS_PER_TOKEN));
}
