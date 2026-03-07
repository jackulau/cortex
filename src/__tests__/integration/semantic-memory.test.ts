/**
 * Integration tests for SemanticMemory against real D1 (via Miniflare).
 *
 * These tests exercise:
 * - Writing memories to D1 + Vectorize (mock)
 * - Retrieving memories by ID from D1
 * - Listing memories with type filters
 * - Semantic similarity search via mock Vectorize
 * - Deleting memories from both D1 and Vectorize
 *
 * Setup: D1 tables are created in beforeAll via Miniflare bindings.
 * Teardown: Tables are dropped in afterAll for clean test isolation.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { env } from "cloudflare:test";
import { SemanticMemory } from "@/memory/semantic";
import {
  setupD1Tables,
  teardownD1Tables,
  createMockVectorize,
  createMockAi,
} from "./helpers";

describe("SemanticMemory — D1 Integration", () => {
  let memory: SemanticMemory;
  let mockVectorize: VectorizeIndex;
  let mockAi: Ai;

  beforeAll(async () => {
    await setupD1Tables(env.DB);
    mockVectorize = createMockVectorize();
    mockAi = createMockAi();
    memory = new SemanticMemory(
      env.DB,
      mockAi,
      "@cf/baai/bge-large-en-v1.5",
      mockVectorize
    );
  });

  afterAll(async () => {
    await teardownD1Tables(env.DB);
  });

  beforeEach(async () => {
    // Ensure foreign keys are enabled (needed for cascade deletes)
    await env.DB.prepare("PRAGMA foreign_keys = ON").run();
    // Clear all rows between tests for isolation
    await env.DB.batch([
      env.DB.prepare("DELETE FROM memory_embeddings"),
      env.DB.prepare("DELETE FROM semantic_memories"),
    ]);
  });

  // ── Write ───────────────────────────────────────────────────────

  describe("write()", () => {
    it("stores a memory in D1 and returns a UUID", async () => {
      const id = await memory.write({
        content: "TypeScript is a typed superset of JavaScript",
        type: "fact",
        source: "user",
        tags: ["programming", "typescript"],
      });

      expect(id).toBeDefined();
      expect(typeof id).toBe("string");
      // UUID format check
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("persists content, type, source, and tags in D1", async () => {
      const id = await memory.write({
        content: "User prefers dark mode",
        type: "preference",
        source: "user",
        tags: ["ui"],
      });

      // Verify directly in D1
      const row = await env.DB
        .prepare("SELECT * FROM semantic_memories WHERE id = ?")
        .bind(id)
        .first<Record<string, string>>();

      expect(row).not.toBeNull();
      expect(row!.content).toBe("User prefers dark mode");
      expect(row!.type).toBe("preference");
      expect(row!.source).toBe("user");
      expect(JSON.parse(row!.tags)).toEqual(["ui"]);
    });

    it("stores embedding blob in memory_embeddings table", async () => {
      const id = await memory.write({
        content: "Test embedding storage",
        type: "note",
        source: "consolidated",
      });

      const row = await env.DB
        .prepare("SELECT * FROM memory_embeddings WHERE memory_id = ?")
        .bind(id)
        .first<Record<string, unknown>>();

      expect(row).not.toBeNull();
      expect(row!.memory_id).toBe(id);
      expect(row!.embedding).toBeDefined();
    });

    it("defaults tags to empty array when not provided", async () => {
      const id = await memory.write({
        content: "No tags memory",
        type: "fact",
        source: "user",
      });

      const row = await env.DB
        .prepare("SELECT tags FROM semantic_memories WHERE id = ?")
        .bind(id)
        .first<{ tags: string }>();

      expect(row).not.toBeNull();
      expect(JSON.parse(row!.tags)).toEqual([]);
    });

    it("writes multiple memories without conflicts", async () => {
      const ids = await Promise.all([
        memory.write({ content: "Fact one", type: "fact", source: "user" }),
        memory.write({ content: "Fact two", type: "fact", source: "user" }),
        memory.write({
          content: "Fact three",
          type: "note",
          source: "consolidated",
        }),
      ]);

      // All IDs should be unique
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);

      // All should be in D1
      const { results } = await env.DB
        .prepare("SELECT id FROM semantic_memories")
        .all<{ id: string }>();
      expect(results).toHaveLength(3);
    });
  });

  // ── Get ─────────────────────────────────────────────────────────

  describe("get()", () => {
    it("retrieves a memory by ID with parsed tags", async () => {
      const id = await memory.write({
        content: "Retrievable fact",
        type: "fact",
        source: "user",
        tags: ["test", "get"],
      });

      const result = await memory.get(id);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(id);
      expect(result!.content).toBe("Retrievable fact");
      expect(result!.type).toBe("fact");
      expect(result!.source).toBe("user");
      expect(result!.tags).toEqual(["test", "get"]);
    });

    it("returns null for non-existent ID", async () => {
      const result = await memory.get("non-existent-uuid");
      expect(result).toBeNull();
    });
  });

  // ── List ────────────────────────────────────────────────────────

  describe("list()", () => {
    it("returns all memories ordered by created_at DESC", async () => {
      // Write in sequence to ensure ordering
      await memory.write({
        content: "First",
        type: "fact",
        source: "user",
      });
      // Small delay to ensure different timestamps
      await memory.write({
        content: "Second",
        type: "note",
        source: "consolidated",
      });
      await memory.write({
        content: "Third",
        type: "preference",
        source: "user",
      });

      const list = await memory.list();

      expect(list).toHaveLength(3);
      // Most recent first
      expect(list[0].content).toBe("Third");
      expect(list[2].content).toBe("First");
    });

    it("filters by type", async () => {
      await memory.write({
        content: "A fact",
        type: "fact",
        source: "user",
      });
      await memory.write({
        content: "A preference",
        type: "preference",
        source: "user",
      });
      await memory.write({
        content: "Another fact",
        type: "fact",
        source: "consolidated",
      });

      const facts = await memory.list({ type: "fact" });
      expect(facts).toHaveLength(2);
      facts.forEach((f) => expect(f.type).toBe("fact"));
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await memory.write({
          content: `Memory ${i}`,
          type: "fact",
          source: "user",
        });
      }

      const limited = await memory.list({ limit: 3 });
      expect(limited).toHaveLength(3);
    });

    it("returns empty array when no memories exist", async () => {
      const list = await memory.list();
      expect(list).toEqual([]);
    });
  });

  // ── Search (via mock Vectorize) ────────────────────────────────

  describe("search()", () => {
    it("finds similar memories via cosine similarity", async () => {
      await memory.write({
        content: "TypeScript is great for large projects",
        type: "fact",
        source: "user",
        tags: ["typescript"],
      });
      await memory.write({
        content: "I enjoy hiking in the mountains",
        type: "preference",
        source: "user",
        tags: ["outdoors"],
      });

      const results = await memory.search("TypeScript programming language");

      expect(results.length).toBeGreaterThan(0);
      // The TypeScript-related memory should score higher
      expect(results[0].entry.content).toContain("TypeScript");
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].matchType).toBe("semantic");
    });

    it("returns scored results with entry metadata", async () => {
      await memory.write({
        content: "Python is widely used in data science",
        type: "fact",
        source: "user",
        tags: ["python", "data"],
      });

      const results = await memory.search("data science with Python");

      expect(results.length).toBeGreaterThan(0);
      const result = results[0];
      expect(result.entry).toBeDefined();
      expect(result.entry.id).toBeDefined();
      expect(result.entry.content).toBeDefined();
      expect(result.entry.type).toBe("fact");
      expect(typeof result.score).toBe("number");
    });

    it("filters results by type", async () => {
      await memory.write({
        content: "JavaScript runs in the browser",
        type: "fact",
        source: "user",
      });
      await memory.write({
        content: "I prefer JavaScript over Java",
        type: "preference",
        source: "user",
      });

      const factsOnly = await memory.search("JavaScript", 10, "fact");

      factsOnly.forEach((r) => expect(r.entry.type).toBe("fact"));
    });

    it("returns empty array when no matches found", async () => {
      // Don't write any memories — empty index
      const results = await memory.search("anything");
      expect(results).toEqual([]);
    });

    it("respects limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        await memory.write({
          content: `Programming language fact number ${i}`,
          type: "fact",
          source: "user",
        });
      }

      const results = await memory.search("programming language", 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────

  describe("delete()", () => {
    it("removes memory from D1 and returns true", async () => {
      const id = await memory.write({
        content: "To be deleted",
        type: "note",
        source: "user",
      });

      const deleted = await memory.delete(id);
      expect(deleted).toBe(true);

      // Verify gone from D1
      const row = await env.DB
        .prepare("SELECT id FROM semantic_memories WHERE id = ?")
        .bind(id)
        .first();
      expect(row).toBeNull();
    });

    it("removes embedding from memory_embeddings on cascade", async () => {
      const id = await memory.write({
        content: "Cascade delete test",
        type: "fact",
        source: "user",
      });

      await memory.delete(id);

      const embRow = await env.DB
        .prepare("SELECT memory_id FROM memory_embeddings WHERE memory_id = ?")
        .bind(id)
        .first();
      expect(embRow).toBeNull();
    });

    it("returns false when deleting non-existent ID", async () => {
      const deleted = await memory.delete("nonexistent-uuid");
      expect(deleted).toBe(false);
    });

    it("does not affect other memories", async () => {
      const keepId = await memory.write({
        content: "Keep this",
        type: "fact",
        source: "user",
      });
      const deleteId = await memory.write({
        content: "Delete this",
        type: "fact",
        source: "user",
      });

      await memory.delete(deleteId);

      const remaining = await memory.get(keepId);
      expect(remaining).not.toBeNull();
      expect(remaining!.content).toBe("Keep this");
    });
  });
});
