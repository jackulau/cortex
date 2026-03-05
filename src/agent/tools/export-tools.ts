import { tool } from "ai";
import { z } from "zod";
import type { SemanticMemory } from "@/memory/semantic";
import type { EpisodicMemory } from "@/memory/episodic";
import type { ProceduralMemory } from "@/memory/procedural";
import type { SemanticEntry } from "@/shared/types";

/**
 * Create export tools for downloading knowledge base in portable formats.
 * Supports Obsidian-compatible markdown and full JSON export.
 */
export function createExportTools(deps: {
  semanticMemory: SemanticMemory;
  episodicMemory: EpisodicMemory;
  proceduralMemory: ProceduralMemory;
  storage: R2Bucket;
}) {
  const { semanticMemory, episodicMemory, proceduralMemory, storage } = deps;

  return {
    exportMarkdown: tool({
      description:
        "Export the knowledge base as markdown files. Supports Obsidian format with YAML frontmatter or plain markdown.",
      inputSchema: z.object({
        format: z
          .enum(["obsidian", "plain"])
          .default("obsidian")
          .describe("Export format: obsidian (with YAML frontmatter) or plain"),
      }),
      execute: async ({ format }) => {
        // Fetch all semantic memories
        const memories = await semanticMemory.list({ limit: 10000 });

        if (memories.length === 0) {
          return { key: "", url: "", count: 0, message: "No memories to export." };
        }

        // Group memories by type
        const grouped = groupByType(memories);

        // Generate markdown content per type
        const files: { name: string; content: string }[] = [];
        for (const [type, entries] of Object.entries(grouped)) {
          const typeName = capitalizeFirst(type);
          const fileName = `${typeName}s.md`;
          const content =
            format === "obsidian"
              ? formatObsidian(typeName, entries)
              : formatPlain(typeName, entries);
          files.push({ name: fileName, content });
        }

        // Combine all files into a single markdown bundle
        // (Since we can't create actual zip files in Workers without a library,
        //  we create a combined markdown file with clear file separators)
        const combined = files
          .map(
            (f) =>
              `<!-- FILE: ${f.name} -->\n${f.content}\n<!-- END FILE: ${f.name} -->`
          )
          .join("\n\n---\n\n");

        // Upload to R2
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const key = `exports/markdown-${format}-${timestamp}.md`;
        await storage.put(key, combined, {
          httpMetadata: { contentType: "text/markdown" },
        });

        return {
          key,
          url: `/api/export/${key}`,
          count: memories.length,
        };
      },
    }),

    exportJson: tool({
      description:
        "Export the full knowledge base as JSON, including memories, rules, and session history.",
      inputSchema: z.object({}),
      execute: async () => {
        // Gather all data
        const memories = await semanticMemory.list({ limit: 10000 });
        const rules = proceduralMemory.getAll();
        const sessions = episodicMemory.listSessions(1000);

        const exportData = {
          exportedAt: new Date().toISOString(),
          version: "1.0",
          stats: {
            memories: memories.length,
            rules: rules.length,
            sessions: sessions.length,
          },
          data: {
            memories: memories.map((m) => ({
              id: m.id,
              content: m.content,
              type: m.type,
              source: m.source,
              tags: m.tags,
              createdAt: m.createdAt,
              updatedAt: m.updatedAt,
            })),
            rules: rules.map((r) => ({
              id: r.id,
              rule: r.rule,
              source: r.source,
              active: r.active,
              createdAt: r.createdAt,
            })),
            sessions: sessions.map((s) => ({
              sessionId: s.sessionId,
              startedAt: s.startedAt,
              endedAt: s.endedAt,
              topics:
                typeof s.topics === "string"
                  ? JSON.parse(s.topics)
                  : s.topics,
              turnCount: s.turnCount,
              summary: s.summary,
            })),
          },
        };

        const json = JSON.stringify(exportData, null, 2);

        // Upload to R2
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const key = `exports/knowledge-base-${timestamp}.json`;
        await storage.put(key, json, {
          httpMetadata: { contentType: "application/json" },
        });

        return {
          key,
          url: `/api/export/${key}`,
          stats: exportData.stats,
        };
      },
    }),
  };
}

// ── Helpers ────────────────────────────────────────────────────

function groupByType(
  memories: SemanticEntry[]
): Record<string, SemanticEntry[]> {
  const grouped: Record<string, SemanticEntry[]> = {};
  for (const m of memories) {
    if (!grouped[m.type]) {
      grouped[m.type] = [];
    }
    grouped[m.type].push(m);
  }
  return grouped;
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Format memories as Obsidian-compatible markdown with YAML frontmatter.
 */
function formatObsidian(typeName: string, entries: SemanticEntry[]): string {
  const lines: string[] = [`# ${typeName}s`, ""];

  for (const entry of entries) {
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    lines.push("---");
    lines.push(`id: "${entry.id}"`);
    lines.push(`type: ${entry.type}`);
    lines.push(`source: ${entry.source}`);
    lines.push(
      `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`
    );
    lines.push(`created: ${entry.createdAt}`);
    lines.push(`updated: ${entry.updatedAt}`);
    lines.push("---");
    lines.push("");
    lines.push(entry.content);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Format memories as plain markdown without frontmatter.
 */
function formatPlain(typeName: string, entries: SemanticEntry[]): string {
  const lines: string[] = [`# ${typeName}s`, ""];

  for (const entry of entries) {
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    lines.push(`## ${entry.content.slice(0, 80)}`);
    lines.push("");
    lines.push(entry.content);
    lines.push("");
    if (tags.length > 0) {
      lines.push(`*Tags: ${tags.join(", ")}*`);
    }
    lines.push(`*Created: ${entry.createdAt}*`);
    lines.push("");
  }

  return lines.join("\n");
}

// Export helpers for testing
export { groupByType, formatObsidian, formatPlain };
