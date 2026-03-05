/**
 * Browser content extraction using Cloudflare Browser Rendering.
 *
 * Uses the BROWSER binding (Fetcher type) to render pages and extract content.
 * This powers both the research tools (Phase 2) and the scheduled crawler (Phase 3).
 */

export interface ExtractedContent {
  url: string;
  title: string;
  description: string;
  content: string;
  publishedDate?: string;
  screenshotKey?: string;
  rawKey?: string;
  extractedAt: string;
}

/**
 * Extract content from a URL using Cloudflare Browser Rendering.
 *
 * @param browser - BROWSER binding (Fetcher type from Browser Rendering)
 * @param storage - R2 bucket for screenshots and archives
 * @param url - The URL to extract content from
 * @param options - Optional screenshot and archive flags
 */
export async function extractUrl(
  browser: Fetcher,
  storage: R2Bucket,
  url: string,
  options?: { screenshot?: boolean; archive?: boolean }
): Promise<ExtractedContent> {
  // Use Browser Rendering API to fetch the rendered page
  const response = await browser.fetch(url, {
    headers: {
      // Request the fully rendered HTML via Browser Rendering
      Accept: "text/html",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }

  const html = await response.text();

  // Extract metadata and content from the HTML
  const title = extractTitle(html);
  const description = extractMetaDescription(html);
  const publishedDate = extractPublishedDate(html);
  const content = extractMainContent(html);
  const extractedAt = new Date().toISOString();

  // Generate a hash for R2 storage keys
  const urlHash = await hashString(url);

  let screenshotKey: string | undefined;
  let rawKey: string | undefined;

  // Optional: take screenshot via Browser Rendering
  if (options?.screenshot) {
    try {
      const screenshotResponse = await browser.fetch(url, {
        headers: {
          Accept: "image/png",
        },
      });
      if (screenshotResponse.ok) {
        const screenshotBuffer = await screenshotResponse.arrayBuffer();
        screenshotKey = `screenshots/${urlHash}.png`;
        await storage.put(screenshotKey, screenshotBuffer, {
          httpMetadata: { contentType: "image/png" },
        });
      }
    } catch {
      // Screenshot failures are non-critical
      console.error(`Screenshot failed for ${url}`);
    }
  }

  // Optional: archive raw extracted content as JSON to R2
  if (options?.archive) {
    try {
      rawKey = `archives/${urlHash}.json`;
      const archiveData = JSON.stringify(
        { url, title, description, content, publishedDate, extractedAt },
        null,
        2
      );
      await storage.put(rawKey, archiveData, {
        httpMetadata: { contentType: "application/json" },
      });
    } catch {
      // Archive failures are non-critical
      console.error(`Archive failed for ${url}`);
      rawKey = undefined;
    }
  }

  return {
    url,
    title,
    description,
    content,
    publishedDate: publishedDate || undefined,
    screenshotKey,
    rawKey,
    extractedAt,
  };
}

// ── HTML Parsing Helpers ────────────────────────────────────────

/**
 * Extract the page title from HTML.
 */
export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].trim()) : "";
}

/**
 * Extract meta description from HTML.
 */
export function extractMetaDescription(html: string): string {
  // Try name="description" first, then property="og:description"
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*\/?>/i,
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']description["'][^>]*\/?>/i,
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*\/?>/i,
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']og:description["'][^>]*\/?>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1].trim());
  }

  return "";
}

/**
 * Extract published date from meta tags.
 */
export function extractPublishedDate(html: string): string {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([\s\S]*?)["'][^>]*\/?>/i,
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+property=["']article:published_time["'][^>]*\/?>/i,
    /<meta[^>]+name=["']date["'][^>]+content=["']([\s\S]*?)["'][^>]*\/?>/i,
    /<meta[^>]+content=["']([\s\S]*?)["'][^>]+name=["']date["'][^>]*\/?>/i,
    /<time[^>]+datetime=["']([\s\S]*?)["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1].trim();
  }

  return "";
}

/**
 * Extract the main text content from HTML.
 * Priority: <article> > <main> > <body>
 * Strips scripts, styles, nav, footer, header elements.
 */
export function extractMainContent(html: string): string {
  // Try content elements in priority order
  let contentHtml = extractElement(html, "article");
  if (!contentHtml) contentHtml = extractElement(html, "main");
  if (!contentHtml) contentHtml = extractElement(html, "body");
  if (!contentHtml) contentHtml = html;

  // Strip unwanted elements
  contentHtml = stripElements(contentHtml, [
    "script",
    "style",
    "nav",
    "footer",
    "header",
    "noscript",
    "iframe",
    "svg",
  ]);

  // Strip all HTML tags and get text content
  const text = stripTags(contentHtml);

  // Collapse whitespace
  return collapseWhitespace(text);
}

// ── Low-Level Parsing Helpers ───────────────────────────────────

/**
 * Extract the inner content of the first matching element.
 */
function extractElement(html: string, tag: string): string | null {
  const regex = new RegExp(
    `<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );
  const match = html.match(regex);
  return match ? match[1] : null;
}

/**
 * Strip all instances of specified elements and their content.
 */
export function stripElements(html: string, tags: string[]): string {
  let result = html;
  for (const tag of tags) {
    const regex = new RegExp(
      `<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`,
      "gi"
    );
    result = result.replace(regex, "");
  }
  return result;
}

/**
 * Strip all HTML tags, keeping only text content.
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

/**
 * Collapse multiple whitespace characters into single spaces and trim.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Decode basic HTML entities.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

/**
 * Generate a SHA-256 hash of a string (hex encoded).
 */
async function hashString(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
