import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getCachedResponse,
  cacheResponse,
  invalidateCachedResponse,
  invalidateApiCache,
  isCacheablePath,
  RESPONSE_CACHE_TTL,
  CACHEABLE_PATHS,
} from "./response-cache";

// ── Mock Cache API ────────────────────────────────────────────────
function createMockCache(): Cache {
  const store = new Map<string, Response>();

  return {
    match: vi.fn(async (key: RequestInfo) => {
      const url = typeof key === "string" ? key : (key as Request).url;
      const cached = store.get(url);
      return cached ? cached.clone() : undefined;
    }),
    put: vi.fn(async (key: RequestInfo, response: Response) => {
      const url = typeof key === "string" ? key : (key as Request).url;
      store.set(url, response.clone());
    }),
    delete: vi.fn(async (key: RequestInfo) => {
      const url = typeof key === "string" ? key : (key as Request).url;
      return store.delete(url);
    }),
  } as unknown as Cache;
}

describe("response-cache", () => {
  let mockCache: Cache;

  beforeEach(() => {
    mockCache = createMockCache();
  });

  // ── isCacheablePath ──────────────────────────────────────────
  describe("isCacheablePath", () => {
    it("returns true for cacheable API paths", () => {
      expect(isCacheablePath("/api/memories")).toBe(true);
      expect(isCacheablePath("/api/sessions")).toBe(true);
      expect(isCacheablePath("/api/watchlist")).toBe(true);
      expect(isCacheablePath("/api/digest")).toBe(true);
      expect(isCacheablePath("/api/rules")).toBe(true);
    });

    it("returns false for non-cacheable paths", () => {
      expect(isCacheablePath("/api/export/file.json")).toBe(false);
      expect(isCacheablePath("/api/memories/search")).toBe(false);
      expect(isCacheablePath("/discord")).toBe(false);
      expect(isCacheablePath("/")).toBe(false);
    });

    it("covers all declared CACHEABLE_PATHS", () => {
      for (const path of CACHEABLE_PATHS) {
        expect(isCacheablePath(path)).toBe(true);
      }
    });
  });

  // ── getCachedResponse ────────────────────────────────────────
  describe("getCachedResponse", () => {
    it("returns undefined on cache miss", async () => {
      const request = new Request("https://example.com/api/memories");
      const result = await getCachedResponse(request, mockCache);
      expect(result).toBeUndefined();
      expect(mockCache.match).toHaveBeenCalledWith(
        "https://example.com/api/memories"
      );
    });

    it("returns cached response with X-Cache: HIT header", async () => {
      const request = new Request("https://example.com/api/memories");
      const originalResponse = Response.json({ memories: [], count: 0 });

      // Pre-populate cache
      await cacheResponse(request, originalResponse, 120, mockCache);

      const cached = await getCachedResponse(request, mockCache);
      expect(cached).toBeDefined();
      expect(cached!.headers.get("X-Cache")).toBe("HIT");

      const body = await cached!.json();
      expect(body).toEqual({ memories: [], count: 0 });
    });

    it("preserves query params in cache key", async () => {
      const req1 = new Request(
        "https://example.com/api/memories?type=fact&limit=10"
      );
      const req2 = new Request(
        "https://example.com/api/memories?type=note&limit=50"
      );

      const resp1 = Response.json({ type: "fact" });
      const resp2 = Response.json({ type: "note" });

      await cacheResponse(req1, resp1, 120, mockCache);
      await cacheResponse(req2, resp2, 120, mockCache);

      const cached1 = await getCachedResponse(req1, mockCache);
      const cached2 = await getCachedResponse(req2, mockCache);

      expect(await cached1!.json()).toEqual({ type: "fact" });
      expect(await cached2!.json()).toEqual({ type: "note" });
    });
  });

  // ── cacheResponse ────────────────────────────────────────────
  describe("cacheResponse", () => {
    it("stores response in cache with correct Cache-Control header", async () => {
      const request = new Request("https://example.com/api/sessions");
      const response = Response.json({ sessions: [] });

      await cacheResponse(request, response, 90, mockCache);

      expect(mockCache.put).toHaveBeenCalledTimes(1);
      const putCall = (mockCache.put as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const storedResponse = putCall[1] as Response;
      expect(storedResponse.headers.get("Cache-Control")).toBe("s-maxage=90");
      expect(storedResponse.headers.get("X-Cache")).toBe("MISS");
    });

    it("uses default TTL when not specified", async () => {
      const request = new Request("https://example.com/api/watchlist");
      const response = Response.json({ items: [] });

      await cacheResponse(request, response, RESPONSE_CACHE_TTL, mockCache);

      const putCall = (mockCache.put as ReturnType<typeof vi.fn>).mock
        .calls[0];
      const storedResponse = putCall[1] as Response;
      expect(storedResponse.headers.get("Cache-Control")).toBe(
        `s-maxage=${RESPONSE_CACHE_TTL}`
      );
    });

    it("does not cache non-200 responses", async () => {
      const request = new Request("https://example.com/api/memories");
      const errorResponse = Response.json(
        { error: "Not found" },
        { status: 404 }
      );

      await cacheResponse(request, errorResponse, 120, mockCache);

      expect(mockCache.put).not.toHaveBeenCalled();
    });

    it("does not consume the original response body", async () => {
      const request = new Request("https://example.com/api/digest");
      const response = Response.json({ entries: [], count: 0 });

      await cacheResponse(request, response, 120, mockCache);

      // The original response should still be readable
      const body = await response.json();
      expect(body).toEqual({ entries: [], count: 0 });
    });
  });

  // ── invalidateCachedResponse ─────────────────────────────────
  describe("invalidateCachedResponse", () => {
    it("removes a cached entry by URL", async () => {
      const request = new Request("https://example.com/api/memories");
      const response = Response.json({ memories: [] });

      await cacheResponse(request, response, 120, mockCache);

      const deleted = await invalidateCachedResponse(
        "https://example.com/api/memories",
        mockCache
      );
      expect(deleted).toBe(true);
      expect(mockCache.delete).toHaveBeenCalledWith(
        "https://example.com/api/memories"
      );

      // Verify it's gone
      const cached = await getCachedResponse(request, mockCache);
      expect(cached).toBeUndefined();
    });

    it("returns false when entry does not exist", async () => {
      const deleted = await invalidateCachedResponse(
        "https://example.com/api/nonexistent",
        mockCache
      );
      expect(deleted).toBe(false);
    });
  });

  // ── invalidateApiCache ───────────────────────────────────────
  describe("invalidateApiCache", () => {
    it("invalidates cache for the exact URL path", async () => {
      await invalidateApiCache(
        "https://example.com/api/watchlist",
        mockCache
      );

      expect(mockCache.delete).toHaveBeenCalledWith(
        "https://example.com/api/watchlist"
      );
    });

    it("invalidates both path and full URL when query params present", async () => {
      await invalidateApiCache(
        "https://example.com/api/watchlist?id=abc",
        mockCache
      );

      expect(mockCache.delete).toHaveBeenCalledTimes(2);
      expect(mockCache.delete).toHaveBeenCalledWith(
        "https://example.com/api/watchlist"
      );
      expect(mockCache.delete).toHaveBeenCalledWith(
        "https://example.com/api/watchlist?id=abc"
      );
    });
  });

  // ── Integration: full cache lifecycle ────────────────────────
  describe("cache lifecycle", () => {
    it("miss -> store -> hit -> invalidate -> miss", async () => {
      const request = new Request("https://example.com/api/memories");
      const response = Response.json({ memories: [{ id: "1" }], count: 1 });

      // 1. Initial miss
      const miss = await getCachedResponse(request, mockCache);
      expect(miss).toBeUndefined();

      // 2. Store
      await cacheResponse(request, response, 120, mockCache);

      // 3. Hit
      const hit = await getCachedResponse(request, mockCache);
      expect(hit).toBeDefined();
      expect(hit!.headers.get("X-Cache")).toBe("HIT");
      const hitBody = await hit!.json();
      expect(hitBody).toEqual({ memories: [{ id: "1" }], count: 1 });

      // 4. Invalidate
      await invalidateCachedResponse(request.url, mockCache);

      // 5. Miss again
      const missAgain = await getCachedResponse(request, mockCache);
      expect(missAgain).toBeUndefined();
    });
  });

  // ── Constants ────────────────────────────────────────────────
  describe("constants", () => {
    it("RESPONSE_CACHE_TTL is between 60 and 120 seconds", () => {
      expect(RESPONSE_CACHE_TTL).toBeGreaterThanOrEqual(60);
      expect(RESPONSE_CACHE_TTL).toBeLessThanOrEqual(120);
    });

    it("CACHEABLE_PATHS includes all required dashboard endpoints", () => {
      expect(CACHEABLE_PATHS).toContain("/api/memories");
      expect(CACHEABLE_PATHS).toContain("/api/sessions");
      expect(CACHEABLE_PATHS).toContain("/api/watchlist");
      expect(CACHEABLE_PATHS).toContain("/api/digest");
    });
  });
});
