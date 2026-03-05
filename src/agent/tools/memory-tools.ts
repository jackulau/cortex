import { tool } from "ai";
import { z } from "zod";
import type { SemanticMemory } from "@/memory/semantic";
import type { EpisodicMemory } from "@/memory/episodic";
import type { ProceduralMemory } from "@/memory/procedural";
import type { WorkingMemory } from "@/memory/working";

/**
 * Create memory-related tools for the agent.
 */
export function createMemoryTools(deps: {
  semanticMemory: SemanticMemory;
  episodicMemory: EpisodicMemory;
  proceduralMemory: ProceduralMemory;
  workingMemory: WorkingMemory;
}) {
  const { semanticMemory, episodicMemory, proceduralMemory, workingMemory } =
    deps;

  return {
    remember: tool({
      description:
        "Save a fact, preference, or note to long-term memory. Use this when the user shares important information worth remembering.",
      inputSchema: z.object({
        content: z.string().describe("The fact or information to remember"),
        type: z
          .enum(["fact", "preference", "event", "note"])
          .default("fact")
          .describe("Type of memory"),
        tags: z
          .array(z.string())
          .default([])
          .describe("Tags for categorization"),
      }),
      execute: async ({ content, type, tags }) => {
        const id = await semanticMemory.write({
          content,
          type,
          source: "user",
          tags,
        });
        workingMemory.addFact(content);
        return { success: true, id, message: `Remembered: "${content}"` };
      },
    }),

    recall: tool({
      description:
        "Search long-term memory for relevant information. Use this to find facts, preferences, or past knowledge.",
      inputSchema: z.object({
        query: z.string().describe("What to search for"),
        type: z
          .enum(["fact", "preference", "event", "note", "summary"])
          .optional()
          .describe("Filter by memory type"),
        limit: z.number().default(5).describe("Max results"),
      }),
      execute: async ({ query, type, limit }) => {
        const results = await semanticMemory.search(query, limit, type);
        if (results.length === 0) {
          return { found: false, message: "No relevant memories found." };
        }
        return {
          found: true,
          count: results.length,
          memories: results.map((r) => ({
            content: r.entry.content,
            type: r.entry.type,
            relevance: `${(r.score * 100).toFixed(0)}%`,
            tags: r.entry.tags,
            date: r.entry.createdAt,
          })),
        };
      },
    }),

    forget: tool({
      description: "Remove a specific memory by its ID.",
      inputSchema: z.object({
        id: z.string().describe("Memory ID to delete"),
      }),
      execute: async ({ id }) => {
        const deleted = await semanticMemory.delete(id);
        return {
          success: deleted,
          message: deleted ? "Memory deleted." : "Memory not found.",
        };
      },
    }),

    addRule: tool({
      description:
        "Add a behavioral rule or preference that Cortex should always follow. Examples: 'Always respond in Spanish', 'Never use emojis'.",
      inputSchema: z.object({
        rule: z.string().describe("The rule to add"),
      }),
      execute: async ({ rule }) => {
        const id = proceduralMemory.add(rule, "user");
        return {
          success: true,
          id,
          message: `Rule added: "${rule}"`,
        };
      },
    }),

    listRules: tool({
      description: "List all active behavioral rules.",
      inputSchema: z.object({}),
      execute: async () => {
        const rules = proceduralMemory.getActive();
        return {
          count: rules.length,
          rules: rules.map((r) => ({
            id: r.id,
            rule: r.rule,
            source: r.source,
          })),
        };
      },
    }),

    searchHistory: tool({
      description: "Search past conversations by keyword.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Keywords to search for in conversation history"),
        limit: z.number().default(10).describe("Max results"),
      }),
      execute: async ({ query, limit }) => {
        const results = episodicMemory.search(query, limit);
        if (results.length === 0) {
          return {
            found: false,
            message: "No matching conversations found.",
          };
        }
        return {
          found: true,
          count: results.length,
          results: results.map((r) => ({
            role: r.role,
            content: r.content.slice(0, 200),
            timestamp: r.timestamp,
            sessionId: r.sessionId,
          })),
        };
      },
    }),
  };
}
