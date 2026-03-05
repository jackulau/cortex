import { tool } from "ai";
import { z } from "zod";
import type { WatchListManager } from "@/monitor/watchlist";
import type { DigestManager } from "@/monitor/digest";

/**
 * Create watch/monitoring tools for the agent.
 * Follows the same factory pattern as createMemoryTools.
 */
export function createWatchTools(deps: {
  watchList: WatchListManager;
  digestManager: DigestManager;
  ai: Ai;
  chatModel: string;
}) {
  const { watchList, digestManager, ai, chatModel } = deps;

  return {
    watchAdd: tool({
      description:
        "Add a URL to the watch list for periodic monitoring. The crawler will check it at the specified frequency and notify you of changes.",
      inputSchema: z.object({
        url: z.string().url().describe("The URL to monitor"),
        label: z.string().describe("A short label for this watch item"),
        frequency: z
          .enum(["hourly", "daily", "weekly"])
          .default("daily")
          .describe("How often to check for changes"),
      }),
      execute: async ({ url, label, frequency }) => {
        const id = await watchList.add({ url, label, frequency });
        return {
          success: true,
          id,
          message: `Now watching "${label}" (${url}) — checking ${frequency}.`,
        };
      },
    }),

    watchList: tool({
      description:
        "List all URLs currently being monitored on the watch list.",
      inputSchema: z.object({}),
      execute: async () => {
        const items = await watchList.list();
        return {
          count: items.length,
          items: items.map((item) => ({
            id: item.id,
            url: item.url,
            label: item.label,
            frequency: item.frequency,
            lastChecked: item.lastChecked,
          })),
        };
      },
    }),

    watchRemove: tool({
      description: "Remove a URL from the watch list by its ID.",
      inputSchema: z.object({
        id: z.string().describe("The watch item ID to remove"),
      }),
      execute: async ({ id }) => {
        const removed = await watchList.remove(id);
        return {
          success: removed,
          message: removed
            ? "Watch item removed."
            : "Watch item not found.",
        };
      },
    }),

    getDigest: tool({
      description:
        "Generate and deliver a digest of all undelivered monitoring updates. Shows what has changed on watched URLs since the last digest.",
      inputSchema: z.object({}),
      execute: async () => {
        const digest = await digestManager.generateDigest(ai, chatModel);
        const hasUpdates = digest !== "No new updates to report.";
        return {
          hasUpdates,
          digest,
        };
      },
    }),
  };
}
