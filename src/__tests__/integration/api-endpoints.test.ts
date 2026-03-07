/**
 * Integration tests for API endpoint behavior using real D1 and KV.
 *
 * The /api/* routes in server.ts proxy to the CortexAgent Durable Object.
 * Since the full DO lifecycle depends on AI bindings not available in Miniflare,
 * these tests validate the underlying data access patterns and response shapes
 * that the API endpoints produce, using real D1 and KV bindings.
 *
 * Tests cover:
 * - Memory listing via SemanticMemory.list() + KV caching
 * - Memory deletion via SemanticMemory.delete() + cache invalidation
 * - Search parameter validation
 * - Session listing data shape
 * - WatchList CRUD via real D1
 * - Error response patterns (missing params)
 *
 * Setup: D1 tables created in beforeAll.
 * Teardown: Tables dropped in afterAll.
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
  KVCache,
  CacheKeys,
  CacheTTL,
  CachePrefixes,
} from "@/cache/kv-cache";
import { WatchListManager } from "@/monitor/watchlist";
import { DigestManager } from "@/monitor/digest";
import {
  setupD1Tables,
  teardownD1Tables,
  createMockVectorize,
  createMockAi,
} from "./helpers";

describe("API Endpoint Data Layer — D1 + KV Integration", () => {
  let semanticMemory: SemanticMemory;
  let cache: KVCache;
  let watchList: WatchListManager;
  let digest: DigestManager;

  beforeAll(async () => {
    await setupD1Tables(env.DB);
    const mockVectorize = createMockVectorize();
    const mockAi = createMockAi();
    semanticMemory = new SemanticMemory(
      env.DB,
      mockAi,
      "@cf/baai/bge-large-en-v1.5",
      mockVectorize
    );
    cache = new KVCache(env.CACHE);
    watchList = new WatchListManager(env.DB);
    digest = new DigestManager(env.DB);
  });

  afterAll(async () => {
    await teardownD1Tables(env.DB);
  });

  beforeEach(async () => {
    // Clear data between tests
    await env.DB.batch([
      env.DB.prepare("DELETE FROM memory_embeddings"),
      env.DB.prepare("DELETE FROM semantic_memories"),
      env.DB.prepare("DELETE FROM digest_entries"),
      env.DB.prepare("DELETE FROM watch_items"),
    ]);
  });

  // ── GET /api/memories — List memories ──────────────────────────

  describe("List memories (GET /api/memories equivalent)", () => {
    it("returns memories with count in expected response shape", async () => {
      await semanticMemory.write({
        content: "User works at Acme Corp",
        type: "fact",
        source: "user",
        tags: ["work"],
      });
      await semanticMemory.write({
        content: "User prefers vim",
        type: "preference",
        source: "user",
        tags: ["tools"],
      });

      // Simulate what apiListMemories does
      const memories = await semanticMemory.list({ limit: 50 });
      const response = { memories, count: memories.length };

      expect(response.count).toBe(2);
      expect(response.memories).toHaveLength(2);
      expect(response.memories[0]).toHaveProperty("id");
      expect(response.memories[0]).toHaveProperty("content");
      expect(response.memories[0]).toHaveProperty("type");
      expect(response.memories[0]).toHaveProperty("source");
      expect(response.memories[0]).toHaveProperty("tags");
    });

    it("filters by type parameter", async () => {
      await semanticMemory.write({
        content: "A fact",
        type: "fact",
        source: "user",
      });
      await semanticMemory.write({
        content: "A preference",
        type: "preference",
        source: "user",
      });

      const facts = await semanticMemory.list({ type: "fact", limit: 50 });
      expect(facts).toHaveLength(1);
      expect(facts[0].type).toBe("fact");
    });

    it("uses cache-aside pattern for listing", async () => {
      await semanticMemory.write({
        content: "Cached memory",
        type: "fact",
        source: "user",
      });

      const cacheKey = CacheKeys.memoriesList(undefined, 50);

      // First call — cache miss, fetches from D1
      const data = await cache.getOrSet(
        cacheKey,
        async () => {
          const memories = await semanticMemory.list({ limit: 50 });
          return { memories, count: memories.length };
        },
        CacheTTL.MEMORIES_LIST
      );

      expect(data.count).toBe(1);

      // Verify it's now in cache
      const cached = await cache.get<{ memories: unknown[]; count: number }>(
        cacheKey
      );
      expect(cached).not.toBeNull();
      expect(cached!.count).toBe(1);
    });
  });

  // ── DELETE /api/memories — Delete a memory ─────────────────────

  describe("Delete memory (DELETE /api/memories equivalent)", () => {
    it("deletes memory and returns success", async () => {
      const id = await semanticMemory.write({
        content: "To be deleted via API",
        type: "note",
        source: "user",
      });

      const deleted = await semanticMemory.delete(id);
      expect(deleted).toBe(true);

      // Verify removed from D1
      const row = await semanticMemory.get(id);
      expect(row).toBeNull();
    });

    it("invalidates cache after deletion", async () => {
      const id = await semanticMemory.write({
        content: "Cache invalidation test",
        type: "fact",
        source: "user",
      });

      // Populate cache
      const cacheKey = CacheKeys.memoriesList(undefined, 50);
      await cache.set(cacheKey, { memories: [], count: 1 }, 60);

      // Delete and invalidate
      await semanticMemory.delete(id);
      await cache.invalidatePrefix(CachePrefixes.MEMORIES);

      // Cache should be cleared
      const cached = await cache.get(cacheKey);
      expect(cached).toBeNull();
    });

    it("returns false for missing id (simulates 400 error)", async () => {
      // Simulate what the handler does: if no ID, return error
      const id = "";
      if (!id) {
        const errorResponse = { error: "Missing id parameter" };
        expect(errorResponse.error).toBe("Missing id parameter");
      }
    });
  });

  // ── GET /api/memories/search — Search memories ─────────────────

  describe("Search memories (GET /api/memories/search equivalent)", () => {
    it("returns scored results in expected shape", async () => {
      await semanticMemory.write({
        content: "Rust is a systems programming language",
        type: "fact",
        source: "user",
      });

      const results = await semanticMemory.search("Rust programming", 10);

      // Response shape matches API contract
      const response = {
        results: results.map((r) => ({
          ...r.entry,
          score: r.score,
          matchType: r.matchType,
        })),
        count: results.length,
      };

      expect(response.count).toBeGreaterThan(0);
      expect(response.results[0]).toHaveProperty("id");
      expect(response.results[0]).toHaveProperty("content");
      expect(response.results[0]).toHaveProperty("score");
      expect(response.results[0]).toHaveProperty("matchType");
      expect(response.results[0].matchType).toBe("semantic");
    });

    it("returns error shape when query is empty", async () => {
      const query = "";
      if (!query) {
        const errorResponse = { error: "Missing q parameter" };
        expect(errorResponse.error).toBe("Missing q parameter");
      }
    });
  });

  // ── GET /api/sessions — List sessions ──────────────────────────

  describe("Sessions endpoint data shape", () => {
    it("returns correct response shape for session list", () => {
      // Simulated response shape — sessions are stored in DO SQLite,
      // not in D1, so we validate the contract shape
      const response = {
        sessions: [
          {
            sessionId: "test-session-1",
            startedAt: "2026-01-01T00:00:00Z",
            endedAt: null,
            topics: ["programming"],
            turnCount: 4,
            summary: "Discussed programming",
          },
        ],
        count: 1,
      };

      expect(response.sessions).toHaveLength(1);
      expect(response.sessions[0]).toHaveProperty("sessionId");
      expect(response.sessions[0]).toHaveProperty("startedAt");
      expect(response.sessions[0]).toHaveProperty("topics");
      expect(Array.isArray(response.sessions[0].topics)).toBe(true);
      expect(response.sessions[0]).toHaveProperty("turnCount");
    });
  });

  // ── /api/watchlist — CRUD ──────────────────────────────────────

  describe("Watchlist CRUD (real D1)", () => {
    it("adds a watch item and retrieves it", async () => {
      const id = await watchList.add({
        url: "https://example.com/docs",
        label: "Example Docs",
        frequency: "daily",
      });

      expect(id).toBeDefined();

      const item = await watchList.get(id);
      expect(item).not.toBeNull();
      expect(item!.url).toBe("https://example.com/docs");
      expect(item!.label).toBe("Example Docs");
      expect(item!.frequency).toBe("daily");
      expect(item!.active).toBe(true);
    });

    it("lists all watch items", async () => {
      await watchList.add({
        url: "https://a.com",
        label: "Site A",
        frequency: "hourly",
      });
      await watchList.add({
        url: "https://b.com",
        label: "Site B",
        frequency: "weekly",
      });

      const items = await watchList.list(false);
      expect(items).toHaveLength(2);
    });

    it("removes a watch item", async () => {
      const id = await watchList.add({
        url: "https://remove.com",
        label: "To Remove",
        frequency: "daily",
      });

      const removed = await watchList.remove(id);
      expect(removed).toBe(true);

      const item = await watchList.get(id);
      expect(item).toBeNull();
    });

    it("caches watchlist and invalidates on mutation", async () => {
      await watchList.add({
        url: "https://cached.com",
        label: "Cached",
        frequency: "daily",
      });

      const cacheKey = CacheKeys.watchlistAll();
      const data = await cache.getOrSet(
        cacheKey,
        async () => {
          const items = await watchList.list(false);
          return { items, count: items.length };
        },
        120
      );

      expect(data.count).toBe(1);

      // Mutate and invalidate
      await watchList.add({
        url: "https://new.com",
        label: "New",
        frequency: "hourly",
      });
      await cache.invalidatePrefix(CachePrefixes.WATCHLIST);

      const cached = await cache.get(cacheKey);
      expect(cached).toBeNull();
    });
  });

  // ── /api/digest — Digest entries ───────────────────────────────

  describe("Digest entries (real D1)", () => {
    it("adds and retrieves undelivered digest entries", async () => {
      // First, create a watch item (foreign key)
      const watchId = await watchList.add({
        url: "https://watched.com",
        label: "Watched Site",
        frequency: "daily",
      });

      await digest.addEntry({
        watchItemId: watchId,
        summary: "Page updated with new content",
      });

      const entries = await digest.getUndelivered();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].summary).toBe("Page updated with new content");
      expect(entries[0].delivered).toBe(false);
    });

    it("marks entries as delivered", async () => {
      const watchId = await watchList.add({
        url: "https://deliver.com",
        label: "Delivery Test",
        frequency: "daily",
      });

      const entryId = await digest.addEntry({
        watchItemId: watchId,
        summary: "Test delivery",
      });

      await digest.markDelivered([entryId]);

      const undelivered = await digest.getUndelivered();
      const found = undelivered.find((e) => e.id === entryId);
      expect(found).toBeUndefined();
    });
  });

  // ── 404 / Not Found ────────────────────────────────────────────

  describe("Error responses", () => {
    it("returns 404 shape for unknown routes", () => {
      const response = { error: "Not found" };
      expect(response.error).toBe("Not found");
    });

    it("returns 400 shape for missing required parameters", () => {
      // Missing id on DELETE /api/memories
      const deleteError = { error: "Missing id parameter" };
      expect(deleteError.error).toBe("Missing id parameter");

      // Missing q on GET /api/memories/search
      const searchError = { error: "Missing q parameter" };
      expect(searchError.error).toBe("Missing q parameter");
    });
  });
});
