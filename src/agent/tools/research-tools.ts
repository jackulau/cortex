import { tool } from "ai";
import { z } from "zod";
import type { SemanticMemory } from "@/memory/semantic";
import { extractUrl } from "@/browser/extract";
import { runAI } from "@/ai/model-router";
import {
  ResearchScheduler,
  type ResearchFrequency,
} from "@/research/scheduler";

/**
 * Create research tools for the agent — readUrl, research, and scheduled research management.
 *
 * These tools enable the agent to extract and synthesize content from web pages,
 * optionally saving findings to semantic memory for long-term recall.
 * Also provides tools to schedule, list, and cancel recurring research tasks.
 */
export function createResearchTools(deps: {
  browser: Fetcher;
  storage: R2Bucket;
  semanticMemory: SemanticMemory;
  ai: Ai;
  chatModel: string;
  embeddingModel: string;
  env?: { AI_MODEL_HEAVY?: string; AI_MODEL_LIGHT?: string };
  db?: D1Database;
}) {
  const { browser, storage, semanticMemory, ai, chatModel, env: modelEnv, db } = deps;

  return {
    readUrl: tool({
      description:
        "Read and summarize the content of a web page. Optionally save the summary to long-term memory for future reference.",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to read and extract content from"),
        save: z
          .boolean()
          .default(false)
          .describe("Whether to save the summary to long-term memory"),
      }),
      execute: async ({ url, save }) => {
        // Extract content from the URL
        const extracted = await extractUrl(browser, storage, url);

        // Summarize with LLM (light tier — simple summarization)
        const summary = await summarizeContent(
          ai,
          chatModel,
          extracted.title,
          extracted.content,
          modelEnv
        );

        // Truncate content for preview
        const contentPreview = extracted.content.slice(0, 500);

        let saved: { id: string | null } | undefined;

        if (save) {
          const memoryContent = `[${extracted.title}](${url})\n\n${summary}`;
          const id = await semanticMemory.write({
            content: memoryContent,
            type: "note",
            source: "research",
            tags: ["url", "web-content"],
          });
          saved = { id };
        }

        return {
          title: extracted.title,
          summary,
          content_preview: contentPreview,
          ...(saved ? { saved } : {}),
        };
      },
    }),

    research: tool({
      description:
        "Research a topic by extracting content from multiple URLs, synthesizing findings into a coherent summary. Automatically saves the synthesis to long-term memory.",
      inputSchema: z.object({
        urls: z
          .array(z.string().url())
          .min(1)
          .describe("List of URLs to research"),
        topic: z.string().describe("The research topic to focus on"),
      }),
      execute: async ({ urls, topic }) => {
        // Extract content from all URLs
        const extractions = await Promise.allSettled(
          urls.map((url) => extractUrl(browser, storage, url))
        );

        // Collect successful extractions
        const sources: { url: string; title: string; summary: string }[] = [];
        const contents: string[] = [];

        for (const result of extractions) {
          if (result.status === "fulfilled") {
            const extracted = result.value;
            const summary = await summarizeContent(
              ai,
              chatModel,
              extracted.title,
              extracted.content,
              modelEnv
            );
            sources.push({
              url: extracted.url,
              title: extracted.title,
              summary,
            });
            contents.push(
              `Source: ${extracted.title} (${extracted.url})\n${extracted.content}`
            );
          }
        }

        if (sources.length === 0) {
          return {
            synthesis: "Failed to extract content from any of the provided URLs.",
            sources: [],
            memory_id: null,
          };
        }

        // Synthesize all sources into a coherent summary (heavy tier — complex analysis)
        const synthesis = await synthesizeSources(
          ai,
          chatModel,
          topic,
          contents,
          modelEnv
        );

        // Save synthesis to semantic memory
        const memoryContent = `Research: ${topic}\n\nSources:\n${sources.map((s) => `- [${s.title}](${s.url})`).join("\n")}\n\n${synthesis}`;
        const memoryId = await semanticMemory.write({
          content: memoryContent,
          type: "note",
          source: "research",
          tags: ["research", "synthesis", ...topic.toLowerCase().split(/\s+/).slice(0, 3)],
        });

        return {
          synthesis,
          sources,
          memory_id: memoryId,
        };
      },
    }),

    scheduleResearch: tool({
      description:
        "Schedule a recurring research task on a topic. Cortex will automatically research this topic at the specified frequency and store findings in memory.",
      inputSchema: z.object({
        topic: z
          .string()
          .describe("The research topic (e.g. 'AI safety developments')"),
        frequency: z
          .enum(["daily", "weekly", "biweekly", "monthly"])
          .default("weekly")
          .describe("How often to run the research"),
        sources: z
          .array(z.string())
          .optional()
          .describe("Optional seed URLs or search queries to guide research"),
      }),
      execute: async ({ topic, frequency, sources }) => {
        if (!db) {
          return {
            success: false,
            message: "Research scheduling is not available (database not configured).",
          };
        }
        const scheduler = new ResearchScheduler(db);
        const id = await scheduler.create({
          topic,
          frequency: frequency as ResearchFrequency,
          sources,
        });
        return {
          success: true,
          id,
          message: `Scheduled "${topic}" research — running ${frequency}. Task ID: ${id}`,
        };
      },
    }),

    listResearch: tool({
      description:
        "List active scheduled research tasks and their recent results.",
      inputSchema: z.object({
        includeInactive: z
          .boolean()
          .default(false)
          .describe("Whether to include cancelled/inactive tasks"),
      }),
      execute: async ({ includeInactive }) => {
        if (!db) {
          return { tasks: [], message: "Research scheduling is not available." };
        }
        const scheduler = new ResearchScheduler(db);
        const tasks = await scheduler.list(!includeInactive);
        const recentResults = await scheduler.getRecentResults(10);

        return {
          count: tasks.length,
          tasks: tasks.map((t) => ({
            id: t.id,
            topic: t.topic,
            frequency: t.frequency,
            active: t.active,
            lastRunAt: t.lastRunAt,
            nextRunAt: t.nextRunAt,
            sources: t.sources,
          })),
          recentResults: recentResults.map((r) => ({
            taskId: r.taskId,
            summary:
              r.summary.length > 200
                ? r.summary.slice(0, 200) + "..."
                : r.summary,
            memoriesCreated: r.memoriesCreated,
            runAt: r.runAt,
          })),
        };
      },
    }),

    cancelResearch: tool({
      description: "Cancel a scheduled research task by its ID.",
      inputSchema: z.object({
        id: z.string().describe("The research task ID to cancel"),
      }),
      execute: async ({ id }) => {
        if (!db) {
          return {
            success: false,
            message: "Research scheduling is not available.",
          };
        }
        const scheduler = new ResearchScheduler(db);
        const cancelled = await scheduler.cancel(id);
        return {
          success: cancelled,
          message: cancelled
            ? "Research task cancelled."
            : "Research task not found.",
        };
      },
    }),
  };
}

// ── LLM Helper Functions ────────────────────────────────────────

/**
 * Summarize extracted content using the light model tier.
 */
async function summarizeContent(
  ai: Ai,
  _chatModel: string,
  title: string,
  content: string,
  env?: { AI_MODEL_HEAVY?: string; AI_MODEL_LIGHT?: string }
): Promise<string> {
  // Truncate content to avoid token limits
  const truncated = content.slice(0, 4000);

  try {
    const result = await runAI(
      ai,
      "light",
      [
        {
          role: "system",
          content:
            "You are a concise summarizer. Summarize the following web page content in 2-4 paragraphs. Focus on the key points, facts, and takeaways. Be objective and informative.",
        },
        {
          role: "user",
          content: `Title: ${title}\n\nContent:\n${truncated}`,
        },
      ],
      { max_tokens: 500, env }
    );

    return result || "Unable to generate summary.";
  } catch {
    return "Summary generation failed.";
  }
}

/**
 * Synthesize multiple source contents into a coherent research summary.
 */
async function synthesizeSources(
  ai: Ai,
  _chatModel: string,
  topic: string,
  contents: string[],
  env?: { AI_MODEL_HEAVY?: string; AI_MODEL_LIGHT?: string }
): Promise<string> {
  // Truncate each source and combine
  const combined = contents
    .map((c) => c.slice(0, 2000))
    .join("\n\n---\n\n");

  try {
    const result = await runAI(
      ai,
      "heavy",
      [
        {
          role: "system",
          content: `You are a research synthesizer. Given multiple sources about a topic, create a coherent synthesis that:
1. Identifies the key themes and findings across sources
2. Notes areas of agreement and disagreement
3. Provides a balanced, comprehensive summary
4. Is 3-5 paragraphs long

Be objective, factual, and cite which source supports each claim when possible.`,
        },
        {
          role: "user",
          content: `Topic: ${topic}\n\nSources:\n${combined}`,
        },
      ],
      { max_tokens: 1000, env }
    );

    return result || "Unable to generate synthesis.";
  } catch {
    return "Synthesis generation failed.";
  }
}
