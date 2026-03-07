/**
 * Authentication middleware using Bearer token.
 * Returns null if the request is authenticated, or a 401 Response if unauthorized.
 *
 * For standard HTTP requests, checks the `Authorization: Bearer <key>` header.
 * For WebSocket upgrades, checks the `token` query parameter since WS clients
 * cannot easily set custom headers.
 */
export function checkAuth(request: Request, apiKey: string): Response | null {
  const isWebSocketUpgrade =
    request.headers.get("Upgrade")?.toLowerCase() === "websocket";

  if (isWebSocketUpgrade) {
    // WebSocket connections validate via query parameter
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (token && timingSafeEqual(token, apiKey)) {
      return null; // authenticated
    }
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }

  // Standard HTTP: check Authorization header
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }

  const token = parts[1];
  if (!timingSafeEqual(token, apiKey)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": "Bearer" },
    });
  }

  return null; // authenticated
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Falls back to simple comparison if crypto.subtle is unavailable.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);

  let result = 0;
  for (let i = 0; i < aBuf.length; i++) {
    result |= aBuf[i] ^ bBuf[i];
  }
  return result === 0;
}
