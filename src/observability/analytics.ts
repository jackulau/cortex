/**
 * CortexAnalytics — structured event tracking via Cloudflare Analytics Engine.
 * Each method writes a data point with typed blobs, doubles, and indexes.
 */

/** Simple string hash for use as an Analytics Engine index. */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

export class CortexAnalytics {
  constructor(private engine: AnalyticsEngineDataset) {}

  trackSearch(
    query: string,
    durationMs: number,
    resultCount: number,
    topScore: number
  ) {
    this.engine.writeDataPoint({
      blobs: ["semantic_search"],
      doubles: [durationMs, resultCount, topScore],
      indexes: [hashString(query)],
    });
  }

  trackApiRequest(
    endpoint: string,
    method: string,
    status: number,
    durationMs: number
  ) {
    this.engine.writeDataPoint({
      blobs: ["api_request", endpoint, method],
      doubles: [status, durationMs],
    });
  }

  trackError(context: string, errorType: string) {
    this.engine.writeDataPoint({
      blobs: ["error", context, errorType],
      doubles: [1],
    });
  }
}
