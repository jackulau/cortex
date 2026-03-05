/**
 * Queue message types for crawl fan-out and memory consolidation.
 */
import type { WatchItem } from "./watchlist";

export type CrawlMessage = {
  type: "crawl";
  watchItem: WatchItem;
};

export type ConsolidationMessage = {
  type: "consolidate";
  userMessage: string;
  assistantMessage: string;
  sessionId: string;
};
