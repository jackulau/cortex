import { describe, it, expect } from "vitest";
import type { Env } from "../shared/types";

describe("Env interface", () => {
  it("has all required bindings including Phase 2-4 additions", () => {
    // TypeScript compilation validates the interface structure.
    // This test verifies the interface is importable and usable.
    const mockEnv: Env = {
      CortexAgent: {} as DurableObjectNamespace,
      DB: {} as D1Database,
      STORAGE: {} as R2Bucket,
      AI: {} as Ai,
      EMBEDDING_MODEL: "@cf/baai/bge-large-en-v1.5",
      CHAT_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      // Phase 2 additions
      BROWSER: {} as Fetcher,
      DISCORD_PUBLIC_KEY: "test-public-key",
      DISCORD_APP_ID: "test-app-id",
      DISCORD_BOT_TOKEN: "test-bot-token",
      // Phase 5: Platform bindings
      VECTORIZE: {} as VectorizeIndex,
      CACHE: {} as KVNamespace,
      CRAWL_QUEUE: {} as Queue,
      CONSOLIDATION_QUEUE: {} as Queue,
      ANALYTICS: {} as AnalyticsEngineDataset,
      RATE_LIMITER: {} as RateLimit,
    };

    expect(mockEnv.BROWSER).toBeDefined();
    expect(mockEnv.DISCORD_PUBLIC_KEY).toBe("test-public-key");
    expect(mockEnv.DISCORD_APP_ID).toBe("test-app-id");
    expect(mockEnv.DISCORD_BOT_TOKEN).toBe("test-bot-token");
    expect(mockEnv.CortexAgent).toBeDefined();
    expect(mockEnv.DB).toBeDefined();
    expect(mockEnv.STORAGE).toBeDefined();
    expect(mockEnv.AI).toBeDefined();
    // Phase 5 bindings
    expect(mockEnv.VECTORIZE).toBeDefined();
    expect(mockEnv.CACHE).toBeDefined();
    expect(mockEnv.CRAWL_QUEUE).toBeDefined();
    expect(mockEnv.CONSOLIDATION_QUEUE).toBeDefined();
    expect(mockEnv.ANALYTICS).toBeDefined();
    expect(mockEnv.RATE_LIMITER).toBeDefined();
  });
});
