import { routeAgentRequest } from "agents";
import type { Env } from "@/shared/types";

export { CortexAgent } from "@/agent/cortex-agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Stub: future Discord webhook handler
    if (url.pathname.startsWith("/discord")) {
      return new Response("Discord endpoint (Phase 2)", { status: 501 });
    }

    // Stub: future MCP handler
    if (url.pathname.startsWith("/mcp")) {
      return new Response("MCP endpoint (Phase 4)", { status: 501 });
    }

    // Route agent WebSocket and API requests
    const agentResponse = await routeAgentRequest(request, env, {
      cors: true,
    });
    if (agentResponse) return agentResponse;

    // Static assets are handled by the Cloudflare Vite plugin
    return new Response("Not found", { status: 404 });
  },
};
