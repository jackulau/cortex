import { describe, it, expect } from "vitest";
import { checkAuth } from "../auth";

const VALID_KEY = "sk-test-secret-key-12345";
const INVALID_KEY = "sk-wrong-key";

function makeRequest(opts: {
  path?: string;
  authHeader?: string;
  wsUpgrade?: boolean;
  queryToken?: string;
} = {}): Request {
  const {
    path = "/api/memories",
    authHeader,
    wsUpgrade = false,
    queryToken,
  } = opts;

  let url = `https://example.com${path}`;
  if (queryToken) {
    url += `?token=${encodeURIComponent(queryToken)}`;
  }

  const headers = new Headers();
  if (authHeader !== undefined) {
    headers.set("Authorization", authHeader);
  }
  if (wsUpgrade) {
    headers.set("Upgrade", "websocket");
  }

  return new Request(url, { headers });
}

describe("checkAuth", () => {
  // ── Standard HTTP requests ──────────────────────────────────

  it("returns null when a valid Bearer token is provided", () => {
    const request = makeRequest({ authHeader: `Bearer ${VALID_KEY}` });
    const result = checkAuth(request, VALID_KEY);
    expect(result).toBeNull();
  });

  it("returns 401 when no Authorization header is present", () => {
    const request = makeRequest();
    const result = checkAuth(request, VALID_KEY);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    expect(result!.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("returns 401 when the token is invalid", () => {
    const request = makeRequest({ authHeader: `Bearer ${INVALID_KEY}` });
    const result = checkAuth(request, VALID_KEY);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 401 when the Authorization header is not Bearer scheme", () => {
    const request = makeRequest({ authHeader: `Basic ${VALID_KEY}` });
    const result = checkAuth(request, VALID_KEY);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 401 when the Authorization header is malformed (no space)", () => {
    const request = makeRequest({ authHeader: `Bearer` });
    const result = checkAuth(request, VALID_KEY);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 401 when the Authorization header has extra parts", () => {
    const request = makeRequest({ authHeader: `Bearer token extra` });
    const result = checkAuth(request, VALID_KEY);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 401 response with 'Unauthorized' body text", async () => {
    const request = makeRequest();
    const result = checkAuth(request, VALID_KEY);

    expect(result).not.toBeNull();
    expect(await result!.text()).toBe("Unauthorized");
  });

  // ── WebSocket upgrade requests ──────────────────────────────

  it("returns null for WebSocket upgrade with valid token query param", () => {
    const request = makeRequest({
      wsUpgrade: true,
      queryToken: VALID_KEY,
    });
    const result = checkAuth(request, VALID_KEY);
    expect(result).toBeNull();
  });

  it("returns 401 for WebSocket upgrade with no token", () => {
    const request = makeRequest({ wsUpgrade: true });
    const result = checkAuth(request, VALID_KEY);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 401 for WebSocket upgrade with invalid token", () => {
    const request = makeRequest({
      wsUpgrade: true,
      queryToken: INVALID_KEY,
    });
    const result = checkAuth(request, VALID_KEY);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("prefers token query param over Authorization header for WebSocket", () => {
    // WebSocket with valid query token but invalid header — should pass
    const url = `https://example.com/agents?token=${VALID_KEY}`;
    const headers = new Headers();
    headers.set("Upgrade", "websocket");
    headers.set("Authorization", `Bearer ${INVALID_KEY}`);
    const request = new Request(url, { headers });

    const result = checkAuth(request, VALID_KEY);
    expect(result).toBeNull();
  });

  // ── Timing-safe comparison ──────────────────────────────────

  it("rejects keys of different length", () => {
    const request = makeRequest({ authHeader: "Bearer short" });
    const result = checkAuth(request, "a-much-longer-key");

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("rejects keys of same length but different content", () => {
    const key = "abcdefghijklmnop";
    const wrong = "abcdefghijklmnoq";
    const request = makeRequest({ authHeader: `Bearer ${wrong}` });
    const result = checkAuth(request, key);

    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });
});
