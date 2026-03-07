import { describe, it, expect, vi, beforeEach } from "vitest";
import { CortexAnalytics } from "./analytics";

// ── Mock Analytics Engine ────────────────────────────────────

function createMockEngine() {
  return {
    writeDataPoint: vi.fn(),
  } as unknown as AnalyticsEngineDataset;
}

// ── Tests ────────────────────────────────────────────────────

describe("CortexAnalytics", () => {
  let engine: ReturnType<typeof createMockEngine>;
  let analytics: CortexAnalytics;

  beforeEach(() => {
    engine = createMockEngine();
    analytics = new CortexAnalytics(engine);
  });

  describe("trackSearch", () => {
    it("writes a search data point", () => {
      analytics.trackSearch("test query", 50, 3, 0.95);

      expect(engine.writeDataPoint).toHaveBeenCalledTimes(1);
      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.blobs).toEqual(["semantic_search"]);
      expect(call.doubles).toEqual([50, 3, 0.95]);
      expect(call.indexes).toBeDefined();
      expect(call.indexes).toHaveLength(1);
    });
  });

  describe("trackApiRequest", () => {
    it("writes an API request data point", () => {
      analytics.trackApiRequest("/api/memories", "GET", 200, 120);

      expect(engine.writeDataPoint).toHaveBeenCalledTimes(1);
      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.blobs).toEqual(["api_request", "/api/memories", "GET"]);
      expect(call.doubles).toEqual([200, 120]);
    });
  });

  describe("trackError", () => {
    it("writes an error data point", () => {
      analytics.trackError("onChatMessage", "TypeError");

      expect(engine.writeDataPoint).toHaveBeenCalledTimes(1);
      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.blobs).toEqual(["error", "onChatMessage", "TypeError"]);
      expect(call.doubles).toEqual([1]);
    });
  });

  describe("trackAgentLoop", () => {
    it("writes an agent loop data point with step and tool counts", () => {
      analytics.trackAgentLoop("session-123", 3, 5, 2500);

      expect(engine.writeDataPoint).toHaveBeenCalledTimes(1);
      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.blobs).toEqual(["agent_loop", "session-123"]);
      expect(call.doubles).toEqual([3, 5, 2500]);
      expect(call.indexes).toBeDefined();
      expect(call.indexes).toHaveLength(1);
    });

    it("tracks single-step interactions (no tool calls)", () => {
      analytics.trackAgentLoop("session-456", 1, 0, 100);

      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.doubles[0]).toBe(1); // 1 step
      expect(call.doubles[1]).toBe(0); // 0 tool calls
      expect(call.doubles[2]).toBe(100); // 100ms
    });

    it("tracks max loop depth interactions", () => {
      analytics.trackAgentLoop("session-789", 5, 10, 15000);

      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.doubles[0]).toBe(5); // max steps
      expect(call.doubles[1]).toBe(10); // many tool calls
      expect(call.doubles[2]).toBe(15000); // 15 seconds
    });
  });
});
