import { describe, it, expect, vi } from "vitest";
import {
  checkRateLimit,
  checkAiRateLimit,
  resolveTier,
  RATE_LIMIT_TIERS,
} from "./rate-limit";

// ── Helpers ─────────────────────────────────────────────────────

/** Create a mock RateLimit binding that tracks calls. */
function createMockRateLimiter(options?: {
  /** Return false (rate limited) after this many calls */
  failAfter?: number;
  /** Always return this value */
  alwaysSucceed?: boolean;
}) {
  let callCount = 0;
  const calls: { key: string }[] = [];

  const limiter = {
    limit: vi.fn(async (opts: { key: string }) => {
      callCount++;
      calls.push(opts);

      if (options?.alwaysSucceed) return { success: true };
      if (options?.failAfter !== undefined && callCount > options.failAfter) {
        return { success: false };
      }
      return { success: true };
    }),
    calls,
    get callCount() {
      return callCount;
    },
  };

  return limiter as unknown as RateLimit & {
    limit: ReturnType<typeof vi.fn>;
    calls: { key: string }[];
    callCount: number;
  };
}

/** Create a minimal Request with the given URL and headers. */
function createRequest(
  path: string,
  headers?: Record<string, string>
): Request {
  return new Request(`https://example.com${path}`, {
    headers: headers ? new Headers(headers) : undefined,
  });
}

// ── resolveTier ─────────────────────────────────────────────────

describe("resolveTier", () => {
  it("resolves /discord paths to discord tier", () => {
    expect(resolveTier("/discord")).toBe(RATE_LIMIT_TIERS.discord);
    expect(resolveTier("/discord/webhook")).toBe(RATE_LIMIT_TIERS.discord);
  });

  it("resolves /mcp paths to mcp tier", () => {
    expect(resolveTier("/mcp")).toBe(RATE_LIMIT_TIERS.mcp);
    expect(resolveTier("/mcp/sse")).toBe(RATE_LIMIT_TIERS.mcp);
  });

  it("resolves /api/ paths to api tier", () => {
    expect(resolveTier("/api/memories")).toBe(RATE_LIMIT_TIERS.api);
    expect(resolveTier("/api/export/file.json")).toBe(RATE_LIMIT_TIERS.api);
  });

  it("defaults to api tier for unknown paths", () => {
    expect(resolveTier("/")).toBe(RATE_LIMIT_TIERS.api);
    expect(resolveTier("/unknown")).toBe(RATE_LIMIT_TIERS.api);
  });
});

// ── RATE_LIMIT_TIERS config ─────────────────────────────────────

describe("RATE_LIMIT_TIERS", () => {
  it("defines four tiers with correct weights", () => {
    expect(RATE_LIMIT_TIERS.api.weight).toBe(1);
    expect(RATE_LIMIT_TIERS.discord.weight).toBe(2);
    expect(RATE_LIMIT_TIERS.mcp.weight).toBe(3);
    expect(RATE_LIMIT_TIERS.ai.weight).toBe(5);
  });

  it("has unique prefixes per tier", () => {
    const prefixes = Object.values(RATE_LIMIT_TIERS).map((t) => t.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

// ── checkRateLimit ──────────────────────────────────────────────

describe("checkRateLimit", () => {
  it("allows requests when rate limit is not exceeded", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });
    const req = createRequest("/api/memories", {
      "CF-Connecting-IP": "1.2.3.4",
    });

    const result = await checkRateLimit(req, limiter);
    expect(result).toBeNull();
  });

  it("returns 429 when rate limit is exceeded", async () => {
    const limiter = createMockRateLimiter({ failAfter: 0 });
    const req = createRequest("/api/memories", {
      "CF-Connecting-IP": "1.2.3.4",
    });

    const result = await checkRateLimit(req, limiter);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get("Retry-After")).toBe("60");
  });

  it("includes Retry-After header in 429 response", async () => {
    const limiter = createMockRateLimiter({ failAfter: 0 });
    const req = createRequest("/api/test", {
      "CF-Connecting-IP": "5.6.7.8",
    });

    const result = await checkRateLimit(req, limiter);
    expect(result!.headers.get("Retry-After")).toBe("60");

    const body = await result!.text();
    expect(body).toBe("Too Many Requests");
  });

  it("auto-detects tier from request path", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });

    // API path -> weight 1 -> 1 call
    const apiReq = createRequest("/api/memories", {
      "CF-Connecting-IP": "1.2.3.4",
    });
    await checkRateLimit(apiReq, limiter);
    expect(limiter.limit).toHaveBeenCalledTimes(1);

    // Discord path -> weight 2 -> 2 calls
    limiter.limit.mockClear();
    const discordReq = createRequest("/discord", {
      "CF-Connecting-IP": "1.2.3.4",
    });
    await checkRateLimit(discordReq, limiter);
    expect(limiter.limit).toHaveBeenCalledTimes(2);

    // MCP path -> weight 3 -> 3 calls
    limiter.limit.mockClear();
    const mcpReq = createRequest("/mcp", {
      "CF-Connecting-IP": "1.2.3.4",
    });
    await checkRateLimit(mcpReq, limiter);
    expect(limiter.limit).toHaveBeenCalledTimes(3);
  });

  it("accepts explicit tier parameter", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });
    const req = createRequest("/any-path", {
      "CF-Connecting-IP": "1.2.3.4",
    });

    await checkRateLimit(req, limiter, RATE_LIMIT_TIERS.ai);
    expect(limiter.limit).toHaveBeenCalledTimes(5); // AI tier weight
  });

  it("uses client IP from CF-Connecting-IP header as rate limit key", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });
    const req = createRequest("/api/test", {
      "CF-Connecting-IP": "10.20.30.40",
    });

    await checkRateLimit(req, limiter);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "api:10.20.30.40" });
  });

  it("uses 'unknown' when CF-Connecting-IP header is missing", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });
    const req = createRequest("/api/test");

    await checkRateLimit(req, limiter);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "api:unknown" });
  });

  it("uses tier prefix in rate limit key for namespace separation", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });

    const discordReq = createRequest("/discord", {
      "CF-Connecting-IP": "1.1.1.1",
    });
    await checkRateLimit(discordReq, limiter);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "discord:1.1.1.1" });

    limiter.limit.mockClear();
    const mcpReq = createRequest("/mcp/sse", {
      "CF-Connecting-IP": "1.1.1.1",
    });
    await checkRateLimit(mcpReq, limiter);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "mcp:1.1.1.1" });
  });

  it("stops early on rate limit failure mid-weight", async () => {
    // Fail on the 2nd call (for a weight-3 tier)
    const limiter = createMockRateLimiter({ failAfter: 1 });
    const req = createRequest("/mcp", {
      "CF-Connecting-IP": "1.2.3.4",
    });

    const result = await checkRateLimit(req, limiter);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    // Should stop after the failing call, not continue to weight 3
    expect(limiter.limit).toHaveBeenCalledTimes(2);
  });
});

// ── checkAiRateLimit ────────────────────────────────────────────

describe("checkAiRateLimit", () => {
  it("allows AI calls when rate limit is not exceeded", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });
    const result = await checkAiRateLimit(limiter, "1.2.3.4");
    expect(result).toBeNull();
  });

  it("returns 429 when AI rate limit is exceeded", async () => {
    const limiter = createMockRateLimiter({ failAfter: 0 });
    const result = await checkAiRateLimit(limiter, "1.2.3.4");
    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get("Retry-After")).toBe("60");
  });

  it("consumes 5 units per call (AI tier weight)", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });
    await checkAiRateLimit(limiter, "1.2.3.4");
    expect(limiter.limit).toHaveBeenCalledTimes(5);
  });

  it("uses ai: prefix with client IP in rate limit key", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });
    await checkAiRateLimit(limiter, "10.0.0.1");
    expect(limiter.limit).toHaveBeenCalledWith({ key: "ai:10.0.0.1" });
  });

  it("falls back to 'server' key when no client IP provided", async () => {
    const limiter = createMockRateLimiter({ alwaysSucceed: true });
    await checkAiRateLimit(limiter);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "ai:server" });
  });
});
