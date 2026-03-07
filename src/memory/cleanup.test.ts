import { describe, it, expect, vi } from "vitest";
import {
  runMemoryCleanup,
  detectAndRemoveDuplicates,
  pruneStaleMemories,
  mergeRelatedClusters,
  cosineSimilarity,
  type CleanupEnv,
} from "./cleanup";

// ── Mock factories ───────────────────────────────────────────

function createMockAi(): Ai {
  return {
    run: vi.fn(async (_model: string, input: any) => {
      // If it's an embedding call (has `text` field), return embeddings
      if (input.text) {
        return {
          data: input.text.map(() =>
            Array.from({ length: 4 }, () => Math.random())
          ),
        };
      }
      // Otherwise it's a chat call — return a merged summary
      return { response: "Merged summary of related facts." };
    }),
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

function createMockStorage() {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [] }),
    head: vi.fn().mockResolvedValue(null),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

function createMockEnv(): CleanupEnv & {
  _db: ReturnType<typeof createMockDb>;
  _vectorize: ReturnType<typeof createMockVectorize>;
  _storage: ReturnType<typeof createMockStorage>;
  _ai: Ai;
} {
  const db = createMockDb();
  const vectorize = createMockVectorize();
  const storage = createMockStorage();
  const ai = createMockAi();

  return {
    DB: db as unknown as D1Database,
    AI: ai,
    VECTORIZE: vectorize as unknown as VectorizeIndex,
    STORAGE: storage as unknown as R2Bucket,
    EMBEDDING_MODEL: "test-embedding-model",
    CHAT_MODEL: "test-chat-model",
    _db: db,
    _vectorize: vectorize,
    _storage: storage,
    _ai: ai,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = [1, 2, 3, 4];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe("detectAndRemoveDuplicates", () => {
  it("returns 0 when no memories exist", async () => {
    const env = createMockEnv();
    const result = await detectAndRemoveDuplicates(env);
    expect(result).toBe(0);
  });

  it("supersedes the lower-relevance duplicate", async () => {
    const env = createMockEnv();

    // First call returns a batch of memories, second call returns empty (end of iteration)
    let callCount = 0;
    (env._db._stmt.all as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          results: [
            { id: "mem-1", content: "TypeScript is great", relevance_score: 1.0 },
            { id: "mem-2", content: "TypeScript is awesome", relevance_score: 0.5 },
          ],
        };
      }
      return { results: [] };
    });

    // Vectorize returns a high-similarity match for mem-1
    (env._vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [{ id: "mem-2", score: 0.97 }],
    });

    // D1 first() returns the duplicate row
    (env._db._stmt.first as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "mem-2",
      relevance_score: 0.5,
    });

    const result = await detectAndRemoveDuplicates(env);

    expect(result).toBe(1);
    // Should have called UPDATE to set superseded_by on mem-2
    const prepareCalls = (env._db.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = prepareCalls.find(
      (c: string[]) =>
        typeof c[0] === "string" && c[0].includes("UPDATE") && c[0].includes("superseded_by")
    );
    expect(updateCall).toBeDefined();
  });

  it("does not remove memories below similarity threshold", async () => {
    const env = createMockEnv();

    let callCount = 0;
    (env._db._stmt.all as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          results: [
            { id: "mem-1", content: "TypeScript is great", relevance_score: 1.0 },
          ],
        };
      }
      return { results: [] };
    });

    // Vectorize returns a match below threshold
    (env._vectorize.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      matches: [{ id: "mem-2", score: 0.80 }],
    });

    const result = await detectAndRemoveDuplicates(env);
    expect(result).toBe(0);
  });
});

describe("pruneStaleMemories", () => {
  it("returns 0 when no stale memories found", async () => {
    const env = createMockEnv();
    const result = await pruneStaleMemories(env);
    expect(result).toBe(0);
  });

  it("archives stale memories and backs up to R2", async () => {
    const env = createMockEnv();

    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 100); // 100 days ago

    (env._db._stmt.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        {
          id: "stale-1",
          content: "Old memory",
          type: "fact",
          source: "user",
          tags: "[]",
          created_at: staleDate.toISOString(),
          updated_at: staleDate.toISOString(),
          relevance_score: 0.05,
          last_accessed_at: staleDate.toISOString(),
          access_count: 1,
          archived_at: null,
          superseded_by: null,
        },
      ],
    });

    const result = await pruneStaleMemories(env);

    expect(result).toBe(1);

    // Should have backed up to R2
    expect(env._storage.put).toHaveBeenCalledTimes(1);
    const putArgs = (env._storage.put as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(putArgs[0]).toBe("memory-archive/stale-1.json");
    expect(putArgs[1]).toContain('"stale-1"');

    // Should have marked as archived in D1
    const prepareCalls = (env._db.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const archiveCall = prepareCalls.find(
      (c: string[]) =>
        typeof c[0] === "string" &&
        c[0].includes("UPDATE") &&
        c[0].includes("archived_at")
    );
    expect(archiveCall).toBeDefined();
  });

  it("continues archiving even if one backup fails", async () => {
    const env = createMockEnv();

    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 100);

    (env._db._stmt.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        {
          id: "stale-1",
          content: "Memory 1",
          type: "fact",
          source: "user",
          tags: "[]",
          created_at: staleDate.toISOString(),
          updated_at: staleDate.toISOString(),
          relevance_score: 0.02,
          last_accessed_at: staleDate.toISOString(),
          access_count: 0,
          archived_at: null,
          superseded_by: null,
        },
        {
          id: "stale-2",
          content: "Memory 2",
          type: "note",
          source: "consolidated",
          tags: "[]",
          created_at: staleDate.toISOString(),
          updated_at: staleDate.toISOString(),
          relevance_score: 0.01,
          last_accessed_at: null,
          access_count: 0,
          archived_at: null,
          superseded_by: null,
        },
      ],
    });

    // First R2 put fails, second succeeds
    (env._storage.put as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("R2 write failed"))
      .mockResolvedValueOnce(undefined);

    const result = await pruneStaleMemories(env);

    // Only the second one should have been archived (first failed on R2 backup)
    expect(result).toBe(1);
  });
});

describe("mergeRelatedClusters", () => {
  it("returns 0 when fewer than 3 candidates", async () => {
    const env = createMockEnv();

    (env._db._stmt.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        { id: "mem-1", content: "Fact 1", type: "fact", source: "user", tags: '["ts"]', relevance_score: 1.0 },
        { id: "mem-2", content: "Fact 2", type: "fact", source: "user", tags: '["ts"]', relevance_score: 1.0 },
      ],
    });

    const result = await mergeRelatedClusters(env);
    expect(result).toBe(0);
  });

  it("merges a cluster of same-tag same-type memories", async () => {
    const env = createMockEnv();

    // Return enough memories sharing a tag and type
    (env._db._stmt.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        { id: "mem-1", content: "TypeScript supports generics", type: "fact", source: "user", tags: '["typescript"]', relevance_score: 1.0 },
        { id: "mem-2", content: "TypeScript has interfaces", type: "fact", source: "user", tags: '["typescript"]', relevance_score: 0.8 },
        { id: "mem-3", content: "TypeScript is statically typed", type: "fact", source: "user", tags: '["typescript"]', relevance_score: 0.9 },
      ],
    });

    // Mock AI embedding calls to return similar vectors (for cluster coherence check)
    const similarVector = [0.5, 0.5, 0.5, 0.5];
    (env._ai.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (_model: string, input: any) => {
        if (input.text) {
          return { data: input.text.map(() => [...similarVector]) };
        }
        return { response: "TypeScript supports generics, has interfaces, and is statically typed." };
      }
    );

    const result = await mergeRelatedClusters(env);

    expect(result).toBe(1);

    // Should have created a new merged memory (INSERT)
    const prepareCalls = (env._db.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const insertCall = prepareCalls.find(
      (c: string[]) =>
        typeof c[0] === "string" && c[0].includes("INSERT INTO semantic_memories")
    );
    expect(insertCall).toBeDefined();

    // Should have superseded the originals (3 UPDATE calls for superseded_by)
    const supersedeCalls = prepareCalls.filter(
      (c: string[]) =>
        typeof c[0] === "string" &&
        c[0].includes("UPDATE") &&
        c[0].includes("superseded_by")
    );
    expect(supersedeCalls.length).toBe(3);

    // Should have upserted the merged memory into Vectorize
    expect(env._vectorize.upsert).toHaveBeenCalledTimes(1);
  });

  it("skips clusters that fail coherence check", async () => {
    const env = createMockEnv();

    (env._db._stmt.all as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [
        { id: "mem-1", content: "TypeScript supports generics", type: "fact", source: "user", tags: '["typescript"]', relevance_score: 1.0 },
        { id: "mem-2", content: "I like pizza", type: "fact", source: "user", tags: '["typescript"]', relevance_score: 0.8 },
        { id: "mem-3", content: "The weather is nice", type: "fact", source: "user", tags: '["typescript"]', relevance_score: 0.9 },
      ],
    });

    // Mock AI to return very different embeddings (low coherence)
    let callIdx = 0;
    (env._ai.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (_model: string, input: any) => {
        if (input.text) {
          callIdx++;
          // First and second embeddings are very different
          if (callIdx === 1) {
            return { data: input.text.map(() => [1, 0, 0, 0]) };
          }
          return { data: input.text.map(() => [0, 0, 0, 1]) };
        }
        return { response: "Merged." };
      }
    );

    const result = await mergeRelatedClusters(env);
    expect(result).toBe(0);
  });
});

describe("runMemoryCleanup", () => {
  it("orchestrates all three cleanup operations", async () => {
    const env = createMockEnv();

    const result = await runMemoryCleanup(env);

    expect(result).toHaveProperty("duplicatesRemoved");
    expect(result).toHaveProperty("memoriesArchived");
    expect(result).toHaveProperty("clustersMerged");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("continues and records errors from individual operations", async () => {
    const env = createMockEnv();

    // Make DB.prepare throw on the first call (duplicate detection)
    (env._db.prepare as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("DB connection failed");
    });

    const result = await runMemoryCleanup(env);

    // Should have captured the error but continued
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain("Duplicate detection failed");
  });

  it("returns zero counts when no work to do", async () => {
    const env = createMockEnv();

    const result = await runMemoryCleanup(env);

    expect(result.duplicatesRemoved).toBe(0);
    expect(result.memoriesArchived).toBe(0);
    expect(result.clustersMerged).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
