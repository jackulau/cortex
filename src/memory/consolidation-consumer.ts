/**
 * Consolidation Consumer — processes consolidation messages from CONSOLIDATION_QUEUE.
 * Calls the existing consolidateTurn() logic with automatic queue retries on failure.
 */
import { consolidateTurn } from "./consolidation";
import { SemanticMemory } from "./semantic";
import type { Env } from "@/shared/types";
import type { ConsolidationMessage } from "@/monitor/queue-types";

export async function processConsolidationMessage(
  message: ConsolidationMessage,
  env: Env
): Promise<void> {
  const semanticMemory = new SemanticMemory(
    env.DB,
    env.AI,
    env.EMBEDDING_MODEL
  );

  await consolidateTurn(
    env.AI,
    env.CHAT_MODEL,
    semanticMemory,
    message.userMessage,
    message.assistantMessage
  );
}
