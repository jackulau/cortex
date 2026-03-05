/**
 * Cache-aside helper for Workers KV.
 * Wraps KVNamespace with typed get/set/invalidate + prefix invalidation.
 */
export class KVCache {
  constructor(private kv: KVNamespace) {}

  /**
   * Retrieve a cached value by key. Returns null on cache miss.
   */
  async get<T>(key: string): Promise<T | null> {
    return this.kv.get(key, "json");
  }

  /**
   * Store a value in cache with an expiration TTL (in seconds).
   */
  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.kv.put(key, JSON.stringify(value), {
      expirationTtl: ttlSeconds,
    });
  }

  /**
   * Invalidate a single cache key.
   */
  async invalidate(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  /**
   * Invalidate all keys matching a prefix.
   * Lists keys with the prefix and deletes them in parallel.
   */
  async invalidatePrefix(prefix: string): Promise<void> {
    const list = await this.kv.list({ prefix });
    await Promise.all(list.keys.map((k) => this.kv.delete(k.name)));
  }

  /**
   * Cache-aside pattern: try cache first, fall back to fetcher on miss.
   * Stores the fetched value in cache with the given TTL.
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => T | Promise<T>,
    ttlSeconds: number
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    const value = await fetcher();
    await this.set(key, value, ttlSeconds);
    return value;
  }
}

// ── Cache key patterns ──────────────────────────────────────────
export const CacheKeys = {
  memoriesList: (type: string | undefined, limit: number) =>
    `memories:list:${type || "all"}:${limit}`,
  sessionsList: (limit: number) => `sessions:list:${limit}`,
  rulesAll: () => "rules:all",
  watchlistAll: () => "watchlist:all",
  digestUndelivered: () => "digest:undelivered",
} as const;

// ── Cache TTL constants (seconds) ───────────────────────────────
export const CacheTTL = {
  MEMORIES_LIST: 60,
  SESSIONS_LIST: 60,
  RULES: 300,
  WATCHLIST: 120,
  DIGEST: 60,
} as const;

// ── Cache prefix patterns for invalidation ──────────────────────
export const CachePrefixes = {
  MEMORIES: "memories:",
  SESSIONS: "sessions:",
  RULES: "rules:",
  WATCHLIST: "watchlist:",
  DIGEST: "digest:",
} as const;
