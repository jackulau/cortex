import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Integration test configuration using @cloudflare/vitest-pool-workers.
 * Runs tests against real Miniflare-backed D1, KV, and other bindings.
 *
 * Usage: npm run test:integration
 *
 * Setup/Teardown:
 * - Each test file should create its own D1 tables in beforeAll()
 * - KV namespaces are automatically available via Miniflare
 * - Vectorize is not supported in Miniflare; tests that need vector search
 *   use a mock Vectorize adapter (see test helpers)
 * - No remote Cloudflare resources required (CI-friendly)
 */
export default defineWorkersConfig({
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.jsonc" },
        miniflare: {
          // Override compatibility settings for test environment
          compatibilityDate: "2025-03-01",
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": "./src",
    },
  },
});
