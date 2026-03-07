/**
 * CORS middleware — validates Origin against allowed origins and returns
 * appropriate CORS headers. Handles preflight OPTIONS requests.
 */

/**
 * Build CORS headers for a given origin and list of allowed origins.
 * Returns an empty object if the origin is not allowed.
 */
export function corsHeaders(
  origin: string | null,
  allowedOrigins: string[]
): Record<string, string> {
  if (!origin) return {};

  // Check if the origin is in the allowed list
  const isAllowed = allowedOrigins.some(
    (allowed) => allowed === "*" || allowed === origin
  );

  if (!isAllowed) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

/**
 * Parse the ALLOWED_ORIGINS environment variable (comma-separated) into an array.
 * Returns an empty array if the value is empty or undefined, enforcing same-origin only.
 */
export function parseAllowedOrigins(allowedOrigins?: string): string[] {
  if (!allowedOrigins || allowedOrigins.trim() === "") return [];
  return allowedOrigins
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Handle an OPTIONS preflight request. Returns a 204 response with CORS headers
 * if the origin is allowed, or a 403 if not.
 */
export function handlePreflight(
  request: Request,
  allowedOrigins: string[]
): Response {
  const origin = request.headers.get("Origin");
  const headers = corsHeaders(origin, allowedOrigins);

  // If no CORS headers were returned, the origin is not allowed
  if (!("Access-Control-Allow-Origin" in headers)) {
    return new Response("Forbidden", { status: 403 });
  }

  return new Response(null, { status: 204, headers });
}

/**
 * Apply CORS headers to an existing response.
 * Clones the response to allow header modification.
 */
export function withCorsHeaders(
  response: Response,
  origin: string | null,
  allowedOrigins: string[]
): Response {
  const headers = corsHeaders(origin, allowedOrigins);

  // No CORS headers needed — return original response
  if (!("Access-Control-Allow-Origin" in headers)) {
    return response;
  }

  // Clone response and add CORS headers
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) {
    newResponse.headers.set(key, value as string);
  }
  return newResponse;
}
