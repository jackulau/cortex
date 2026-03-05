import { describe, it, expect, vi } from "vitest";
import {
  extractUrl,
  extractTitle,
  extractMetaDescription,
  extractPublishedDate,
  extractMainContent,
  stripElements,
} from "./extract";

// ── HTML Parsing Tests ──────────────────────────────────────────

describe("extractTitle", () => {
  it("extracts title from standard HTML", () => {
    const html = "<html><head><title>Test Page</title></head><body></body></html>";
    expect(extractTitle(html)).toBe("Test Page");
  });

  it("returns empty string when no title", () => {
    const html = "<html><head></head><body></body></html>";
    expect(extractTitle(html)).toBe("");
  });

  it("decodes HTML entities in title", () => {
    const html = "<title>Tom &amp; Jerry&#039;s Adventure</title>";
    expect(extractTitle(html)).toBe("Tom & Jerry's Adventure");
  });

  it("handles multiline titles", () => {
    const html = "<title>\n  My Page\n  Title\n</title>";
    expect(extractTitle(html)).toBe("My Page\n  Title");
  });
});

describe("extractMetaDescription", () => {
  it("extracts meta description with name attribute", () => {
    const html =
      '<meta name="description" content="This is a description">';
    expect(extractMetaDescription(html)).toBe("This is a description");
  });

  it("extracts meta description with content before name", () => {
    const html =
      '<meta content="Reversed order" name="description">';
    expect(extractMetaDescription(html)).toBe("Reversed order");
  });

  it("falls back to og:description", () => {
    const html =
      '<meta property="og:description" content="OG description">';
    expect(extractMetaDescription(html)).toBe("OG description");
  });

  it("returns empty string when no description", () => {
    const html = "<html><head></head><body></body></html>";
    expect(extractMetaDescription(html)).toBe("");
  });
});

describe("extractPublishedDate", () => {
  it("extracts article:published_time", () => {
    const html =
      '<meta property="article:published_time" content="2024-01-15T10:00:00Z">';
    expect(extractPublishedDate(html)).toBe("2024-01-15T10:00:00Z");
  });

  it("extracts from time element", () => {
    const html = '<time datetime="2024-01-15">January 15, 2024</time>';
    expect(extractPublishedDate(html)).toBe("2024-01-15");
  });

  it("returns empty string when no date", () => {
    const html = "<html><body></body></html>";
    expect(extractPublishedDate(html)).toBe("");
  });
});

describe("extractMainContent", () => {
  it("prefers article element", () => {
    const html = `
      <html><body>
        <nav>Navigation</nav>
        <article>Article content here</article>
        <main>Main content here</main>
      </body></html>
    `;
    const content = extractMainContent(html);
    expect(content).toContain("Article content here");
    expect(content).not.toContain("Navigation");
  });

  it("falls back to main element when no article", () => {
    const html = `
      <html><body>
        <nav>Navigation</nav>
        <main>Main content here</main>
      </body></html>
    `;
    const content = extractMainContent(html);
    expect(content).toContain("Main content here");
    expect(content).not.toContain("Navigation");
  });

  it("falls back to body when no article or main", () => {
    const html = `
      <html><body>
        <div>Just body content</div>
      </body></html>
    `;
    const content = extractMainContent(html);
    expect(content).toContain("Just body content");
  });

  it("strips script, style, nav, footer, header elements", () => {
    const html = `
      <body>
        <header>Header</header>
        <nav>Nav</nav>
        <script>console.log('x')</script>
        <style>.foo { color: red; }</style>
        <p>Actual content</p>
        <footer>Footer</footer>
      </body>
    `;
    const content = extractMainContent(html);
    expect(content).toContain("Actual content");
    expect(content).not.toContain("Header");
    expect(content).not.toContain("Nav");
    expect(content).not.toContain("console.log");
    expect(content).not.toContain("color: red");
    expect(content).not.toContain("Footer");
  });

  it("collapses whitespace", () => {
    const html = "<body>  lots   of    spaces  </body>";
    const content = extractMainContent(html);
    expect(content).toBe("lots of spaces");
  });
});

describe("stripElements", () => {
  it("removes specified elements and their content", () => {
    const html =
      "<div>Keep<script>remove</script> this<style>remove</style></div>";
    const result = stripElements(html, ["script", "style"]);
    expect(result).toContain("Keep");
    expect(result).toContain("this");
    expect(result).not.toContain("remove");
  });

  it("handles nested elements", () => {
    const html = "<nav><ul><li>Link 1</li></ul></nav><p>Content</p>";
    const result = stripElements(html, ["nav"]);
    expect(result).toContain("Content");
    expect(result).not.toContain("Link 1");
  });
});

// ── extractUrl Integration Tests ────────────────────────────────

describe("extractUrl", () => {
  function createMockBrowser(html: string, screenshotOk = true): Fetcher {
    return {
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        const accept = (init?.headers as Record<string, string>)?.Accept;
        if (accept === "image/png" && screenshotOk) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        if (accept === "image/png" && !screenshotOk) {
          return new Response("Error", { status: 500 });
        }
        return new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }),
    } as unknown as Fetcher;
  }

  function createMockStorage(): R2Bucket {
    const stored = new Map<string, unknown>();
    return {
      put: vi.fn(async (key: string, value: unknown) => {
        stored.set(key, value);
      }),
      get: vi.fn(async (key: string) => stored.get(key)),
    } as unknown as R2Bucket;
  }

  const sampleHtml = `
    <html>
      <head>
        <title>Test Article</title>
        <meta name="description" content="A test article description">
        <meta property="article:published_time" content="2024-06-15T12:00:00Z">
      </head>
      <body>
        <nav>Navigation links</nav>
        <article>
          <h1>Test Article</h1>
          <p>This is the main article content with important information.</p>
        </article>
        <footer>Footer content</footer>
      </body>
    </html>
  `;

  it("extracts content from a URL", async () => {
    const browser = createMockBrowser(sampleHtml);
    const storage = createMockStorage();

    const result = await extractUrl(browser, storage, "https://example.com/article");

    expect(result.url).toBe("https://example.com/article");
    expect(result.title).toBe("Test Article");
    expect(result.description).toBe("A test article description");
    expect(result.content).toContain("main article content");
    expect(result.content).not.toContain("Navigation links");
    expect(result.content).not.toContain("Footer content");
    expect(result.publishedDate).toBe("2024-06-15T12:00:00Z");
    expect(result.extractedAt).toBeTruthy();
    expect(result.screenshotKey).toBeUndefined();
    expect(result.rawKey).toBeUndefined();
  });

  it("stores screenshot in R2 when requested", async () => {
    const browser = createMockBrowser(sampleHtml);
    const storage = createMockStorage();

    const result = await extractUrl(browser, storage, "https://example.com", {
      screenshot: true,
    });

    expect(result.screenshotKey).toMatch(/^screenshots\/[a-f0-9]+\.png$/);
    expect(storage.put).toHaveBeenCalledWith(
      expect.stringMatching(/^screenshots\//),
      expect.any(ArrayBuffer),
      expect.objectContaining({
        httpMetadata: { contentType: "image/png" },
      })
    );
  });

  it("stores archive in R2 when requested", async () => {
    const browser = createMockBrowser(sampleHtml);
    const storage = createMockStorage();

    const result = await extractUrl(browser, storage, "https://example.com", {
      archive: true,
    });

    expect(result.rawKey).toMatch(/^archives\/[a-f0-9]+\.json$/);
    expect(storage.put).toHaveBeenCalledWith(
      expect.stringMatching(/^archives\//),
      expect.any(String),
      expect.objectContaining({
        httpMetadata: { contentType: "application/json" },
      })
    );
  });

  it("throws on HTTP error", async () => {
    const browser = {
      fetch: vi.fn(async () => new Response("Not Found", { status: 404 })),
    } as unknown as Fetcher;
    const storage = createMockStorage();

    await expect(
      extractUrl(browser, storage, "https://example.com/missing")
    ).rejects.toThrow("Failed to fetch");
  });

  it("handles screenshot failure gracefully", async () => {
    const browser = createMockBrowser(sampleHtml, false);
    const storage = createMockStorage();

    const result = await extractUrl(browser, storage, "https://example.com", {
      screenshot: true,
    });

    // Screenshot failed silently; screenshotKey should be undefined
    expect(result.screenshotKey).toBeUndefined();
    // But content extraction should still succeed
    expect(result.title).toBe("Test Article");
  });
});
