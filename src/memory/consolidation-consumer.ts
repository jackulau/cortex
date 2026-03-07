/**
 * Consolidation Consumer — processes consolidation messages from CONSOLIDATION_QUEUE.
 * Calls the existing consolidateTurn() logic with automatic queue retries on failure.
 *
 * Uses Claude API for fact extraction when ANTHROPIC_API_KEY is set,
 * otherwise falls back to Workers AI.
 */
import { consolidateTurn } from "./consolidation";
import { SemanticMemory } from "./semantic";
import { getChatProvider } from "@/ai/providers";
import type { Env } from "@/shared/types";
import type { ConsolidationMessage } from "@/monitor/queue-types";

export async function processConsolidationMessage(
  message: ConsolidationMessage,
  env: Env
): Promise<void> {
  const semanticMemory = new SemanticMemory(
    env.DB,
    env.AI,
    env.EMBEDDING_MODEL,
    env.VECTORIZE
  );

  const chatProvider = getChatProvider(env);

  await consolidateTurn(
    env.AI,
    env.CHAT_MODEL,
    semanticMemory,
    message.userMessage,
    message.assistantMessage,
    env,
    chatProvider
  );
}
