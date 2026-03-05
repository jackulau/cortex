import { describe, it, expect, vi, beforeEach } from "vitest";
import { SemanticMemory } from "./semantic";

// ── Mock factories ───────────────────────────────────────────

function createMockAi(): Ai {
  return {
    run: vi.fn(async (_model: string, input: { text: string[] }) => ({
      data: input.text.map(() =>
        Array.from({ length: 4 }, () => Math.random())
      ),
    })),
  } as unknown as Ai;
}

function createMockDb() {
  const preparedStmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
  };

  return {
    prepare: vi.fn().mockReturnValue(preparedStmt),
    batch: vi.fn().mockResolvedValue([]),
    _stmt: preparedStmt,
  } as unknown as D1Database & { _stmt: typeof preparedStmt };
}

function createMockVectorize() {
  return {
    upsert: vi.fn().mockResolvedValue({ count: 1 }),
    query: vi.fn().mockResolvedValue({ matches: [] }),
    deleteByIds: vi.fn().mockResolvedValue({ count: 1 }),
    getByIds: vi.fn().mockResolvedValue({ vectors: [] }),
    describe: vi.fn().mockResolvedValue({
      name: "test-index",
      dimensions: 4,
      metric: "cosine",
      vectorCount: 0,
    }),
    insert: vi.fn().mockResolvedValue({ count: 0 }),
  } as unknown as VectorizeIndex;
}

// ── Tests ────────────────────────────────────────────────────

describe("SemanticMemory", () => {
  let db: ReturnType<typeof createMockDb>;
  let ai: Ai;
  let vectorize: ReturnType<typeof createMockVectorize>;
  let memory: SemanticMemory;

  beforeEach(() => {
    db = createMockDb();
    ai = createMockAi();
    vectorize = createMockVectorize();
    memory = new SemanticMemory(
      db as unknown as D1Database,
      ai,
      "test-model",
      vectorize as unknown as VectorizeIndex
    );
  });

  describe("write()", () => {
    it("inserts into D1 and Vectorize", async () => {
      const id = await memory.write({
        content: "TypeScript is great",
        type: "fact",
        source: "user",
        tags: ["language"],
      });

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");

      // D1 batch should have been called (semantic_memories + memory_embeddings)
      expect(db.batch).toHaveBeenCalledTimes(1);

      // Vectorize upsert should have been called with the ID and embedding
      expect(vectorize.upsert).toHaveBeenCalledTimes(1);
      const upsertArgs = (vectorize.upsert as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(upsertArgs).toHaveLength(1);
      expect(upsertArgs[0].id).toBe(id);
      expect(upsertArgs[0].values).toHaveLength(4);
      expect(upsertArgs[0].metadata).toEqual({ type: "fact" });
    });

    it("writes embedding to D1 as a dual-write", async () => {
      await memory.write({
        content: "Test content",
        type: "note",
        source: "consolidated",
      });

      // Verify D1 batch was called
      expect(db.batch).toHaveBeenCalledTimes(1);

      // Verify db.prepare was called at least twice (semantic_memories + memory_embeddings)
      expect(db.prepare).toHaveBeenCalledTimes(2);
    });
  });

  describe("search()", () => {
    it("queries Vectorize and fetches metadata from D1", async () => {
      // Mock Vectorize to return matches
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [
          { id: "mem-1", score: 0.95 },
          { id: "mem-2", score: 0.80 },
        ],
      });

      // Mock D1 to return memory rows for matched IDs
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              id: "mem-1",
              content: "TypeScript is great",
              type: "fact",
              source: "user",
              tags: '["language"]',
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
            {
              id: "mem-2",
              content: "I prefer dark themes",
              type: "preference",
              source: "user",
              tags: "[]",
              createdAt: "2026-01-02T00:00:00Z",
              updatedAt: "2026-01-02T00:00:00Z",
            },
          ],
        }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const results = await memory.search("programming languages", 5);

      // Should have queried Vectorize
      expect(vectorize.query).toHaveBeenCalledTimes(1);
      const queryArgs = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(queryArgs[1]).toEqual({ topK: 5, filter: undefined });

      // Should return 2 results with correct scores
      expect(results).toHaveLength(2);
      expect(results[0].entry.id).toBe("mem-1");
      expect(results[0].score).toBe(0.95);
      expect(results[0].matchType).toBe("semantic");
      expect(results[1].entry.id).toBe("mem-2");
      expect(results[1].score).toBe(0.80);
    });

    it("passes type filter to Vectorize", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      await memory.search("test query", 3, "fact");

      const queryArgs = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(queryArgs[1]).toEqual({
        topK: 3,
        filter: { type: "fact" },
      });
    });

    it("returns empty array when Vectorize has no matches", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      const results = await memory.search("unknown topic");
      expect(results).toEqual([]);
    });

    it("handles Vectorize matches missing from D1 gracefully", async () => {
      // Vectorize returns an ID, but D1 has no matching row (orphaned vector)
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [
          { id: "orphan-id", score: 0.99 },
          { id: "valid-id", score: 0.85 },
        ],
      });

      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              id: "valid-id",
              content: "Valid memory",
              type: "note",
              source: "user",
              tags: "[]",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const results = await memory.search("test");

      // Only the valid-id should be returned, orphan-id skipped
      expect(results).toHaveLength(1);
      expect(results[0].entry.id).toBe("valid-id");
      expect(results[0].score).toBe(0.85);
    });

    it("parses tags stored as JSON string", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [{ id: "mem-1", score: 0.90 }],
      });

      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              id: "mem-1",
              content: "Tagged memory",
              type: "fact",
              source: "user",
              tags: '["tag1","tag2"]',
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const results = await memory.search("tagged");
      expect(results[0].entry.tags).toEqual(["tag1", "tag2"]);
    });
  });

  describe("delete()", () => {
    it("deletes from both D1 and Vectorize", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const deleted = await memory.delete("mem-123");

      expect(deleted).toBe(true);
      expect(db.prepare).toHaveBeenCalledWith(
        "DELETE FROM semantic_memories WHERE id = ?"
      );
      expect(vectorize.deleteByIds).toHaveBeenCalledWith(["mem-123"]);
    });

    it("returns false when D1 deletes nothing", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const deleted = await memory.delete("nonexistent");

      expect(deleted).toBe(false);
      // Should still attempt Vectorize deletion
      expect(vectorize.deleteByIds).toHaveBeenCalledWith(["nonexistent"]);
    });
  });

  describe("list()", () => {
    it("returns memories from D1 without touching Vectorize", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            {
              id: "mem-1",
              content: "Test",
              type: "fact",
              source: "user",
              tags: "[]",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
        }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const list = await memory.list({ limit: 10 });

      expect(list).toHaveLength(1);
      expect(list[0].id).toBe("mem-1");
      // Vectorize should not have been called
      expect(vectorize.query).not.toHaveBeenCalled();
      expect(vectorize.upsert).not.toHaveBeenCalled();
    });
  });

  describe("get()", () => {
    it("returns a single memory from D1", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({
          id: "mem-1",
          content: "Test fact",
          type: "fact",
          source: "user",
          tags: '["test"]',
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const result = await memory.get("mem-1");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("mem-1");
      expect(result?.tags).toEqual(["test"]);
    });

    it("returns null when memory not found", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const result = await memory.get("nonexistent");
      expect(result).toBeNull();
    });
  });
});
