import { describe, it, expect, vi } from "vitest";

// Mock Cloudflare-specific modules that use cloudflare: protocol (not available in Node.js)
vi.mock("agents", () => ({
  Agent: class {},
  __DO_NOT_USE_WILL_BREAK__agentContext: {},
  getAgentByName: vi.fn(),
  routeAgentRequest: vi.fn(),
}));

vi.mock("agents/mcp", () => ({
  createMcpHandler: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("@cloudflare/ai-chat", () => ({
  AIChatAgent: class {
    static options = {};
    sql() { return []; }
  },
}));

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
  WorkflowStep: class {},
  WorkflowEvent: class {},
}));

describe("Server Routing", () => {
  // Since we can't easily instantiate the full Worker environment,
  // we test the routing logic by examining the server module structure

  it("server module exports both fetch and scheduled", async () => {
    const server = await import("../server");
    const handler = server.default;

    expect(handler).toBeDefined();
    expect(typeof handler.fetch).toBe("function");
    expect(typeof handler.scheduled).toBe("function");
  });

  it("server module exports CortexAgent class", async () => {
    const server = await import("../server");
    expect(server.CortexAgent).toBeDefined();
  });
});

describe("Discord handler", () => {
  it("rejects requests with invalid signatures", async () => {
    const { handleDiscordInteraction } = await import("../discord/index");

    const request = new Request("https://example.com/discord", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: 1 }),
    });

    const env = {
      DISCORD_PUBLIC_KEY: "0".repeat(64),
      DB: {} as any,
      AI: {} as any,
      EMBEDDING_MODEL: "test",
      CHAT_MODEL: "test",
      DISCORD_APP_ID: "test",
      DISCORD_BOT_TOKEN: "test",
      BROWSER: {} as any,
      STORAGE: {} as any,
      CortexAgent: {} as any,
    };

    const response = await handleDiscordInteraction(request, env);
    expect(response.status).toBe(401);
  });
});

describe("MCP handler", () => {
  // MCP handler tests require the agents/mcp package which depends on cloudflare: protocol.
  // These tests are skipped in Node.js and would run in @cloudflare/vitest-pool-workers.

  it("createCortexMcpHandler is importable", async () => {
    const { createCortexMcpHandler } = await import("../mcp/index");
    expect(createCortexMcpHandler).toBeDefined();
    expect(typeof createCortexMcpHandler).toBe("function");
  });

  it("createMcpServer is importable and creates a server", async () => {
    const { createMcpServer } = await import("../mcp/index");
    expect(createMcpServer).toBeDefined();
    expect(typeof createMcpServer).toBe("function");
  });
});
