import { describe, it, expect, vi, beforeEach } from "vitest";
import { KVCache, CacheKeys, CacheTTL, CachePrefixes } from "../kv-cache";

// ── Mock KVNamespace ────────────────────────────────────────────
function createMockKV(): KVNamespace {
  const store = new Map<string, string>();

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const val = store.get(key);
      if (val === undefined) return null;
      if (type === "json") return JSON.parse(val);
      return val;
    }),
    put: vi.fn(async (key: string, value: string, _opts?: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix || "";
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name, expiration: 0, metadata: null }));
      return {
        keys,
        list_complete: true,
        cacheStatus: null,
      };
    }),
    getWithMetadata: vi.fn(),
    // Expose store for test assertions
    _store: store,
  } as unknown as KVNamespace & { _store: Map<string, string> };
}

describe("KVCache", () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let cache: KVCache;

  beforeEach(() => {
    mockKV = createMockKV();
    cache = new KVCache(mockKV);
  });

  // ── get ──────────────────────────────────────────────────────
  describe("get", () => {
    it("returns null on cache miss", async () => {
      const result = await cache.get("nonexistent");
      expect(result).toBeNull();
      expect(mockKV.get).toHaveBeenCalledWith("nonexistent", "json");
    });

    it("returns typed value on cache hit", async () => {
      await mockKV.put("test-key", JSON.stringify({ data: [1, 2, 3] }));

      const result = await cache.get<{ data: number[] }>("test-key");
      expect(result).toEqual({ data: [1, 2, 3] });
    });
  });

  // ── set ──────────────────────────────────────────────────────
  describe("set", () => {
    it("stores JSON value with TTL", async () => {
      const value = { memories: ["a", "b"], count: 2 };
      await cache.set("memories:list:all:50", value, 60);

      expect(mockKV.put).toHaveBeenCalledWith(
        "memories:list:all:50",
        JSON.stringify(value),
        { expirationTtl: 60 }
      );
    });
  });

  // ── invalidate ───────────────────────────────────────────────
  describe("invalidate", () => {
    it("deletes a single key", async () => {
      await mockKV.put("test-key", '"value"');
      await cache.invalidate("test-key");

      expect(mockKV.delete).toHaveBeenCalledWith("test-key");
      const result = await cache.get("test-key");
      expect(result).toBeNull();
    });
  });

  // ── invalidatePrefix ─────────────────────────────────────────
  describe("invalidatePrefix", () => {
    it("deletes all keys matching the prefix", async () => {
      await mockKV.put("memories:list:all:50", '"data1"');
      await mockKV.put("memories:list:fact:10", '"data2"');
      await mockKV.put("sessions:list:20", '"data3"');

      await cache.invalidatePrefix("memories:");

      // memories keys should be deleted
      expect(await cache.get("memories:list:all:50")).toBeNull();
      expect(await cache.get("memories:list:fact:10")).toBeNull();
      // sessions key should remain
      expect(await cache.get("sessions:list:20")).toBe("data3");
    });

    it("handles empty prefix match gracefully", async () => {
      await cache.invalidatePrefix("nonexistent:");
      expect(mockKV.list).toHaveBeenCalledWith({ prefix: "nonexistent:" });
    });
  });

  // ── getOrSet ─────────────────────────────────────────────────
  describe("getOrSet", () => {
    it("returns cached value on cache hit without calling fetcher", async () => {
      const cached = { memories: ["cached"], count: 1 };
      await cache.set("test-key", cached, 60);

      const fetcher = vi.fn(() => ({ memories: ["fresh"], count: 1 }));
      const result = await cache.getOrSet("test-key", fetcher, 60);

      expect(result).toEqual(cached);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it("calls fetcher and caches result on cache miss", async () => {
      const freshData = { memories: ["fresh"], count: 1 };
      const fetcher = vi.fn(() => freshData);

      const result = await cache.getOrSet("test-key", fetcher, 60);

      expect(result).toEqual(freshData);
      expect(fetcher).toHaveBeenCalledOnce();
      // Verify it was stored in cache
      expect(mockKV.put).toHaveBeenCalledWith(
        "test-key",
        JSON.stringify(freshData),
        { expirationTtl: 60 }
      );
    });

    it("works with async fetchers", async () => {
      const freshData = { items: [1, 2, 3] };
      const fetcher = vi.fn(async () => freshData);

      const result = await cache.getOrSet("async-key", fetcher, 120);

      expect(result).toEqual(freshData);
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it("cache hit returns without hitting KV put", async () => {
      await cache.set("preloaded", { value: 42 }, 300);
      vi.mocked(mockKV.put).mockClear();

      const fetcher = vi.fn(() => ({ value: 99 }));
      await cache.getOrSet("preloaded", fetcher, 300);

      // put should not be called since we got a cache hit
      expect(mockKV.put).not.toHaveBeenCalled();
    });
  });

  // ── Cache invalidation flow (integration-style) ──────────────
  describe("cache-aside workflow", () => {
    it("invalidation causes next getOrSet to call fetcher", async () => {
      const fetcher = vi.fn()
        .mockResolvedValueOnce({ v: 1 })
        .mockResolvedValueOnce({ v: 2 });

      // First call: miss, populates cache
      const r1 = await cache.getOrSet("key", fetcher, 60);
      expect(r1).toEqual({ v: 1 });
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Second call: hit, returns cached
      const r2 = await cache.getOrSet("key", fetcher, 60);
      expect(r2).toEqual({ v: 1 });
      expect(fetcher).toHaveBeenCalledTimes(1);

      // Invalidate
      await cache.invalidate("key");

      // Third call: miss again, fetcher returns new value
      const r3 = await cache.getOrSet("key", fetcher, 60);
      expect(r3).toEqual({ v: 2 });
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("prefix invalidation clears related keys", async () => {
      const memoriesFetcher1 = vi.fn().mockResolvedValue({ type: "all" });
      const memoriesFetcher2 = vi.fn().mockResolvedValue({ type: "fact" });
      const sessionsFetcher = vi.fn().mockResolvedValue({ sessions: [] });

      // Populate caches
      await cache.getOrSet("memories:list:all:50", memoriesFetcher1, 60);
      await cache.getOrSet("memories:list:fact:10", memoriesFetcher2, 60);
      await cache.getOrSet("sessions:list:20", sessionsFetcher, 60);

      expect(memoriesFetcher1).toHaveBeenCalledTimes(1);
      expect(memoriesFetcher2).toHaveBeenCalledTimes(1);
      expect(sessionsFetcher).toHaveBeenCalledTimes(1);

      // Invalidate all memories
      await cache.invalidatePrefix("memories:");

      // Re-fetch memories (should call fetcher again)
      await cache.getOrSet("memories:list:all:50", memoriesFetcher1, 60);
      await cache.getOrSet("memories:list:fact:10", memoriesFetcher2, 60);
      // Sessions should still be cached
      await cache.getOrSet("sessions:list:20", sessionsFetcher, 60);

      expect(memoriesFetcher1).toHaveBeenCalledTimes(2);
      expect(memoriesFetcher2).toHaveBeenCalledTimes(2);
      expect(sessionsFetcher).toHaveBeenCalledTimes(1); // not called again
    });
  });
});

// ── CacheKeys ──────────────────────────────────────────────────
describe("CacheKeys", () => {
  it("generates correct memories list key with type", () => {
    expect(CacheKeys.memoriesList("fact", 50)).toBe("memories:list:fact:50");
  });

  it("generates correct memories list key without type", () => {
    expect(CacheKeys.memoriesList(undefined, 50)).toBe(
      "memories:list:all:50"
    );
  });

  it("generates correct sessions list key", () => {
    expect(CacheKeys.sessionsList(20)).toBe("sessions:list:20");
  });

  it("generates correct rules key", () => {
    expect(CacheKeys.rulesAll()).toBe("rules:all");
  });

  it("generates correct watchlist key", () => {
    expect(CacheKeys.watchlistAll()).toBe("watchlist:all");
  });

  it("generates correct digest key", () => {
    expect(CacheKeys.digestUndelivered()).toBe("digest:undelivered");
  });
});

// ── CacheTTL ───────────────────────────────────────────────────
describe("CacheTTL", () => {
  it("has appropriate TTL values", () => {
    expect(CacheTTL.MEMORIES_LIST).toBe(60);
    expect(CacheTTL.SESSIONS_LIST).toBe(60);
    expect(CacheTTL.RULES).toBe(300);
    expect(CacheTTL.WATCHLIST).toBe(120);
    expect(CacheTTL.DIGEST).toBe(60);
  });
});

// ── CachePrefixes ──────────────────────────────────────────────
describe("CachePrefixes", () => {
  it("has correct prefix values", () => {
    expect(CachePrefixes.MEMORIES).toBe("memories:");
    expect(CachePrefixes.SESSIONS).toBe("sessions:");
    expect(CachePrefixes.RULES).toBe("rules:");
    expect(CachePrefixes.WATCHLIST).toBe("watchlist:");
    expect(CachePrefixes.DIGEST).toBe("digest:");
  });
});
