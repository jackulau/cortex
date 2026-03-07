import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkAccessAuth,
  verifyAccessJwt,
  _resetKeyCache,
} from "./access-auth";

const TEAM_DOMAIN = "myteam";
const AUD = "test-audience-tag-abc123";
const ISSUER = `https://${TEAM_DOMAIN}.cloudflareaccess.com`;
const CERTS_URL = `https://${TEAM_DOMAIN}.cloudflareaccess.com/cdn-cgi/access/certs`;

// ── Helpers ──────────────────────────────────────────────────────

/** Base64url encode a string */
function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Create a fake JWT with the given header and payload (signature is arbitrary) */
function makeFakeJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signature = "fake-signature"
): string {
  return [
    base64UrlEncode(JSON.stringify(header)),
    base64UrlEncode(JSON.stringify(payload)),
    base64UrlEncode(signature),
  ].join(".");
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: [AUD],
    email: "user@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) - 60,
    iss: ISSUER,
    sub: "user-id-123",
    type: "app",
    ...overrides,
  };
}

function validHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alg: "RS256",
    kid: "key-1",
    typ: "JWT",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("checkAccessAuth", () => {
  beforeEach(() => {
    _resetKeyCache();
  });

  it("returns null (allow) for /discord path without any JWT", async () => {
    const request = new Request("https://example.com/discord/webhook", {
      method: "POST",
    });

    const result = await checkAccessAuth(request, TEAM_DOMAIN, AUD);
    expect(result).toBeNull();
  });

  it("returns null (allow) for /discord subpath", async () => {
    const request = new Request("https://example.com/discord/interactions", {
      method: "POST",
    });

    const result = await checkAccessAuth(request, TEAM_DOMAIN, AUD);
    expect(result).toBeNull();
  });

  it("returns 403 when CF-Access-JWT-Assertion header is missing", async () => {
    const request = new Request("https://example.com/api/data");

    const result = await checkAccessAuth(request, TEAM_DOMAIN, AUD);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    const body = await result!.text();
    expect(body).toBe("Forbidden");
  });

  it("returns 403 for /api/* without JWT", async () => {
    const request = new Request("https://example.com/api/memories");

    const result = await checkAccessAuth(request, TEAM_DOMAIN, AUD);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 for /mcp without JWT", async () => {
    const request = new Request("https://example.com/mcp");

    const result = await checkAccessAuth(request, TEAM_DOMAIN, AUD);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 for dashboard root without JWT", async () => {
    const request = new Request("https://example.com/");

    const result = await checkAccessAuth(request, TEAM_DOMAIN, AUD);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when JWT has invalid format (not 3 parts)", async () => {
    const request = new Request("https://example.com/api/data", {
      headers: { "CF-Access-JWT-Assertion": "not-a-valid-jwt" },
    });

    const result = await checkAccessAuth(request, TEAM_DOMAIN, AUD);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it("returns 403 when JWT has invalid format (2 parts)", async () => {
    const request = new Request("https://example.com/api/data", {
      headers: { "CF-Access-JWT-Assertion": "part1.part2" },
    });

    const result = await checkAccessAuth(request, TEAM_DOMAIN, AUD);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });
});

describe("verifyAccessJwt", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetKeyCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns false for token with wrong number of parts", async () => {
    const result = await verifyAccessJwt("not.valid", TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false for token with only one part", async () => {
    const result = await verifyAccessJwt("singlepart", TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false for empty string", async () => {
    const result = await verifyAccessJwt("", TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false when issuer does not match", async () => {
    const token = makeFakeJwt(validHeader(), validPayload({ iss: "https://wrong.cloudflareaccess.com" }));

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false when audience does not match", async () => {
    const token = makeFakeJwt(validHeader(), validPayload({ aud: ["wrong-audience"] }));

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false when audience is not an array", async () => {
    const token = makeFakeJwt(validHeader(), validPayload({ aud: "not-an-array" }));

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false when token is expired", async () => {
    const token = makeFakeJwt(
      validHeader(),
      validPayload({ exp: Math.floor(Date.now() / 1000) - 100 })
    );

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false when header contains invalid base64", async () => {
    const result = await verifyAccessJwt("!!!.!!!.!!!", TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false when fetch for certs fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    const token = makeFakeJwt(validHeader(), validPayload());

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false when no key matches the signature", async () => {
    // Mock fetch to return empty JWKS
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const token = makeFakeJwt(validHeader(), validPayload());

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("fetches certs from the correct URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = mockFetch;

    const token = makeFakeJwt(validHeader(), validPayload());
    await verifyAccessJwt(token, TEAM_DOMAIN, AUD);

    expect(mockFetch).toHaveBeenCalledWith(CERTS_URL);
  });

  it("caches JWKS keys across calls", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = mockFetch;

    const token = makeFakeJwt(validHeader(), validPayload());

    // First call — fetches keys
    await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call — uses cached keys
    await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("re-fetches keys after cache is reset", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    globalThis.fetch = mockFetch;

    const token = makeFakeJwt(validHeader(), validPayload());

    await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    _resetKeyCache();

    await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("verifyAccessJwt with real RSA keys", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetKeyCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Generate an RSA key pair and sign a JWT */
  async function createSignedJwt(
    payload: Record<string, unknown>
  ): Promise<{ token: string; publicJwk: JsonWebKey }> {
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    );

    const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

    const header = { alg: "RS256", kid: "test-key-1", typ: "JWT" };
    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));

    const encoder = new TextEncoder();
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const signatureBuffer = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keyPair.privateKey,
      data
    );

    const signatureB64 = arrayBufferToBase64Url(signatureBuffer);
    const token = `${headerB64}.${payloadB64}.${signatureB64}`;

    return { token, publicJwk };
  }

  function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  it("returns true for a properly signed valid JWT", async () => {
    const payload = validPayload();
    const { token, publicJwk } = await createSignedJwt(payload);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(result).toBe(true);
  });

  it("returns false when signature does not match (tampered payload)", async () => {
    const payload = validPayload();
    const { token, publicJwk } = await createSignedJwt(payload);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    // Tamper with the payload (change email)
    const parts = token.split(".");
    const tamperedPayload = { ...payload, email: "hacker@evil.com" };
    const tamperedPayloadB64 = base64UrlEncode(JSON.stringify(tamperedPayload));
    const tamperedToken = `${parts[0]}.${tamperedPayloadB64}.${parts[2]}`;

    const result = await verifyAccessJwt(tamperedToken, TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("returns false when signed with a different key", async () => {
    const payload = validPayload();
    const { token } = await createSignedJwt(payload);

    // Generate a different key pair for the JWKS
    const differentKeyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    );
    const differentPublicJwk = await crypto.subtle.exportKey(
      "jwk",
      differentKeyPair.publicKey
    );

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [differentPublicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(result).toBe(false);
  });

  it("validates the full checkAccessAuth flow with a valid JWT", async () => {
    const payload = validPayload();
    const { token, publicJwk } = await createSignedJwt(payload);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const request = new Request("https://example.com/api/data", {
      headers: { "CF-Access-JWT-Assertion": token },
    });

    const result = await checkAccessAuth(request, TEAM_DOMAIN, AUD);
    expect(result).toBeNull(); // allowed
  });

  it("returns true when one of multiple JWKS keys matches", async () => {
    const payload = validPayload();
    const { token, publicJwk } = await createSignedJwt(payload);

    // Generate an extra unrelated key
    const extraKeyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    );
    const extraJwk = await crypto.subtle.exportKey("jwk", extraKeyPair.publicKey);

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ keys: [extraJwk, publicJwk] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await verifyAccessJwt(token, TEAM_DOMAIN, AUD);
    expect(result).toBe(true);
  });
});
