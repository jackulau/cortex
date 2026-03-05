/**
 * Scheduled Crawler — runs monitoring cycles to detect changes on watched URLs.
 * Computes SHA-256 hashes for content dedup and generates digest entries on change.
 */
import { extractUrl } from "../browser/extract";
import { WatchListManager } from "./watchlist";
import { DigestManager } from "./digest";
import type { Env } from "@/shared/types";

export async function runMonitoringCycle(env: Env): Promise<{
  checked: number;
  changed: number;
  errors: number;
}> {
  const watchList = new WatchListManager(env.DB);
  const digestManager = new DigestManager(env.DB);

  const dueItems = await watchList.getDueItems();
  let checked = 0;
  let changed = 0;
  let errors = 0;

  for (const item of dueItems) {
    try {
      // Extract URL content
      const extracted = await extractUrl(
        (env as any).BROWSER,
        env.STORAGE,
        item.url
      );

      // Compute SHA-256 hash of the extracted content
      const hash = await computeSha256(extracted.content);

      checked++;

      // Detect change
      if (hash !== item.lastHash) {
        changed++;

        // Summarize the change with LLM
        const summary = await summarizeChange(
          env.AI,
          env.CHAT_MODEL,
          item.label,
          item.url,
          extracted.content
        );

        // Insert digest entry
        await digestManager.addEntry({
          watchItemId: item.id,
          summary,
          changes: extracted.content.slice(0, 2000),
        });
      }

      // Update last_checked and last_hash regardless
      await watchList.updateLastChecked(item.id, hash);
    } catch (err) {
      errors++;
      console.error(
        `Monitoring error for ${item.url}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { checked, changed, errors };
}

// ── Helpers ────────────────────────────────────────────────────

async function computeSha256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function summarizeChange(
  ai: Ai,
  chatModel: string,
  label: string,
  url: string,
  content: string
): Promise<string> {
  const truncatedContent = content.slice(0, 4000);

  const response = await ai.run(chatModel as any, {
    messages: [
      {
        role: "system",
        content:
          "You are a concise summarizer. Summarize the key content and any notable changes on this page. Keep it under 200 words.",
      },
      {
        role: "user",
        content: `Summarize the current content of "${label}" (${url}):\n\n${truncatedContent}`,
      },
    ],
  });

  if (typeof response === "object" && response !== null && "response" in response) {
    return (response as { response: string }).response;
  }
  return String(response);
}
