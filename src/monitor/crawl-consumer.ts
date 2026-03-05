/**
 * Crawl Consumer — processes individual crawl messages from CRAWL_QUEUE.
 * Extracts URL content, computes SHA-256 hash, detects changes,
 * summarizes with LLM, and inserts digest entries.
 *
 * Errors propagate to let the Queue retry automatically.
 */
import { extractUrl } from "../browser/extract";
import { WatchListManager } from "./watchlist";
import { DigestManager } from "./digest";
import type { Env } from "@/shared/types";
import type { CrawlMessage } from "./queue-types";

export async function processCrawlMessage(
  message: CrawlMessage,
  env: Env
): Promise<void> {
  const { watchItem } = message;
  const watchList = new WatchListManager(env.DB);
  const digestManager = new DigestManager(env.DB);

  // Extract URL content
  const extracted = await extractUrl(
    (env as any).BROWSER,
    env.STORAGE,
    watchItem.url
  );

  // Compute SHA-256 hash of the extracted content
  const hash = await computeSha256(extracted.content);

  // Detect change
  if (hash !== watchItem.lastHash) {
    // Summarize the change with LLM
    const summary = await summarizeChange(
      env.AI,
      env.CHAT_MODEL,
      watchItem.label,
      watchItem.url,
      extracted.content
    );

    // Insert digest entry
    await digestManager.addEntry({
      watchItemId: watchItem.id,
      summary,
      changes: extracted.content.slice(0, 2000),
    });
  }

  // Update last_checked and last_hash regardless
  await watchList.updateLastChecked(watchItem.id, hash);
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
