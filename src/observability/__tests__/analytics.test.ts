import { describe, it, expect, vi } from "vitest";
import { CortexAnalytics } from "../analytics";

function makeMockEngine() {
  return {
    writeDataPoint: vi.fn(),
  } as unknown as AnalyticsEngineDataset;
}

describe("CortexAnalytics", () => {
  describe("trackSearch", () => {
    it("writes a data point with correct blobs, doubles, and indexes", () => {
      const engine = makeMockEngine();
      const analytics = new CortexAnalytics(engine);

      analytics.trackSearch("test query", 150, 5, 0.95);

      expect(engine.writeDataPoint).toHaveBeenCalledOnce();
      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];

      expect(call.blobs).toEqual(["semantic_search"]);
      expect(call.doubles).toEqual([150, 5, 0.95]);
      expect(call.indexes).toHaveLength(1);
      expect(typeof call.indexes[0]).toBe("string");
    });

    it("produces consistent hash indexes for the same query", () => {
      const engine = makeMockEngine();
      const analytics = new CortexAnalytics(engine);

      analytics.trackSearch("same query", 100, 3, 0.8);
      analytics.trackSearch("same query", 200, 7, 0.9);

      const calls = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(calls[0][0].indexes[0]).toBe(calls[1][0].indexes[0]);
    });

    it("produces different hash indexes for different queries", () => {
      const engine = makeMockEngine();
      const analytics = new CortexAnalytics(engine);

      analytics.trackSearch("query one", 100, 3, 0.8);
      analytics.trackSearch("query two", 200, 7, 0.9);

      const calls = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(calls[0][0].indexes[0]).not.toBe(calls[1][0].indexes[0]);
    });
  });

  describe("trackApiRequest", () => {
    it("writes a data point with endpoint, method, status, and duration", () => {
      const engine = makeMockEngine();
      const analytics = new CortexAnalytics(engine);

      analytics.trackApiRequest("/api/search", "GET", 200, 45);

      expect(engine.writeDataPoint).toHaveBeenCalledOnce();
      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];

      expect(call.blobs).toEqual(["api_request", "/api/search", "GET"]);
      expect(call.doubles).toEqual([200, 45]);
    });

    it("correctly records non-200 status codes", () => {
      const engine = makeMockEngine();
      const analytics = new CortexAnalytics(engine);

      analytics.trackApiRequest("/api/missing", "POST", 404, 12);

      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(call.doubles[0]).toBe(404);
    });
  });

  describe("trackError", () => {
    it("writes a data point with error context and type", () => {
      const engine = makeMockEngine();
      const analytics = new CortexAnalytics(engine);

      analytics.trackError("/api/search", "TypeError");

      expect(engine.writeDataPoint).toHaveBeenCalledOnce();
      const call = (engine.writeDataPoint as ReturnType<typeof vi.fn>).mock
        .calls[0][0];

      expect(call.blobs).toEqual(["error", "/api/search", "TypeError"]);
      expect(call.doubles).toEqual([1]);
    });
  });
});
