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

  /**
   * Track agent loop depth per chat request.
   * Records how many LLM steps (tool call -> observe -> decide cycles)
   * were used to complete a single user message.
   */
  trackAgentLoop(
    sessionId: string,
    stepCount: number,
    toolCallCount: number,
    durationMs: number
  ) {
    this.engine.writeDataPoint({
      blobs: ["agent_loop", sessionId],
      doubles: [stepCount, toolCallCount, durationMs],
      indexes: [hashString(sessionId)],
    });
  }

  /**
   * Track R2 event notifications (object create, delete, etc.).
   * Records the action type, object key, and object size.
   */
  trackR2Event(action: string, objectKey: string, objectSize: number) {
    this.engine.writeDataPoint({
      blobs: ["r2_event", action, objectKey],
      doubles: [objectSize],
      indexes: [hashString(objectKey)],
    });
  }
}
