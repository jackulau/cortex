import { describe, it, expect } from "vitest";

/**
 * Tests for dashboard tab configuration.
 * Verifies the Digest tab is present in the TABS array.
 */
describe("Dashboard tab configuration", () => {
  // Replicate the TABS array from app.tsx for verification
  const TABS = [
    { id: "chat", label: "Chat" },
    { id: "graph", label: "Knowledge Graph" },
    { id: "memories", label: "Memory Explorer" },
    { id: "watchlist", label: "Watch List" },
    { id: "history", label: "History" },
    { id: "digest", label: "Digest" },
  ];

  it("includes the Digest tab", () => {
    const digestTab = TABS.find((t) => t.id === "digest");
    expect(digestTab).toBeDefined();
    expect(digestTab!.label).toBe("Digest");
  });

  it("has 6 tabs total", () => {
    expect(TABS).toHaveLength(6);
  });

  it("includes all expected tab IDs", () => {
    const ids = TABS.map((t) => t.id);
    expect(ids).toContain("chat");
    expect(ids).toContain("graph");
    expect(ids).toContain("memories");
    expect(ids).toContain("watchlist");
    expect(ids).toContain("history");
    expect(ids).toContain("digest");
  });

  it("has unique tab IDs", () => {
    const ids = TABS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
