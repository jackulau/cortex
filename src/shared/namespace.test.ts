import { describe, it, expect } from "vitest";
import { DEFAULT_NAMESPACE_ID } from "./types";
import type { Namespace } from "./types";

describe("Namespace types and constants", () => {
  it("DEFAULT_NAMESPACE_ID is 'default'", () => {
    expect(DEFAULT_NAMESPACE_ID).toBe("default");
  });

  it("Namespace interface structure", () => {
    const ns: Namespace = {
      id: "test-ns",
      name: "Test Namespace",
      owner: "user-1",
      createdAt: new Date().toISOString(),
      settings: { theme: "dark" },
    };

    expect(ns.id).toBe("test-ns");
    expect(ns.name).toBe("Test Namespace");
    expect(ns.owner).toBe("user-1");
    expect(ns.settings).toEqual({ theme: "dark" });
  });

  it("Namespace settings can be null", () => {
    const ns: Namespace = {
      id: "minimal-ns",
      name: "Minimal",
      owner: "system",
      createdAt: new Date().toISOString(),
      settings: null,
    };

    expect(ns.settings).toBeNull();
  });
});
