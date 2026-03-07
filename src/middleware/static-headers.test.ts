import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Validates the public/_headers file is correctly formatted
 * for Cloudflare Workers Static Assets.
 */
describe("public/_headers file", () => {
  const headersPath = resolve(__dirname, "../../public/_headers");
  const content = readFileSync(headersPath, "utf-8");

  it("exists and is non-empty", () => {
    expect(content.length).toBeGreaterThan(0);
  });

  it("sets immutable cache for /assets/*", () => {
    // Must have a rule for /assets/* with immutable cache
    expect(content).toContain("/assets/*");
    expect(content).toContain("max-age=31536000");
    expect(content).toContain("immutable");
  });

  it("sets must-revalidate for /index.html", () => {
    expect(content).toContain("/index.html");
    expect(content).toContain("max-age=0");
    expect(content).toContain("must-revalidate");
  });

  it("sets must-revalidate for root path /", () => {
    // The root path should also be covered
    const lines = content.split("\n");
    const rootLine = lines.find((line) => line.trim() === "/");
    expect(rootLine).toBeDefined();
  });

  it("uses correct Cloudflare _headers format (path on own line, header indented)", () => {
    const lines = content.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    // Paths start at column 0, headers are indented
    for (const line of lines) {
      if (line.startsWith("/")) {
        // Path line — should not contain ":"
        expect(line).not.toContain(":");
      } else {
        // Header line — should be indented and contain ":"
        expect(line).toMatch(/^\s+.+:.+/);
      }
    }
  });
});
