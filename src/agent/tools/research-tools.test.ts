import { describe, it, expect, vi } from "vitest";
import { createResearchTools } from "./research-tools";

// ── Mock Factories ──────────────────────────────────────────────

function createMockBrowser(html: string): Fetcher {
  return {
    fetch: vi.fn(async () => {
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }),
  } as unknown as Fetcher;
}

function createMockStorage(): R2Bucket {
  return {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => null),
  } as unknown as R2Bucket;
}

function createMockSemanticMemory() {
  return {
    write: vi.fn(async () => "mock-memory-id"),
    search: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
  };
}

function createMockAi(): Ai {
  return {
    run: vi.fn(async () => ({
      response: "This is a mock summary of the content.",
    })),
  } as unknown as Ai;
}

const sampleHtml = `
  <html>
    <head>
      <title>Sample Page</title>
      <meta name="description" content="A sample page description">
    </head>
    <body>
      <article>
        <h1>Sample Page</h1>
        <p>This is the main content of the sample page.</p>
      </article>
    </body>
  </html>
`;

// ── readUrl Tool Tests ──────────────────────────────────────────

describe("readUrl tool", () => {
  it("extracts and summarizes content from a URL", async () => {
    const semanticMemory = createMockSemanticMemory();
    const tools = createResearchTools({
      browser: createMockBrowser(sampleHtml),
      storage: createMockStorage(),
      semanticMemory: semanticMemory as any,
      ai: createMockAi(),
      chatModel: "test-model",
      embeddingModel: "test-embed-model",
    });

    const result = await tools.readUrl.execute(
      { url: "https://example.com", save: false },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );

    expect(result.title).toBe("Sample Page");
    expect(result.summary).toBeTruthy();
    expect(result.content_preview).toBeTruthy();
    expect(result).not.toHaveProperty("saved");
    expect(semanticMemory.write).not.toHaveBeenCalled();
  });

  it("saves to semantic memory when save=true", async () => {
    const semanticMemory = createMockSemanticMemory();
    const tools = createResearchTools({
      browser: createMockBrowser(sampleHtml),
      storage: createMockStorage(),
      semanticMemory: semanticMemory as any,
      ai: createMockAi(),
      chatModel: "test-model",
      embeddingModel: "test-embed-model",
    });

    const result = await tools.readUrl.execute(
      { url: "https://example.com", save: true },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );

    expect(result.saved).toBeDefined();
    expect(result.saved!.id).toBe("mock-memory-id");
    expect(semanticMemory.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "note",
        source: "research",
        tags: expect.arrayContaining(["url", "web-content"]),
      })
    );
  });

  it("has correct tool definition properties", () => {
    const tools = createResearchTools({
      browser: createMockBrowser(sampleHtml),
      storage: createMockStorage(),
      semanticMemory: createMockSemanticMemory() as any,
      ai: createMockAi(),
      chatModel: "test-model",
      embeddingModel: "test-embed-model",
    });

    // The tool should have description and inputSchema (AI SDK v6 pattern)
    expect(tools.readUrl).toHaveProperty("description");
    expect(tools.readUrl).toHaveProperty("execute");
  });
});

// ── research Tool Tests ─────────────────────────────────────────

describe("research tool", () => {
  it("synthesizes content from multiple URLs", async () => {
    const semanticMemory = createMockSemanticMemory();
    const ai = createMockAi();
    const tools = createResearchTools({
      browser: createMockBrowser(sampleHtml),
      storage: createMockStorage(),
      semanticMemory: semanticMemory as any,
      ai,
      chatModel: "test-model",
      embeddingModel: "test-embed-model",
    });

    const result = await tools.research.execute(
      {
        urls: ["https://example.com/1", "https://example.com/2"],
        topic: "test topic",
      },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );

    expect(result.synthesis).toBeTruthy();
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toHaveProperty("url");
    expect(result.sources[0]).toHaveProperty("title");
    expect(result.sources[0]).toHaveProperty("summary");
    expect(result.memory_id).toBe("mock-memory-id");
  });

  it("saves synthesis to semantic memory with research source", async () => {
    const semanticMemory = createMockSemanticMemory();
    const tools = createResearchTools({
      browser: createMockBrowser(sampleHtml),
      storage: createMockStorage(),
      semanticMemory: semanticMemory as any,
      ai: createMockAi(),
      chatModel: "test-model",
      embeddingModel: "test-embed-model",
    });

    await tools.research.execute(
      {
        urls: ["https://example.com/1"],
        topic: "AI agents",
      },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );

    expect(semanticMemory.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "note",
        source: "research",
        tags: expect.arrayContaining(["research", "synthesis"]),
      })
    );
  });

  it("handles URL extraction failures gracefully", async () => {
    const failingBrowser = {
      fetch: vi.fn(async () => new Response("Error", { status: 500 })),
    } as unknown as Fetcher;

    const semanticMemory = createMockSemanticMemory();
    const tools = createResearchTools({
      browser: failingBrowser,
      storage: createMockStorage(),
      semanticMemory: semanticMemory as any,
      ai: createMockAi(),
      chatModel: "test-model",
      embeddingModel: "test-embed-model",
    });

    const result = await tools.research.execute(
      {
        urls: ["https://example.com/fail"],
        topic: "test topic",
      },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );

    expect(result.sources).toHaveLength(0);
    expect(result.synthesis).toContain("Failed to extract");
    expect(result.memory_id).toBeNull();
  });

  it("handles mixed success and failure URLs", async () => {
    let callCount = 0;
    const mixedBrowser = {
      fetch: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response(sampleHtml, {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response("Error", { status: 500 });
      }),
    } as unknown as Fetcher;

    const semanticMemory = createMockSemanticMemory();
    const tools = createResearchTools({
      browser: mixedBrowser,
      storage: createMockStorage(),
      semanticMemory: semanticMemory as any,
      ai: createMockAi(),
      chatModel: "test-model",
      embeddingModel: "test-embed-model",
    });

    const result = await tools.research.execute(
      {
        urls: ["https://example.com/good", "https://example.com/bad"],
        topic: "test topic",
      },
      { toolCallId: "test", messages: [], abortSignal: undefined as any }
    );

    // Should succeed with at least the one good URL
    expect(result.sources.length).toBeGreaterThanOrEqual(1);
    expect(result.memory_id).toBe("mock-memory-id");
  });
});

// ── Tool Index Export Test ───────────────────────────────────────

describe("tool barrel export", () => {
  it("exports createResearchTools from index", async () => {
    const { createResearchTools: exported } = await import("./index");
    expect(exported).toBeDefined();
    expect(typeof exported).toBe("function");
  });
});
