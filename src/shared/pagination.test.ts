import { describe, it, expect } from "vitest";
import type { PaginatedResponse, SemanticEntry } from "./types";

describe("PaginatedResponse type", () => {
  it("can represent a page with more results", () => {
    const response: PaginatedResponse<SemanticEntry> = {
      data: [
        {
          id: "mem-1",
          content: "Test",
          type: "fact",
          source: "user",
          tags: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          relevanceScore: 1.0,
          lastAccessedAt: null,
          accessCount: 0,
        },
      ],
      cursor: "2026-01-01T00:00:00Z",
      hasMore: true,
    };

    expect(response.data).toHaveLength(1);
    expect(response.cursor).toBe("2026-01-01T00:00:00Z");
    expect(response.hasMore).toBe(true);
  });

  it("can represent the last page with no more results", () => {
    const response: PaginatedResponse<SemanticEntry> = {
      data: [],
      cursor: null,
      hasMore: false,
    };

    expect(response.data).toHaveLength(0);
    expect(response.cursor).toBeNull();
    expect(response.hasMore).toBe(false);
  });

  it("works with generic types", () => {
    const response: PaginatedResponse<{ id: string; name: string }> = {
      data: [{ id: "1", name: "test" }],
      cursor: null,
      hasMore: false,
    };

    expect(response.data[0].name).toBe("test");
  });
});
