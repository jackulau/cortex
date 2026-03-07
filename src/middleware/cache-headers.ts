/**
 * Cache header utilities for static assets and API responses.
 *
 * Static assets served via Workers Static Assets use the `public/_headers`
 * file for cache rules. This module provides Worker-level cache header
 * injection as defense-in-depth for assets that pass through the Worker
 * fetch handler, and utilities for API response caching.
 */

/** One year in seconds — used for immutable hashed assets. */
const ONE_YEAR = 31_536_000;

/** Regex matching Vite hashed filenames: `name-abc12def.ext` or `name.abc12def.ext`. */
const HASHED_ASSET_RE = /[-\.][a-f0-9]{8,}\./;

/**
 * Returns appropriate Cache-Control header value for a given URL pathname.
 *
 * - Hashed assets (`/assets/index-abc123.js`) → immutable, 1 year
 * - HTML or root paths → must-revalidate, no caching
 * - Other paths → null (no cache header to set)
 */
export function getCacheControl(pathname: string): string | null {
  // Hashed Vite assets under /assets/ — cache forever
  if (pathname.startsWith("/assets/") && HASHED_ASSET_RE.test(pathname)) {
    return `public, max-age=${ONE_YEAR}, immutable`;
  }

  // HTML entry point or root — always revalidate
  if (pathname === "/" || pathname.endsWith(".html")) {
    return "public, max-age=0, must-revalidate";
  }

  return null;
}

/**
 * Applies cache headers to a Response based on the request pathname.
 * Returns a new Response with the Cache-Control header set, or the
 * original response if no caching policy applies.
 */
export function applyCacheHeaders(
  response: Response,
  pathname: string
): Response {
  const cacheControl = getCacheControl(pathname);
  if (!cacheControl) {
    return response;
  }

  // Clone the response to add headers (Response headers may be immutable)
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
