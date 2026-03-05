/**
 * Scheduled Crawler — enqueues due watch items to CRAWL_QUEUE for parallel processing.
 * Individual item processing is handled by the crawl consumer.
 */
import { WatchListManager } from "./watchlist";
import type { Env } from "@/shared/types";
import type { CrawlMessage } from "./queue-types";

export async function runMonitoringCycle(env: Env): Promise<{
  enqueued: number;
}> {
  const watchList = new WatchListManager(env.DB);
  const dueItems = await watchList.getDueItems();

  for (const item of dueItems) {
    await env.CRAWL_QUEUE.send({
      type: "crawl",
      watchItem: item,
    } satisfies CrawlMessage);
  }

  return { enqueued: dueItems.length };
}
