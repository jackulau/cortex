import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import { SemanticMemory } from "@/memory/semantic";
import type { Env } from "@/shared/types";

/**
 * Create the MCP server instance with Cortex memory tools.
 * Exposes remember, recall, and research_url tools via the MCP protocol.
 */
export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "cortex",
    version: "0.1.0",
  });

  const semanticMemory = new SemanticMemory(
    env.DB,
    env.AI,
    env.EMBEDDING_MODEL
  );

  // ── remember ─────────────────────────────────────────────────
  server.tool(
    "remember",
    "Save a fact to Cortex's memory",
    {
      content: z.string().describe("The fact or information to remember"),
      type: z
        .enum(["fact", "preference", "event", "note"])
        .default("fact")
        .describe("Type of memory"),
      tags: z
        .array(z.string())
        .default([])
        .describe("Tags for categorization"),
    },
    async ({ content, type, tags }) => {
      const id = await semanticMemory.write({
        content,
        type,
        source: "user",
        tags,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id,
              message: `Remembered: "${content}"`,
            }),
          },
        ],
      };
    }
  );

  // ── recall ───────────────────────────────────────────────────
  server.tool(
    "recall",
    "Search Cortex's memory",
    {
      query: z.string().describe("What to search for"),
      limit: z.number().default(5).describe("Max results"),
    },
    async ({ query, limit }) => {
      const results = await semanticMemory.search(query, limit);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              results.map((r) => ({
                content: r.entry.content,
                type: r.entry.type,
                relevance: `${(r.score * 100).toFixed(0)}%`,
                tags: r.entry.tags,
                date: r.entry.createdAt,
              }))
            ),
          },
        ],
      };
    }
  );

  // ── research_url (stubbed) ──────────────────────────────────
  server.tool(
    "research_url",
    "Extract and summarize a URL, save to memory",
    {
      url: z.string().describe("URL to research"),
    },
    async ({ url }) => {
      // Stubbed until browser-research module is merged
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              message: `URL research is not yet implemented. URL: ${url}`,
              status: "stub",
            }),
          },
        ],
      };
    }
  );

  return server;
}

/**
 * Create the MCP request handler for use in server.ts routing.
 * Returns a function that handles HTTP requests on the /mcp path.
 */
export function createCortexMcpHandler(env: Env) {
  const server = createMcpServer(env);
  return createMcpHandler(server, { route: "/mcp" });
}
