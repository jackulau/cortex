import { describe, it, expect, vi } from "vitest";

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
  it("responds to GET with server info", async () => {
    const { mcpHandler } = await import("../mcp/index");

    const request = new Request("https://example.com/mcp", {
      method: "GET",
    });

    const env = {
      DB: {} as any,
      AI: {} as any,
      EMBEDDING_MODEL: "test",
      CHAT_MODEL: "test",
    } as any;

    const response = await mcpHandler(request, env);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("name", "cortex");
    expect(data).toHaveProperty("capabilities");
  });

  it("handles initialize method", async () => {
    const { mcpHandler } = await import("../mcp/index");

    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      }),
    });

    const env = {
      DB: {} as any,
      AI: {} as any,
      EMBEDDING_MODEL: "test",
    } as any;

    const response = await mcpHandler(request, env);
    const data = await response.json() as any;
    expect(data.jsonrpc).toBe("2.0");
    expect(data.result).toHaveProperty("protocolVersion");
    expect(data.result).toHaveProperty("serverInfo");
  });

  it("handles tools/list method", async () => {
    const { mcpHandler } = await import("../mcp/index");

    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      }),
    });

    const env = {} as any;

    const response = await mcpHandler(request, env);
    const data = await response.json() as any;
    expect(data.result.tools).toBeDefined();
    expect(data.result.tools.length).toBeGreaterThan(0);
    expect(data.result.tools.map((t: any) => t.name)).toContain("remember");
    expect(data.result.tools.map((t: any) => t.name)).toContain("recall");
  });

  it("rejects invalid JSON-RPC version", async () => {
    const { mcpHandler } = await import("../mcp/index");

    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: 1,
        method: "initialize",
      }),
    });

    const env = {} as any;

    const response = await mcpHandler(request, env);
    const data = await response.json() as any;
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32600);
  });

  it("rejects unknown methods", async () => {
    const { mcpHandler } = await import("../mcp/index");

    const request = new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "unknown/method",
      }),
    });

    const env = {} as any;

    const response = await mcpHandler(request, env);
    const data = await response.json() as any;
    expect(data.error).toBeDefined();
    expect(data.error.code).toBe(-32601);
  });
});
