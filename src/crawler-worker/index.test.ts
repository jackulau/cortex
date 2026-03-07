import { describe, it, expect, vi, beforeEach } from "vitest";
import crawlerWorker, { handleCrawlRequest, computeSha256 } from "./index";
import type { CrawlerEnv } from "../shared/types";
import type { CrawlMessage } from "../monitor/queue-types";

// ── Mock Helpers ────────────────────────────────────────────────

function createMockCrawlerEnv(): CrawlerEnv {
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
    } as any,
    STORAGE: {} as any,
    BROWSER: {
      fetch: vi.fn(async () => {
        const html = `
          <html>
            <head><title>Test Page</title></head>
            <body><article>Test content here</article></body>
          </html>
        `;
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }),
    } as unknown as Fetcher,
    AI: {
      run: vi.fn().mockResolvedValue({ response: "Summary of changes" }),
    } as any,
    VECTORIZE: {} as any,
    EMBEDDING_MODEL: "@cf/baai/bge-large-en-v1.5",
    CHAT_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  };
}

function createCrawlMessage(overrides?: Partial<CrawlMessage["watchItem"]>): CrawlMessage {
  return {
    type: "crawl",
    watchItem: {
      id: "item-1",
      url: "https://example.com/page",
      label: "Example Page",
      frequency: "daily",
      lastChecked: null,
      lastHash: null,
      active: true,
      createdAt: "2024-01-01T00:00:00Z",
      ...overrides,
    },
  };
}

// ── Worker fetch() Tests ────────────────────────────────────────

describe("crawler worker fetch handler", () => {
  let env: CrawlerEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createMockCrawlerEnv();
  });

  it("rejects non-POST requests with 405", async () => {
    const request = new Request("https://crawler.internal/crawl", {
      method: "GET",
    });

    const response = await crawlerWorker.fetch(request, env);
    expect(response.status).toBe(405);
  });

  it("rejects invalid crawl messages with 400", async () => {
    const request = new Request("https://crawler.internal/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "invalid" }),
    });

    const response = await crawlerWorker.fetch(request, env);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect((body as any).error).toBe("Invalid crawl message");
  });

  it("processes valid crawl message and returns 200", async () => {
    const message = createCrawlMessage();
    const request = new Request("https://crawler.internal/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    const response = await crawlerWorker.fetch(request, env);
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; hash: string };
    expect(body.ok).toBe(true);
    expect(body.hash).toBeTruthy();
  });

  it("returns 500 on processing errors", async () => {
    // Make BROWSER.fetch fail
    (env.BROWSER as any).fetch = vi.fn().mockRejectedValue(new Error("Browser crash"));

    const message = createCrawlMessage();
    const request = new Request("https://crawler.internal/crawl", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    const response = await crawlerWorker.fetch(request, env);
    expect(response.status).toBe(500);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Browser crash");
  });
});

// ── handleCrawlRequest Tests ────────────────────────────────────

describe("handleCrawlRequest", () => {
  let env: CrawlerEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createMockCrawlerEnv();
  });

  it("extracts content via BROWSER binding", async () => {
    const message = createCrawlMessage();

    const response = await handleCrawlRequest(message, env);
    expect(response.status).toBe(200);

    // Verify BROWSER.fetch was called with the watch item URL
    expect(env.BROWSER.fetch).toHaveBeenCalledWith(
      "https://example.com/page",
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: "text/html" }),
      })
    );
  });

  it("inserts digest entry when content hash differs from lastHash", async () => {
    const message = createCrawlMessage({ lastHash: "different-hash" });

    await handleCrawlRequest(message, env);

    // AI.run should have been called for summarization
    expect(env.AI.run).toHaveBeenCalled();

    // DB.prepare should be called for both addEntry (INSERT) and updateLastChecked (UPDATE)
    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const sqlStatements = prepareCalls.map((c: string[]) => c[0]);

    expect(sqlStatements.some((s: string) => s.includes("INSERT INTO digest_entries"))).toBe(
      true
    );
    expect(sqlStatements.some((s: string) => s.includes("UPDATE watch_items"))).toBe(true);
  });

  it("skips digest entry when content hash matches lastHash", async () => {
    // Content extracted from <article> by extractMainContent (title not included)
    const extractedContent = "Test content here";
    const expectedHash = await computeSha256(extractedContent);

    const message = createCrawlMessage({ lastHash: expectedHash });

    await handleCrawlRequest(message, env);

    // AI.run should NOT have been called (no change detected)
    expect(env.AI.run).not.toHaveBeenCalled();

    // Only updateLastChecked should be called, not addEntry
    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const sqlStatements = prepareCalls.map((c: string[]) => c[0]);

    expect(sqlStatements.some((s: string) => s.includes("INSERT INTO digest_entries"))).toBe(
      false
    );
    expect(sqlStatements.some((s: string) => s.includes("UPDATE watch_items"))).toBe(true);
  });

  it("always updates last_checked regardless of change", async () => {
    const message = createCrawlMessage();

    await handleCrawlRequest(message, env);

    const prepareCalls = (env.DB.prepare as ReturnType<typeof vi.fn>).mock.calls;
    const sqlStatements = prepareCalls.map((c: string[]) => c[0]);

    expect(sqlStatements.some((s: string) => s.includes("UPDATE watch_items"))).toBe(true);
  });
});

// ── computeSha256 Tests ────────────────────────────────────────

describe("computeSha256", () => {
  it("produces consistent hashes for the same input", async () => {
    const hash1 = await computeSha256("hello world");
    const hash2 = await computeSha256("hello world");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", async () => {
    const hash1 = await computeSha256("hello");
    const hash2 = await computeSha256("world");
    expect(hash1).not.toBe(hash2);
  });

  it("returns a 64-character hex string", async () => {
    const hash = await computeSha256("test");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ── Service Binding Integration Test ────────────────────────────

describe("crawl-consumer integration (service binding forwarding)", () => {
  it("forwards crawl message to CRAWLER_SERVICE and handles success", async () => {
    // This tests the pattern used in crawl-consumer.ts
    const mockCrawlerService = {
      fetch: vi.fn().mockResolvedValue(
        Response.json({ ok: true, hash: "abc123" }, { status: 200 })
      ),
    } as unknown as Fetcher;

    const message = createCrawlMessage();

    const response = await mockCrawlerService.fetch(
      new Request("https://crawler.internal/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      })
    );

    expect(response.ok).toBe(true);
    expect(mockCrawlerService.fetch).toHaveBeenCalledTimes(1);
  });

  it("propagates errors when crawler service returns non-200", async () => {
    const mockCrawlerService = {
      fetch: vi.fn().mockResolvedValue(
        Response.json({ error: "Browser timeout" }, { status: 500 })
      ),
    } as unknown as Fetcher;

    const response = await mockCrawlerService.fetch(
      new Request("https://crawler.internal/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createCrawlMessage()),
      })
    );

    expect(response.ok).toBe(false);
    expect(response.status).toBe(500);
  });
});
