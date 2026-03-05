import { routeAgentRequest } from "agents";
import type { Env } from "@/shared/types";
import { handleDiscordInteraction } from "@/discord/index";
import { mcpHandler } from "@/mcp/index";
import { runMonitoringCycle } from "@/monitor/crawler";
import { processCrawlMessage } from "@/monitor/crawl-consumer";
import { processConsolidationMessage } from "@/memory/consolidation-consumer";
import type { CrawlMessage, ConsolidationMessage } from "@/monitor/queue-types";

export { CortexAgent } from "@/agent/cortex-agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Discord webhook handler (Phase 2)
    if (url.pathname.startsWith("/discord")) {
      return handleDiscordInteraction(request, env);
    }

    // Export download endpoint (Phase 4)
    // Must be checked before the general /api/ proxy so exports are served directly
    if (url.pathname.startsWith("/api/export/")) {
      const key = url.pathname.replace("/api/export/", "");
      const object = await env.STORAGE.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type":
            object.httpMetadata?.contentType || "application/octet-stream",
        },
      });
    }

    // API proxy to Durable Object (Phase 3 dashboard)
    if (url.pathname.startsWith("/api/")) {
      const doId = env.CortexAgent.idFromName("default");
      const stub = env.CortexAgent.get(doId);
      return stub.fetch(request);
    }

    // MCP server endpoint (Phase 4)
    if (url.pathname.startsWith("/mcp")) {
      return mcpHandler(request, env);
    }

    // Route agent WebSocket and API requests
    const agentResponse = await routeAgentRequest(request, env, {
      cors: true,
    });
    if (agentResponse) return agentResponse;

    // Static assets are handled by the Cloudflare Vite plugin
    return new Response("Not found", { status: 404 });
  },

  // Scheduled handler (Phase 3 — cron trigger for URL monitoring)
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runMonitoringCycle(env));
  },

  // Queue handler — processes crawl and consolidation messages
  async queue(
    batch: MessageBatch<CrawlMessage | ConsolidationMessage>,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (msg.body.type === "crawl") {
          await processCrawlMessage(msg.body, env);
        } else if (msg.body.type === "consolidate") {
          await processConsolidationMessage(msg.body, env);
        }
        msg.ack();
      } catch (err) {
        console.error(
          `Queue processing error for ${msg.body.type}:`,
          err instanceof Error ? err.message : err
        );
        msg.retry();
      }
    }
  },
};
