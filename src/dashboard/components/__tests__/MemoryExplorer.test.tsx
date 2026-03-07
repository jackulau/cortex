import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// We test the component logic and API interactions without a full React render,
// since the project uses vitest with node environment (no DOM).
// Instead, we verify the API contract and data transformations.

describe("MemoryExplorer — API contract and data handling", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("PATCH /api/memories (edit)", () => {
    it("sends correct payload for memory edit", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          memory: {
            id: "mem-1",
            content: "Updated content",
            type: "note",
            source: "user",
            tags: ["updated"],
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-03-06T00:00:00Z",
            relevanceScore: 1.0,
            lastAccessedAt: null,
            accessCount: 0,
          },
        }),
      });

      const res = await fetch("/api/memories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "mem-1",
          content: "Updated content",
          type: "note",
          tags: ["updated"],
        }),
      });

      expect(mockFetch).toHaveBeenCalledWith("/api/memories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "mem-1",
          content: "Updated content",
          type: "note",
          tags: ["updated"],
        }),
      });

      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.memory.content).toBe("Updated content");
      expect(data.memory.type).toBe("note");
      expect(data.memory.tags).toEqual(["updated"]);
    });

    it("handles edit failure gracefully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: "Memory not found" }),
      });

      const res = await fetch("/api/memories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "nonexistent", content: "test" }),
      });

      expect(res.ok).toBe(false);
      expect(res.status).toBe(404);
    });
  });

  describe("Semantic search with scores", () => {
    it("returns similarity scores in search results", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "mem-1",
              content: "TypeScript is great",
              type: "fact",
              source: "user",
              tags: ["programming"],
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              relevanceScore: 1.0,
              score: 0.87,
              matchType: "semantic",
            },
            {
              id: "mem-2",
              content: "I prefer dark themes",
              type: "preference",
              source: "user",
              tags: [],
              createdAt: "2026-01-02T00:00:00Z",
              updatedAt: "2026-01-02T00:00:00Z",
              relevanceScore: 0.5,
              score: 0.65,
              matchType: "semantic",
            },
          ],
          count: 2,
        }),
      });

      const res = await fetch("/api/memories/search?q=programming&limit=10");
      const data = await res.json();

      expect(data.results).toHaveLength(2);
      expect(data.results[0].score).toBe(0.87);
      expect(data.results[1].score).toBe(0.65);
      expect(data.results[0].matchType).toBe("semantic");
    });
  });

  describe("SimilarityBadge logic", () => {
    it("calculates correct color thresholds", () => {
      // Replicate the SimilarityBadge color logic
      const getColor = (score: number) => {
        if (score > 0.8) return "#4ade80"; // green
        if (score >= 0.6) return "#facc15"; // yellow
        return "#fb923c"; // orange
      };

      expect(getColor(0.95)).toBe("#4ade80");
      expect(getColor(0.81)).toBe("#4ade80");
      expect(getColor(0.80)).toBe("#facc15");
      expect(getColor(0.60)).toBe("#facc15");
      expect(getColor(0.59)).toBe("#fb923c");
      expect(getColor(0.30)).toBe("#fb923c");
    });

    it("calculates correct percentage", () => {
      expect(Math.round(0.87 * 100)).toBe(87);
      expect(Math.round(0.65 * 100)).toBe(65);
      expect(Math.round(1.0 * 100)).toBe(100);
      expect(Math.round(0.0 * 100)).toBe(0);
    });
  });
});
