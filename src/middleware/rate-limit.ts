/**
 * Rate limiting middleware using Cloudflare Rate Limiting binding.
 * Supports per-endpoint tiers with different effective limits.
 *
 * The RATE_LIMITER binding is configured at 100 req/60s. To enforce lower
 * limits per tier, each request consumes `weight` units (calls to limit()).
 * Effective limit = 100 / weight.
 */

// ── Rate Limit Tiers ────────────────────────────────────────────

export interface RateLimitTier {
  /** Descriptive name for the tier */
  name: string;
  /** Key prefix for namespaced rate-limit counters */
  prefix: string;
  /** Number of limit() calls per request (100 / weight = effective limit) */
  weight: number;
}

/**
 * Per-endpoint rate limit tiers.
 *
 * With the binding configured at 100 req/60s:
 *   api:      weight 1  → 100 req/60s
 *   discord:  weight 2  → 50 req/60s
 *   mcp:      weight 3  → ~33 req/60s (target: 30)
 *   ai:       weight 5  → 20 req/60s
 */
export const RATE_LIMIT_TIERS: Record<string, RateLimitTier> = {
  api: { name: "API", prefix: "api", weight: 1 },
  discord: { name: "Discord", prefix: "discord", weight: 2 },
  mcp: { name: "MCP", prefix: "mcp", weight: 3 },
  ai: { name: "AI Internal", prefix: "ai", weight: 5 },
} as const;

/**
 * Resolve the appropriate rate limit tier from a request path.
 */
export function resolveTier(pathname: string): RateLimitTier {
  if (pathname.startsWith("/discord")) return RATE_LIMIT_TIERS.discord;
  if (pathname.startsWith("/mcp")) return RATE_LIMIT_TIERS.mcp;
  if (pathname.startsWith("/api/")) return RATE_LIMIT_TIERS.api;
  // Default to the API tier for unmatched routes
  return RATE_LIMIT_TIERS.api;
}

// ── Rate Limit Check ────────────────────────────────────────────

/**
 * Check rate limit for a request using per-endpoint tiers.
 *
 * Returns null if the request is allowed, or a 429 Response if blocked.
 * The tier can be provided explicitly or auto-detected from the request path.
 */
export async function checkRateLimit(
  request: Request,
  rateLimiter: RateLimit,
  tier?: RateLimitTier
): Promise<Response | null> {
  const url = new URL(request.url);
  const resolvedTier = tier ?? resolveTier(url.pathname);
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `${resolvedTier.prefix}:${clientIp}`;

  // Consume `weight` units to enforce the effective limit
  for (let i = 0; i < resolvedTier.weight; i++) {
    const { success } = await rateLimiter.limit({ key });
    if (!success) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
  }

  return null; // allowed
}

// ── AI Rate Limit ───────────────────────────────────────────────

/**
 * Check rate limit for AI calls (embeddings + chat completions).
 *
 * Uses the "ai" tier (20 req/60s) with a server-level key since
 * AI calls are internal and not tied to a specific client request.
 * When a clientIp is provided, it rate-limits per client; otherwise
 * it uses a global "server" key for internal/background AI calls.
 */
export async function checkAiRateLimit(
  rateLimiter: RateLimit,
  clientIp?: string
): Promise<Response | null> {
  const tier = RATE_LIMIT_TIERS.ai;
  const key = `${tier.prefix}:${clientIp || "server"}`;

  for (let i = 0; i < tier.weight; i++) {
    const { success } = await rateLimiter.limit({ key });
    if (!success) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
  }

  return null; // allowed
}
