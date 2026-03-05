/**
 * Ed25519 signature verification for Discord interaction webhooks.
 * Uses Web Crypto API (crypto.subtle) -- no npm packages needed.
 */

/**
 * Verify a Discord interaction request's Ed25519 signature.
 * Returns the parsed body if valid, or isValid: false if verification fails.
 */
export async function verifyDiscordRequest(
  request: Request,
  publicKey: string
): Promise<{ isValid: boolean; body: any }> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");

  if (!signature || !timestamp) {
    return { isValid: false, body: null };
  }

  const body = await request.text();
  const message = timestamp + body;

  try {
    // Ed25519 is supported in CF Workers (compatibility_date >= 2024-09-23)
    // Type assertion needed because @cloudflare/workers-types may not include Ed25519 overloads
    const key = await (crypto.subtle.importKey as any)(
      "raw",
      hexToUint8Array(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    const isValid: boolean = await (crypto.subtle.verify as any)(
      "Ed25519",
      key,
      hexToUint8Array(signature),
      new TextEncoder().encode(message)
    );

    return { isValid, body: isValid ? JSON.parse(body) : null };
  } catch {
    return { isValid: false, body: null };
  }
}

/**
 * Convert a hex string to Uint8Array.
 */
export function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
