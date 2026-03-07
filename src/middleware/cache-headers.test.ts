import { describe, it, expect } from "vitest";
import { getCacheControl, applyCacheHeaders } from "./cache-headers";

// ── getCacheControl ─────────────────────────────────────────

describe("getCacheControl", () => {
  it("returns immutable header for hashed JS assets", () => {
    const result = getCacheControl("/assets/index-a1b2c3d4.js");
    expect(result).toBe("public, max-age=31536000, immutable");
  });

  it("returns immutable header for hashed CSS assets", () => {
    const result = getCacheControl("/assets/style-abcdef01.css");
    expect(result).toBe("public, max-age=31536000, immutable");
  });

  it("returns immutable header for assets with long hashes", () => {
    const result = getCacheControl("/assets/vendor-a1b2c3d4e5f6a7b8.js");
    expect(result).toBe("public, max-age=31536000, immutable");
  });

  it("returns must-revalidate for /index.html", () => {
    const result = getCacheControl("/index.html");
    expect(result).toBe("public, max-age=0, must-revalidate");
  });

  it("returns must-revalidate for root path", () => {
    const result = getCacheControl("/");
    expect(result).toBe("public, max-age=0, must-revalidate");
  });

  it("returns must-revalidate for nested HTML files", () => {
    const result = getCacheControl("/pages/about.html");
    expect(result).toBe("public, max-age=0, must-revalidate");
  });

  it("returns null for API paths", () => {
    expect(getCacheControl("/api/memories")).toBeNull();
  });

  it("returns null for non-hashed assets", () => {
    // No hash in filename — not a Vite hashed asset
    expect(getCacheControl("/assets/logo.png")).toBeNull();
  });

  it("returns null for assets with short hashes (less than 8 chars)", () => {
    expect(getCacheControl("/assets/index-abc.js")).toBeNull();
  });

  it("returns immutable header for dot-separated hash pattern", () => {
    // Some bundlers use dot-separated hashes: name.hash.ext
    const result = getCacheControl("/assets/font.a1b2c3d4.woff2");
    expect(result).toBe("public, max-age=31536000, immutable");
  });

  it("returns null for /discord paths", () => {
    expect(getCacheControl("/discord/interactions")).toBeNull();
  });

  it("returns null for /mcp paths", () => {
    expect(getCacheControl("/mcp")).toBeNull();
  });
});

// ── applyCacheHeaders ───────────────────────────────────────

describe("applyCacheHeaders", () => {
  it("adds Cache-Control header for hashed assets", () => {
    const original = new Response("body", { status: 200 });
    const result = applyCacheHeaders(original, "/assets/app-deadbeef.js");

    expect(result.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(result.status).toBe(200);
  });

  it("adds Cache-Control header for HTML", () => {
    const original = new Response("<html></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    const result = applyCacheHeaders(original, "/index.html");

    expect(result.headers.get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate"
    );
    expect(result.headers.get("Content-Type")).toBe("text/html");
  });

  it("preserves existing headers when adding cache headers", () => {
    const original = new Response("body", {
      status: 200,
      headers: {
        "Content-Type": "application/javascript",
        "X-Custom": "value",
      },
    });
    const result = applyCacheHeaders(original, "/assets/chunk-abcdef99.js");

    expect(result.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(result.headers.get("Content-Type")).toBe("application/javascript");
    expect(result.headers.get("X-Custom")).toBe("value");
  });

  it("returns original response when no cache policy applies", () => {
    const original = new Response("api response", { status: 200 });
    const result = applyCacheHeaders(original, "/api/memories");

    // Should be the exact same object
    expect(result).toBe(original);
    expect(result.headers.get("Cache-Control")).toBeNull();
  });

  it("preserves status code", () => {
    const original = new Response(null, { status: 301, headers: { Location: "/new" } });
    const result = applyCacheHeaders(original, "/index.html");

    expect(result.status).toBe(301);
    expect(result.headers.get("Cache-Control")).toBe(
      "public, max-age=0, must-revalidate"
    );
  });
});
