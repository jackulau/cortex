import { AIChatAgent } from "@cloudflare/ai-chat";
import { streamText, stepCountIs, type UIMessage } from "ai";
import type { Env, Namespace } from "@/shared/types";
import { DEFAULT_NAMESPACE_ID } from "@/shared/types";
import { getChatModel } from "@/ai/providers";
import { initDoSchemas } from "@/memory/schemas";
import { WorkingMemory } from "@/memory/working";
import { EpisodicMemory } from "@/memory/episodic";
import { SemanticMemory } from "@/memory/semantic";
import { ProceduralMemory } from "@/memory/procedural";

import { buildSystemPrompt } from "@/agent/prompts/system";
import { retrieveMemoryContext } from "@/agent/prompts/memory-context";
import { createMemoryTools } from "@/agent/tools/memory-tools";
import { createResearchTools } from "@/agent/tools/research-tools";
import { createWatchTools } from "@/agent/tools/watch-tools";
import { createExportTools } from "@/agent/tools/export-tools";
import { createThinkingTool } from "@/agent/tools/thinking-tool";
import { WatchListManager } from "@/monitor/watchlist";
import { DigestManager } from "@/monitor/digest";
import { scheduleWatchAlarm, cancelWatchAlarm } from "@/monitor/watch-scheduler";
import { CortexAnalytics } from "@/observability/analytics";
import {
  KVCache,
  CacheKeys,
  CacheTTL,
  CachePrefixes,
} from "@/cache/kv-cache";
import { MAX_AGENT_LOOPS } from "@/agent/constants";
import { buildKnowledgeGraphData } from "@/agent/graph-builder";

export { MAX_AGENT_LOOPS };

export class CortexAgent extends AIChatAgent<Env> {
  /**
   * Enable Hibernatable WebSockets for idle cost savings.
   *
   * When hibernate is true, the Durable Object can be evicted from memory
   * during idle periods while keeping WebSocket connections alive. On wake
   * (incoming WebSocket message, alarm, or fetch), the DO is re-instantiated
   * and ensureInit() re-hydrates all instance state.
   *
   * Hibernation-safe by design:
   * - DO SQLite (this.sql) survives hibernation automatically
   * - EpisodicMemory and ProceduralMemory use DO SQLite, so their data persists
   * - SemanticMemory uses D1 + Vectorize (external), unaffected by hibernation
   * - WorkingMemory is ephemeral per-session state, recreated fresh on wake
   * - The `initialized` flag resets to false on eviction, triggering re-init
   * - Chat messages are persisted to SQLite by AIChatAgent base class
   */
  static options = { hibernate: true };

  private workingMemory!: WorkingMemory;
  private episodicMemory!: EpisodicMemory;
  private semanticMemory!: SemanticMemory;
  private proceduralMemory!: ProceduralMemory;
  private watchListManager!: WatchListManager;
  private digestManager!: DigestManager;
  private cache!: KVCache;
  private initialized = false;
  private activeNamespaceId: string = DEFAULT_NAMESPACE_ID;

  /**
   * Lazy initialization — called on every code path that accesses instance state.
   *
   * After hibernation, the DO is a fresh instance with `initialized = false` and
   * all private fields unset. This method re-creates them from durable storage
   * (DO SQLite, D1) and external bindings. Safe to call multiple times.
   *
   * @param namespaceId — Namespace to scope memory and monitor operations to.
   *        Extracted from the X-Namespace-Id header or URL by the caller.
   */
  private ensureInit(namespaceId: string = DEFAULT_NAMESPACE_ID) {
    // Re-initialize if namespace changed
    if (this.initialized && this.activeNamespaceId === namespaceId) return;

    // Init DO SQLite tables (idempotent CREATE IF NOT EXISTS)
    if (!this.initialized) {
      initDoSchemas(this.sql.bind(this));
    }

    this.activeNamespaceId = namespaceId;

    // Instantiate memory layers — rebuilt from durable storage on wake
    const sessionId = this.name || crypto.randomUUID();
    this.workingMemory = new WorkingMemory(sessionId);
    this.episodicMemory = new EpisodicMemory(this.sql.bind(this));
    this.semanticMemory = new SemanticMemory(
      this.env.DB,
      this.env.AI,
      this.env.EMBEDDING_MODEL,
      this.env.VECTORIZE,
      namespaceId
    );
    this.proceduralMemory = new ProceduralMemory(this.sql.bind(this));

    // Initialize Phase 3 managers (backed by D1, survives hibernation, scoped to namespace)
    this.watchListManager = new WatchListManager(this.env.DB, namespaceId);
    this.digestManager = new DigestManager(this.env.DB, namespaceId);

    // Initialize KV cache layer (external binding, unaffected by hibernation)
    this.cache = new KVCache(this.env.CACHE);

    this.initialized = true;
  }

  /**
   * Extract the namespace ID from request headers or URL path.
   * Priority: X-Namespace-Id header > ?namespace= query param > default.
   */
  private getNamespaceFromRequest(request: Request): string {
    const header = request.headers.get("X-Namespace-Id");
    if (header) return header;

    const url = new URL(request.url);
    const param = url.searchParams.get("namespace");
    if (param) return param;

    return DEFAULT_NAMESPACE_ID;
  }

  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0]
  ): Promise<Response> {
    // Default namespace for the standard agent protocol chat path
    this.ensureInit(this.activeNamespaceId);

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

    // Create all tools (Phase 1 + Phase 2-4 + thinking)
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
        env: this.env,
        db: this.env.DB,
      }),
      ...createWatchTools({
        watchList: this.watchListManager,
        digestManager: this.digestManager,
        ai: this.env.AI,
        chatModel: this.env.CHAT_MODEL,
      }),
      ...createExportTools({
        semanticMemory: this.semanticMemory,
        episodicMemory: this.episodicMemory,
        proceduralMemory: this.proceduralMemory,
        storage: this.env.STORAGE,
      }),
      ...createThinkingTool(),
    };

    // Stream response with agentic loop support
    // The AI SDK's streamText with stopWhen: stepCountIs(MAX_AGENT_LOOPS)
    // automatically implements the tool call -> observe -> decide -> tool call loop.
    // Uses Claude API when ANTHROPIC_API_KEY is set, otherwise Workers AI fallback.
    const chatModel = await getChatModel(this.env);
    const turnIndex = this.episodicMemory.getTurnCount(
      this.workingMemory.getState().sessionId
    );
    const loopStartTime = Date.now();

    const result = streamText({
      model: chatModel as any,
      system: systemPrompt,
      messages: this.messages as any,
      tools,
      stopWhen: stepCountIs(MAX_AGENT_LOOPS),
      onFinish: async (streamResult) => {
        const sessionId = this.workingMemory.getState().sessionId;
        const loopDurationMs = Date.now() - loopStartTime;

        // Count agent loop steps and total tool calls from the result
        const steps = streamResult.steps || [];
        const stepCount = steps.length;
        const toolCallCount = steps.reduce(
          (sum, step) => sum + (step.toolCalls?.length || 0),
          0
        );

        // Log loop telemetry via Analytics Engine
        try {
          const analytics = new CortexAnalytics(this.env.ANALYTICS);
          analytics.trackAgentLoop(
            sessionId,
            stepCount,
            toolCallCount,
            loopDurationMs
          );
        } catch {
          // Non-critical — continue without analytics
        }

        // Log each loop iteration for debugging
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const toolNames = step.toolCalls?.map((tc) => tc.toolName) || [];
          if (toolNames.length > 0) {
            console.log(
              `[agent-loop] step=${i + 1}/${stepCount} tools=[${toolNames.join(",")}] session=${sessionId}`
            );
          }
        }

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

        // Invalidate caches after new turns are logged
        await Promise.all([
          this.cache.invalidatePrefix(CachePrefixes.MEMORIES),
          this.cache.invalidatePrefix(CachePrefixes.SESSIONS),
        ]);

        // Post-turn consolidation via durable Workflow (per-step retries)
        await this.env.CONSOLIDATION_WORKFLOW.create({
          params: {
            userMessage: userText,
            assistantMessage: streamResult.text,
            sessionId,
          },
        });

        // Call the provided onFinish callback
        onFinish(streamResult as any);
      },
    });

    return result.toUIMessageStreamResponse();
  }

  /**
   * Handle API requests from the dashboard.
   * Called when server.ts proxies /api/* and /ws/* requests to this DO.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const namespaceId = this.getNamespaceFromRequest(request);

    // WebSocket chat endpoint — dashboard streaming chat
    if (url.pathname === "/ws/chat") {
      this.ensureInit(namespaceId);
      return this.handleWsChatUpgrade(request);
    }

    // API endpoints for dashboard
    if (url.pathname.startsWith("/api/")) {
      return this.handleApiRequest(request, namespaceId);
    }

    // Delegate to the base class for agent protocol (WebSocket, etc.)
    this.ensureInit(namespaceId);
    return super.fetch(request);
  }

  // ── WebSocket Chat ──────────────────────────────────────────────

  /**
   * Accept a WebSocket upgrade for the /ws/chat endpoint.
   * Uses the Cloudflare Durable Object WebSocket Hibernation API.
   */
  private handleWsChatUpgrade(request: Request): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Tag the WebSocket so we can identify it as a chat socket on message
    this.ctx.acceptWebSocket(server, ["ws-chat"]);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Hibernatable WebSocket message handler.
   * Called by the runtime when a WebSocket frame arrives (even after hibernation wake).
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Check if this is a ws-chat tagged socket
    const tags = this.ctx.getTags(ws);
    if (!tags.includes("ws-chat")) {
      // Not a chat socket — delegate to parent for the standard agent protocol
      return super.webSocketMessage(ws, message);
    }

    // Chat sockets only handle string messages
    if (typeof message !== "string") return;

    let parsed: { type: string; content?: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      this.wsSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    if (parsed.type !== "chat" || !parsed.content?.trim()) {
      this.wsSend(ws, { type: "error", message: "Expected { type: \"chat\", content: \"...\" }" });
      return;
    }

    await this.handleWsChatMessage(ws, parsed.content.trim());
  }

  /**
   * Hibernatable WebSocket close handler.
   */
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const tags = this.ctx.getTags(ws);
    if (tags.includes("ws-chat")) {
      // Clean up — nothing special needed for chat sockets
      try {
        ws.close(code, reason);
      } catch {
        // Socket may already be closed
      }
      return;
    }
    return super.webSocketClose(ws, code, reason, wasClean);
  }

  /**
   * Process a chat message received via WebSocket.
   * Runs the agentic loop and streams intermediate results back as frames.
   */
  private async handleWsChatMessage(ws: WebSocket, userText: string): Promise<void> {
    // ensureInit already called during WebSocket upgrade with the correct namespace

    try {
      // Retrieve memory context for the user message
      let memoryContext = await retrieveMemoryContext(
        this.semanticMemory,
        this.episodicMemory,
        userText
      );

      // Proactive surfacing: inject relevant digest entries
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
        // Non-critical
      }

      const systemPrompt = buildSystemPrompt(
        this.workingMemory,
        this.proceduralMemory,
        memoryContext
      );

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
          env: this.env,
          db: this.env.DB,
        }),
        ...createWatchTools({
          watchList: this.watchListManager,
          digestManager: this.digestManager,
          ai: this.env.AI,
          chatModel: this.env.CHAT_MODEL,
        }),
        ...createExportTools({
          semanticMemory: this.semanticMemory,
          episodicMemory: this.episodicMemory,
          proceduralMemory: this.proceduralMemory,
          storage: this.env.STORAGE,
        }),
        ...createThinkingTool(),
      };

      const chatModel = await getChatModel(this.env);
      const sessionId = this.workingMemory.getState().sessionId;
      const turnIndex = this.episodicMemory.getTurnCount(sessionId);
      const loopStartTime = Date.now();

      // Build a simple message array for the agentic loop
      // Include any prior WS chat context from episodic memory
      const priorTurns = this.episodicMemory.getSession(sessionId);
      const messagesForLlm: Array<{ role: "user" | "assistant"; content: string }> = [
        ...priorTurns.map((t) => ({ role: t.role as "user" | "assistant", content: t.content })),
        { role: "user" as const, content: userText },
      ];

      const result = streamText({
        model: chatModel as any,
        system: systemPrompt,
        messages: messagesForLlm,
        tools,
        stopWhen: stepCountIs(MAX_AGENT_LOOPS),
        onChunk: ({ chunk }: { chunk: any }) => {
          // Stream text deltas as response frames
          if (chunk.type === "text-delta") {
            this.wsSend(ws, {
              type: "response",
              content: chunk.text ?? chunk.textDelta ?? "",
              done: false,
            });
          }
        },
        onStepFinish: (stepEvent: any) => {
          const { toolCalls, toolResults } = stepEvent;

          // Send tool call frames
          if (toolCalls) {
            for (const tc of toolCalls) {
              this.wsSend(ws, {
                type: "tool_call",
                tool: tc.toolName,
                args: tc.args as Record<string, unknown>,
              });
            }
          }

          // Send tool result frames
          if (toolResults) {
            for (const tr of toolResults) {
              this.wsSend(ws, {
                type: "tool_result",
                tool: tr.toolName,
                result: tr.result,
              });

              // Detect memory formation from store_memory tool results
              if (
                tr.toolName === "store_memory" &&
                tr.result &&
                typeof tr.result === "object"
              ) {
                const memResult = tr.result as Record<string, unknown>;
                if (memResult.success) {
                  this.wsSend(ws, {
                    type: "memory_formed",
                    memory: {
                      content:
                        (memResult.content as string) ||
                        (tr.args as Record<string, unknown>)?.content ||
                        "",
                      type:
                        (memResult.type as string) ||
                        (tr.args as Record<string, unknown>)?.type ||
                        "note",
                      tags: (memResult.tags as string[]) || [],
                    },
                  });
                }
              }
            }
          }
        },
        onFinish: async (streamResult) => {
          const loopDurationMs = Date.now() - loopStartTime;

          // Send completion frame
          this.wsSend(ws, { type: "response", content: "", done: true });

          // Analytics
          const steps = streamResult.steps || [];
          const stepCount = steps.length;
          const toolCallCount = steps.reduce(
            (sum, step) => sum + (step.toolCalls?.length || 0),
            0
          );

          try {
            const analytics = new CortexAnalytics(this.env.ANALYTICS);
            analytics.trackAgentLoop(sessionId, stepCount, toolCallCount, loopDurationMs);
          } catch {
            // Non-critical
          }

          // Log episodic turns
          this.episodicMemory.logTurn(sessionId, "user", userText, turnIndex);
          this.episodicMemory.logTurn(sessionId, "assistant", streamResult.text, turnIndex + 1);
          this.episodicMemory.upsertSession(sessionId, { turnCount: turnIndex + 2 });

          // Invalidate caches
          await Promise.all([
            this.cache.invalidatePrefix(CachePrefixes.MEMORIES),
            this.cache.invalidatePrefix(CachePrefixes.SESSIONS),
          ]);

          // Post-turn consolidation
          await this.env.CONSOLIDATION_WORKFLOW.create({
            params: {
              userMessage: userText,
              assistantMessage: streamResult.text,
              sessionId,
            },
          });
        },
      });

      // Consume the stream to drive the callbacks
      await result.text;
    } catch (err) {
      this.wsSend(ws, {
        type: "error",
        message: err instanceof Error ? err.message : "Internal error",
      });
    }
  }

  /**
   * Send a JSON message over a WebSocket, handling closed-state gracefully.
   */
  private wsSend(ws: WebSocket, data: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // Socket may have closed mid-stream — ignore
    }
  }

  private async handleApiRequest(request: Request, namespaceId: string = DEFAULT_NAMESPACE_ID): Promise<Response> {
    // Namespace management endpoints do NOT need namespace-scoped init
    // because they operate across all namespaces.
    const url = new URL(request.url);
    const method = request.method;

    try {
      // /api/namespaces — CRUD for namespace management (not scoped to a namespace)
      if (url.pathname === "/api/namespaces" || url.pathname.startsWith("/api/namespaces/")) {
        this.ensureInit(DEFAULT_NAMESPACE_ID);
        return this.apiNamespaces(request, url, method);
      }

      // All other API routes are namespace-scoped
      this.ensureInit(namespaceId);

      // /api/memories — list, delete, or update memories
      if (url.pathname === "/api/memories") {
        if (method === "GET") {
          return this.apiListMemories(url);
        }
        if (method === "DELETE") {
          return this.apiDeleteMemory(url);
        }
        if (method === "PATCH") {
          return this.apiUpdateMemory(request);
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

      // /api/knowledge-graph — graph data for visualization
      if (url.pathname === "/api/knowledge-graph") {
        return this.apiKnowledgeGraph(url);
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
    const cursor = url.searchParams.get("cursor") || undefined;

    const cacheKey = CacheKeys.memoriesList(type || undefined, limit, cursor);
    const data = await this.cache.getOrSet(
      cacheKey,
      async () => {
        return this.semanticMemory.list({
          type: type || undefined,
          limit,
          cursor,
        });
      },
      CacheTTL.MEMORIES_LIST
    );

    return Response.json(data);
  }

  private async apiDeleteMemory(url: URL): Promise<Response> {
    const id = url.searchParams.get("id");
    if (!id) {
      return Response.json({ error: "Missing id parameter" }, { status: 400 });
    }
    const deleted = await this.semanticMemory.delete(id);

    // Invalidate memories cache after deletion
    await this.cache.invalidatePrefix(CachePrefixes.MEMORIES);

    return Response.json({ success: deleted });
  }

  private async apiUpdateMemory(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      id: string;
      content?: string;
      tags?: string[];
      type?: string;
    };

    if (!body.id) {
      return Response.json({ error: "Missing id field" }, { status: 400 });
    }

    // Fetch the existing memory to merge updates
    const existing = await this.semanticMemory.get(body.id);
    if (!existing) {
      return Response.json({ error: "Memory not found" }, { status: 404 });
    }

    const updatedContent = body.content ?? existing.content;
    const updatedTags = body.tags ?? existing.tags;

    // If type changed, update it directly in D1 (update() handles content + tags)
    if (body.type && body.type !== existing.type) {
      await this.env.DB
        .prepare(`UPDATE semantic_memories SET type = ? WHERE id = ? AND namespace_id = ?`)
        .bind(body.type, body.id, this.activeNamespaceId)
        .run();
    }

    // Call semantic memory update (re-generates embedding)
    const updated = await this.semanticMemory.update(
      body.id,
      updatedContent,
      updatedTags
    );

    if (!updated) {
      return Response.json(
        { error: "Failed to update memory" },
        { status: 500 }
      );
    }

    // Invalidate memories cache after edit
    await this.cache.invalidatePrefix(CachePrefixes.MEMORIES);

    // Return the updated memory
    const result = await this.semanticMemory.get(body.id);
    return Response.json({ success: true, memory: result });
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

  private async apiSessions(url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("id");

    if (sessionId) {
      // Get turns for a specific session (not cached — specific session lookup)
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

    // List all sessions (cached, paginated)
    const limit = parseInt(url.searchParams.get("limit") || "20", 10);
    const cursor = url.searchParams.get("cursor") || undefined;
    const cacheKey = CacheKeys.sessionsList(limit, cursor);
    const data = await this.cache.getOrSet(
      cacheKey,
      () => {
        const result = this.episodicMemory.listSessionsPaginated(limit, cursor);
        return {
          data: result.data.map((s) => ({
            sessionId: s.sessionId,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            topics:
              typeof s.topics === "string"
                ? JSON.parse(s.topics)
                : s.topics || [],
            turnCount: s.turnCount,
            summary: s.summary,
          })),
          cursor: result.cursor,
          hasMore: result.hasMore,
        };
      },
      CacheTTL.SESSIONS_LIST
    );

    return Response.json(data);
  }

  private async apiListRules(): Promise<Response> {
    const cacheKey = CacheKeys.rulesAll();
    const data = await this.cache.getOrSet(
      cacheKey,
      () => {
        const rules = this.proceduralMemory.getAll();
        return { rules, count: rules.length };
      },
      CacheTTL.RULES
    );
    return Response.json(data);
  }

  private async apiWatchList(request: Request, url: URL): Promise<Response> {
    const method = request.method;

    if (method === "GET") {
      const cacheKey = CacheKeys.watchlistAll();
      const data = await this.cache.getOrSet(
        cacheKey,
        async () => {
          const items = await this.watchListManager.list(false);
          return { items, count: items.length };
        },
        CacheTTL.WATCHLIST
      );
      return Response.json(data);
    }

    if (method === "POST") {
      const body = (await request.json()) as {
        url: string;
        label: string;
        frequency: "hourly" | "daily" | "weekly";
      };
      const frequency = body.frequency || "daily";
      const id = await this.watchListManager.add({
        url: body.url,
        label: body.label,
        frequency,
      });

      // Schedule a DO alarm for the new watch item
      const newItem = await this.watchListManager.get(id);
      if (newItem) {
        await scheduleWatchAlarm(this.env, newItem);
      }

      await this.cache.invalidatePrefix(CachePrefixes.WATCHLIST);
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

      // Cancel the DO alarm for the removed watch item
      await cancelWatchAlarm(this.env, id);

      await this.cache.invalidatePrefix(CachePrefixes.WATCHLIST);
      return Response.json({ success });
    }

    if (method === "PATCH") {
      const body = (await request.json()) as { id: string; active: boolean };
      await this.watchListManager.setActive(body.id, body.active);

      // Schedule or cancel alarm based on active status
      if (body.active) {
        const item = await this.watchListManager.get(body.id);
        if (item) {
          await scheduleWatchAlarm(this.env, item);
        }
      } else {
        await cancelWatchAlarm(this.env, body.id);
      }

      await this.cache.invalidatePrefix(CachePrefixes.WATCHLIST);
      return Response.json({ success: true });
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  private async apiGetDigest(): Promise<Response> {
    const cacheKey = CacheKeys.digestUndelivered();
    const data = await this.cache.getOrSet(
      cacheKey,
      async () => {
        const entries = await this.digestManager.getUndelivered();
        return {
          entries: entries.map((e) => ({
            id: e.id,
            watchItemId: e.watchItemId,
            summary: e.summary,
            createdAt: e.createdAt,
          })),
          count: entries.length,
        };
      },
      CacheTTL.DIGEST
    );
    return Response.json(data);
  }

  private async apiKnowledgeGraph(url: URL): Promise<Response> {
    const limit = Math.min(
      parseInt(url.searchParams.get("limit") || "200", 10),
      200
    );

    const cacheKey = `knowledge-graph:${limit}`;
    const data = await this.cache.getOrSet(
      cacheKey,
      async () => {
        const memories = await this.semanticMemory.list({ limit });
        const items = Array.isArray(memories)
          ? memories
          : (memories as any).data || [];
        return buildKnowledgeGraphData(items);
      },
      CacheTTL.MEMORIES_LIST
    );

    return Response.json(data);
  }

  // ── Namespace Management API ──────────────────────────────────

  private async apiNamespaces(request: Request, url: URL, method: string): Promise<Response> {
    // Extract namespace ID from URL path: /api/namespaces/:id
    const pathParts = url.pathname.split("/").filter(Boolean);
    const namespaceIdFromPath = pathParts.length > 2 ? pathParts[2] : null;

    // POST /api/namespaces — Create a new namespace
    if (method === "POST" && !namespaceIdFromPath) {
      const body = (await request.json()) as {
        id?: string;
        name: string;
        owner: string;
        settings?: Record<string, unknown>;
      };

      if (!body.name || !body.owner) {
        return Response.json(
          { error: "Missing required fields: name, owner" },
          { status: 400 }
        );
      }

      const id = body.id || crypto.randomUUID();
      const settings = body.settings ? JSON.stringify(body.settings) : null;

      try {
        await this.env.DB
          .prepare(
            `INSERT INTO namespaces (id, name, owner, settings) VALUES (?, ?, ?, ?)`
          )
          .bind(id, body.name, body.owner, settings)
          .run();
      } catch (err) {
        // Check for unique constraint violation (duplicate ID)
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("UNIQUE") || errMsg.includes("PRIMARY KEY")) {
          return Response.json(
            { error: `Namespace with id '${id}' already exists` },
            { status: 409 }
          );
        }
        throw err;
      }

      const created = await this.env.DB
        .prepare(`SELECT * FROM namespaces WHERE id = ?`)
        .bind(id)
        .first<RawNamespaceRow>();

      return Response.json(
        { success: true, namespace: created ? rawToNamespace(created) : { id, name: body.name, owner: body.owner, settings: body.settings ?? null, createdAt: new Date().toISOString() } },
        { status: 201 }
      );
    }

    // GET /api/namespaces — List all namespaces
    if (method === "GET" && !namespaceIdFromPath) {
      const { results } = await this.env.DB
        .prepare(`SELECT * FROM namespaces ORDER BY created_at DESC`)
        .all<RawNamespaceRow>();

      const namespaces = (results ?? []).map(rawToNamespace);
      return Response.json({ namespaces, count: namespaces.length });
    }

    // GET /api/namespaces/:id — Get a single namespace
    if (method === "GET" && namespaceIdFromPath) {
      const row = await this.env.DB
        .prepare(`SELECT * FROM namespaces WHERE id = ?`)
        .bind(namespaceIdFromPath)
        .first<RawNamespaceRow>();

      if (!row) {
        return Response.json({ error: "Namespace not found" }, { status: 404 });
      }
      return Response.json({ namespace: rawToNamespace(row) });
    }

    // PUT /api/namespaces/:id — Update namespace settings
    if (method === "PUT" && namespaceIdFromPath) {
      const body = (await request.json()) as {
        name?: string;
        settings?: Record<string, unknown>;
      };

      // Build dynamic UPDATE query
      const updates: string[] = [];
      const params: (string | null)[] = [];

      if (body.name !== undefined) {
        updates.push("name = ?");
        params.push(body.name);
      }
      if (body.settings !== undefined) {
        updates.push("settings = ?");
        params.push(JSON.stringify(body.settings));
      }

      if (updates.length === 0) {
        return Response.json(
          { error: "No fields to update" },
          { status: 400 }
        );
      }

      params.push(namespaceIdFromPath);

      const result = await this.env.DB
        .prepare(`UPDATE namespaces SET ${updates.join(", ")} WHERE id = ?`)
        .bind(...params)
        .run();

      if ((result.meta?.changes ?? 0) === 0) {
        return Response.json({ error: "Namespace not found" }, { status: 404 });
      }

      const updated = await this.env.DB
        .prepare(`SELECT * FROM namespaces WHERE id = ?`)
        .bind(namespaceIdFromPath)
        .first<RawNamespaceRow>();

      return Response.json({
        success: true,
        namespace: updated ? rawToNamespace(updated) : null,
      });
    }

    // DELETE /api/namespaces/:id — Archive (delete) a namespace
    if (method === "DELETE" && namespaceIdFromPath) {
      // Prevent deleting the default namespace
      if (namespaceIdFromPath === DEFAULT_NAMESPACE_ID) {
        return Response.json(
          { error: "Cannot delete the default namespace" },
          { status: 400 }
        );
      }

      const result = await this.env.DB
        .prepare(`DELETE FROM namespaces WHERE id = ?`)
        .bind(namespaceIdFromPath)
        .run();

      return Response.json({
        success: (result.meta?.changes ?? 0) > 0,
      });
    }

    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
}

// ── Namespace Helpers ──────────────────────────────────────────

interface RawNamespaceRow {
  id: string;
  name: string;
  owner: string;
  created_at: string;
  settings: string | null;
}

function rawToNamespace(row: RawNamespaceRow): Namespace {
  let parsedSettings: Record<string, unknown> | null = null;
  if (row.settings) {
    try {
      parsedSettings = JSON.parse(row.settings);
    } catch {
      parsedSettings = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    owner: row.owner,
    createdAt: row.created_at,
    settings: parsedSettings,
  };
}
