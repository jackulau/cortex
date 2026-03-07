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

describe("Integration Wiring", () => {
  describe("Server exports", () => {
    it("exports CortexAgent class from server module", async () => {
      const mod = await import("../server");
      expect(mod.CortexAgent).toBeDefined();
    });

    it("exports default with fetch and scheduled handlers", async () => {
      const mod = await import("../server");
      expect(mod.default).toBeDefined();
      expect(typeof mod.default.fetch).toBe("function");
      expect(typeof mod.default.scheduled).toBe("function");
    });
  });

  describe("Agent tool registration", () => {
    it("createMemoryTools is importable", async () => {
      const mod = await import("../agent/tools/memory-tools");
      expect(mod.createMemoryTools).toBeDefined();
      expect(typeof mod.createMemoryTools).toBe("function");
    });

    it("createResearchTools is importable", async () => {
      const mod = await import("../agent/tools/research-tools");
      expect(mod.createResearchTools).toBeDefined();
      expect(typeof mod.createResearchTools).toBe("function");
    });

    it("createWatchTools is importable", async () => {
      const mod = await import("../agent/tools/watch-tools");
      expect(mod.createWatchTools).toBeDefined();
      expect(typeof mod.createWatchTools).toBe("function");
    });

    it("createExportTools is importable", async () => {
      const mod = await import("../agent/tools/export-tools");
      expect(mod.createExportTools).toBeDefined();
      expect(typeof mod.createExportTools).toBe("function");
    });

    it("tools barrel export includes all tool factories", async () => {
      const mod = await import("../agent/tools/index");
      expect(mod.createMemoryTools).toBeDefined();
      expect(mod.createResearchTools).toBeDefined();
      expect(mod.createWatchTools).toBeDefined();
      expect(mod.createExportTools).toBeDefined();
    });
  });

  describe("Monitor system", () => {
    it("WatchListManager is importable", async () => {
      const mod = await import("../monitor/watchlist");
      expect(mod.WatchListManager).toBeDefined();
    });

    it("DigestManager is importable", async () => {
      const mod = await import("../monitor/digest");
      expect(mod.DigestManager).toBeDefined();
    });

    it("WatchListManager has updateLastChecked method", async () => {
      const mod = await import("../monitor/watchlist");
      const wlm = new (mod.WatchListManager as any)({} as any);
      expect(typeof wlm.updateLastChecked).toBe("function");
    });
  });

  describe("Discord", () => {
    it("handleDiscordInteraction is importable", async () => {
      const mod = await import("../discord/index");
      expect(mod.handleDiscordInteraction).toBeDefined();
      expect(typeof mod.handleDiscordInteraction).toBe("function");
    });
  });

  describe("MCP", () => {
    it("createCortexMcpHandler is importable", async () => {
      const mod = await import("../mcp/index");
      expect(mod.createCortexMcpHandler).toBeDefined();
      expect(typeof mod.createCortexMcpHandler).toBe("function");
    });
  });

  describe("Types", () => {
    it("Env interface includes BROWSER binding", async () => {
      // TypeScript compilation validates this; runtime check that types module loads
      const mod = await import("../shared/types");
      expect(mod).toBeDefined();
    });
  });
});
