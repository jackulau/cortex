/**
 * Rate limiting middleware using Cloudflare Rate Limiting binding.
 * Returns null if the request is allowed, or a 429 Response if blocked.
 */
export async function checkRateLimit(
  request: Request,
  rateLimiter: RateLimit,
  limit: number
): Promise<Response | null> {
  const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
  const { success } = await rateLimiter.limit({ key: clientIp });
  if (!success) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  }
  return null; // allowed
}
