import { describe, it, expect, vi } from "vitest";
import { createExportTools } from "./export-tools";
import type { SemanticEntry } from "@/shared/types";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Constants matching lifecycle policy ─────────────────────────
const LIFECYCLE_PREFIX = "exports/";
const LIFECYCLE_EXPIRATION_DAYS = 30;

// ── Mock Data ──────────────────────────────────────────────────

const mockMemories: SemanticEntry[] = [
  {
    id: "mem-1",
    content: "Test memory",
    type: "fact",
    source: "user",
    tags: ["test"],
    createdAt: "2024-01-15T10:30:00Z",
    updatedAt: "2024-01-15T10:30:00Z",
  },
];

function createMockDeps() {
  const putCalls: { key: string; body: string; options: any }[] = [];

  return {
    deps: {
      semanticMemory: {
        list: vi.fn().mockResolvedValue(mockMemories),
        write: vi.fn(),
        search: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
      } as any,
      episodicMemory: {
        listSessions: vi.fn().mockReturnValue([]),
        search: vi.fn(),
        logTurn: vi.fn(),
        getSession: vi.fn(),
        upsertSession: vi.fn(),
        getTurnCount: vi.fn(),
        getRecentTurns: vi.fn(),
      } as any,
      proceduralMemory: {
        getAll: vi.fn().mockReturnValue([]),
        getActive: vi.fn(),
        add: vi.fn(),
        deactivate: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        toPromptString: vi.fn(),
      } as any,
      storage: {
        put: vi
          .fn()
          .mockImplementation(
            async (key: string, body: string, options: any) => {
              putCalls.push({
                key,
                body: typeof body === "string" ? body : "binary",
                options,
              });
            }
          ),
        get: vi.fn(),
      } as any,
    },
    putCalls,
  };
}

// ── Tests: Export keys use lifecycle-compatible prefix ──────────

describe("R2 lifecycle policy compatibility", () => {
  it("exportMarkdown keys start with the lifecycle prefix", async () => {
    const mock = createMockDeps();
    const tools = createExportTools(mock.deps);

    const result = await tools.exportMarkdown.execute(
      { format: "obsidian" },
      { messages: [], toolCallId: "test", abortSignal: undefined as any }
    );

    expect(result.key).toMatch(new RegExp(`^${LIFECYCLE_PREFIX}`));
    expect(mock.putCalls[0].key).toMatch(new RegExp(`^${LIFECYCLE_PREFIX}`));
  });

  it("exportJson keys start with the lifecycle prefix", async () => {
    const mock = createMockDeps();
    const tools = createExportTools(mock.deps);

    const result = await tools.exportJson.execute(
      {},
      { messages: [], toolCallId: "test", abortSignal: undefined as any }
    );

    expect(result.key).toMatch(new RegExp(`^${LIFECYCLE_PREFIX}`));
    expect(mock.putCalls[0].key).toMatch(new RegExp(`^${LIFECYCLE_PREFIX}`));
  });

  it("all export formats produce keys under the lifecycle prefix", async () => {
    const mock = createMockDeps();
    const tools = createExportTools(mock.deps);

    await tools.exportMarkdown.execute(
      { format: "obsidian" },
      { messages: [], toolCallId: "test", abortSignal: undefined as any }
    );
    await tools.exportMarkdown.execute(
      { format: "plain" },
      { messages: [], toolCallId: "test", abortSignal: undefined as any }
    );
    await tools.exportJson.execute(
      {},
      { messages: [], toolCallId: "test", abortSignal: undefined as any }
    );

    expect(mock.putCalls).toHaveLength(3);
    for (const call of mock.putCalls) {
      expect(call.key.startsWith(LIFECYCLE_PREFIX)).toBe(true);
    }
  });
});

describe("wrangler.jsonc lifecycle documentation", () => {
  it("documents the R2 lifecycle policy in wrangler.jsonc", () => {
    const wranglerPath = resolve(process.cwd(), "wrangler.jsonc");
    const content = readFileSync(wranglerPath, "utf-8");

    // Verify the lifecycle policy is documented
    expect(content).toContain("lifecycle: auto-delete");
    expect(content).toContain("30 days");
    expect(content).toContain("cortex-storage");
  });

  it("references the setup script in wrangler.jsonc", () => {
    const wranglerPath = resolve(process.cwd(), "wrangler.jsonc");
    const content = readFileSync(wranglerPath, "utf-8");

    expect(content).toContain("r2-lifecycle.sh");
  });
});

describe("r2-lifecycle.sh setup script", () => {
  it("exists and contains correct configuration", () => {
    const scriptPath = resolve(process.cwd(), "scripts/r2-lifecycle.sh");
    const content = readFileSync(scriptPath, "utf-8");

    // Verify script targets the correct bucket
    expect(content).toContain('BUCKET_NAME="cortex-storage"');

    // Verify expiration period
    expect(content).toContain(`EXPIRATION_DAYS=${LIFECYCLE_EXPIRATION_DAYS}`);

    // Verify it targets the exports prefix
    expect(content).toContain('"prefix": "exports/"');

    // Verify it uses DeleteObject action
    expect(content).toContain('"type": "DeleteObject"');

    // Verify it requires authentication
    expect(content).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(content).toContain("CLOUDFLARE_API_TOKEN");
  });

  it("has proper error handling for missing env vars", () => {
    const scriptPath = resolve(process.cwd(), "scripts/r2-lifecycle.sh");
    const content = readFileSync(scriptPath, "utf-8");

    // Verify it checks for required env vars and exits on failure
    expect(content).toContain("set -euo pipefail");
    expect(content).toContain("exit 1");
  });
});
