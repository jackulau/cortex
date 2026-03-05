import { describe, it, expect, vi, beforeEach } from "vitest";
import { processCrawlMessage } from "./crawl-consumer";
import type { CrawlMessage } from "./queue-types";

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
    CRAWL_QUEUE: { send: vi.fn() },
    CONSOLIDATION_QUEUE: { send: vi.fn() },
  } as any;
}

function createCrawlMessage(overrides?: Partial<CrawlMessage["watchItem"]>): CrawlMessage {
  return {
    type: "crawl",
    watchItem: {
      id: "item-1",
      url: "https://example.com",
      label: "Example",
      frequency: "daily",
      lastChecked: null,
      lastHash: null,
      active: true,
      createdAt: "2024-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("processCrawlMessage", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createMockEnv();
  });

  it("extracts URL content and updates last_checked", async () => {
    const mockExtract = extractUrl as unknown as ReturnType<typeof vi.fn>;
    mockExtract.mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      description: "",
      content: "Page content here",
      extractedAt: new Date().toISOString(),
    });

    const msg = createCrawlMessage();
    await processCrawlMessage(msg, env);

    // extractUrl should be called for the item's URL
    expect(mockExtract).toHaveBeenCalledWith(
      env.BROWSER,
      env.STORAGE,
      "https://example.com"
    );

    // Should call DB to update last_checked (updateLastChecked uses prepare + bind + run)
    // At minimum, prepare should have been called for the update
    expect(env.DB.prepare).toHaveBeenCalled();
  });

  it("detects change and creates digest entry when hash differs", async () => {
    const mockExtract = extractUrl as unknown as ReturnType<typeof vi.fn>;
    mockExtract.mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      description: "",
      content: "New content",
      extractedAt: new Date().toISOString(),
    });

    // Item with no previous hash — always counts as changed
    const msg = createCrawlMessage({ lastHash: null });
    await processCrawlMessage(msg, env);

    // AI should be called to summarize
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

    // Digest entry should be inserted (INSERT INTO digest_entries)
    const prepareCalls = env.DB.prepare.mock.calls.map(
      (c: string[]) => c[0]
    );
    const hasDigestInsert = prepareCalls.some(
      (sql: string) =>
        typeof sql === "string" && sql.includes("digest_entries")
    );
    expect(hasDigestInsert).toBe(true);
  });

  it("skips digest creation when hash matches (no change)", async () => {
    // We need the hash of "Same content" to match lastHash.
    // Since crypto.subtle.digest is available in vitest (node env), compute it.
    const encoder = new TextEncoder();
    const data = encoder.encode("Same content");
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const expectedHash = hashArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const mockExtract = extractUrl as unknown as ReturnType<typeof vi.fn>;
    mockExtract.mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      description: "",
      content: "Same content",
      extractedAt: new Date().toISOString(),
    });

    const msg = createCrawlMessage({ lastHash: expectedHash });
    await processCrawlMessage(msg, env);

    // AI should NOT be called (no change detected)
    expect(env.AI.run).not.toHaveBeenCalled();

    // updateLastChecked should still be called
    expect(env.DB.prepare).toHaveBeenCalled();
  });

  it("propagates errors to allow queue retry", async () => {
    const mockExtract = extractUrl as unknown as ReturnType<typeof vi.fn>;
    mockExtract.mockRejectedValue(new Error("Network error"));

    const msg = createCrawlMessage();

    await expect(processCrawlMessage(msg, env)).rejects.toThrow(
      "Network error"
    );
  });

  it("truncates content to 2000 chars for digest changes field", async () => {
    const longContent = "x".repeat(5000);
    const mockExtract = extractUrl as unknown as ReturnType<typeof vi.fn>;
    mockExtract.mockResolvedValue({
      url: "https://example.com",
      title: "Example",
      description: "",
      content: longContent,
      extractedAt: new Date().toISOString(),
    });

    const msg = createCrawlMessage({ lastHash: null });
    await processCrawlMessage(msg, env);

    // The digest insert's changes parameter should be truncated
    // Find the bind call that includes the truncated content
    const bindCalls = env.DB._stmt.bind.mock.calls;
    const hasSlicedContent = bindCalls.some(
      (args: any[]) =>
        typeof args[3] === "string" && args[3].length === 2000
    );
    expect(hasSlicedContent).toBe(true);
  });
});
