import { describe, it, expect, vi, beforeEach } from "vitest";
import { processCrawlMessage } from "./crawl-consumer";
import type { CrawlMessage } from "./queue-types";

// ── Mock Env ─────────────────────────────────────────────────

function createMockEnv() {
  return {
    CRAWLER_SERVICE: {
      fetch: vi.fn().mockResolvedValue(
        Response.json({ ok: true, hash: "abc123" }, { status: 200 })
      ),
    },
    // Other env bindings (not used by the forwarding consumer, but present for type compatibility)
    DB: {} as any,
    STORAGE: {} as any,
    BROWSER: {} as any,
    AI: {} as any,
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

  it("forwards crawl message to CRAWLER_SERVICE via fetch", async () => {
    const msg = createCrawlMessage();
    await processCrawlMessage(msg, env);

    expect(env.CRAWLER_SERVICE.fetch).toHaveBeenCalledTimes(1);

    // Verify the request was a POST with JSON body
    const fetchCall = env.CRAWLER_SERVICE.fetch.mock.calls[0][0] as Request;
    expect(fetchCall.method).toBe("POST");
    expect(fetchCall.headers.get("Content-Type")).toBe("application/json");

    // Verify the body contains the crawl message
    const body = await fetchCall.clone().json();
    expect(body).toEqual(msg);
  });

  it("sends the complete watch item data in the request body", async () => {
    const msg = createCrawlMessage({
      id: "item-42",
      url: "https://special.example.com",
      label: "Special Page",
      lastHash: "previous-hash",
    });

    await processCrawlMessage(msg, env);

    const fetchCall = env.CRAWLER_SERVICE.fetch.mock.calls[0][0] as Request;
    const body = await fetchCall.clone().json();
    expect(body.watchItem.id).toBe("item-42");
    expect(body.watchItem.url).toBe("https://special.example.com");
    expect(body.watchItem.label).toBe("Special Page");
    expect(body.watchItem.lastHash).toBe("previous-hash");
  });

  it("completes successfully when crawler service returns 200", async () => {
    const msg = createCrawlMessage();
    // Should not throw
    await expect(processCrawlMessage(msg, env)).resolves.toBeUndefined();
  });

  it("throws error when crawler service returns non-200 status", async () => {
    env.CRAWLER_SERVICE.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "Browser timeout" }), { status: 500 })
    );

    const msg = createCrawlMessage();
    await expect(processCrawlMessage(msg, env)).rejects.toThrow(
      "Crawler service returned 500"
    );
  });

  it("throws error when crawler service returns 400", async () => {
    env.CRAWLER_SERVICE.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid crawl message" }), { status: 400 })
    );

    const msg = createCrawlMessage();
    await expect(processCrawlMessage(msg, env)).rejects.toThrow(
      "Crawler service returned 400"
    );
  });

  it("does not directly access DB, AI, or BROWSER bindings", async () => {
    // The consumer should only forward via CRAWLER_SERVICE,
    // not process the crawl locally
    const dbPrepare = vi.fn();
    const aiRun = vi.fn();
    const browserFetch = vi.fn();

    env.DB = { prepare: dbPrepare } as any;
    env.AI = { run: aiRun } as any;
    env.BROWSER = { fetch: browserFetch } as any;

    const msg = createCrawlMessage();
    await processCrawlMessage(msg, env);

    expect(dbPrepare).not.toHaveBeenCalled();
    expect(aiRun).not.toHaveBeenCalled();
    expect(browserFetch).not.toHaveBeenCalled();
  });
});
