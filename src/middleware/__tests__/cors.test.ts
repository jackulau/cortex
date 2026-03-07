import { describe, it, expect } from "vitest";
import {
  corsHeaders,
  parseAllowedOrigins,
  handlePreflight,
  withCorsHeaders,
} from "../cors";

describe("corsHeaders", () => {
  it("returns CORS headers when origin is in allowed list", () => {
    const headers = corsHeaders(
      "https://app.example.com",
      ["https://app.example.com", "https://other.example.com"]
    );

    expect(headers).toHaveProperty(
      "Access-Control-Allow-Origin",
      "https://app.example.com"
    );
    expect(headers).toHaveProperty("Access-Control-Allow-Methods");
    expect(headers).toHaveProperty("Access-Control-Allow-Headers");
    expect(headers).toHaveProperty("Access-Control-Allow-Credentials", "true");
    expect(headers).toHaveProperty("Access-Control-Max-Age", "86400");
  });

  it("returns empty object when origin is not in allowed list", () => {
    const headers = corsHeaders(
      "https://evil.example.com",
      ["https://app.example.com"]
    );
    expect(headers).toEqual({});
  });

  it("returns empty object when origin is null", () => {
    const headers = corsHeaders(null, ["https://app.example.com"]);
    expect(headers).toEqual({});
  });

  it("allows any origin when wildcard '*' is in the list", () => {
    const headers = corsHeaders("https://anything.com", ["*"]);
    expect(headers).toHaveProperty(
      "Access-Control-Allow-Origin",
      "https://anything.com"
    );
  });

  it("returns empty object when allowed origins list is empty", () => {
    const headers = corsHeaders("https://app.example.com", []);
    expect(headers).toEqual({});
  });
});

describe("parseAllowedOrigins", () => {
  it("parses a comma-separated string into an array", () => {
    const result = parseAllowedOrigins("https://a.com,https://b.com");
    expect(result).toEqual(["https://a.com", "https://b.com"]);
  });

  it("trims whitespace from origins", () => {
    const result = parseAllowedOrigins("  https://a.com , https://b.com  ");
    expect(result).toEqual(["https://a.com", "https://b.com"]);
  });

  it("returns empty array for empty string", () => {
    expect(parseAllowedOrigins("")).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseAllowedOrigins("   ")).toEqual([]);
  });

  it("filters out empty entries from trailing commas", () => {
    const result = parseAllowedOrigins("https://a.com,,https://b.com,");
    expect(result).toEqual(["https://a.com", "https://b.com"]);
  });
});

describe("handlePreflight", () => {
  it("returns 204 with CORS headers for allowed origin", () => {
    const request = new Request("https://example.com/api/test", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    });

    const response = handlePreflight(request, ["https://app.example.com"]);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com"
    );
  });

  it("returns 403 for disallowed origin", () => {
    const request = new Request("https://example.com/api/test", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });

    const response = handlePreflight(request, ["https://app.example.com"]);
    expect(response.status).toBe(403);
  });

  it("returns 403 when no Origin header is present", () => {
    const request = new Request("https://example.com/api/test", {
      method: "OPTIONS",
    });

    const response = handlePreflight(request, ["https://app.example.com"]);
    expect(response.status).toBe(403);
  });
});

describe("withCorsHeaders", () => {
  it("adds CORS headers to an existing response for allowed origin", () => {
    const original = new Response("OK", { status: 200 });
    const result = withCorsHeaders(
      original,
      "https://app.example.com",
      ["https://app.example.com"]
    );

    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com"
    );
    expect(result.status).toBe(200);
  });

  it("returns original response if origin is not allowed", () => {
    const original = new Response("OK", { status: 200 });
    const result = withCorsHeaders(
      original,
      "https://evil.example.com",
      ["https://app.example.com"]
    );

    expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns original response if origin is null", () => {
    const original = new Response("OK", { status: 200 });
    const result = withCorsHeaders(
      original,
      null,
      ["https://app.example.com"]
    );

    // Should return the response without CORS headers
    expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("preserves original response body", async () => {
    const body = JSON.stringify({ data: "test" });
    const original = new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    const result = withCorsHeaders(
      original,
      "https://app.example.com",
      ["https://app.example.com"]
    );

    expect(await result.text()).toBe(body);
    expect(result.headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves original response status code", () => {
    const original = new Response("Not Found", { status: 404 });
    const result = withCorsHeaders(
      original,
      "https://app.example.com",
      ["https://app.example.com"]
    );

    expect(result.status).toBe(404);
    expect(result.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com"
    );
  });
});
