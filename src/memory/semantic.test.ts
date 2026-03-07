import { describe, it, expect, vi, beforeEach } from "vitest";
import { SemanticMemory, decayRelevanceScores } from "./semantic";

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

/** Helper to create a mock D1 row with relevance fields. */
function mockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "mem-1",
    content: "Test content",
    type: "fact",
    source: "user",
    tags: "[]",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    relevanceScore: 1.0,
    lastAccessedAt: null,
    accessCount: 0,
    ...overrides,
  };
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

  describe("constructor", () => {
    it("defaults to 'default' namespace", () => {
      expect(memory.getNamespaceId()).toBe("default");
    });

    it("accepts a custom namespace", () => {
      const custom = new SemanticMemory(
        db as unknown as D1Database,
        ai,
        "test-model",
        vectorize as unknown as VectorizeIndex,
        "team-alpha"
      );
      expect(custom.getNamespaceId()).toBe("team-alpha");
    });
  });

  describe("write()", () => {
    it("inserts into D1 and Vectorize with namespace", async () => {
      // write() calls search() first for dedup — Vectorize returns no matches
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      const id = await memory.write({
        content: "TypeScript is great",
        type: "fact",
        source: "user",
        tags: ["language"],
      });

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");

      // D1 prepare should have been called with INSERT including namespace_id
      const prepareCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls;
      const insertCall = prepareCalls.find(
        (c: string[]) =>
          typeof c[0] === "string" && c[0].includes("INSERT INTO semantic_memories")
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![0]).toContain("namespace_id");

      // Vectorize upsert should include namespace_id in metadata
      expect(vectorize.upsert).toHaveBeenCalledTimes(1);
      const upsertArgs = (vectorize.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(upsertArgs[0].metadata).toEqual({ type: "fact", namespace_id: "default" });
    });

    it("includes custom namespace in Vectorize metadata", async () => {
      const custom = new SemanticMemory(
        db as unknown as D1Database,
        ai,
        "test-model",
        vectorize as unknown as VectorizeIndex,
        "custom-ns"
      );

      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      await custom.write({
        content: "Custom namespace memory",
        type: "note",
        source: "user",
      });

      const upsertArgs = (vectorize.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(upsertArgs[0].metadata).toEqual({ type: "note", namespace_id: "custom-ns" });
    });

    it("returns null and touches existing memory when near-duplicate found", async () => {
      // Simulate search finding a duplicate
      const selectStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            mockRow({ id: "existing-mem", content: "TypeScript is great" }),
          ],
        }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(selectStmt);

      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [{ id: "existing-mem", score: 0.95 }],
      });

      const id = await memory.write({
        content: "TypeScript is great",
        type: "fact",
        source: "user",
      });

      expect(id).toBeNull();
    });
  });

  describe("search()", () => {
    it("filters Vectorize queries by namespace", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      await memory.search("test query");

      const queryArgs = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(queryArgs[1]).toEqual({
        topK: 5,
        filter: { namespace_id: "default" },
      });
    });

    it("combines namespace filter with type filter", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      await memory.search("test query", 3, "fact");

      const queryArgs = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(queryArgs[1]).toEqual({
        topK: 3,
        filter: { namespace_id: "default", type: "fact" },
      });
    });

    it("uses custom namespace in Vectorize filter", async () => {
      const custom = new SemanticMemory(
        db as unknown as D1Database,
        ai,
        "test-model",
        vectorize as unknown as VectorizeIndex,
        "project-x"
      );

      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      await custom.search("test query");

      const queryArgs = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(queryArgs[1]).toEqual({
        topK: 5,
        filter: { namespace_id: "project-x" },
      });
    });

    it("includes namespace in D1 SELECT query", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [{ id: "mem-1", score: 0.90 }],
      });

      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [mockRow({ id: "mem-1" })],
        }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      await memory.search("test");

      // Check the D1 SELECT query includes namespace_id
      const prepareCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls;
      const selectCall = prepareCalls.find(
        (c: string[]) =>
          typeof c[0] === "string" && c[0].includes("SELECT * FROM semantic_memories")
      );
      expect(selectCall).toBeDefined();
      expect(selectCall![0]).toContain("namespace_id = ?");
    });

    it("blends vector similarity with relevance score", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [
          { id: "mem-1", score: 0.95 },
          { id: "mem-2", score: 0.80 },
        ],
      });

      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            mockRow({
              id: "mem-1",
              content: "TypeScript is great",
              relevanceScore: 1.0,
            }),
            mockRow({
              id: "mem-2",
              content: "I prefer dark themes",
              type: "preference",
              relevanceScore: 2.0,
            }),
          ],
        }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const results = await memory.search("programming languages", 5);

      expect(vectorize.query).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);

      // mem-2 has higher relevance (2.0) so should get a relevance boost
      expect(results[0].entry.id).toBe("mem-2");
      expect(results[1].entry.id).toBe("mem-1");

      // Verify blended scores
      expect(results[0].score).toBeCloseTo(0.86, 2);
      expect(results[1].score).toBeCloseTo(0.815, 2);
    });

    it("returns empty array when Vectorize has no matches", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      const results = await memory.search("unknown topic");
      expect(results).toEqual([]);
    });

    it("handles Vectorize matches missing from D1 gracefully", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [
          { id: "orphan-id", score: 0.99 },
          { id: "valid-id", score: 0.85 },
        ],
      });

      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [mockRow({ id: "valid-id", content: "Valid memory", type: "note" })],
        }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const results = await memory.search("test");

      expect(results).toHaveLength(1);
      expect(results[0].entry.id).toBe("valid-id");
    });

    it("parses tags stored as JSON string", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [{ id: "mem-1", score: 0.90 }],
      });

      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            mockRow({
              id: "mem-1",
              content: "Tagged memory",
              tags: '["tag1","tag2"]',
            }),
          ],
        }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const results = await memory.search("tagged");
      expect(results[0].entry.tags).toEqual(["tag1", "tag2"]);
    });
  });

  describe("touch()", () => {
    it("updates access tracking scoped to namespace", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      await memory.touch("mem-1");

      expect(db.prepare).toHaveBeenCalled();
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sql).toContain("UPDATE semantic_memories");
      expect(sql).toContain("namespace_id = ?");

      // bind should include namespace_id
      expect(mockStmt.bind).toHaveBeenCalledWith(
        expect.any(String), // now (updated_at)
        expect.any(String), // now (last_accessed_at)
        "mem-1",
        "default" // namespace_id
      );
    });
  });

  describe("delete()", () => {
    it("deletes from both D1 and Vectorize with namespace scoping", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const deleted = await memory.delete("mem-123");

      expect(deleted).toBe(true);
      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sql).toContain("DELETE FROM semantic_memories");
      expect(sql).toContain("namespace_id = ?");
      expect(mockStmt.bind).toHaveBeenCalledWith("mem-123", "default");
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
      expect(vectorize.deleteByIds).toHaveBeenCalledWith(["nonexistent"]);
    });
  });

  describe("list()", () => {
    it("includes namespace_id in WHERE conditions", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      await memory.list();

      const sqlArg = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sqlArg).toContain("namespace_id = ?");
      expect(sqlArg).toContain("superseded_by IS NULL");
      // First param should be namespace_id, then limit+1
      expect(mockStmt.bind).toHaveBeenCalledWith("default", 51);
    });

    it("returns paginated response", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            mockRow({ id: "mem-1", content: "Test" }),
          ],
        }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const result = await memory.list({ limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe("mem-1");
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
      expect(vectorize.query).not.toHaveBeenCalled();
    });

    it("returns hasMore=true and cursor when more results exist", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            mockRow({ id: "mem-1", createdAt: "2026-01-03T00:00:00Z" }),
            mockRow({ id: "mem-2", createdAt: "2026-01-02T00:00:00Z" }),
            mockRow({ id: "mem-3", createdAt: "2026-01-01T00:00:00Z" }),
          ],
        }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const result = await memory.list({ limit: 2 });

      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.cursor).toBe("2026-01-02T00:00:00Z");
    });

    it("passes cursor and type with namespace in bind", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      await memory.list({ type: "fact", limit: 5, cursor: "2026-01-02T00:00:00Z" });

      const sqlArg = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sqlArg).toContain("namespace_id = ?");
      expect(sqlArg).toContain("type = ?");
      expect(sqlArg).toContain("created_at < ?");
      // namespace_id first, then type, then cursor, then limit+1
      expect(mockStmt.bind).toHaveBeenCalledWith("default", "fact", "2026-01-02T00:00:00Z", 6);
    });
  });

  describe("get()", () => {
    it("returns a single memory from D1 scoped to namespace", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(
          mockRow({ id: "mem-1", content: "Test fact", tags: '["test"]' })
        ),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const result = await memory.get("mem-1");

      expect(result).not.toBeNull();
      expect(result?.id).toBe("mem-1");
      expect(result?.tags).toEqual(["test"]);

      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sql).toContain("namespace_id = ?");
      expect(mockStmt.bind).toHaveBeenCalledWith("mem-1", "default");
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

  describe("supersedeMemory()", () => {
    it("sets superseded_by scoped to namespace", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      await memory.supersedeMemory("old-mem", "new-mem");

      const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sql).toContain("superseded_by = ?");
      expect(sql).toContain("namespace_id = ?");

      expect(mockStmt.bind).toHaveBeenCalledWith(
        "new-mem",
        expect.any(String),
        "old-mem",
        "default"
      );

      expect(vectorize.deleteByIds).toHaveBeenCalledWith(["old-mem"]);
    });
  });

  describe("searchRaw()", () => {
    it("includes namespace in Vectorize filter", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      await memory.searchRaw("test query", 5);

      const queryArgs = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(queryArgs[1]).toEqual({
        topK: 5,
        filter: { namespace_id: "default" },
      });
    });

    it("combines namespace and type filters", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      await memory.searchRaw("test query", 5, "fact");

      const queryArgs = (vectorize.query as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(queryArgs[1]).toEqual({
        topK: 5,
        filter: { namespace_id: "default", type: "fact" },
      });
    });

    it("returns raw vector scores without blending", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [
          { id: "mem-1", score: 0.92 },
          { id: "mem-2", score: 0.87 },
        ],
      });

      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            mockRow({ id: "mem-1", content: "Fact A" }),
            mockRow({ id: "mem-2", content: "Fact B" }),
          ],
        }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const results = await memory.searchRaw("test query", 5);

      expect(results).toHaveLength(2);
      expect(results[0].vectorScore).toBe(0.92);
      expect(results[0].entry.id).toBe("mem-1");
      expect(results[1].vectorScore).toBe(0.87);
    });

    it("excludes superseded memories from D1 query", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [{ id: "mem-1", score: 0.90 }],
      });

      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      await memory.searchRaw("test");

      const sqlArg = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(sqlArg).toContain("superseded_by IS NULL");
      expect(sqlArg).toContain("namespace_id = ?");
    });

    it("returns empty array when no matches", async () => {
      (vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        matches: [],
      });

      const results = await memory.searchRaw("nothing");
      expect(results).toEqual([]);
    });
  });

  describe("namespace isolation", () => {
    it("different namespaces are isolated", async () => {
      const nsA = new SemanticMemory(
        db as unknown as D1Database,
        ai,
        "test-model",
        vectorize as unknown as VectorizeIndex,
        "ns-a"
      );

      const nsB = new SemanticMemory(
        db as unknown as D1Database,
        ai,
        "test-model",
        vectorize as unknown as VectorizeIndex,
        "ns-b"
      );

      expect(nsA.getNamespaceId()).toBe("ns-a");
      expect(nsB.getNamespaceId()).toBe("ns-b");
      expect(nsA.getNamespaceId()).not.toBe(nsB.getNamespaceId());
    });

    it("update() includes namespace in WHERE clause", async () => {
      const mockStmt = {
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        first: vi.fn().mockResolvedValue({ type: "fact" }),
      };
      (db as any).prepare = vi.fn().mockReturnValue(mockStmt);

      const custom = new SemanticMemory(
        db as unknown as D1Database,
        ai,
        "test-model",
        vectorize as unknown as VectorizeIndex,
        "ns-custom"
      );

      await custom.update("mem-1", "Updated content");

      const prepareCalls = (db.prepare as ReturnType<typeof vi.fn>).mock.calls;
      const updateCall = prepareCalls.find(
        (c: string[]) =>
          typeof c[0] === "string" && c[0].includes("UPDATE semantic_memories SET content")
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain("namespace_id = ?");
    });
  });
});

describe("decayRelevanceScores()", () => {
  it("runs decay UPDATE on the database (applies to all namespaces)", async () => {
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ meta: { changes: 10 } }),
    };
    const mockDb = {
      prepare: vi.fn().mockReturnValue(mockStmt),
    } as unknown as D1Database;

    await decayRelevanceScores(mockDb);

    expect(mockDb.prepare).toHaveBeenCalledTimes(1);
    const sql = (mockDb.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(sql).toContain("relevance_score = relevance_score * 0.95");
    expect(sql).toContain("relevance_score > 0.01");
    expect(mockStmt.run).toHaveBeenCalledTimes(1);
  });
});
