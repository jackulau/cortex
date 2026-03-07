import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Wrangler Configuration", () => {
  // Parse the jsonc file (strip comments)
  const raw = readFileSync(
    resolve(__dirname, "../../wrangler.jsonc"),
    "utf-8"
  );
  // Strip comments line-by-line to avoid mangling // inside strings (e.g. URLs)
  const stripped = raw
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const config = JSON.parse(stripped);

  it("has cron trigger for daily digest", () => {
    expect(config.triggers).toBeDefined();
    expect(config.triggers.crons).toBeDefined();
    expect(config.triggers.crons).toContain("0 9 * * *");
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

  // Phase 5: New platform bindings

  it("has Vectorize index binding", () => {
    expect(config.vectorize).toBeDefined();
    expect(config.vectorize[0].binding).toBe("VECTORIZE");
    expect(config.vectorize[0].index_name).toBe("cortex-memories");
  });

  it("has KV namespace binding for CACHE", () => {
    expect(config.kv_namespaces).toBeDefined();
    expect(config.kv_namespaces[0].binding).toBe("CACHE");
  });

  it("has Queue producer bindings", () => {
    expect(config.queues).toBeDefined();
    expect(config.queues.producers).toBeDefined();
    const crawlProducer = config.queues.producers.find(
      (p: { binding: string }) => p.binding === "CRAWL_QUEUE"
    );
    const consolidationProducer = config.queues.producers.find(
      (p: { binding: string }) => p.binding === "CONSOLIDATION_QUEUE"
    );
    expect(crawlProducer).toBeDefined();
    expect(crawlProducer.queue).toBe("cortex-crawl");
    expect(consolidationProducer).toBeDefined();
    expect(consolidationProducer.queue).toBe("cortex-consolidate");
  });

  it("has Queue consumer bindings", () => {
    expect(config.queues.consumers).toBeDefined();
    expect(config.queues.consumers.length).toBe(3);
  });

  it("has Analytics Engine dataset binding", () => {
    expect(config.analytics_engine_datasets).toBeDefined();
    expect(config.analytics_engine_datasets[0].binding).toBe("ANALYTICS");
    expect(config.analytics_engine_datasets[0].dataset).toBe("cortex_events");
  });

  it("has Rate Limiter binding in unsafe bindings", () => {
    expect(config.unsafe).toBeDefined();
    expect(config.unsafe.bindings).toBeDefined();
    const rateLimiter = config.unsafe.bindings.find(
      (b: { name: string }) => b.name === "RATE_LIMITER"
    );
    expect(rateLimiter).toBeDefined();
    expect(rateLimiter.type).toBe("ratelimit");
  });
});
