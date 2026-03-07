import { routeAgentRequest } from "agents";
import type { Env } from "@/shared/types";
import { handleDiscordInteraction } from "@/discord/index";
import { mcpHandler } from "@/mcp/index";
import { sendProactiveDigest } from "@/discord/proactive";
import { processCrawlMessage } from "@/monitor/crawl-consumer";
import { processConsolidationMessage } from "@/memory/consolidation-consumer";
import type { CrawlMessage, ConsolidationMessage } from "@/monitor/queue-types";
import { processR2EventMessage, isR2EventMessage } from "@/storage/r2-event-handler";
import type { R2EventMessage } from "@/storage/r2-event-handler";
import { checkRateLimit, checkAiRateLimit } from "@/middleware/rate-limit";
import { checkAuth } from "@/middleware/auth";
import {
  parseAllowedOrigins,
  handlePreflight,
  withCorsHeaders,
} from "@/middleware/cors";
import { CortexAnalytics } from "@/observability/analytics";
import { decayRelevanceScores } from "@/memory/semantic";
import { checkAccessAuth } from "@/middleware/access-auth";
import {
  getCachedResponse,
  cacheResponse,
  invalidateApiCache,
  isCacheablePath,
  RESPONSE_CACHE_TTL,
} from "@/cache/response-cache";
import { runMemoryCleanup } from "@/memory/cleanup";
import { processDueResearchTasks } from "@/research/scheduler";
import { SemanticMemory } from "@/memory/semantic";

export { CortexAgent } from "@/agent/cortex-agent";
export { WatchSchedulerDO } from "@/monitor/watch-scheduler";
export { ConsolidationWorkflow } from "@/workflows/consolidation-workflow";

/** Maximum allowed length for watchlist POST body fields. */
const INPUT_LIMITS = {
  watchlistUrl: 2048,
  watchlistLabel: 256,
  searchQuery: 512,
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);
    const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
    const origin = request.headers.get("Origin");

    // Handle CORS preflight for all routes
    if (request.method === "OPTIONS") {
      return handlePreflight(request, allowedOrigins);
    }

    // Per-endpoint rate limiting — auto-detects tier from request path
    const rateLimited = await checkRateLimit(request, env.RATE_LIMITER);
    if (rateLimited) return withCorsHeaders(rateLimited, origin, allowedOrigins);

    // Cloudflare Access auth — after rate limiting, before routing
    const accessDenied = await checkAccessAuth(
      request,
      env.CF_ACCESS_TEAM_DOMAIN,
      env.CF_ACCESS_AUD
    );
    if (accessDenied) return accessDenied;

    const analytics = new CortexAnalytics(env.ANALYTICS);
    let response: Response | undefined;

    try {
      // Discord webhook handler (Phase 2) — exempted from auth (uses its own signature verification)
      if (url.pathname.startsWith("/discord")) {
        response = await handleDiscordInteraction(request, env);
        return response;
      }

      // Authentication — applied to all routes except /discord
      if (env.API_KEY) {
        const authDenied = checkAuth(request, env.API_KEY);
        if (authDenied) return withCorsHeaders(authDenied, origin, allowedOrigins);
      }

      // Input sanitization: search query length limit
      if (url.pathname === "/api/memories/search") {
        const q = url.searchParams.get("q") || "";
        if (q.length > INPUT_LIMITS.searchQuery) {
          response = Response.json(
            { error: `Search query exceeds maximum length of ${INPUT_LIMITS.searchQuery}` },
            { status: 400 }
          );
          return withCorsHeaders(response, origin, allowedOrigins);
        }

        // AI rate limit — search triggers embedding generation
        const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
        const aiLimited = await checkAiRateLimit(env.RATE_LIMITER, clientIp);
        if (aiLimited) return withCorsHeaders(aiLimited, origin, allowedOrigins);
      }

      // Input sanitization: watchlist POST body field length limits
      if (url.pathname === "/api/watchlist" && request.method === "POST") {
        // Clone request so the body can be read again by downstream handlers
        const clonedRequest = request.clone();
        try {
          const body = (await clonedRequest.json()) as Record<string, unknown>;
          if (
            typeof body.url === "string" &&
            body.url.length > INPUT_LIMITS.watchlistUrl
          ) {
            response = Response.json(
              { error: `URL exceeds maximum length of ${INPUT_LIMITS.watchlistUrl}` },
              { status: 400 }
            );
            return withCorsHeaders(response, origin, allowedOrigins);
          }
          if (
            typeof body.label === "string" &&
            body.label.length > INPUT_LIMITS.watchlistLabel
          ) {
            response = Response.json(
              { error: `Label exceeds maximum length of ${INPUT_LIMITS.watchlistLabel}` },
              { status: 400 }
            );
            return withCorsHeaders(response, origin, allowedOrigins);
          }
        } catch {
          response = Response.json(
            { error: "Invalid JSON body" },
            { status: 400 }
          );
          return withCorsHeaders(response, origin, allowedOrigins);
        }
      }

      // WebSocket chat endpoint — proxy to Durable Object for upgrade
      if (url.pathname === "/ws/chat") {
        const doId = env.CortexAgent.idFromName("default");
        const stub = env.CortexAgent.get(doId);
        response = await stub.fetch(request);
        return response; // WebSocket upgrades must not have CORS headers added
      }

      // Export download endpoint (Phase 4)
      // Must be checked before the general /api/ proxy so exports are served directly
      if (url.pathname.startsWith("/api/export/")) {
        const key = url.pathname.replace("/api/export/", "");
        const object = await env.STORAGE.get(key);
        if (!object) {
          response = new Response("Not found", { status: 404 });
          return withCorsHeaders(response, origin, allowedOrigins);
        }
        response = new Response(object.body, {
          headers: {
            "Content-Type":
              object.httpMetadata?.contentType || "application/octet-stream",
          },
        });
        return withCorsHeaders(response, origin, allowedOrigins);
      }

      // API proxy to Durable Object (Phase 3 dashboard)
      if (url.pathname.startsWith("/api/")) {
        const isGet = request.method === "GET";
        const cacheable = isGet && isCacheablePath(url.pathname);

        // Tier 1: Check Cache API for GET requests to cacheable paths
        if (cacheable) {
          const cached = await getCachedResponse(request);
          if (cached) {
            response = cached;
            return withCorsHeaders(response, origin, allowedOrigins);
          }
        }

        // Cache miss or non-cacheable — proxy to DO
        const doId = env.CortexAgent.idFromName("default");
        const stub = env.CortexAgent.get(doId);
        response = await stub.fetch(request);

        // Store successful GET responses in Cache API
        if (cacheable && response.status === 200) {
          await cacheResponse(request, response, RESPONSE_CACHE_TTL);
        }

        // Invalidate cache on mutating requests (POST, DELETE, PATCH, PUT)
        if (!isGet) {
          await invalidateApiCache(request.url);
        }

        return withCorsHeaders(response, origin, allowedOrigins);
      }

      // MCP server endpoint (Phase 4)
      if (url.pathname.startsWith("/mcp")) {
        response = await mcpHandler(request, env);
        return withCorsHeaders(response, origin, allowedOrigins);
      }

      // Route agent WebSocket and API requests
      const agentResponse = await routeAgentRequest(request, env, {
        cors: true,
      });
      if (agentResponse) {
        response = agentResponse;
        return withCorsHeaders(response, origin, allowedOrigins);
      }

      // Static assets are handled by the Cloudflare Vite plugin
      response = new Response("Not found", { status: 404 });
      return withCorsHeaders(response, origin, allowedOrigins);
    } catch (error) {
      const errorType =
        error instanceof Error ? error.constructor.name : "UnknownError";
      analytics.trackError(url.pathname, errorType);
      throw error;
    } finally {
      const durationMs = Date.now() - startTime;
      // Track API request metrics (skip if response was not set, e.g. thrown error)
      if (response) {
        analytics.trackApiRequest(
          url.pathname,
          request.method,
          response.status,
          durationMs
        );
      }
    }
  },

  // Scheduled handler — per-item URL monitoring is now handled by WatchSchedulerDO alarms.
  // The blanket runMonitoringCycle() is removed; retained cron triggers handle
  // maintenance tasks (relevance decay) and proactive digest only.
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // Apply exponential decay to memory relevance scores
    ctx.waitUntil(
      decayRelevanceScores(env.DB).catch((err) => {
        console.error(
          "Relevance decay error:",
          err instanceof Error ? err.message : err
        );
      })
    );

    // Send proactive digest to Discord (non-blocking)
    ctx.waitUntil(
      sendProactiveDigest(env).catch((err) => {
        console.error(
          "Proactive digest error:",
          err instanceof Error ? err.message : err
        );
      })
    );

    // Memory cleanup — dedup, staleness pruning, consolidation merging (non-blocking)
    ctx.waitUntil(
      runMemoryCleanup({
        DB: env.DB,
        AI: env.AI,
        VECTORIZE: env.VECTORIZE,
        STORAGE: env.STORAGE,
        EMBEDDING_MODEL: env.EMBEDDING_MODEL,
        CHAT_MODEL: env.CHAT_MODEL,
      }).catch((err) => {
        console.error(
          "Memory cleanup error:",
          err instanceof Error ? err.message : err
        );
      })
    );

    // Process due scheduled research tasks (non-blocking)
    ctx.waitUntil(
      processDueResearchTasks({
        db: env.DB,
        semanticMemory: new SemanticMemory(
          env.DB,
          env.AI,
          env.EMBEDDING_MODEL,
          env.VECTORIZE
        ),
        ai: env.AI,
        chatModel: env.CHAT_MODEL,
      }).catch((err) => {
        console.error(
          "Research task processing error:",
          err instanceof Error ? err.message : err
        );
      })
    );
  },

  // Queue handler — processes crawl, consolidation, and R2 event messages
  async queue(
    batch: MessageBatch<CrawlMessage | ConsolidationMessage | R2EventMessage>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    for (const msg of batch.messages) {
      try {
        // R2 event notifications have a different shape (no `type` field)
        if (isR2EventMessage(msg.body)) {
          await processR2EventMessage(msg.body, env);
        } else if (msg.body.type === "crawl") {
          await processCrawlMessage(msg.body as CrawlMessage, env);
        } else if (msg.body.type === "consolidate") {
          await processConsolidationMessage(msg.body as ConsolidationMessage, env);
        }
        msg.ack();
      } catch (err) {
        const errorContext = isR2EventMessage(msg.body)
          ? `r2-event:${msg.body.action}`
          : (msg.body as CrawlMessage | ConsolidationMessage).type;
        console.error(
          `Queue processing error for ${errorContext}:`,
          err instanceof Error ? err.message : err
        );
        msg.retry();
      }
    }
  },
};
