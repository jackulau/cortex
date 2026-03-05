import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, stepCountIs, type UIMessage } from "ai";
import type { Env } from "@/shared/types";
import { initDoSchemas } from "@/memory/schemas";
import { WorkingMemory } from "@/memory/working";
import { EpisodicMemory } from "@/memory/episodic";
import { SemanticMemory } from "@/memory/semantic";
import { ProceduralMemory } from "@/memory/procedural";
import type { ConsolidationMessage } from "@/monitor/queue-types";
import { buildSystemPrompt } from "@/agent/prompts/system";
import { retrieveMemoryContext } from "@/agent/prompts/memory-context";
import { createMemoryTools } from "@/agent/tools/memory-tools";
import { createResearchTools } from "@/agent/tools/research-tools";
import { createWatchTools } from "@/agent/tools/watch-tools";
import { createExportTools } from "@/agent/tools/export-tools";
import { WatchListManager } from "@/monitor/watchlist";
import { DigestManager } from "@/monitor/digest";

export class CortexAgent extends AIChatAgent<Env> {
  private workingMemory!: WorkingMemory;
  private episodicMemory!: EpisodicMemory;
  private semanticMemory!: SemanticMemory;
  private proceduralMemory!: ProceduralMemory;
  private watchListManager!: WatchListManager;
  private digestManager!: DigestManager;
  private initialized = false;

  private ensureInit() {
    if (this.initialized) return;

    // Init DO SQLite tables
    initDoSchemas(this.sql.bind(this));

    // Instantiate memory layers
    const sessionId = this.name || crypto.randomUUID();
    this.workingMemory = new WorkingMemory(sessionId);
    this.episodicMemory = new EpisodicMemory(this.sql.bind(this));
    this.semanticMemory = new SemanticMemory(
      this.env.DB,
      this.env.AI,
      this.env.EMBEDDING_MODEL
    );
    this.proceduralMemory = new ProceduralMemory(this.sql.bind(this));

    // Initialize Phase 3 managers
    this.watchListManager = new WatchListManager(this.env.DB);
    this.digestManager = new DigestManager(this.env.DB);

    this.initialized = true;
  }

  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0]
  ): Promise<Response> {
    this.ensureInit();

    // Get the latest user message text from parts
    const lastUserMsg = [...this.messages]
      .reverse()
      .find((m) => m.role === "user");
    const userText = lastUserMsg?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ") ?? "";

    // Pre-response: retrieve relevant memories
    let memoryContext = await retrieveMemoryContext(
      this.semanticMemory,
      this.episodicMemory,
      userText
    );

    // Proactive surfacing: inject relevant digest entries (Phase 3)
    try {
      const undelivered = await this.digestManager.getUndelivered();
      if (undelivered.length > 0) {
        const relevant = undelivered.filter((entry) =>
          this.workingMemory
            .getState()
            .topics.some((topic) =>
              entry.summary.toLowerCase().includes(topic.toLowerCase())
            )
        );
        if (relevant.length > 0) {
          memoryContext +=
            "\n\n### New Updates\n" +
            relevant.map((e) => `- ${e.summary}`).join("\n");
        }
      }
    } catch {
      // Non-critical — continue without proactive surfacing
    }

    // Build system prompt with injected memories + rules
    const systemPrompt = buildSystemPrompt(
      this.workingMemory,
      this.proceduralMemory,
      memoryContext
    );

    // Create all tools (Phase 1 + Phase 2-4)
    const tools = {
      ...createMemoryTools({
        semanticMemory: this.semanticMemory,
        episodicMemory: this.episodicMemory,
        proceduralMemory: this.proceduralMemory,
        workingMemory: this.workingMemory,
      }),
      ...createResearchTools({
        browser: this.env.BROWSER,
        storage: this.env.STORAGE,
        semanticMemory: this.semanticMemory,
        ai: this.env.AI,
        chatModel: this.env.CHAT_MODEL,
        embeddingModel: this.env.EMBEDDING_MODEL,
      }),
      ...createWatchTools({
        watchList: this.watchListManager,
        digestManager: this.digestManager,
      }),
      ...createExportTools({
        semanticMemory: this.semanticMemory,
        episodicMemory: this.episodicMemory,
        proceduralMemory: this.proceduralMemory,
        storage: this.env.STORAGE,
      }),
    };

    // Stream response
    const ai = createWorkersAI({ binding: this.env.AI });
    const turnIndex = this.episodicMemory.getTurnCount(
      this.workingMemory.getState().sessionId
    );

    const result = streamText({
      model: ai(this.env.CHAT_MODEL) as any,
      system: systemPrompt,
      messages: this.messages as any,
      tools,
      stopWhen: stepCountIs(5),
      onFinish: async (streamResult) => {
        const sessionId = this.workingMemory.getState().sessionId;

        // Log episodic turns
        this.episodicMemory.logTurn(
          sessionId,
          "user",
          userText,
          turnIndex
        );
        this.episodicMemory.logTurn(
          sessionId,
          "assistant",
          streamResult.text,
          turnIndex + 1
        );

        // Update session metadata
        this.episodicMemory.upsertSession(sessionId, {
          turnCount: turnIndex + 2,
        });

        // Post-turn consolidation via queue (reliable retries)
        await this.env.CONSOLIDATION_QUEUE.send({
          type: "consolidate",
          userMessage: userText,
          assistantMessage: streamResult.text,
          sessionId,
        } satisfies ConsolidationMessage);

        // Call the provided onFinish callback
        onFinish(streamResult as any);
      },
    });

    return result.toUIMessageStreamResponse();
  }

  /**
   * Handle API requests from the dashboard.
   * Called when server.ts proxies /api/* requests to this DO.
   */
  async fetch(request: Request): Promise<Response> {
    // Try the parent class handler first (for WebSocket upgrades and agent protocol)
    // If the URL starts with /api/, handle it ourselves
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return this.handleApiRequest(request);
    }

    // Delegate to the base class for agent protocol (WebSocket, etc.)
    return super.fetch(request);
  }

  private async handleApiRequest(request: Request): Promise<Response> {
    this.ensureInit();

    const url = new URL(request.url);
    const method = request.method;

    try {
      // /api/memories — list or delete memories
      if (url.pathname === "/api/memories") {
        if (method === "GET") {
          return this.apiListMemories(url);
        }
        if (method === "DELETE") {
          return this.apiDeleteMemory(url);
        }
      }

      // /api/memories/search — search semantic memory
      if (url.pathname === "/api/memories/search") {
        return this.apiSearchMemories(url);
      }

      // /api/sessions — list sessions or get session turns
      if (url.pathname === "/api/sessions") {
        return this.apiSessions(url);
      }

      // /api/rules — list procedural rules
      if (url.pathname === "/api/rules") {
        return this.apiListRules();
      }

      // /api/watchlist — CRUD for watch items
      if (url.pathname === "/api/watchlist") {
        return this.apiWatchList(request, url);
      }

      // /api/digest — get digest entries
      if (url.pathname === "/api/digest") {
        return this.apiGetDigest();
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (err) {
      return Response.json(
        {
          error: err instanceof Error ? err.message : "Internal error",
        },
        { status: 500 }
      );
    }
  }

  private async apiListMemories(url: URL): Promise<Response> {
    const type = url.searchParams.get("type") as
      | "fact"
      | "preference"
      | "event"
      | "note"
      | "summary"
      | null;
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);

    const memories = await this.semanticMemory.list({
      type: type || undefined,
      limit,
    });

    return Response.json({ memories, count: memories.length });
  }

  private async apiDeleteMemory(url: URL): Promise<Response> {
    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ error: "Missing id parameter" }, { status: 400 });
    }
    const deleted = await this.semanticMemory.delete(id);
    return Response.json({ success: deleted });
  }

  private async apiSearchMemories(url: URL): Promise<Response> {
    const query = url.searchParams.get("q") || "";
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);

    if (!query) {
      return Response.json(
        { error: "Missing q parameter" },
        { status: 400 }
      );
    }

    const results = await this.semanticMemory.search(query, limit);
    return Response.json({
      results: results.map((r) => ({
        ...r.entry,
        score: r.score,
        matchType: r.matchType,
      })),
      count: results.length,
    });
  }

  private apiSessions(url: URL): Response {
    const sessionId = url.searchParams.get("id");

    if (sessionId) {
      // Get turns for a specific session
      const turns = this.episodicMemory.getSession(sessionId);
      return Response.json({
        sessionId,
        turns: turns.map((t) => ({
          role: t.role,
          content: t.content,
          timestamp: t.timestamp,
          turnIndex: t.turnIndex,
        })),
      });
    }

    // List all sessions
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const sessions = this.episodicMemory.listSessions(limit);
    return Response.json({
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        topics:
          typeof s.topics === "string" ? JSON.parse(s.topics) : s.topics || [],
        turnCount: s.turnCount,
        summary: s.summary,
      })),
      count: sessions.length,
    });
  }

  private apiListRules(): Response {
    const rules = this.proceduralMemory.getAll();
    return Response.json({ rules, count: rules.length });
  }

  private async apiWatchList(request: Request, url: URL): Promise<Response> {
    const method = request.method;

    if (method === "GET") {
      const items = await this.watchListManager.list(false);
      return Response.json({ items, count: items.length });
    }

    if (method === "POST") {
      const body = await request.json() as {
        url: string;
        label: string;
        frequency: "hourly" | "daily" | "weekly";
      };
      const id = await this.watchListManager.add({
        url: body.url,
        label: body.label,
        frequency: body.frequency || "daily",
      });
      return Response.json({ success: true, id });
    }

    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) {
        return Response.json(
          { error: "Missing id parameter" },
          { status: 400 }
        );
      }
      const success = await this.watchListManager.remove(id);
      return Response.json({ success });
    }

    if (method === "PATCH") {
      const body = await request.json() as { id: string; active: boolean };
      await this.watchListManager.setActive(body.id, body.active);
      return Response.json({ success: true });
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  private async apiGetDigest(): Promise<Response> {
    const entries = await this.digestManager.getUndelivered();
    return Response.json({
      entries: entries.map((e) => ({
        id: e.id,
        watchItemId: e.watchItemId,
        summary: e.summary,
        createdAt: e.createdAt,
      })),
      count: entries.length,
    });
  }
}
