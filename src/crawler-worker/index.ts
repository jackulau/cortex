/**
 * Crawler Worker — isolated Worker for CPU-intensive browser rendering and content extraction.
 *
 * Receives crawl requests via Service Binding (fetch) from the main Cortex worker.
 * Has its own BROWSER, DB, AI, STORAGE bindings for independent scaling and CPU limits.
 */
import { extractUrl } from "../browser/extract";
import { WatchListManager } from "../monitor/watchlist";
import { DigestManager } from "../monitor/digest";
import type { CrawlerEnv } from "../shared/types";
import type { CrawlMessage } from "../monitor/queue-types";

/**
 * Process a crawl request: extract content, detect changes, summarize, and store results.
 */
async function handleCrawlRequest(
  message: CrawlMessage,
  env: CrawlerEnv
): Promise<Response> {
  const { watchItem } = message;
  const watchList = new WatchListManager(env.DB);
  const digestManager = new DigestManager(env.DB);

  // Extract URL content using Browser Rendering
  const extracted = await extractUrl(env.BROWSER, env.STORAGE, watchItem.url);

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

  return Response.json({ ok: true, hash });
}

// ── Worker Entry Point ────────────────────────────────────────

export default {
  async fetch(request: Request, env: CrawlerEnv): Promise<Response> {
    // Only accept POST requests with JSON body
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const message = (await request.json()) as CrawlMessage;

      // Validate message shape
      if (message.type !== "crawl" || !message.watchItem) {
        return Response.json(
          { error: "Invalid crawl message" },
          { status: 400 }
        );
      }

      return await handleCrawlRequest(message, env);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Crawler worker error:", errorMessage);
      return Response.json({ error: errorMessage }, { status: 500 });
    }
  },
};

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

  if (
    typeof response === "object" &&
    response !== null &&
    "response" in response
  ) {
    return (response as { response: string }).response;
  }
  return String(response);
}

// Export for testing
export { handleCrawlRequest, computeSha256, summarizeChange };
