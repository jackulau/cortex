import { describe, it, expect, vi, beforeEach } from "vitest";
import { SemanticMemory } from "../semantic";

// ── Mock generateEmbedding ──────────────────────────────────────
// Return a deterministic embedding based on content hash so identical
// content produces identical vectors and different content diverges.
vi.mock("@/embeddings/generate", () => ({
  generateEmbedding: vi.fn(
    async (_ai: unknown, _model: string, text: string) => {
      return deterministicEmbedding(text);
    }
  ),
}));

/** Generate a simple deterministic 3-dimensional embedding from text. */
function deterministicEmbedding(text: string): number[] {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) & 0xffffffff;
  }
  const a = ((hash & 0xff) / 255) * 2 - 1;
  const b = (((hash >> 8) & 0xff) / 255) * 2 - 1;
  const c = (((hash >> 16) & 0xff) / 255) * 2 - 1;
  // Normalize to unit vector
  const mag = Math.sqrt(a * a + b * b + c * c) || 1;
  return [a / mag, b / mag, c / mag];
}

/** Cosine similarity between two unit vectors (dot product). */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ── Mock Factories ──────────────────────────────────────────────

/** In-memory D1 mock that stores rows in Maps. */
function createMockD1() {
  const memories = new Map<string, Record<string, unknown>>();

  const runResult = (changes = 1) => ({
    results: [],
    success: true,
    meta: { changes },
  });

  const makePrepared = (sql: string) => {
    let boundValues: unknown[] = [];

    const prepared: Record<string, unknown> = {
      bind: (...args: unknown[]) => {
        boundValues = args;
        return prepared;
      },
      run: async () => {
        if (sql.startsWith("INSERT INTO semantic_memories")) {
          const [id, content, type, source, tags, created_at, updated_at] =
            boundValues as string[];
          memories.set(id, {
            id,
            content,
            type,
            source,
            tags,
            created_at,
            updated_at,
            createdAt: created_at,
            updatedAt: updated_at,
            relevanceScore: 1.0,
            lastAccessedAt: null,
            accessCount: 0,
          });
          return runResult(1);
        }
        // touch() SQL: SET updated_at, last_accessed_at, access_count, relevance_score
        if (
          sql.includes("UPDATE semantic_memories") &&
          sql.includes("updated_at") &&
          sql.includes("access_count") &&
          sql.includes("relevance_score") &&
          !sql.includes("content") &&
          !sql.includes("WHERE id IN")
        ) {
          const [updated_at, last_accessed_at, id] = boundValues as string[];
          const row = memories.get(id);
          if (row) {
            row.updated_at = updated_at;
            row.updatedAt = updated_at;
            row.last_accessed_at = last_accessed_at;
            row.accessCount = ((row.accessCount as number) || 0) + 1;
          }
          return runResult(row ? 1 : 0);
        }
        // search() fire-and-forget access tracking (WHERE id IN (...))
        if (
          sql.includes("UPDATE semantic_memories") &&
          sql.includes("WHERE id IN")
        ) {
          return runResult(0);
        }
        if (sql.includes("UPDATE semantic_memories SET content = ?")) {
          // Handle both variants (with and without tags)
          if (sql.includes("tags")) {
            const [content, tags, updated_at, id] = boundValues as string[];
            const row = memories.get(id);
            if (row) {
              row.content = content;
              row.tags = tags;
              row.updated_at = updated_at;
              row.updatedAt = updated_at;
            }
            return runResult(row ? 1 : 0);
          } else {
            const [content, updated_at, id] = boundValues as string[];
            const row = memories.get(id);
            if (row) {
              row.content = content;
              row.updated_at = updated_at;
              row.updatedAt = updated_at;
            }
            return runResult(row ? 1 : 0);
          }
        }
        if (sql.startsWith("DELETE")) {
          const [id] = boundValues as string[];
          const existed = memories.delete(id);
          return runResult(existed ? 1 : 0);
        }
        if (sql.includes("SELECT type FROM semantic_memories")) {
          const [id] = boundValues as string[];
          const row = memories.get(id);
          return { results: row ? [{ type: row.type }] : [] };
        }
        return runResult(0);
      },
      all: async () => {
        // Handle SELECT * FROM semantic_memories WHERE id IN (...)
        const results: Record<string, unknown>[] = [];
        for (const val of boundValues) {
          const row = memories.get(val as string);
          if (row) results.push({ ...row });
        }
        return { results };
      },
      first: async () => {
        const [id] = boundValues as string[];
        const row = memories.get(id);
        return row ? { ...row } : null;
      },
    };
    return prepared;
  };

  return {
    prepare: vi.fn((sql: string) => makePrepared(sql)),
    batch: vi.fn(async (stmts: { run: () => Promise<unknown> }[]) => {
      const results = [];
      for (const stmt of stmts) {
        results.push(await stmt.run());
      }
      return results;
    }),
    _memories: memories,
  };
}

/** In-memory Vectorize mock that does real cosine similarity. */
function createMockVectorize() {
  const vectors = new Map<string, { values: number[]; metadata: unknown }>();

  return {
    upsert: vi.fn(
      async (
        entries: { id: string; values: number[]; metadata: unknown }[]
      ) => {
        for (const e of entries) {
          vectors.set(e.id, { values: e.values, metadata: e.metadata });
        }
      }
    ),
    query: vi.fn(
      async (
        queryVec: number[],
        opts: { topK: number; filter?: { type: string } }
      ) => {
        const matches: { id: string; score: number }[] = [];
        for (const [id, entry] of vectors) {
          if (
            opts.filter?.type &&
            (entry.metadata as { type: string })?.type !== opts.filter.type
          ) {
            continue;
          }
          const score = cosineSimilarity(queryVec, entry.values);
          matches.push({ id, score });
        }
        matches.sort((a, b) => b.score - a.score);
        return { matches: matches.slice(0, opts.topK) };
      }
    ),
    deleteByIds: vi.fn(async (ids: string[]) => {
      for (const id of ids) vectors.delete(id);
    }),
    _vectors: vectors,
  };
}

function createMockAi() {
  return {} as Ai;
}

// ── Tests ───────────────────────────────────────────────────────

describe("SemanticMemory deduplication", () => {
  let db: ReturnType<typeof createMockD1>;
  let vectorize: ReturnType<typeof createMockVectorize>;
  let memory: SemanticMemory;

  beforeEach(() => {
    db = createMockD1();
    vectorize = createMockVectorize();
    memory = new SemanticMemory(
      db as unknown as D1Database,
      createMockAi(),
      "test-model",
      vectorize as unknown as VectorizeIndex
    );
  });

  it("creates a new memory when no duplicate exists", async () => {
    const id = await memory.write({
      content: "User's favorite color is blue",
      type: "fact",
      source: "consolidated",
      tags: ["preference"],
    });

    expect(id).not.toBeNull();
    expect(typeof id).toBe("string");
    expect(db._memories.size).toBe(1);
    expect(vectorize.upsert).toHaveBeenCalledTimes(1);
  });

  it("returns null for a near-duplicate (same content)", async () => {
    const content = "User's favorite color is blue";

    // First write succeeds
    const id1 = await memory.write({
      content,
      type: "fact",
      source: "consolidated",
    });
    expect(id1).not.toBeNull();

    // Second write of identical content should be deduped
    const id2 = await memory.write({
      content,
      type: "fact",
      source: "consolidated",
    });
    expect(id2).toBeNull();

    // Only one memory should exist
    expect(db._memories.size).toBe(1);
  });

  it("stores both when facts are genuinely different", async () => {
    const id1 = await memory.write({
      content: "User's favorite color is blue",
      type: "fact",
      source: "consolidated",
    });

    const id2 = await memory.write({
      content: "User works as a software engineer in Tokyo",
      type: "fact",
      source: "consolidated",
    });

    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(id1).not.toBe(id2);
    expect(db._memories.size).toBe(2);
  });

  it("touches the existing memory timestamp on dedup", async () => {
    const content = "User's favorite color is blue";

    const id1 = await memory.write({
      content,
      type: "fact",
      source: "consolidated",
    });
    expect(id1).not.toBeNull();

    const originalTimestamp = db._memories.get(id1!)?.updatedAt;

    // Wait a tick so timestamps differ
    await new Promise((r) => setTimeout(r, 10));

    // Write duplicate — should touch the existing memory
    const id2 = await memory.write({
      content,
      type: "fact",
      source: "consolidated",
    });
    expect(id2).toBeNull();

    const updatedTimestamp = db._memories.get(id1!)?.updatedAt;
    expect(updatedTimestamp).not.toBe(originalTimestamp);
  });

  it("touch() updates the timestamp of an existing memory", async () => {
    const id = await memory.write({
      content: "A standalone fact for touch testing",
      type: "note",
      source: "user",
    });
    expect(id).not.toBeNull();

    const beforeTouch = db._memories.get(id!)?.updatedAt;
    await new Promise((r) => setTimeout(r, 10));

    await memory.touch(id!);

    const afterTouch = db._memories.get(id!)?.updatedAt;
    expect(afterTouch).not.toBe(beforeTouch);
  });

  it("touch() increments access_count", async () => {
    const id = await memory.write({
      content: "A fact to track access count",
      type: "fact",
      source: "consolidated",
    });
    expect(id).not.toBeNull();

    expect(db._memories.get(id!)?.accessCount).toBe(0);

    await memory.touch(id!);
    expect(db._memories.get(id!)?.accessCount).toBe(1);

    await memory.touch(id!);
    expect(db._memories.get(id!)?.accessCount).toBe(2);
  });

  it("update() changes content and re-generates embedding", async () => {
    const id = await memory.write({
      content: "User likes cats",
      type: "preference",
      source: "consolidated",
      tags: ["pets"],
    });
    expect(id).not.toBeNull();

    const originalContent = db._memories.get(id!)?.content;

    const updated = await memory.update(id!, "User likes dogs", ["pets"]);
    expect(updated).toBe(true);

    const row = db._memories.get(id!);
    expect(row?.content).toBe("User likes dogs");
    expect(row?.content).not.toBe(originalContent);

    // Vectorize should have been updated (upsert called for original write + update)
    expect(vectorize.upsert).toHaveBeenCalledTimes(2);
  });

  it("update() without tags preserves existing tags", async () => {
    const id = await memory.write({
      content: "User likes cats",
      type: "preference",
      source: "consolidated",
      tags: ["pets"],
    });
    expect(id).not.toBeNull();

    const updated = await memory.update(id!, "User likes dogs");
    expect(updated).toBe(true);

    const row = db._memories.get(id!);
    expect(row?.content).toBe("User likes dogs");
    // Tags should remain unchanged since we didn't pass new tags
    expect(row?.tags).toBe(JSON.stringify(["pets"]));
  });

  it("update() returns false for non-existent memory", async () => {
    const updated = await memory.update("non-existent-id", "Some content");
    expect(updated).toBe(false);
  });

  it("allows same content with different type filters", async () => {
    // Write as 'fact'
    const id1 = await memory.write({
      content: "User mentioned a birthday party",
      type: "fact",
      source: "consolidated",
    });

    // Write same content as 'event' — different type filter means the search
    // won't find the 'fact' type entry, so it should be stored
    const id2 = await memory.write({
      content: "User mentioned a birthday party",
      type: "event",
      source: "consolidated",
    });

    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
    expect(db._memories.size).toBe(2);
  });
});

// Mock the model-router module so consolidateTurn uses our mock AI response
vi.mock("@/ai/model-router", () => ({
  runAI: vi.fn(),
  getModel: vi.fn(() => "test-model"),
}));

describe("consolidation dedup logging", () => {
  it("logs skip message when duplicates are found", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Set up runAI mock to return a duplicate fact
    const { runAI } = await import("@/ai/model-router");
    const mockRunAI = vi.mocked(runAI);
    mockRunAI.mockResolvedValue(
      JSON.stringify([
        {
          content: "User's favorite color is blue",
          type: "fact",
          tags: ["preference"],
        },
      ])
    );

    // Import consolidateTurn after mocks are set up
    const { consolidateTurn } = await import("../consolidation");

    const db = createMockD1();
    const vectorize = createMockVectorize();
    const semanticMemory = new SemanticMemory(
      db as unknown as D1Database,
      createMockAi(),
      "test-model",
      vectorize as unknown as VectorizeIndex
    );

    // Pre-populate a memory
    await semanticMemory.write({
      content: "User's favorite color is blue",
      type: "fact",
      source: "consolidated",
    });

    await consolidateTurn(
      createMockAi(),
      "test-chat-model",
      semanticMemory,
      "My favorite color is blue",
      "I'll remember that your favorite color is blue!"
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipped 1 duplicate fact during consolidation")
    );

    consoleSpy.mockRestore();
  });
});
