import { describe, it, expect, vi, beforeEach } from "vitest";
import { runMonitoringCycle } from "./crawler";

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
    CRAWL_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    STORAGE: {} as any,
    BROWSER: {} as any,
    AI: {
      run: vi.fn().mockResolvedValue({ response: "Summary of changes" }),
    },
    CHAT_MODEL: "test-model",
    EMBEDDING_MODEL: "test-embed",
    CortexAgent: {} as any,
    CONSOLIDATION_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    },
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

  it("returns zero enqueued when no items are due", async () => {
    env.DB._stmt.all.mockResolvedValue({ results: [] });

    const result = await runMonitoringCycle(env);

    expect(result).toEqual({ enqueued: 0 });
    expect(env.CRAWL_QUEUE.send).not.toHaveBeenCalled();
  });

  it("enqueues all due items to CRAWL_QUEUE", async () => {
    env.DB._stmt.all.mockResolvedValueOnce({ results: mockDueItems });

    const result = await runMonitoringCycle(env);

    expect(result.enqueued).toBe(2);
    expect(env.CRAWL_QUEUE.send).toHaveBeenCalledTimes(2);
  });

  it("sends correct message shape for each item", async () => {
    env.DB._stmt.all.mockResolvedValueOnce({
      results: [mockDueItems[0]],
    });

    await runMonitoringCycle(env);

    expect(env.CRAWL_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "crawl",
        watchItem: expect.objectContaining({
          id: "item-1",
          url: "https://example.com",
          label: "Example",
        }),
      })
    );
  });

  it("does not process items directly — no extractUrl or AI calls", async () => {
    env.DB._stmt.all.mockResolvedValueOnce({ results: mockDueItems });

    await runMonitoringCycle(env);

    // Crawler should only enqueue, not call AI or update DB beyond getDueItems
    expect(env.AI.run).not.toHaveBeenCalled();
    // Only the getDueItems prepare call should happen, not updateLastChecked
    expect(env.DB.prepare).toHaveBeenCalledTimes(1);
  });
});
