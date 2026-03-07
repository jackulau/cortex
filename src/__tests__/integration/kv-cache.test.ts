/**
 * Integration tests for KVCache against real KV (via Miniflare).
 *
 * These tests exercise:
 * - Setting and getting cached values with JSON serialization
 * - Cache miss behavior (returns null)
 * - Single-key invalidation
 * - Prefix-based invalidation
 * - Cache-aside pattern (getOrSet)
 *
 * Setup: KV namespace "CACHE" is automatically provisioned by Miniflare.
 * Teardown: KV is ephemeral per test run — no manual cleanup needed.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { KVCache, CacheKeys, CachePrefixes } from "@/cache/kv-cache";

describe("KVCache — KV Integration", () => {
  let cache: KVCache;

  beforeEach(() => {
    cache = new KVCache(env.CACHE);
  });

  // ── Set & Get ──────────────────────────────────────────────────

  describe("set() and get()", () => {
    it("stores and retrieves a string value", async () => {
      await cache.set("test:string", "hello world", 60);
      const result = await cache.get<string>("test:string");
      expect(result).toBe("hello world");
    });

    it("stores and retrieves an object value", async () => {
      const data = { name: "test", count: 42, nested: { flag: true } };
      await cache.set("test:object", data, 60);
      const result = await cache.get<typeof data>("test:object");
      expect(result).toEqual(data);
    });

    it("stores and retrieves an array value", async () => {
      const data = [1, 2, 3, "four", { five: 5 }];
      await cache.set("test:array", data, 60);
      const result = await cache.get<typeof data>("test:array");
      expect(result).toEqual(data);
    });

    it("returns null for a cache miss", async () => {
      const result = await cache.get("nonexistent:key");
      expect(result).toBeNull();
    });

    it("overwrites existing value on re-set", async () => {
      await cache.set("test:overwrite", "original", 60);
      await cache.set("test:overwrite", "updated", 60);
      const result = await cache.get<string>("test:overwrite");
      expect(result).toBe("updated");
    });

    it("handles null and boolean values", async () => {
      await cache.set("test:null", null, 60);
      // JSON.stringify(null) = "null", JSON.parse("null") = null
      const nullResult = await cache.get("test:null");
      expect(nullResult).toBeNull();

      await cache.set("test:bool", true, 60);
      const boolResult = await cache.get<boolean>("test:bool");
      expect(boolResult).toBe(true);
    });

    it("handles numeric values", async () => {
      await cache.set("test:number", 3.14, 60);
      const result = await cache.get<number>("test:number");
      expect(result).toBe(3.14);
    });
  });

  // ── Invalidation ───────────────────────────────────────────────

  describe("invalidate()", () => {
    it("removes a single key from cache", async () => {
      await cache.set("test:delete", "value", 60);
      await cache.invalidate("test:delete");
      const result = await cache.get("test:delete");
      expect(result).toBeNull();
    });

    it("does not throw when invalidating a non-existent key", async () => {
      await expect(
        cache.invalidate("nonexistent:key")
      ).resolves.toBeUndefined();
    });

    it("does not affect other keys", async () => {
      await cache.set("test:keep", "kept", 60);
      await cache.set("test:remove", "removed", 60);
      await cache.invalidate("test:remove");

      expect(await cache.get<string>("test:keep")).toBe("kept");
      expect(await cache.get("test:remove")).toBeNull();
    });
  });

  // ── Prefix Invalidation ────────────────────────────────────────

  describe("invalidatePrefix()", () => {
    it("removes all keys matching the prefix", async () => {
      await cache.set("memories:list:all:50", { data: "a" }, 60);
      await cache.set("memories:list:fact:10", { data: "b" }, 60);
      await cache.set("memories:search:test", { data: "c" }, 60);
      await cache.set("sessions:list:20", { data: "d" }, 60);

      await cache.invalidatePrefix(CachePrefixes.MEMORIES);

      // All memories: keys should be gone
      expect(await cache.get("memories:list:all:50")).toBeNull();
      expect(await cache.get("memories:list:fact:10")).toBeNull();
      expect(await cache.get("memories:search:test")).toBeNull();

      // sessions: key should remain
      expect(await cache.get<{ data: string }>("sessions:list:20")).toEqual({
        data: "d",
      });
    });

    it("handles empty prefix (no matching keys)", async () => {
      await cache.set("other:key", "value", 60);
      await expect(
        cache.invalidatePrefix("nonexistent:")
      ).resolves.toBeUndefined();

      // Original key untouched
      expect(await cache.get<string>("other:key")).toBe("value");
    });
  });

  // ── Cache-Aside (getOrSet) ─────────────────────────────────────

  describe("getOrSet()", () => {
    it("returns cached value without calling fetcher on hit", async () => {
      await cache.set("test:aside", "cached-value", 60);

      let fetcherCalled = false;
      const result = await cache.getOrSet(
        "test:aside",
        () => {
          fetcherCalled = true;
          return "fetched-value";
        },
        60
      );

      expect(result).toBe("cached-value");
      expect(fetcherCalled).toBe(false);
    });

    it("calls fetcher and caches result on miss", async () => {
      let fetcherCalls = 0;
      const result = await cache.getOrSet(
        "test:aside:miss",
        () => {
          fetcherCalls++;
          return { items: [1, 2, 3], count: 3 };
        },
        60
      );

      expect(result).toEqual({ items: [1, 2, 3], count: 3 });
      expect(fetcherCalls).toBe(1);

      // Second call should use cache
      const cached = await cache.getOrSet(
        "test:aside:miss",
        () => {
          fetcherCalls++;
          return { items: [], count: 0 };
        },
        60
      );

      expect(cached).toEqual({ items: [1, 2, 3], count: 3 });
      expect(fetcherCalls).toBe(1); // Fetcher not called again
    });

    it("works with async fetcher", async () => {
      const result = await cache.getOrSet(
        "test:aside:async",
        async () => {
          // Simulate async fetch
          return new Promise<string>((resolve) =>
            setTimeout(() => resolve("async-value"), 10)
          );
        },
        60
      );

      expect(result).toBe("async-value");
    });
  });

  // ── CacheKeys patterns ─────────────────────────────────────────

  describe("CacheKeys", () => {
    it("generates correct memoriesList keys", () => {
      expect(CacheKeys.memoriesList(undefined, 50)).toBe(
        "memories:list:all:50"
      );
      expect(CacheKeys.memoriesList("fact", 10)).toBe(
        "memories:list:fact:10"
      );
    });

    it("generates correct sessionsList keys", () => {
      expect(CacheKeys.sessionsList(20)).toBe("sessions:list:20");
    });

    it("generates correct static keys", () => {
      expect(CacheKeys.rulesAll()).toBe("rules:all");
      expect(CacheKeys.watchlistAll()).toBe("watchlist:all");
      expect(CacheKeys.digestUndelivered()).toBe("digest:undelivered");
    });
  });
});
