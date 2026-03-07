/**
 * Cloudflare Access Zero Trust authentication middleware.
 * Verifies the CF-Access-JWT-Assertion header against the Access certs endpoint.
 * Returns null if the request is allowed, or a 403 Response if authentication fails.
 */

/** Cached JWKS keys to avoid fetching on every request */
let cachedKeys: CryptoKey[] | null = null;
let cachedKeysExpiry = 0;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Paths that bypass Access authentication */
const BYPASS_PATHS = ["/discord"];

interface JWKSet {
  keys: JsonWebKey[];
}

interface AccessJwtPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  iss: string;
  sub: string;
  type: string;
}

/**
 * Check Cloudflare Access authentication.
 * Returns null if the request is allowed, or a 403 Response if authentication fails.
 * Skips authentication for bypass paths (e.g., /discord).
 */
export async function checkAccessAuth(
  request: Request,
  teamDomain: string,
  aud: string
): Promise<Response | null> {
  const url = new URL(request.url);

  // Skip auth for bypass paths
  for (const path of BYPASS_PATHS) {
    if (url.pathname.startsWith(path)) {
      return null; // allowed — uses its own verification
    }
  }

  const jwtToken = request.headers.get("CF-Access-JWT-Assertion");
  if (!jwtToken) {
    return new Response("Forbidden", { status: 403 });
  }

  const isValid = await verifyAccessJwt(jwtToken, teamDomain, aud);
  if (!isValid) {
    return new Response("Forbidden", { status: 403 });
  }

  return null; // allowed
}

/**
 * Verify a Cloudflare Access JWT token.
 * Validates signature, audience, issuer, and expiration.
 */
export async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  expectedAud: string
): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    // Parse header to validate structure (kid is not used for key selection;
    // we try all keys from the JWKS to handle key rotation gracefully)
    JSON.parse(base64UrlDecode(parts[0]));
    const payload: AccessJwtPayload = JSON.parse(base64UrlDecode(parts[1]));

    // Validate issuer
    const expectedIssuer = `https://${teamDomain}.cloudflareaccess.com`;
    if (payload.iss !== expectedIssuer) return false;

    // Validate audience
    if (!Array.isArray(payload.aud) || !payload.aud.includes(expectedAud)) {
      return false;
    }

    // Validate expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return false;

    // Fetch and verify with JWKS
    const keys = await fetchAccessKeys(teamDomain);

    for (const key of keys) {
      try {
        const valid = await verifySignature(token, key);
        if (valid) return true;
      } catch {
        // Try next key
        continue;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Fetch JWKS keys from the Cloudflare Access certs endpoint.
 * Results are cached to avoid excessive network requests.
 */
export async function fetchAccessKeys(teamDomain: string): Promise<CryptoKey[]> {
  const now = Date.now();
  if (cachedKeys && now < cachedKeysExpiry) {
    return cachedKeys;
  }

  const certsUrl = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;
  const response = await fetch(certsUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch Access certs: ${response.status}`);
  }

  const jwks: JWKSet = await response.json();
  const keys: CryptoKey[] = [];

  for (const jwk of jwks.keys) {
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      );
      keys.push(key);
    } catch {
      // Skip keys that can't be imported (e.g., wrong algorithm)
      continue;
    }
  }

  cachedKeys = keys;
  cachedKeysExpiry = now + CACHE_TTL_MS;

  return keys;
}

/**
 * Verify the JWT signature using a CryptoKey.
 */
async function verifySignature(
  token: string,
  key: CryptoKey
): Promise<boolean> {
  const parts = token.split(".");
  const encoder = new TextEncoder();
  const data = encoder.encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlToArrayBuffer(parts[2]);

  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    data
  );
}

/** Decode a base64url-encoded string to a UTF-8 string */
function base64UrlDecode(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

/** Decode a base64url-encoded string to an ArrayBuffer */
function base64UrlToArrayBuffer(str: string): ArrayBuffer {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Reset the cached keys — exposed for testing */
export function _resetKeyCache(): void {
  cachedKeys = null;
  cachedKeysExpiry = 0;
}
