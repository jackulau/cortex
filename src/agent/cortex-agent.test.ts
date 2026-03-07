import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for CortexAgent Durable Object hibernation behavior.
 *
 * These tests verify that the CortexAgent is correctly configured for
 * Hibernatable WebSockets and that its lazy-init pattern handles
 * post-hibernation re-initialization correctly.
 *
 * Since CortexAgent extends AIChatAgent (which extends Agent from the
 * agents SDK), and the Agent base class handles the actual WebSocket
 * hibernation protocol, these tests focus on:
 *
 * 1. The static options configuration
 * 2. The ensureInit() re-hydration pattern
 * 3. State survival across simulated hibernation cycles
 */

// We need to mock the heavy dependencies so we can instantiate/inspect the class
vi.mock("@cloudflare/ai-chat", () => {
  class MockAIChatAgent {
    env: any;
    name: string;
    messages: any[];

    static options = {};

    constructor(ctx: any, env: any) {
      this.env = env;
      this.name = ctx?.id?.name || "test-session";
      this.messages = [];
    }

    sql(strings: TemplateStringsArray, ...values: any[]) {
      // Return empty arrays for schema creation queries
      return [];
    }
  }

  return { AIChatAgent: MockAIChatAgent };
});

vi.mock("ai", () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn(),
}));

vi.mock("@/ai/providers", () => ({
  getChatModel: vi.fn(() => "test-model"),
}));

vi.mock("@/memory/schemas", () => ({
  initDoSchemas: vi.fn(),
}));

vi.mock("@/memory/working", () => ({
  WorkingMemory: vi.fn().mockImplementation((sessionId: string) => ({
    getState: () => ({
      sessionId,
      startedAt: new Date().toISOString(),
      topics: [],
      recentFacts: [],
      pendingActions: [],
    }),
    toContextString: () => "",
    addTopic: vi.fn(),
    addFact: vi.fn(),
  })),
}));

vi.mock("@/memory/episodic", () => ({
  EpisodicMemory: vi.fn().mockImplementation(() => ({
    logTurn: vi.fn(),
    getTurnCount: vi.fn(() => 0),
    upsertSession: vi.fn(),
    getSession: vi.fn(() => []),
    listSessionsPaginated: vi.fn(() => ({
      data: [],
      cursor: null,
      hasMore: false,
    })),
  })),
}));

vi.mock("@/memory/semantic", () => ({
  SemanticMemory: vi.fn().mockImplementation(() => ({
    search: vi.fn(async () => []),
    list: vi.fn(async () => ({ data: [], cursor: null, hasMore: false })),
    delete: vi.fn(async () => true),
    get: vi.fn(async () => null),
    update: vi.fn(async () => true),
  })),
}));

vi.mock("@/memory/procedural", () => ({
  ProceduralMemory: vi.fn().mockImplementation(() => ({
    getAll: vi.fn(() => []),
  })),
}));

vi.mock("@/agent/prompts/system", () => ({
  buildSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("@/agent/prompts/memory-context", () => ({
  retrieveMemoryContext: vi.fn(async () => ""),
}));

vi.mock("@/agent/tools/memory-tools", () => ({
  createMemoryTools: vi.fn(() => ({})),
}));

vi.mock("@/agent/tools/research-tools", () => ({
  createResearchTools: vi.fn(() => ({})),
}));

vi.mock("@/agent/tools/watch-tools", () => ({
  createWatchTools: vi.fn(() => ({})),
}));

vi.mock("@/agent/tools/export-tools", () => ({
  createExportTools: vi.fn(() => ({})),
}));

vi.mock("@/agent/tools/thinking-tool", () => ({
  createThinkingTool: vi.fn(() => ({})),
}));

vi.mock("@/monitor/watchlist", () => ({
  WatchListManager: vi.fn().mockImplementation(() => ({
    list: vi.fn(async () => []),
    add: vi.fn(async () => "item-1"),
    get: vi.fn(async () => null),
    remove: vi.fn(async () => true),
    setActive: vi.fn(async () => {}),
  })),
}));

vi.mock("@/monitor/digest", () => ({
  DigestManager: vi.fn().mockImplementation(() => ({
    getUndelivered: vi.fn(async () => []),
  })),
}));

vi.mock("@/monitor/watch-scheduler", () => ({
  scheduleWatchAlarm: vi.fn(async () => {}),
  cancelWatchAlarm: vi.fn(async () => {}),
}));

vi.mock("@/observability/analytics", () => ({
  CortexAnalytics: vi.fn().mockImplementation(() => ({
    trackAgentLoop: vi.fn(),
  })),
}));

vi.mock("@/cache/kv-cache", () => ({
  KVCache: vi.fn().mockImplementation(() => ({
    getOrSet: vi.fn(async (_key: string, factory: () => any) => factory()),
    invalidatePrefix: vi.fn(async () => {}),
  })),
  CacheKeys: {
    memoriesList: vi.fn(() => "memories:list"),
    sessionsList: vi.fn(() => "sessions:list"),
    rulesAll: vi.fn(() => "rules:all"),
    watchlistAll: vi.fn(() => "watchlist:all"),
    digestUndelivered: vi.fn(() => "digest:undelivered"),
  },
  CacheTTL: {
    MEMORIES_LIST: 300,
    SESSIONS_LIST: 300,
    RULES: 600,
    WATCHLIST: 300,
    DIGEST: 60,
  },
  CachePrefixes: {
    MEMORIES: "memories:",
    SESSIONS: "sessions:",
    WATCHLIST: "watchlist:",
  },
}));

vi.mock("@/agent/graph-builder", () => ({
  buildKnowledgeGraphData: vi.fn(() => ({ nodes: [], edges: [] })),
}));

// Import after mocks are set up
import { CortexAgent } from "./cortex-agent";
import { initDoSchemas } from "@/memory/schemas";
import { WorkingMemory } from "@/memory/working";
import { EpisodicMemory } from "@/memory/episodic";
import { SemanticMemory } from "@/memory/semantic";
import { ProceduralMemory } from "@/memory/procedural";
import { WatchListManager } from "@/monitor/watchlist";
import { DigestManager } from "@/monitor/digest";
import { KVCache } from "@/cache/kv-cache";

function createMockEnv() {
  return {
    DB: {} as any,
    AI: {} as any,
    EMBEDDING_MODEL: "@cf/baai/bge-large-en-v1.5",
    CHAT_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    BROWSER: {} as any,
    STORAGE: {} as any,
    VECTORIZE: {} as any,
    CACHE: {} as any,
    CRAWL_QUEUE: { send: vi.fn() } as any,
    CONSOLIDATION_QUEUE: { send: vi.fn() } as any,
    CONSOLIDATION_WORKFLOW: { create: vi.fn() } as any,
    R2_EVENT_QUEUE: { send: vi.fn() } as any,
    ANALYTICS: { writeDataPoint: vi.fn() } as any,
    RATE_LIMITER: {} as any,
    CRAWLER_SERVICE: {} as any,
    CortexAgent: {} as any,
    WatchScheduler: {} as any,
    API_KEY: "",
    ALLOWED_ORIGINS: "",
    DISCORD_PUBLIC_KEY: "",
    DISCORD_APP_ID: "",
    DISCORD_BOT_TOKEN: "",
    DISCORD_DIGEST_CHANNEL_ID: "",
  };
}

function createMockCtx() {
  return {
    id: { name: "test-session" },
    storage: {
      sql: {
        exec: vi.fn(() => []),
      },
    },
  };
}

function createAgent(): CortexAgent {
  const ctx = createMockCtx();
  const env = createMockEnv();
  return new (CortexAgent as any)(ctx, env);
}

describe("CortexAgent hibernation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("static options", () => {
    it("has hibernate: true in static options", () => {
      expect(CortexAgent.options).toBeDefined();
      expect((CortexAgent as any).options.hibernate).toBe(true);
    });
  });

  describe("ensureInit() re-hydration after hibernation", () => {
    it("initializes all memory layers on first API call", async () => {
      const agent = createAgent();

      // Simulate an API request that triggers ensureInit()
      const request = new Request("https://do/api/rules", { method: "GET" });
      const response = await (agent as any).fetch(request);

      expect(response.status).toBe(200);

      // Verify all dependencies were initialized
      expect(initDoSchemas).toHaveBeenCalledTimes(1);
      expect(WorkingMemory).toHaveBeenCalledTimes(1);
      expect(EpisodicMemory).toHaveBeenCalledTimes(1);
      expect(SemanticMemory).toHaveBeenCalledTimes(1);
      expect(ProceduralMemory).toHaveBeenCalledTimes(1);
      expect(WatchListManager).toHaveBeenCalledTimes(1);
      expect(DigestManager).toHaveBeenCalledTimes(1);
      expect(KVCache).toHaveBeenCalledTimes(1);
    });

    it("does not re-initialize if already initialized", async () => {
      const agent = createAgent();

      // Two requests in the same lifecycle
      const req1 = new Request("https://do/api/rules", { method: "GET" });
      const req2 = new Request("https://do/api/rules", { method: "GET" });
      await (agent as any).fetch(req1);
      await (agent as any).fetch(req2);

      // ensureInit() should only run once
      expect(initDoSchemas).toHaveBeenCalledTimes(1);
      expect(WorkingMemory).toHaveBeenCalledTimes(1);
    });

    it("re-initializes after simulated hibernation (new instance)", async () => {
      // First lifecycle
      const agent1 = createAgent();
      const req1 = new Request("https://do/api/rules", { method: "GET" });
      await (agent1 as any).fetch(req1);
      expect(initDoSchemas).toHaveBeenCalledTimes(1);

      // Simulate hibernation: create a new instance (DO evicted and re-created)
      vi.clearAllMocks();
      const agent2 = createAgent();
      const req2 = new Request("https://do/api/rules", { method: "GET" });
      await (agent2 as any).fetch(req2);

      // After hibernation wake, ensureInit() runs again on the new instance
      expect(initDoSchemas).toHaveBeenCalledTimes(1);
      expect(WorkingMemory).toHaveBeenCalledTimes(1);
      expect(EpisodicMemory).toHaveBeenCalledTimes(1);
      expect(SemanticMemory).toHaveBeenCalledTimes(1);
      expect(ProceduralMemory).toHaveBeenCalledTimes(1);
      expect(WatchListManager).toHaveBeenCalledTimes(1);
      expect(DigestManager).toHaveBeenCalledTimes(1);
      expect(KVCache).toHaveBeenCalledTimes(1);
    });

    it("creates WorkingMemory with the correct session ID from DO name", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/rules", { method: "GET" });
      await (agent as any).fetch(request);

      // The mock ctx has id.name = "test-session"
      expect(WorkingMemory).toHaveBeenCalledWith("test-session");
    });

    it("passes sql binding to DO SQLite-backed memory layers", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/rules", { method: "GET" });
      await (agent as any).fetch(request);

      // initDoSchemas receives a bound sql function
      expect(initDoSchemas).toHaveBeenCalledWith(expect.any(Function));

      // EpisodicMemory and ProceduralMemory receive the sql binding
      expect(EpisodicMemory).toHaveBeenCalledWith(expect.any(Function));
      expect(ProceduralMemory).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe("API endpoints work after simulated hibernation", () => {
    it("serves /api/memories after re-init", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/memories", { method: "GET" });
      const response = await (agent as any).fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      // SemanticMemory.list returns the mocked paginated response
      expect(body).toBeDefined();
    });

    it("serves /api/sessions after re-init", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/sessions", { method: "GET" });
      const response = await (agent as any).fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toBeDefined();
    });

    it("serves /api/rules after re-init", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/rules", { method: "GET" });
      const response = await (agent as any).fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ rules: [], count: 0 });
    });

    it("serves /api/watchlist after re-init", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/watchlist", {
        method: "GET",
      });
      const response = await (agent as any).fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ items: [], count: 0 });
    });

    it("serves /api/digest after re-init", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/digest", { method: "GET" });
      const response = await (agent as any).fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ entries: [], count: 0 });
    });

    it("serves /api/knowledge-graph after re-init", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/knowledge-graph", {
        method: "GET",
      });
      const response = await (agent as any).fetch(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ nodes: [], edges: [] });
    });
  });

  describe("hibernation-safe state architecture", () => {
    it("initialized flag starts as false for new instances", () => {
      const agent = createAgent();
      // Access the private field via any cast
      expect((agent as any).initialized).toBe(false);
    });

    it("initialized flag becomes true after ensureInit()", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/rules", { method: "GET" });
      await (agent as any).fetch(request);
      expect((agent as any).initialized).toBe(true);
    });

    it("new instance after hibernation has initialized = false", () => {
      // First instance
      const agent1 = createAgent();
      (agent1 as any).ensureInit();
      expect((agent1 as any).initialized).toBe(true);

      // Second instance (simulating hibernation wake)
      const agent2 = createAgent();
      expect((agent2 as any).initialized).toBe(false);
    });

    it("SemanticMemory uses external D1/Vectorize bindings (hibernation-safe)", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/rules", { method: "GET" });
      await (agent as any).fetch(request);

      // SemanticMemory receives env bindings that survive hibernation
      expect(SemanticMemory).toHaveBeenCalledWith(
        expect.anything(), // DB
        expect.anything(), // AI
        "@cf/baai/bge-large-en-v1.5", // EMBEDDING_MODEL
        expect.anything() // VECTORIZE
      );
    });

    it("WatchListManager and DigestManager use D1 (hibernation-safe)", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/rules", { method: "GET" });
      await (agent as any).fetch(request);

      // Both managers receive the D1 binding
      expect(WatchListManager).toHaveBeenCalledWith(expect.anything());
      expect(DigestManager).toHaveBeenCalledWith(expect.anything());
    });

    it("KVCache uses external KV binding (hibernation-safe)", async () => {
      const agent = createAgent();
      const request = new Request("https://do/api/rules", { method: "GET" });
      await (agent as any).fetch(request);

      expect(KVCache).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe("non-API fetch delegates to parent class", () => {
    it("non-/api/ paths are forwarded to AIChatAgent.fetch()", async () => {
      const agent = createAgent();

      // Mock super.fetch for non-API paths
      const parentFetch = vi
        .fn()
        .mockResolvedValue(new Response("parent handled"));
      // The parent class prototype fetch
      Object.getPrototypeOf(Object.getPrototypeOf(agent)).fetch = parentFetch;

      const request = new Request("https://do/chat", { method: "GET" });
      const response = await (agent as any).fetch(request);

      expect(parentFetch).toHaveBeenCalledWith(request);
      expect(await response.text()).toBe("parent handled");
    });
  });
});
