import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWatchTools } from "./watch-tools";

// ── Mock Dependencies ────────────────────────────────────────

function createMockDeps() {
  const mockWatchList = {
    add: vi.fn().mockResolvedValue("new-watch-id"),
    remove: vi.fn().mockResolvedValue(true),
    list: vi.fn().mockResolvedValue([
      {
        id: "watch-1",
        url: "https://example.com",
        label: "Example",
        frequency: "daily",
        lastChecked: "2024-01-15T10:00:00Z",
        lastHash: "abc123",
        active: true,
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "watch-2",
        url: "https://other.com",
        label: "Other",
        frequency: "weekly",
        lastChecked: null,
        lastHash: null,
        active: true,
        createdAt: "2024-01-02T00:00:00Z",
      },
    ]),
    get: vi.fn(),
    getDueItems: vi.fn(),
    updateLastChecked: vi.fn(),
  } as any;

  const mockDigestManager = {
    getUndelivered: vi.fn().mockResolvedValue([]),
    getByWatchItem: vi.fn(),
    markDelivered: vi.fn(),
    generateDigest: vi.fn().mockResolvedValue("Formatted digest"),
    addEntry: vi.fn(),
  } as any;

  const mockAi = {
    run: vi.fn().mockResolvedValue({ response: "test" }),
  } as any;

  return {
    watchList: mockWatchList,
    digestManager: mockDigestManager,
    ai: mockAi,
    chatModel: "test-model",
  };
}

const toolContext = {
  messages: [],
  toolCallId: "test",
  abortSignal: undefined as any,
};

// ── Tests ────────────────────────────────────────────────────

describe("createWatchTools", () => {
  let deps: ReturnType<typeof createMockDeps>;
  let tools: ReturnType<typeof createWatchTools>;

  beforeEach(() => {
    deps = createMockDeps();
    tools = createWatchTools(deps);
  });

  it("returns all four watch tools", () => {
    expect(tools.watchAdd).toBeDefined();
    expect(tools.watchList).toBeDefined();
    expect(tools.watchRemove).toBeDefined();
    expect(tools.getDigest).toBeDefined();
  });

  describe("watchAdd", () => {
    it("adds a URL and returns success with ID", async () => {
      const result = await tools.watchAdd.execute(
        { url: "https://example.com", label: "Example", frequency: "daily" },
        toolContext
      );

      expect(result.success).toBe(true);
      expect(result.id).toBe("new-watch-id");
      expect(result.message).toContain("Example");
      expect(result.message).toContain("daily");
      expect(deps.watchList.add).toHaveBeenCalledWith({
        url: "https://example.com",
        label: "Example",
        frequency: "daily",
      });
    });
  });

  describe("watchList", () => {
    it("returns all watch items", async () => {
      const result = await tools.watchList.execute({}, toolContext);

      expect(result.count).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].id).toBe("watch-1");
      expect(result.items[0].url).toBe("https://example.com");
      expect(result.items[0].label).toBe("Example");
      expect(result.items[0].frequency).toBe("daily");
      expect(result.items[0].lastChecked).toBe("2024-01-15T10:00:00Z");
    });

    it("returns empty list when no items", async () => {
      deps.watchList.list.mockResolvedValue([]);
      const result = await tools.watchList.execute({}, toolContext);

      expect(result.count).toBe(0);
      expect(result.items).toHaveLength(0);
    });
  });

  describe("watchRemove", () => {
    it("returns success when item is removed", async () => {
      const result = await tools.watchRemove.execute(
        { id: "watch-1" },
        toolContext
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe("Watch item removed.");
      expect(deps.watchList.remove).toHaveBeenCalledWith("watch-1");
    });

    it("returns failure when item not found", async () => {
      deps.watchList.remove.mockResolvedValue(false);
      const result = await tools.watchRemove.execute(
        { id: "nonexistent" },
        toolContext
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe("Watch item not found.");
    });
  });

  describe("getDigest", () => {
    it("returns no updates when nothing to deliver", async () => {
      deps.digestManager.generateDigest.mockResolvedValue(
        "No new updates to report."
      );

      const result = await tools.getDigest.execute({}, toolContext);

      expect(result.hasUpdates).toBe(false);
      expect(result.digest).toBe("No new updates to report.");
    });

    it("returns formatted digest when updates exist", async () => {
      deps.digestManager.generateDigest.mockResolvedValue(
        "# Digest\n## Example\n- New changes detected"
      );

      const result = await tools.getDigest.execute({}, toolContext);

      expect(result.hasUpdates).toBe(true);
      expect(result.digest).toContain("Digest");
      expect(deps.digestManager.generateDigest).toHaveBeenCalledWith(
        deps.ai,
        "test-model"
      );
    });
  });
});
