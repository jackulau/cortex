import { describe, it, expect } from "vitest";
import { hexToUint8Array, verifyDiscordRequest } from "../verify";

describe("hexToUint8Array", () => {
  it("converts empty hex string to empty array", () => {
    const result = hexToUint8Array("");
    expect(result).toEqual(new Uint8Array(0));
  });

  it("converts hex string to bytes correctly", () => {
    const result = hexToUint8Array("deadbeef");
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("converts all zeros", () => {
    const result = hexToUint8Array("00000000");
    expect(result).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it("converts all ff bytes", () => {
    const result = hexToUint8Array("ffffffff");
    expect(result).toEqual(new Uint8Array([255, 255, 255, 255]));
  });

  it("handles 64-character hex string (32 bytes)", () => {
    const hex =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const result = hexToUint8Array(hex);
    expect(result.length).toBe(32);
    expect(result[0]).toBe(0x01);
    expect(result[1]).toBe(0x23);
  });
});

describe("verifyDiscordRequest", () => {
  it("returns invalid when signature header is missing", async () => {
    const request = new Request("https://example.com/discord", {
      method: "POST",
      headers: {
        "X-Signature-Timestamp": "1234567890",
      },
      body: "{}",
    });

    const result = await verifyDiscordRequest(request, "abcd1234");
    expect(result.isValid).toBe(false);
    expect(result.body).toBeNull();
  });

  it("returns invalid when timestamp header is missing", async () => {
    const request = new Request("https://example.com/discord", {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": "abcd1234",
      },
      body: "{}",
    });

    const result = await verifyDiscordRequest(request, "abcd1234");
    expect(result.isValid).toBe(false);
    expect(result.body).toBeNull();
  });

  it("returns invalid when both headers are missing", async () => {
    const request = new Request("https://example.com/discord", {
      method: "POST",
      body: "{}",
    });

    const result = await verifyDiscordRequest(request, "abcd1234");
    expect(result.isValid).toBe(false);
    expect(result.body).toBeNull();
  });

  it("returns invalid for a forged signature", async () => {
    const request = new Request("https://example.com/discord", {
      method: "POST",
      headers: {
        "X-Signature-Ed25519":
          "0000000000000000000000000000000000000000000000000000000000000000" +
          "0000000000000000000000000000000000000000000000000000000000000000",
        "X-Signature-Timestamp": "1234567890",
      },
      body: JSON.stringify({ type: 1 }),
    });

    // A valid Ed25519 public key (32 bytes = 64 hex chars)
    const fakePublicKey =
      "e2b0f2c7d4a5e6f8a1b3c5d7e9f0a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e3";

    const result = await verifyDiscordRequest(request, fakePublicKey);
    expect(result.isValid).toBe(false);
    expect(result.body).toBeNull();
  });

  it("verifies a valid Ed25519 signature", async () => {
    // Generate a real Ed25519 key pair for testing
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, [
      "sign",
      "verify",
    ]);

    const timestamp = "1234567890";
    const body = JSON.stringify({ type: 1 });
    const message = new TextEncoder().encode(timestamp + body);

    // Sign with the private key
    const signatureBuffer = await crypto.subtle.sign(
      { name: "Ed25519" } as any,
      keyPair.privateKey,
      message
    );
    const signatureHex = uint8ArrayToHex(new Uint8Array(signatureBuffer));

    // Export the public key to raw format
    const publicKeyBuffer = await (crypto.subtle.exportKey as any)(
      "raw",
      keyPair.publicKey
    );
    const publicKeyHex = uint8ArrayToHex(new Uint8Array(publicKeyBuffer));

    const request = new Request("https://example.com/discord", {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": signatureHex,
        "X-Signature-Timestamp": timestamp,
      },
      body: body,
    });

    const result = await verifyDiscordRequest(request, publicKeyHex);
    expect(result.isValid).toBe(true);
    expect(result.body).toEqual({ type: 1 });
  });

  it("rejects a tampered body with valid key", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" } as any, true, [
      "sign",
      "verify",
    ]);

    const timestamp = "1234567890";
    const originalBody = JSON.stringify({ type: 1 });
    const message = new TextEncoder().encode(timestamp + originalBody);

    const signatureBuffer = await crypto.subtle.sign(
      { name: "Ed25519" } as any,
      keyPair.privateKey,
      message
    );
    const signatureHex = uint8ArrayToHex(new Uint8Array(signatureBuffer));

    const publicKeyBuffer = await (crypto.subtle.exportKey as any)(
      "raw",
      keyPair.publicKey
    );
    const publicKeyHex = uint8ArrayToHex(new Uint8Array(publicKeyBuffer));

    // Tamper with the body
    const tamperedBody = JSON.stringify({ type: 2 });

    const request = new Request("https://example.com/discord", {
      method: "POST",
      headers: {
        "X-Signature-Ed25519": signatureHex,
        "X-Signature-Timestamp": timestamp,
      },
      body: tamperedBody,
    });

    const result = await verifyDiscordRequest(request, publicKeyHex);
    expect(result.isValid).toBe(false);
    expect(result.body).toBeNull();
  });
});

// Helper for tests
function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
