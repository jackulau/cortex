// ── Working Memory ──────────────────────────────────────────────
export interface WorkingMemoryState {
  sessionId: string;
  startedAt: string;
  topics: string[];
  recentFacts: string[];
  pendingActions: string[];
  userName?: string;
  userContext?: Record<string, string>;
}

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  topics: string[];
  turnCount: number;
  summary: string;
}

// ── Episodic Memory (DO SQLite) ────────────────────────────────
export interface EpisodicEntry {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  turnIndex: number;
}

// ── Semantic Memory (D1 + Vectorize) ────────────────────────────
export interface SemanticEntry {
  id: string;
  content: string;
  type: "fact" | "preference" | "event" | "note" | "summary";
  source: "user" | "consolidated" | "research";
  tags: string[];
  createdAt: string;
  updatedAt: string;
  relevanceScore: number;
  lastAccessedAt: string | null;
  accessCount: number;
  archivedAt?: string | null;
  /** ID of the memory that superseded this one (null if still active). */
  supersededBy: string | null;
  /** Namespace this memory belongs to. Defaults to 'default'. */
  namespaceId?: string;
}

// ── Namespace ──────────────────────────────────────────────────
export interface Namespace {
  id: string;
  name: string;
  owner: string;
  createdAt: string;
  /** JSON config per namespace (e.g., custom rules, model overrides). */
  settings: Record<string, unknown> | null;
}

/** Default namespace ID for backward compatibility. */
export const DEFAULT_NAMESPACE_ID = "default";

// ── Procedural Memory (DO SQLite) ──────────────────────────────
export interface ProceduralRule {
  id: number;
  rule: string;
  source: "user" | "system";
  active: boolean;
  createdAt: string;
}

// ── Pagination ────────────────────────────────────────────────
export interface PaginatedResponse<T> {
  data: T[];
  cursor: string | null; // null means no more pages
  hasMore: boolean;
}

// ── Search & Write ─────────────────────────────────────────────
export interface MemorySearchResult {
  entry: SemanticEntry;
  score: number;
  matchType: "semantic" | "fts" | "exact";
}

export interface MemoryWriteRequest {
  content: string;
  type: SemanticEntry["type"];
  source: SemanticEntry["source"];
  tags?: string[];
}

// ── DO SQL Function ────────────────────────────────────────────
/** Tagged template literal SQL function from Agents SDK */
export type SqlFn = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

// ── Cloudflare Env ─────────────────────────────────────────────
export interface Env {
  CortexAgent: DurableObjectNamespace;
  WatchScheduler: DurableObjectNamespace;
  DB: D1Database;
  STORAGE: R2Bucket;
  AI: Ai;
  EMBEDDING_MODEL: string;
  CHAT_MODEL: string;
  // Model tier overrides (optional — fall back to defaults in model-router)
  AI_MODEL_HEAVY?: string;
  AI_MODEL_LIGHT?: string;
  // Phase 2: Browser rendering + Discord
  BROWSER: Fetcher;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  DISCORD_BOT_TOKEN: string;
  // Proactive digest: channel to post scheduled digests
  DISCORD_DIGEST_CHANNEL_ID: string;
  // Phase 5: Platform bindings
  VECTORIZE: VectorizeIndex;
  CACHE: KVNamespace;
  CRAWL_QUEUE: Queue;
  CONSOLIDATION_QUEUE: Queue;
  // Workflows — durable multi-step pipelines
  CONSOLIDATION_WORKFLOW: Workflow;
  R2_EVENT_QUEUE: Queue;
  ANALYTICS: AnalyticsEngineDataset;
  RATE_LIMITER: RateLimit;
  // Service Bindings — isolated crawler worker
  CRAWLER_SERVICE: Fetcher;
  // Authentication & CORS
  API_KEY: string;
  ALLOWED_ORIGINS: string;
  // External AI provider — Claude API (set via `wrangler secret put ANTHROPIC_API_KEY`)
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  // Cloudflare Access Zero Trust auth
  CF_ACCESS_AUD: string;
  CF_ACCESS_TEAM_DOMAIN: string;
}

// ── Crawler Worker Env ────────────────────────────────────────
/** Environment bindings for the isolated crawler Worker (cortex-crawler). */
export interface CrawlerEnv {
  DB: D1Database;
  STORAGE: R2Bucket;
  AI: Ai;
  BROWSER: Fetcher;
  VECTORIZE: VectorizeIndex;
  EMBEDDING_MODEL: string;
  CHAT_MODEL: string;
}
