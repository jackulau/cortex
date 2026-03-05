import { describe, it, expect, vi } from "vitest";
import { checkRateLimit } from "../rate-limit";

function makeRequest(ip?: string): Request {
  const headers = new Headers();
  if (ip) {
    headers.set("CF-Connecting-IP", ip);
  }
  return new Request("https://example.com/api/test", { headers });
}

function makeMockRateLimiter(success: boolean) {
  return {
    limit: vi.fn().mockResolvedValue({ success }),
  } as unknown as RateLimit;
}

describe("checkRateLimit", () => {
  it("returns null when the request is within the rate limit", async () => {
    const rateLimiter = makeMockRateLimiter(true);
    const request = makeRequest("1.2.3.4");

    const result = await checkRateLimit(request, rateLimiter, 100);

    expect(result).toBeNull();
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: "1.2.3.4" });
  });

  it("returns a 429 response when the rate limit is exceeded", async () => {
    const rateLimiter = makeMockRateLimiter(false);
    const request = makeRequest("1.2.3.4");

    const result = await checkRateLimit(request, rateLimiter, 100);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(429);
    expect(result!.headers.get("Retry-After")).toBe("60");
    expect(await result!.text()).toBe("Too Many Requests");
  });

  it("uses 'unknown' as key when CF-Connecting-IP header is missing", async () => {
    const rateLimiter = makeMockRateLimiter(true);
    const request = makeRequest(); // no IP header

    await checkRateLimit(request, rateLimiter, 100);

    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: "unknown" });
  });

  it("passes distinct IPs as distinct rate limit keys", async () => {
    const rateLimiter = makeMockRateLimiter(true);

    await checkRateLimit(makeRequest("10.0.0.1"), rateLimiter, 100);
    await checkRateLimit(makeRequest("10.0.0.2"), rateLimiter, 100);

    expect(rateLimiter.limit).toHaveBeenCalledTimes(2);
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: "10.0.0.1" });
    expect(rateLimiter.limit).toHaveBeenCalledWith({ key: "10.0.0.2" });
  });
});
