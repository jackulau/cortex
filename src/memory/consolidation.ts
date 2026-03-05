import type { SemanticEntry } from "@/shared/types";
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

export interface ExtractedFact {
  content: string;
  type: SemanticEntry["type"];
  tags: string[];
}

/**
 * Extract facts from a user-assistant exchange and save to semantic memory.
 */
export async function consolidateTurn(
  ai: Ai,
  chatModel: string,
  semanticMemory: SemanticMemory,
  userMessage: string,
  assistantMessage: string
): Promise<ExtractedFact[]> {
  const conversationText = `User: ${userMessage}\nAssistant: ${assistantMessage}`;

  try {
    const response = (await ai.run(chatModel as any, {
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: conversationText },
      ],
      max_tokens: 500,
    })) as { response?: string };

    const text = response.response ?? "";
    if (!text) return [];

    // Parse JSON from response (handle markdown code blocks)
    const jsonStr = text.replace(/```json?\s*|\s*```/g, "").trim();
    const facts: ExtractedFact[] = JSON.parse(jsonStr);

    if (!Array.isArray(facts) || facts.length === 0) return [];

    // Save each fact to semantic memory
    for (const fact of facts) {
      await semanticMemory.write({
        content: fact.content,
        type: fact.type || "fact",
        source: "consolidated",
        tags: fact.tags || [],
      });
    }

    return facts;
  } catch {
    // Extraction failures are non-critical — log and move on
    console.error("Consolidation failed, skipping");
    return [];
  }
}
