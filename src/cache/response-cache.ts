/**
 * Cache API (Tier 1) — edge-local HTTP response caching.
 * Complements KV cache (Tier 2) with sub-millisecond reads for hot-path API responses.
 *
 * Uses `caches.default` (Cloudflare Workers global cache instance).
 * Short TTLs (60-120s) keep data fresh while eliminating DO round-trips
 * for repeated dashboard API calls within the same colo.
 */

/** Default TTL for cached API responses (seconds). */
export const RESPONSE_CACHE_TTL = 120;

/** API paths eligible for Cache API caching. */
export const CACHEABLE_PATHS = [
  "/api/memories",
  "/api/sessions",
  "/api/watchlist",
  "/api/digest",
  "/api/rules",
] as const;

/**
 * Build a cache key URL from a request.
 * The Cache API requires a full URL as key. We use the original request URL
 * including query params so different query variations are cached separately.
 */
function getCacheKey(request: Request): string {
  return request.url;
}

/**
 * Check if a request path is eligible for response caching.
 */
export function isCacheablePath(pathname: string): boolean {
  return CACHEABLE_PATHS.some((p) => pathname === p);
}

/**
 * Retrieve a cached response from the Cache API.
 * Returns the cached Response or undefined on cache miss.
 */
export async function getCachedResponse(
  request: Request,
  cache?: Cache
): Promise<Response | undefined> {
  const cacheInstance = cache ?? caches.default;
  const cacheKey = getCacheKey(request);
  const match = await cacheInstance.match(cacheKey);
  if (match) {
    // Clone and add a header indicating cache hit for observability
    const headers = new Headers(match.headers);
    headers.set("X-Cache", "HIT");
    return new Response(match.body, {
      status: match.status,
      statusText: match.statusText,
      headers,
    });
  }
  return undefined;
}

/**
 * Store a response in the Cache API with the given TTL.
 * Clones the response so the original can still be consumed by the caller.
 */
export async function cacheResponse(
  request: Request,
  response: Response,
  ttlSeconds: number = RESPONSE_CACHE_TTL,
  cache?: Cache
): Promise<void> {
  const cacheInstance = cache ?? caches.default;

  // Only cache successful JSON responses
  if (response.status !== 200) return;

  const cacheKey = getCacheKey(request);

  // Clone and set Cache-Control for TTL
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", `s-maxage=${ttlSeconds}`);
  headers.set("X-Cache", "MISS");

  const cachedResponse = new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  await cacheInstance.put(cacheKey, cachedResponse);
}

/**
 * Invalidate cached responses for a specific URL.
 */
export async function invalidateCachedResponse(
  url: string,
  cache?: Cache
): Promise<boolean> {
  const cacheInstance = cache ?? caches.default;
  return cacheInstance.delete(url);
}

/**
 * Invalidate all cached responses for cacheable API paths related to a base URL.
 * Used after mutating operations (POST, DELETE, PATCH) to ensure stale data is purged.
 */
export async function invalidateApiCache(
  requestUrl: string,
  cache?: Cache
): Promise<void> {
  const cacheInstance = cache ?? caches.default;
  const url = new URL(requestUrl);
  const baseUrl = `${url.origin}`;

  // Invalidate the exact path (without query params)
  const pathUrl = `${baseUrl}${url.pathname}`;
  await cacheInstance.delete(pathUrl);

  // Also invalidate with query params if present
  if (url.search) {
    await cacheInstance.delete(requestUrl);
  }
}
