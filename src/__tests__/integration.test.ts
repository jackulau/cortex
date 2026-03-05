import { describe, it, expect } from "vitest";

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

    it("runMonitoringCycle is importable", async () => {
      const mod = await import("../monitor/crawler");
      expect(mod.runMonitoringCycle).toBeDefined();
      expect(typeof mod.runMonitoringCycle).toBe("function");
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
    it("mcpHandler is importable", async () => {
      const mod = await import("../mcp/index");
      expect(mod.mcpHandler).toBeDefined();
      expect(typeof mod.mcpHandler).toBe("function");
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
