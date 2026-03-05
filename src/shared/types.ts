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

// ── Semantic Memory (D1 + Embeddings) ──────────────────────────
export interface SemanticEntry {
  id: string;
  content: string;
  type: "fact" | "preference" | "event" | "note" | "summary";
  source: "user" | "consolidated" | "research";
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEmbedding {
  memoryId: string;
  embedding: Float32Array;
}

// ── Procedural Memory (DO SQLite) ──────────────────────────────
export interface ProceduralRule {
  id: number;
  rule: string;
  source: "user" | "system";
  active: boolean;
  createdAt: string;
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
  DB: D1Database;
  STORAGE: R2Bucket;
  AI: Ai;
  EMBEDDING_MODEL: string;
  CHAT_MODEL: string;
}
