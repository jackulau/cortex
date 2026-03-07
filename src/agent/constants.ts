/**
 * Maximum number of LLM steps (tool call -> observe -> decide cycles)
 * allowed per single user message to prevent runaway loops.
 */
export const MAX_AGENT_LOOPS = 5;
