import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Wrangler Configuration", () => {
  // Parse the jsonc file (strip comments)
  const raw = readFileSync(
    resolve(__dirname, "../../wrangler.jsonc"),
    "utf-8"
  );
  const stripped = raw.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const config = JSON.parse(stripped);

  it("has browser binding for Phase 2", () => {
    expect(config.browser).toBeDefined();
    expect(config.browser.binding).toBe("BROWSER");
  });

  it("has cron trigger for Phase 3 scheduled crawler", () => {
    expect(config.triggers).toBeDefined();
    expect(config.triggers.crons).toBeDefined();
    expect(config.triggers.crons).toContain("0 */6 * * *");
  });

  it("has D1 database binding", () => {
    expect(config.d1_databases).toBeDefined();
    expect(config.d1_databases[0].binding).toBe("DB");
  });

  it("has R2 storage binding", () => {
    expect(config.r2_buckets).toBeDefined();
    expect(config.r2_buckets[0].binding).toBe("STORAGE");
  });

  it("has Workers AI binding", () => {
    expect(config.ai).toBeDefined();
    expect(config.ai.binding).toBe("AI");
  });

  it("has CortexAgent durable object binding", () => {
    expect(config.durable_objects).toBeDefined();
    expect(config.durable_objects.bindings[0].name).toBe("CortexAgent");
  });
});
