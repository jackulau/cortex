import { routeAgentRequest } from "agents";
import type { Env } from "@/shared/types";
import { handleDiscordInteraction } from "@/discord/index";
import { mcpHandler } from "@/mcp/index";
import { runMonitoringCycle } from "@/monitor/crawler";
import { checkRateLimit } from "@/middleware/rate-limit";
import { CortexAnalytics } from "@/observability/analytics";

export { CortexAgent } from "@/agent/cortex-agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startTime = Date.now();
    const url = new URL(request.url);

    // Rate limiting — applied to all routes before routing
    const rateLimited = await checkRateLimit(request, env.RATE_LIMITER, 100);
    if (rateLimited) return rateLimited;

    const analytics = new CortexAnalytics(env.ANALYTICS);
    let response: Response | undefined;

    try {
      // Discord webhook handler (Phase 2)
      if (url.pathname.startsWith("/discord")) {
        response = await handleDiscordInteraction(request, env);
        return response;
      }

      // Export download endpoint (Phase 4)
      // Must be checked before the general /api/ proxy so exports are served directly
      if (url.pathname.startsWith("/api/export/")) {
        const key = url.pathname.replace("/api/export/", "");
        const object = await env.STORAGE.get(key);
        if (!object) {
          response = new Response("Not found", { status: 404 });
          return response;
        }
        response = new Response(object.body, {
          headers: {
            "Content-Type":
              object.httpMetadata?.contentType || "application/octet-stream",
          },
        });
        return response;
      }

      // API proxy to Durable Object (Phase 3 dashboard)
      if (url.pathname.startsWith("/api/")) {
        const doId = env.CortexAgent.idFromName("default");
        const stub = env.CortexAgent.get(doId);
        response = await stub.fetch(request);
        return response;
      }

      // MCP server endpoint (Phase 4)
      if (url.pathname.startsWith("/mcp")) {
        response = await mcpHandler(request, env);
        return response;
      }

      // Route agent WebSocket and API requests
      const agentResponse = await routeAgentRequest(request, env, {
        cors: true,
      });
      if (agentResponse) {
        response = agentResponse;
        return response;
      }

      // Static assets are handled by the Cloudflare Vite plugin
      response = new Response("Not found", { status: 404 });
      return response;
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

  // Scheduled handler (Phase 3 — cron trigger for URL monitoring)
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runMonitoringCycle(env));
  },
};
