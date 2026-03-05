import { describe, it, expect } from "vitest";
import React from "react";

// Test the Dashboard app component structure
describe("Dashboard App", () => {
  it("exports Dashboard component", async () => {
    const mod = await import("../app");
    expect(mod.Dashboard).toBeDefined();
    expect(typeof mod.Dashboard).toBe("function");
  });
});

describe("Dashboard Components", () => {
  it("exports KnowledgeGraph component", async () => {
    const mod = await import("../components/KnowledgeGraph");
    expect(mod.KnowledgeGraph).toBeDefined();
    expect(typeof mod.KnowledgeGraph).toBe("function");
  });

  it("exports MemoryExplorer component", async () => {
    const mod = await import("../components/MemoryExplorer");
    expect(mod.MemoryExplorer).toBeDefined();
    expect(typeof mod.MemoryExplorer).toBe("function");
  });

  it("exports WatchList component", async () => {
    const mod = await import("../components/WatchList");
    expect(mod.WatchList).toBeDefined();
    expect(typeof mod.WatchList).toBe("function");
  });

  it("exports SessionHistory component", async () => {
    const mod = await import("../components/SessionHistory");
    expect(mod.SessionHistory).toBeDefined();
    expect(typeof mod.SessionHistory).toBe("function");
  });
});
