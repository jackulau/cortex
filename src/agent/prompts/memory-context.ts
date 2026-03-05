import type { SemanticMemory } from "@/memory/semantic";
import type { EpisodicMemory } from "@/memory/episodic";
import type { MemorySearchResult } from "@/shared/types";

/**
 * Pre-response memory retrieval — gathers relevant context
 * from semantic and episodic memory before generating a response.
 */
export async function retrieveMemoryContext(
  semanticMemory: SemanticMemory,
  episodicMemory: EpisodicMemory,
  userMessage: string
): Promise<string> {
  const parts: string[] = [];

  // Semantic search for relevant long-term memories
  try {
    const semanticResults = await semanticMemory.search(userMessage, 5);
    if (semanticResults.length > 0) {
      const relevant = semanticResults.filter((r) => r.score > 0.5);
      if (relevant.length > 0) {
        parts.push(formatSemanticResults(relevant));
      }
    }
  } catch {
    // Non-critical — continue without semantic context
  }

  // FTS search over episodic memory for keyword matches
  try {
    // Extract meaningful keywords (skip common words)
    const keywords = extractKeywords(userMessage);
    if (keywords) {
      const episodicResults = episodicMemory.search(keywords, 5);
      if (episodicResults.length > 0) {
        parts.push(formatEpisodicResults(episodicResults));
      }
    }
  } catch {
    // Non-critical — continue without episodic context
  }

  return parts.join("\n\n");
}

function formatSemanticResults(results: MemorySearchResult[]): string {
  const items = results
    .map((r) => `- [${r.entry.type}] ${r.entry.content} (relevance: ${(r.score * 100).toFixed(0)}%)`)
    .join("\n");
  return `### Known Facts & Preferences\n${items}`;
}

function formatEpisodicResults(
  results: { content: string; sessionId: string; timestamp: string }[]
): string {
  const items = results
    .slice(0, 3)
    .map((r) => `- "${r.content.slice(0, 150)}" (${r.timestamp})`)
    .join("\n");
  return `### Related Past Conversations\n${items}`;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "have", "has", "had", "will", "would",
  "can", "could", "should", "may", "might", "shall",
  "i", "me", "my", "you", "your", "he", "she", "it", "we", "they",
  "this", "that", "what", "which", "who", "whom",
  "and", "or", "but", "not", "no", "so", "if", "of", "in", "on",
  "at", "to", "for", "with", "from", "by", "about", "as", "into",
  "how", "when", "where", "why",
]);

function extractKeywords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .slice(0, 5)
    .join(" ");
}
