import type { SemanticEntry } from "@/shared/types";
import { runAI } from "@/ai/model-router";
import type { ChatProvider } from "@/ai/providers";
import { SemanticMemory } from "./semantic";

/**
 * Post-turn consolidation — AI extracts facts from conversation
 * and writes them to semantic memory automatically.
 */

const EXTRACTION_PROMPT = `You are a fact extraction system. Given a conversation exchange, extract any facts, preferences, or important information worth remembering long-term.

Rules:
- Extract only concrete, specific facts (not vague statements)
- Each fact should be self-contained and understandable without context
- Include who/what the fact is about
- Skip greetings, filler, and meta-conversation
- Return valid JSON only

Return a JSON array of objects:
[{ "content": "fact text", "type": "fact|preference|event|note", "tags": ["tag1"] }]

If nothing worth extracting, return: []`;

/** Prompt for AI-based conflict classification between two facts. */
const CONFLICT_PROMPT = `You compare two facts and classify their relationship.

Old: "{old_fact}"
New: "{new_fact}"

Reply with exactly one word: CONTRADICTS, SUPPLEMENTS, or UNRELATED.
- CONTRADICTS: the new fact directly replaces or invalidates the old fact
- SUPPLEMENTS: both facts are true and add different information
- UNRELATED: the facts are about different topics (false positive from similarity)`;

export type ConflictClassification = "CONTRADICTS" | "SUPPLEMENTS" | "UNRELATED";

/** Similarity threshold above which two memories are checked for contradiction. */
export const CONFLICT_SIMILARITY_THRESHOLD = 0.85;

export interface ExtractedFact {
  content: string;
  type: SemanticEntry["type"];
  tags: string[];
}

/**
 * Classify the relationship between an old and new fact using Workers AI.
 * Returns one of CONTRADICTS, SUPPLEMENTS, or UNRELATED.
 */
export async function classifyConflict(
  ai: Ai,
  oldFact: string,
  newFact: string,
  env?: { AI_MODEL_HEAVY?: string; AI_MODEL_LIGHT?: string }
): Promise<ConflictClassification> {
  const prompt = CONFLICT_PROMPT
    .replace("{old_fact}", oldFact)
    .replace("{new_fact}", newFact);

  const response = await runAI(
    ai,
    "fast",
    [
      { role: "system", content: "Reply with exactly one word." },
      { role: "user", content: prompt },
    ],
    { max_tokens: 10, env }
  );

  const cleaned = response.trim().toUpperCase();

  if (cleaned.includes("CONTRADICTS")) return "CONTRADICTS";
  if (cleaned.includes("SUPPLEMENTS")) return "SUPPLEMENTS";
  return "UNRELATED";
}

/**
 * Check a new fact against existing memories for contradictions.
 * If a contradiction is found, supersedes the old memory and returns
 * the old entry. Otherwise returns null.
 */
export async function checkConflicts(
  ai: Ai,
  semanticMemory: SemanticMemory,
  newFact: string,
  env?: { AI_MODEL_HEAVY?: string; AI_MODEL_LIGHT?: string }
): Promise<{ superseded: SemanticEntry } | null> {
  // Search for semantically similar existing memories
  const similar = await semanticMemory.searchRaw(newFact, 5);

  for (const { entry: existing, vectorScore } of similar) {
    // Only check high-similarity matches
    if (vectorScore < CONFLICT_SIMILARITY_THRESHOLD) continue;

    const classification = await classifyConflict(
      ai,
      existing.content,
      newFact,
      env
    );

    if (classification === "CONTRADICTS") {
      return { superseded: existing };
    }
    // SUPPLEMENTS or UNRELATED: keep both, continue checking others
  }

  return null;
}

/**
 * Extract facts from a user-assistant exchange and save to semantic memory.
 * Performs conflict detection: contradicting facts supersede existing memories.
 *
 * Uses ChatProvider abstraction — Claude API when available, Workers AI fallback.
 */
export async function consolidateTurn(
  ai: Ai,
  _chatModel: string,
  semanticMemory: SemanticMemory,
  userMessage: string,
  assistantMessage: string,
  env?: { AI_MODEL_HEAVY?: string; AI_MODEL_LIGHT?: string },
  chatProvider?: ChatProvider
): Promise<ExtractedFact[]> {
  const conversationText = `User: ${userMessage}\nAssistant: ${assistantMessage}`;

  try {
    // Use ChatProvider (Claude) for extraction when available, fall back to Workers AI
    let text: string;
    if (chatProvider) {
      text = await chatProvider.chat(
        [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: conversationText },
        ],
        { maxTokens: 500 }
      );
    } else {
      text = await runAI(
        ai,
        "light",
        [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: conversationText },
        ],
        { max_tokens: 500, env }
      );
    }

    if (!text) return [];

    // Parse JSON from response (handle markdown code blocks)
    const jsonStr = text.replace(/```json?\s*|\s*```/g, "").trim();
    const facts: ExtractedFact[] = JSON.parse(jsonStr);

    if (!Array.isArray(facts) || facts.length === 0) return [];

    // Save each fact to semantic memory, with conflict detection
    let dedupCount = 0;
    let conflictCount = 0;
    for (const fact of facts) {
      // Check for contradictions before writing
      const conflict = await checkConflicts(ai, semanticMemory, fact.content, env);

      if (conflict) {
        // Write the new fact, then supersede the old one
        const newId = await semanticMemory.write({
          content: fact.content,
          type: fact.type || "fact",
          source: "consolidated",
          tags: fact.tags || [],
        });

        if (newId) {
          await semanticMemory.supersedeMemory(conflict.superseded.id, newId);
          conflictCount++;
          console.log(
            `Conflict resolved: superseded "${conflict.superseded.content}" with "${fact.content}"`
          );
        }
      } else {
        // No conflict — normal write (dedup still handled by write())
        const id = await semanticMemory.write({
          content: fact.content,
          type: fact.type || "fact",
          source: "consolidated",
          tags: fact.tags || [],
        });
        if (id === null) {
          dedupCount++;
        }
      }
    }

    if (dedupCount > 0) {
      console.log(
        `Skipped ${dedupCount} duplicate fact${dedupCount > 1 ? "s" : ""} during consolidation`
      );
    }
    if (conflictCount > 0) {
      console.log(
        `Resolved ${conflictCount} conflict${conflictCount > 1 ? "s" : ""} during consolidation`
      );
    }

    return facts;
  } catch {
    // Extraction failures are non-critical — log and move on
    console.error("Consolidation failed, skipping");
    return [];
  }
}
