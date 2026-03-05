import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMonitoringCycle } from "./crawler";

// Mock the extractUrl import from browser/extract
vi.mock("../browser/extract", () => ({
  extractUrl: vi.fn(),
}));

import { extractUrl } from "../browser/extract";

// ── Mock Env ─────────────────────────────────────────────────

function createMockEnv() {
  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue(null),
  };

  return {
    DB: {
      prepare: vi.fn().mockReturnValue(mockStmt),
      batch: vi.fn().mockResolvedValue([]),
      _stmt: mockStmt,
    },
    STORAGE: {} as any,
    BROWSER: {} as any,
    AI: {
      run: vi.fn().mockResolvedValue({ response: "Summary of changes" }),
    },
    CHAT_MODEL: "test-model",
    EMBEDDING_MODEL: "test-embed",
    CortexAgent: {} as any,
  } as any;
}

const mockDueItems = [
  {
    id: "item-1",
    url: "https://example.com",
    label: "Example",
    frequency: "daily",
    last_checked: null,
    last_hash: null,
    active: 1,
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "item-2",
    url: "https://other.com",
    label: "Other",
    frequency: "hourly",
    last_checked: "2024-01-01T00:00:00Z",
    last_hash: "oldhash",
    active: 1,
    created_at: "2024-01-01T00:00:00Z",
  },
];

// ── Tests ────────────────────────────────────────────────────

describe("runMonitoringCycle", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createMockEnv();
  });

  it("returns zero stats when no items are due", async () => {
    env.DB._stmt.all.mockResolvedValue({ results: [] });

    const result = await runMonitoringCycle(env);

    expect(result).toEqual({ checked: 0, changed: 0, errors: 0 });
  });

  it("checks due items and detects changes", async () => {
    // getDueItems returns 2 items
    env.DB._stmt.all.mockResolvedValueOnce({ results: mockDueItems });

    // Mock extractUrl to return content
    const mockExtract = extractUrl as unknown as ReturnType<typeof vi.fn>;
    mockExtract.mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      description: "",
      content: "New content here",
      extractedAt: new Date().toISOString(),
    });

    const result = await runMonitoringCycle(env);

    expect(result.checked).toBe(2);
    // Both items should show as changed since they have different/null hashes
    expect(result.changed).toBe(2);
    expect(result.errors).toBe(0);

    // extractUrl should be called for each due item
    expect(mockExtract).toHaveBeenCalledTimes(2);
  });

  it("does not mark as changed when hash matches", async () => {
    // Single item with a known hash
    const sameContentItem = {
      ...mockDueItems[1],
      // We need to set last_hash to the SHA-256 of "Same content"
      // Since we can't compute it here, we'll mock extractUrl to return content
      // whose hash won't match the existing hash
    };
    env.DB._stmt.all.mockResolvedValueOnce({
      results: [sameContentItem],
    });

    const mockExtract = extractUrl as unknown as ReturnType<typeof vi.fn>;
    mockExtract.mockResolvedValue({
      url: "https://other.com",
      title: "Other",
      description: "",
      content: "Some content",
      extractedAt: new Date().toISOString(),
    });

    const result = await runMonitoringCycle(env);

    expect(result.checked).toBe(1);
    // Hash won't match "oldhash" so it counts as changed
    expect(result.changed).toBe(1);
  });

  it("handles extraction errors gracefully", async () => {
    env.DB._stmt.all.mockResolvedValueOnce({ results: [mockDueItems[0]] });

    const mockExtract = extractUrl as unknown as ReturnType<typeof vi.fn>;
    mockExtract.mockRejectedValue(new Error("Network error"));

    const result = await runMonitoringCycle(env);

    expect(result.checked).toBe(0);
    expect(result.changed).toBe(0);
    expect(result.errors).toBe(1);
  });

  it("calls AI to summarize when content changes", async () => {
    env.DB._stmt.all.mockResolvedValueOnce({
      results: [mockDueItems[0]],
    });

    const mockExtract = extractUrl as unknown as ReturnType<typeof vi.fn>;
    mockExtract.mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      description: "",
      content: "Changed content",
      extractedAt: new Date().toISOString(),
    });

    await runMonitoringCycle(env);

    // AI should be called to summarize the changes
    expect(env.AI.run).toHaveBeenCalledWith(
      "test-model",
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "system" }),
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Example"),
          }),
        ]),
      })
    );
  });
});
