/**
 * Crawl Consumer — forwards crawl messages to the isolated Crawler Worker
 * via Service Binding (env.CRAWLER_SERVICE).
 *
 * The actual crawl processing (browser rendering, content extraction,
 * change detection, summarization) happens in the crawler worker,
 * which has independent CPU limits and scaling.
 *
 * Errors propagate to let the Queue retry automatically.
 */
import type { Env } from "@/shared/types";
import type { CrawlMessage } from "./queue-types";

export async function processCrawlMessage(
  message: CrawlMessage,
  env: Env
): Promise<void> {
  // Forward the crawl message to the isolated crawler worker via Service Binding
  const response = await env.CRAWLER_SERVICE.fetch(
    new Request("https://crawler.internal/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    })
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Crawler service returned ${response.status}: ${errorBody}`
    );
  }
}
