import { describe, it, expect, vi } from "vitest";

// Mock Cloudflare-specific modules that use cloudflare: protocol (not available in Node.js)
vi.mock("agents/mcp", () => ({
  createMcpHandler: vi.fn().mockReturnValue(vi.fn()),
}));

import { createMcpServer, createCortexMcpHandler } from "./index";
import type { Env } from "@/shared/types";

// ── Mock Env ───────────────────────────────────────────────────

function createMockEnv(): Env {
  return {
    CortexAgent: {} as any,
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ meta: {} }),
          first: vi.fn().mockResolvedValue(null),
        }),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ meta: {} }),
      }),
      batch: vi.fn().mockResolvedValue([]),
    } as any,
    STORAGE: {} as any,
    AI: {
      run: vi.fn().mockResolvedValue({
        data: [Array.from({ length: 1024 }, () => 0.1)],
      }),
    } as any,
    VECTORIZE: {
      query: vi.fn().mockResolvedValue({ matches: [] }),
      upsert: vi.fn(),
      deleteByIds: vi.fn(),
    } as any,
    EMBEDDING_MODEL: "@cf/baai/bge-large-en-v1.5",
    CHAT_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe("createMcpServer", () => {
  it("creates an McpServer instance", () => {
    const env = createMockEnv();
    const server = createMcpServer(env);

    // McpServer from the SDK has a `server` property (the underlying Server)
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });

  it("registers remember, recall, and research_url tools", () => {
    const env = createMockEnv();
    const server = createMcpServer(env);

    // Access internal registered tools via any cast for verification
    const registeredTools = (server as any)._registeredTools;
    expect(registeredTools).toBeDefined();

    // Verify all three tools are registered
    const toolNames = Object.keys(registeredTools);
    expect(toolNames).toContain("remember");
    expect(toolNames).toContain("recall");
    expect(toolNames).toContain("research_url");
    expect(toolNames).toHaveLength(3);
  });

  it("has proper tool descriptions", () => {
    const env = createMockEnv();
    const server = createMcpServer(env);
    const tools = (server as any)._registeredTools;

    expect(tools.remember.description).toBe("Save a fact to Cortex's memory");
    expect(tools.recall.description).toBe("Search Cortex's memory");
    expect(tools.research_url.description).toBe(
      "Extract and summarize a URL, save to memory"
    );
  });

  it("has connect and close methods", () => {
    const env = createMockEnv();
    const server = createMcpServer(env);
    expect(typeof server.connect).toBe("function");
    expect(typeof server.close).toBe("function");
  });
});

describe("createCortexMcpHandler", () => {
  it("returns a request handler function", () => {
    const env = createMockEnv();
    const handler = createCortexMcpHandler(env);
    expect(typeof handler).toBe("function");
  });
});
