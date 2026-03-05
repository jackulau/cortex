# Cortex — Complete Implementation Specification

> Personal AI agent with persistent 4-layer memory, built on Cloudflare's edge.
> This document is the single source of truth for all implementation work.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Structure](#2-project-structure)
3. [Technology Stack & Versions](#3-technology-stack--versions)
4. [Cloudflare Resource Configuration](#4-cloudflare-resource-configuration)
5. [Type System](#5-type-system)
6. [Memory Architecture (4 Layers)](#6-memory-architecture-4-layers)
7. [Embedding Pipeline](#7-embedding-pipeline)
8. [Agent Core](#8-agent-core)
9. [Tool System](#9-tool-system)
10. [Prompt Engineering](#10-prompt-engineering)
11. [Chat UI](#11-chat-ui)
12. [Server & Routing](#12-server--routing)
13. [Database Schemas](#13-database-schemas)
14. [Phase 1 Status (COMPLETE)](#14-phase-1-status-complete)
15. [Phase 2 Specification: Browser + Discord](#15-phase-2-specification-browser--discord)
16. [Phase 3 Specification: Proactive Intelligence](#16-phase-3-specification-proactive-intelligence)
17. [Phase 4 Specification: MCP + Export](#17-phase-4-specification-mcp--export)
18. [Critical Implementation Notes](#18-critical-implementation-notes)
19. [Development Workflow](#19-development-workflow)
20. [Testing Strategy](#20-testing-strategy)
21. [Deployment](#21-deployment)

---

## 1. Architecture Overview

### High-Level Data Flow

```
User (Browser)
    │
    ▼ WebSocket
┌──────────────────────────────────────────────────┐
│ Cloudflare Worker (src/server.ts)                │
│   └─ routeAgentRequest() ──► CortexAgent DO      │
│                                                   │
│ CortexAgent (Durable Object)                     │
│   ├── onChatMessage()                            │
│   │     1. retrieveMemoryContext()               │
│   │        ├── SemanticMemory.search() [D1+AI]   │
│   │        └── EpisodicMemory.search() [DO FTS]  │
│   │     2. buildSystemPrompt()                   │
│   │        ├── WorkingMemory context             │
│   │        └── ProceduralMemory rules            │
│   │     3. streamText() [Workers AI LLM]         │
│   │        └── tools: remember, recall, forget,  │
│   │            addRule, listRules, searchHistory  │
│   │     4. onFinish callback:                    │
│   │        ├── EpisodicMemory.logTurn()          │
│   │        └── consolidateTurn() [AI extract]    │
│   │             └── SemanticMemory.write()       │
│   │                                              │
│   ├── DO SQLite (colocated)                      │
│   │     ├── episodic_memory + FTS5 index         │
│   │     ├── sessions                             │
│   │     └── procedural_memory                    │
│   │                                              │
│   └── External Bindings                          │
│         ├── D1 (cortex-db)                       │
│         │     ├── semantic_memories              │
│         │     ├── memory_embeddings              │
│         │     ├── watch_items (Phase 3)          │
│         │     └── digest_entries (Phase 3)       │
│         ├── Workers AI                           │
│         │     ├── @cf/baai/bge-large-en-v1.5     │
│         │     └── @cf/meta/llama-3.3-70b-*       │
│         ├── R2 (cortex-storage)                  │
│         └── Browser Rendering (Phase 2)          │
└──────────────────────────────────────────────────┘
```

### Why This Architecture

| Decision | Rationale |
|----------|-----------|
| DO SQLite for episodic + procedural | Zero-latency colocated storage, user-scoped, survives hibernation |
| D1 for semantic memory | Cross-session queries, larger scale, JOIN with embeddings table |
| Manual cosine similarity (not Vectorize) | ~1000s of memories for personal use = fast enough in-worker. Migrate to Vectorize if >10K |
| WebSocket Hibernation | Avoids duration charges when user isn't actively chatting |
| Post-turn consolidation | Automatic memory growth without requiring user to explicitly "save" |
| `AIChatAgent` base class | Built-in WebSocket handling, message persistence, tool calling via AI SDK |

---

## 2. Project Structure

```
cortex/
├── src/
│   ├── agent/
│   │   ├── cortex-agent.ts          # Main agent class (extends AIChatAgent)
│   │   ├── tools/
│   │   │   ├── index.ts             # Tool barrel export
│   │   │   ├── memory-tools.ts      # remember, recall, forget, addRule, listRules, searchHistory
│   │   │   ├── research-tools.ts    # [Phase 2] readUrl, research
│   │   │   └── watch-tools.ts       # [Phase 3] watchAdd, watchList, watchRemove, getDigest
│   │   └── prompts/
│   │       ├── system.ts            # System prompt builder with memory injection
│   │       └── memory-context.ts    # Pre-response memory retrieval + formatting
│   ├── memory/
│   │   ├── working.ts               # Working memory (in-memory session state)
│   │   ├── episodic.ts              # Episodic memory (DO SQLite + FTS5)
│   │   ├── semantic.ts              # Semantic memory (D1 + Workers AI embeddings)
│   │   ├── procedural.ts            # Procedural rules (DO SQLite)
│   │   ├── consolidation.ts         # Post-turn AI fact extraction
│   │   └── schemas.ts              # DO SQLite DDL initialization
│   ├── embeddings/
│   │   ├── generate.ts              # Workers AI embedding generation + chunking
│   │   └── search.ts               # Cosine similarity computation
│   ├── browser/                     # [Phase 2]
│   │   └── extract.ts              # Puppeteer content extraction + R2 storage
│   ├── discord/                     # [Phase 2]
│   │   ├── index.ts                # Discord interaction handler
│   │   ├── commands.ts             # Slash command definitions
│   │   ├── verify.ts               # Ed25519 signature verification
│   │   └── register.ts            # Command registration script
│   ├── monitor/                     # [Phase 3]
│   │   ├── watchlist.ts            # Watch item CRUD (D1)
│   │   ├── crawler.ts             # Scheduled crawl + SHA-256 dedup
│   │   └── digest.ts              # Digest generation + delivery
│   ├── mcp/                        # [Phase 4]
│   │   └── index.ts               # MCP server (remember, recall, research)
│   ├── dashboard/                   # [Phase 3]
│   │   ├── app.tsx                 # React dashboard app
│   │   └── components/            # KnowledgeGraph, MemoryExplorer, etc.
│   ├── shared/
│   │   └── types.ts               # All TypeScript interfaces + Env
│   ├── server.ts                   # Worker entry point + routing
│   ├── app.tsx                     # Chat UI React component
│   ├── main.tsx                    # React entry point
│   └── styles.css                  # Tailwind CSS styles
├── migrations/
│   ├── 0001_create_semantic_memories.sql
│   ├── 0002_create_embeddings.sql
│   └── 0003_create_watchlists.sql
├── index.html                       # Vite HTML entry
├── package.json
├── tsconfig.json
├── vite.config.ts
├── wrangler.jsonc
└── .gitignore
```

---

## 3. Technology Stack & Versions

### CRITICAL: Package Versions

These versions are pinned because of breaking API changes. Do NOT change without verifying compatibility.

| Package | Version | Why This Version |
|---------|---------|-----------------|
| `agents` | `^0.7.3` (installed: 0.7.4) | Required by `@cloudflare/ai-chat`. Provides `Agent` base class, `routeAgentRequest`, `useAgent` React hook. The `sql` method is a tagged template literal (NOT `SqlStorage.exec()`). |
| `@cloudflare/ai-chat` | `^0.1.8` | Provides `AIChatAgent` class and `useAgentChat` hook. Peer-depends on `agents@^0.7.3`. |
| `ai` | `^6.0.0` (installed: 6.0.114) | Vercel AI SDK v6. BREAKING CHANGES from v4: `parameters` → `inputSchema`, `toDataStreamResponse()` → `toUIMessageStreamResponse()`, `maxSteps` → `stopWhen: stepCountIs(N)`, `UIMessage.content` → `UIMessage.parts`, `Message` type → `UIMessage` type. |
| `workers-ai-provider` | `^3.1.0` (installed: 3.1.2) | v3 implements `LanguageModelV3` (required by AI SDK v6). v0.2.x only had `LanguageModelV1`. |
| `@cloudflare/vite-plugin` | `^1.26.0` | Integrates Vite with Wrangler — handles both client build and worker bundling. Reads `wrangler.jsonc` automatically. Eliminates need for separate `assets` config. |
| `@cloudflare/workers-types` | `^4.20250303.0` | TypeScript types for Workers runtime. Use `2023-07-01` compat date types in tsconfig. |
| `react` / `react-dom` | `^19.0.0` | React 19 for the chat UI. |
| `zod` | `^3.24.0` | Schema validation for tool input definitions. |
| `hono` | `^4.7.0` | Lightweight routing (reserved for Phase 2+ API routes). |
| `tailwindcss` | `^4.0.0` | CSS framework. v4 uses `@import "tailwindcss"` instead of `@tailwind` directives. |

### AI SDK v6 Migration Cheat Sheet

```typescript
// OLD (v4)                              // NEW (v6)
import { tool } from "ai";              // Same
tool({ parameters: z.object({}) })      // tool({ inputSchema: z.object({}) })
result.toDataStreamResponse()            // result.toUIMessageStreamResponse()
streamText({ maxSteps: 5 })              // streamText({ stopWhen: stepCountIs(5) })
msg.content                              // msg.parts (array of TextUIPart, ToolUIPart, etc.)
msg.toolInvocations                      // msg.parts.filter(p => p.type === "tool-invocation")
sendMessage("text")                      // sendMessage({ text: "text" })
type Message                             // type UIMessage
createDataStream                         // createUIMessageStream
```

### Agents SDK SQL API

The `this.sql` on the Agent class is a **tagged template literal function**, NOT the `SqlStorage` interface from `@cloudflare/workers-types`.

```typescript
// CORRECT usage:
this.sql`SELECT * FROM table WHERE id = ${id}`;
this.sql<MyType>`SELECT col FROM table`;

// WRONG — SqlStorage.exec() does NOT exist:
// this.sql.exec("SELECT * FROM table WHERE id = ?", id);
```

When passing to other classes, bind it: `new EpisodicMemory(this.sql.bind(this))`

The `SqlFn` type is defined in `src/shared/types.ts`:
```typescript
type SqlFn = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];
```

---

## 4. Cloudflare Resource Configuration

### wrangler.jsonc

```jsonc
{
  "name": "cortex",
  "main": "src/server.ts",
  "compatibility_date": "2025-03-01",
  "compatibility_flags": ["nodejs_compat"],

  "durable_objects": {
    "bindings": [
      {
        "name": "CortexAgent",        // MUST match class name for routeAgentRequest
        "class_name": "CortexAgent"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["CortexAgent"]
    }
  ],

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "cortex-db",
      "database_id": "2839c0c7-d433-4ce5-9e06-6f7cbee18528"
    }
  ],

  "r2_buckets": [
    {
      "binding": "STORAGE",
      "bucket_name": "cortex-storage"
    }
  ],

  "ai": {
    "binding": "AI"
  },

  "vars": {
    "EMBEDDING_MODEL": "@cf/baai/bge-large-en-v1.5",
    "CHAT_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
  }
}
```

### Key Binding Rules

- **DO binding name MUST match class name**: `routeAgentRequest()` iterates `env` to find DO bindings by matching binding name to class name. If `name: "CORTEX_AGENT"` but `class_name: "CortexAgent"`, routing silently fails.
- **AI binding always remote**: Even in `wrangler dev --local`, the `AI` binding connects to Cloudflare's API. This means local dev requires internet + auth.
- **D1 database_id required**: Can be empty for purely local dev but `wrangler d1 create cortex-db` gives the real ID for deployment.
- **R2 bucket**: Create with `wrangler r2 bucket create cortex-storage` before deploying.

### Phase 2+ Additional Config

```jsonc
// Add to wrangler.jsonc for Phase 2:
"browser": {
  "binding": "BROWSER"
},

// Add to wrangler.jsonc for Phase 3:
"triggers": {
  "crons": ["0 */6 * * *"]
}
```

### Env Interface

```typescript
// src/shared/types.ts
export interface Env {
  CortexAgent: DurableObjectNamespace;
  DB: D1Database;
  STORAGE: R2Bucket;
  AI: Ai;
  EMBEDDING_MODEL: string;
  CHAT_MODEL: string;
  // Phase 2:
  // BROWSER: Fetcher;
  // DISCORD_PUBLIC_KEY: string;
  // DISCORD_APP_ID: string;
  // DISCORD_BOT_TOKEN: string;
}
```

---

## 5. Type System

### Complete Type Definitions (`src/shared/types.ts`)

```typescript
// ── Working Memory ──────────────────────────────────────────────
export interface WorkingMemoryState {
  sessionId: string;
  startedAt: string;          // ISO 8601
  topics: string[];           // Active conversation topics
  recentFacts: string[];      // Last 20 facts from this session
  pendingActions: string[];   // Unresolved actions
  userName?: string;          // Learned user name
  userContext?: Record<string, string>; // Arbitrary key-value context
}

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  topics: string[];           // JSON-serialized in DB
  turnCount: number;
  summary: string;
}

// ── Episodic Memory (DO SQLite) ────────────────────────────────
export interface EpisodicEntry {
  id: number;                 // AUTOINCREMENT
  sessionId: string;          // UUID
  role: "user" | "assistant";
  content: string;
  timestamp: string;          // ISO 8601, DEFAULT datetime('now')
  turnIndex: number;          // Sequential within session
}

// ── Semantic Memory (D1 + Embeddings) ──────────────────────────
export interface SemanticEntry {
  id: string;                 // UUID
  content: string;            // The fact/preference/note text
  type: "fact" | "preference" | "event" | "note" | "summary";
  source: "user" | "consolidated" | "research";
  tags: string[];             // JSON-serialized in DB
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEmbedding {
  memoryId: string;           // FK → semantic_memories.id
  embedding: Float32Array;    // Stored as BLOB in D1
}

// ── Procedural Memory (DO SQLite) ──────────────────────────────
export interface ProceduralRule {
  id: number;                 // AUTOINCREMENT
  rule: string;               // Natural language rule text
  source: "user" | "system";
  active: boolean;            // Soft-delete via deactivation
  createdAt: string;
}

// ── Search & Write ─────────────────────────────────────────────
export interface MemorySearchResult {
  entry: SemanticEntry;
  score: number;              // Cosine similarity 0-1
  matchType: "semantic" | "fts" | "exact";
}

export interface MemoryWriteRequest {
  content: string;
  type: SemanticEntry["type"];
  source: SemanticEntry["source"];
  tags?: string[];
}

// ── DO SQL Function ────────────────────────────────────────────
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
```

---

## 6. Memory Architecture (4 Layers)

### Layer 1: Working Memory (`src/memory/working.ts`)

**Storage**: In-memory on DO instance (ephemeral per session).
**Purpose**: Tracks current conversation context — topics, recent facts, user info.
**Lifetime**: Lives as long as the DO instance is active. Lost on hibernation/eviction.

```typescript
class WorkingMemory {
  constructor(sessionId: string)

  getState(): WorkingMemoryState        // Returns copy of current state
  setUserName(name: string): void
  setUserContext(key: string, value: string): void
  addTopic(topic: string): void         // Deduplicates
  addFact(fact: string): void           // Keeps last 20
  addPendingAction(action: string): void
  removePendingAction(action: string): void
  toContextString(): string             // Formatted for system prompt injection
}
```

**Context String Format** (injected into system prompt):
```
User: Jack
Context: location: SF, timezone: PST
Current topics: AI agents, Cloudflare Workers
Recent facts from this session:
- Jack is building a personal AI agent
- He prefers TypeScript
```

### Layer 2: Episodic Memory (`src/memory/episodic.ts`)

**Storage**: DO SQLite (colocated with the agent instance).
**Purpose**: Full conversation history with FTS5 full-text search.
**Lifetime**: Persists across sessions. Survives DO hibernation.

```typescript
class EpisodicMemory {
  constructor(sql: SqlFn)

  logTurn(sessionId: string, role: "user" | "assistant", content: string, turnIndex: number): void
  getSession(sessionId: string): EpisodicEntry[]
  search(query: string, limit?: number): EpisodicEntry[]     // FTS5 MATCH
  listSessions(limit?: number): SessionSummary[]
  upsertSession(sessionId: string, updates: { topics?: string[]; turnCount?: number; summary?: string; endedAt?: string }): void
  getTurnCount(sessionId: string): number
  getRecentTurns(limit?: number): EpisodicEntry[]
}
```

**FTS5 Search**: Uses SQLite's FTS5 extension for full-text search. The `episodic_fts` virtual table is kept in sync via INSERT/DELETE triggers on `episodic_memory`.

**Query pattern**: `WHERE episodic_fts MATCH ${query}` — supports FTS5 syntax (`AND`, `OR`, `NOT`, `"phrase"`, `NEAR()`).

### Layer 3: Semantic Memory (`src/memory/semantic.ts`)

**Storage**: D1 database + Workers AI embeddings.
**Purpose**: Long-term facts, preferences, events, notes — searchable by meaning.
**Lifetime**: Permanent. Cross-session. The "knowledge base."

```typescript
class SemanticMemory {
  constructor(db: D1Database, ai: Ai, embeddingModel: string)

  async write(entry: { content: string; type: SemanticEntry["type"]; source: SemanticEntry["source"]; tags?: string[] }): Promise<string>  // Returns new UUID
  async search(query: string, limit?: number, typeFilter?: SemanticEntry["type"]): Promise<MemorySearchResult[]>
  async delete(id: string): Promise<boolean>
  async list(opts?: { type?: SemanticEntry["type"]; limit?: number }): Promise<SemanticEntry[]>
  async get(id: string): Promise<SemanticEntry | null>
}
```

**Write flow**:
1. Generate UUID for the memory
2. Generate embedding via Workers AI (`@cf/baai/bge-large-en-v1.5`)
3. Batch insert into `semantic_memories` and `memory_embeddings` tables

**Search flow**:
1. Generate embedding for the query text
2. Load ALL embeddings from D1 (fine for ~1000s of memories)
3. Compute cosine similarity between query embedding and each stored embedding
4. Sort by similarity descending, return top N
5. Filter by score > 0.5 threshold in the caller (`memory-context.ts`)

**Embedding storage**: `Float32Array` → `ArrayBuffer` → D1 `BLOB` column. Conversion helpers:
```typescript
function embeddingToBlob(embedding: number[]): ArrayBuffer {
  return new Float32Array(embedding).buffer;
}
function blobToEmbedding(blob: ArrayBuffer): number[] {
  return Array.from(new Float32Array(blob));
}
```

**Tags handling**: Tags are stored as JSON strings in D1 (`'["tag1","tag2"]'`). Parsed back to arrays on read with `typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags`.

### Layer 4: Procedural Memory (`src/memory/procedural.ts`)

**Storage**: DO SQLite (colocated).
**Purpose**: User-defined behavioral rules injected into every system prompt.
**Lifetime**: Permanent. Survives hibernation.

```typescript
class ProceduralMemory {
  constructor(sql: SqlFn)

  add(rule: string, source?: "user" | "system"): number  // Returns new ID
  getActive(): ProceduralRule[]
  getAll(): ProceduralRule[]           // Including inactive
  deactivate(id: number): boolean      // Soft delete
  update(id: number, rule: string): boolean
  delete(id: number): boolean          // Hard delete
  toPromptString(): string             // Formatted for system prompt
}
```

**Prompt injection format**:
```
## User Rules & Preferences
- Always respond in bullet points
- Never use emojis
- Prefer TypeScript examples over JavaScript
```

### Post-Turn Consolidation (`src/memory/consolidation.ts`)

**Purpose**: After every user-assistant exchange, automatically extract facts and save to semantic memory.

```typescript
async function consolidateTurn(
  ai: Ai,
  chatModel: string,
  semanticMemory: SemanticMemory,
  userMessage: string,
  assistantMessage: string
): Promise<ExtractedFact[]>
```

**Flow**:
1. Format the exchange as `"User: ...\nAssistant: ..."`
2. Send to LLM with extraction prompt requesting JSON output
3. Parse response (handles markdown code blocks)
4. For each extracted fact, call `semanticMemory.write()` with `source: "consolidated"`
5. Return extracted facts (or empty array on failure — non-critical)

**Extraction prompt** instructs the LLM to:
- Extract only concrete, specific facts (not vague statements)
- Make each fact self-contained
- Skip greetings, filler, meta-conversation
- Return JSON: `[{ "content": "...", "type": "fact|preference|event|note", "tags": ["..."] }]`
- Return `[]` if nothing worth extracting

**Error handling**: Wrapped in try/catch. Consolidation failures are logged but never block the response. Called with `.catch(() => {})` in the agent.

---

## 7. Embedding Pipeline

### Generation (`src/embeddings/generate.ts`)

```typescript
// Single embedding
async function generateEmbedding(ai: Ai, model: string, text: string): Promise<number[]>

// Batch embeddings
async function generateEmbeddings(ai: Ai, model: string, texts: string[]): Promise<number[][]>

// Text chunking for long content
function chunkText(text: string, chunkSize?: number, overlap?: number): string[]
```

**Model**: `@cf/baai/bge-large-en-v1.5` — produces 1024-dimensional vectors.

**Type casting**: The model parameter is `string` (from env var), cast to `any` for `ai.run()` because the typed overloads expect a specific model literal:
```typescript
const result = (await ai.run(model as any, { text: [text] })) as { data: number[][] };
```

**Chunking**: For long content (Phase 2 URL extraction), splits into ~350-word chunks with ~50-word overlap. Each chunk gets its own embedding, then averaged for document-level vector.

### Search (`src/embeddings/search.ts`)

```typescript
function cosineSimilarity(a: number[], b: number[]): number
```

Standard cosine similarity: `dot(a,b) / (||a|| * ||b||)`. Returns 0 if either vector has zero magnitude.

---

## 8. Agent Core

### CortexAgent (`src/agent/cortex-agent.ts`)

```typescript
export class CortexAgent extends AIChatAgent<Env> {
  // Private memory layer instances
  private workingMemory!: WorkingMemory;
  private episodicMemory!: EpisodicMemory;
  private semanticMemory!: SemanticMemory;
  private proceduralMemory!: ProceduralMemory;
  private initialized = false;

  // Lazy initialization (called on first message)
  private ensureInit(): void

  // Main message handler
  async onChatMessage(onFinish: StreamTextOnFinishCallback): Promise<Response>
}
```

### Initialization Flow (`ensureInit()`)

1. Run all DO SQLite DDL via `initDoSchemas(this.sql.bind(this))`
2. Create `WorkingMemory` with `this.name` as session ID (DO instance name)
3. Create `EpisodicMemory` with `this.sql.bind(this)`
4. Create `SemanticMemory` with `this.env.DB`, `this.env.AI`, `this.env.EMBEDDING_MODEL`
5. Create `ProceduralMemory` with `this.sql.bind(this)`
6. Set `this.initialized = true` (only runs once)

**Why `this.sql.bind(this)`**: The `sql` method on the Agent class accesses the DO's internal SQLite storage. When passing it to memory classes, it must be bound to preserve `this` context.

### Message Handling Flow (`onChatMessage()`)

1. **Extract user text** from `this.messages` (the AIChatAgent auto-populates this from WebSocket messages):
   ```typescript
   const lastUserMsg = [...this.messages].reverse().find((m) => m.role === "user");
   const userText = lastUserMsg?.parts
     ?.filter((p) => p.type === "text")
     .map((p) => p.text)
     .join(" ") ?? "";
   ```

2. **Retrieve memory context** — semantic search + episodic FTS:
   ```typescript
   const memoryContext = await retrieveMemoryContext(semanticMemory, episodicMemory, userText);
   ```

3. **Build system prompt** — core prompt + procedural rules + working memory + retrieved memories:
   ```typescript
   const systemPrompt = buildSystemPrompt(workingMemory, proceduralMemory, memoryContext);
   ```

4. **Create tools** — memory tools from the tool registry.

5. **Stream LLM response**:
   ```typescript
   const result = streamText({
     model: ai(this.env.CHAT_MODEL) as any,
     system: systemPrompt,
     messages: this.messages as any,
     tools,
     stopWhen: stepCountIs(5),     // Max 5 tool-use rounds
     onFinish: async (streamResult) => { ... },
   });
   return result.toUIMessageStreamResponse();
   ```

6. **Post-response** (in `onFinish` callback):
   - Log user turn and assistant turn to episodic memory
   - Update session metadata (turn count)
   - Fire-and-forget consolidation: extract facts → semantic memory

### Important: `as any` Casts

Two `as any` casts are required due to type mismatches:

1. **`ai(this.env.CHAT_MODEL) as any`**: `createWorkersAI` returns a model provider function that expects a specific model string literal. Our env var is `string`, not the exact literal type.

2. **`this.messages as any`**: `AIChatAgent.messages` is `UIMessage[]` but `streamText` expects `ModelMessage[]`. The AI SDK handles the conversion internally, but the types don't align at compile time.

### AIChatAgent Base Class API

```typescript
class AIChatAgent<Env> extends Agent<Env> {
  messages: UIMessage[];                    // Auto-loaded conversation history from DO SQLite
  maxPersistedMessages?: number;            // Cap persisted messages (default: unlimited)
  waitForMcpConnections?: boolean;          // Wait for MCP before onChatMessage

  onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions
  ): Promise<Response | undefined>;

  async persistMessages(messages: UIMessage[]): Promise<void>;
  async saveMessages(messages: UIMessage[]): Promise<void>;
}
```

- `this.messages` is pre-populated with the full conversation history when `onChatMessage` runs
- `this.name` is the DO instance name (used as session ID)
- `this.sql` is the tagged template SQL function for DO SQLite
- `this.env` has all Cloudflare bindings

---

## 9. Tool System

### Tool Definitions (`src/agent/tools/memory-tools.ts`)

All tools use AI SDK v6 `tool()` with `inputSchema` (NOT `parameters`).

#### `remember`
- **Description**: Save a fact, preference, or note to long-term memory
- **Input**: `{ content: string, type: "fact"|"preference"|"event"|"note" (default "fact"), tags: string[] (default []) }`
- **Action**: `semanticMemory.write()` + `workingMemory.addFact()`
- **Returns**: `{ success: true, id: string, message: string }`

#### `recall`
- **Description**: Search long-term memory for relevant information
- **Input**: `{ query: string, type?: "fact"|"preference"|"event"|"note"|"summary", limit: number (default 5) }`
- **Action**: `semanticMemory.search()`
- **Returns**: `{ found: boolean, count: number, memories: [{ content, type, relevance, tags, date }] }`

#### `forget`
- **Description**: Remove a specific memory by ID
- **Input**: `{ id: string }`
- **Action**: `semanticMemory.delete()`
- **Returns**: `{ success: boolean, message: string }`

#### `addRule`
- **Description**: Add a behavioral rule that Cortex always follows
- **Input**: `{ rule: string }`
- **Action**: `proceduralMemory.add(rule, "user")`
- **Returns**: `{ success: true, id: number, message: string }`

#### `listRules`
- **Description**: List all active behavioral rules
- **Input**: `{}`
- **Action**: `proceduralMemory.getActive()`
- **Returns**: `{ count: number, rules: [{ id, rule, source }] }`

#### `searchHistory`
- **Description**: Search past conversations by keyword
- **Input**: `{ query: string, limit: number (default 10) }`
- **Action**: `episodicMemory.search()` (FTS5)
- **Returns**: `{ found: boolean, count: number, results: [{ role, content, timestamp, sessionId }] }`

### Tool Registry (`src/agent/tools/index.ts`)

```typescript
export { createMemoryTools } from "./memory-tools";
// Phase 2: export { createResearchTools } from "./research-tools";
// Phase 3: export { createWatchTools } from "./watch-tools";
```

### Adding New Tools (for Phase 2/3/4)

1. Create new file in `src/agent/tools/` following the pattern in `memory-tools.ts`
2. Export a factory function that accepts dependencies and returns tool definitions
3. Add the export to `src/agent/tools/index.ts`
4. Import and spread the tools in `cortex-agent.ts`:
   ```typescript
   const tools = {
     ...createMemoryTools({ ... }),
     ...createResearchTools({ ... }),  // Phase 2
   };
   ```

---

## 10. Prompt Engineering

### System Prompt Construction (`src/agent/prompts/system.ts`)

```typescript
function buildSystemPrompt(
  workingMemory: WorkingMemory,
  proceduralMemory: ProceduralMemory,
  memoryContext: string
): string
```

**Assembly order** (each section separated by `\n\n`):

1. **Core prompt** — Identity, capabilities, behavior guidelines, tool usage instructions
2. **Procedural rules** — `## User Rules & Preferences\n- rule1\n- rule2` (from `proceduralMemory.toPromptString()`)
3. **Working memory** — `## Current Session Context\n` + user name, context, topics, recent facts
4. **Retrieved memories** — `## Relevant Memories\n` + semantic search results + episodic FTS results

### Pre-Response Memory Retrieval (`src/agent/prompts/memory-context.ts`)

```typescript
async function retrieveMemoryContext(
  semanticMemory: SemanticMemory,
  episodicMemory: EpisodicMemory,
  userMessage: string
): Promise<string>
```

**Steps**:
1. **Semantic search**: `semanticMemory.search(userMessage, 5)` → filter results with score > 0.5 → format as:
   ```
   ### Known Facts & Preferences
   - [fact] User's name is Jack (relevance: 87%)
   - [preference] Prefers TypeScript (relevance: 72%)
   ```

2. **Episodic FTS search**: Extract keywords from user message (remove stop words, take top 5) → `episodicMemory.search(keywords, 5)` → format as:
   ```
   ### Related Past Conversations
   - "I was working on the Cortex project and..." (2024-01-15T10:30:00Z)
   ```

**Keyword extraction**: Removes common English stop words (73 words), filters words < 3 chars, takes top 5 remaining words, joins with spaces for FTS5 query.

**Error handling**: Both searches are wrapped in try/catch. Failures are silently swallowed — memory context is enhancement, not requirement.

---

## 11. Chat UI

### React App (`src/app.tsx`)

```typescript
export function Chat() {
  const agent = useAgent({ agent: "CortexAgent" });
  const { messages, sendMessage, status } = useAgentChat({ agent });
  // ...
}
```

**Key behaviors**:
- `useAgent({ agent: "CortexAgent" })` — connects WebSocket to `/agents/CortexAgent/<instanceName>`
- `useAgentChat({ agent })` — manages chat state, handles streaming, persists messages
- `sendMessage({ text: input.value })` — v6 API requires `{ text }` object, NOT plain string
- `messages` — `UIMessage[]` with `.parts` array (NOT `.content`)
- `status` — `"idle" | "submitted" | "streaming" | "error"`
- Auto-scrolls on new messages via `useEffect` + `scrollIntoView`
- Shows typing indicator during streaming
- Renders tool invocations from `msg.parts.filter(p => p.type === "tool-invocation")`

### Styles (`src/styles.css`)

Dark theme with CSS custom properties. Uses Tailwind v4 via `@import "tailwindcss"`.

Key classes: `.app`, `.header`, `.messages`, `.message.user`, `.message.assistant`, `.input-area`, `.tool-call`, `.typing-indicator`.

### Entry Point (`src/main.tsx`)

```typescript
import React from "react";
import { createRoot } from "react-dom/client";
import { Chat } from "./app";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><Chat /></React.StrictMode>
);
```

### HTML (`index.html`)

Standard Vite entry HTML. `<div id="root">` mount point. Loads `src/main.tsx` as module.

---

## 12. Server & Routing

### Worker Entry Point (`src/server.ts`)

```typescript
export { CortexAgent } from "@/agent/cortex-agent";  // DO class export (required by wrangler)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Phase 2 stub: /discord/*
    // Phase 4 stub: /mcp/*

    // Route agent WebSocket + API requests
    const agentResponse = await routeAgentRequest(request, env, { cors: true });
    if (agentResponse) return agentResponse;

    return new Response("Not found", { status: 404 });
  },
};
```

**Critical**: `export { CortexAgent }` at the top level is REQUIRED. Wrangler needs to discover the DO class from the worker's exports.

### Routing

| Path | Handler | Status |
|------|---------|--------|
| `/agents/CortexAgent/<name>` | `routeAgentRequest()` → DO WebSocket | Phase 1 |
| `/discord/*` | Discord interaction handler | Phase 2 (stub) |
| `/mcp/*` | MCP server | Phase 4 (stub) |
| `/*` (other) | 404 (static assets via Vite plugin) | Phase 1 |

### `routeAgentRequest` Options

```typescript
routeAgentRequest(request, env, {
  cors: true,                    // Permissive CORS headers
  // props: { userId: "..." },   // Forwarded to agent
  // onBeforeConnect: async (req) => { ... },  // Gate WebSocket upgrades
  // onBeforeRequest: async (req) => { ... },  // Gate HTTP requests
});
```

---

## 13. Database Schemas

### DO SQLite Schemas (`src/memory/schemas.ts`)

Initialized via `initDoSchemas(sql)` — called once in `CortexAgent.ensureInit()`.

```sql
-- Episodic memory: full conversation turns
CREATE TABLE IF NOT EXISTS episodic_memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
  turn_index  INTEGER NOT NULL
);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
  content,
  content=episodic_memory,
  content_rowid=id
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS episodic_ai AFTER INSERT ON episodic_memory BEGIN
  INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS episodic_ad AFTER DELETE ON episodic_memory BEGIN
  INSERT INTO episodic_fts(episodic_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

-- Session tracking
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at    TEXT,
  topics      TEXT DEFAULT '[]',       -- JSON array
  turn_count  INTEGER DEFAULT 0,
  summary     TEXT
);

-- Procedural memory: behavioral rules
CREATE TABLE IF NOT EXISTS procedural_memory (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule        TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user', 'system')),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_episodic_session ON episodic_memory(session_id);
CREATE INDEX IF NOT EXISTS idx_episodic_timestamp ON episodic_memory(timestamp);
```

### D1 Migrations

**`migrations/0001_create_semantic_memories.sql`**:
```sql
CREATE TABLE IF NOT EXISTS semantic_memories (
  id         TEXT PRIMARY KEY,       -- UUID
  content    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('fact', 'preference', 'event', 'note', 'summary')),
  source     TEXT NOT NULL CHECK(source IN ('user', 'consolidated', 'research')),
  tags       TEXT NOT NULL DEFAULT '[]',  -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_semantic_type ON semantic_memories(type);
CREATE INDEX IF NOT EXISTS idx_semantic_source ON semantic_memories(source);
CREATE INDEX IF NOT EXISTS idx_semantic_created ON semantic_memories(created_at);
```

**`migrations/0002_create_embeddings.sql`**:
```sql
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES semantic_memories(id) ON DELETE CASCADE,
  embedding  BLOB NOT NULL,          -- Float32Array as ArrayBuffer
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**`migrations/0003_create_watchlists.sql`** (Phase 3):
```sql
CREATE TABLE IF NOT EXISTS watch_items (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  label        TEXT NOT NULL,
  frequency    TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('hourly', 'daily', 'weekly')),
  last_checked TEXT,
  last_hash    TEXT,                  -- SHA-256 for dedup
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS digest_entries (
  id            TEXT PRIMARY KEY,
  watch_item_id TEXT NOT NULL REFERENCES watch_items(id) ON DELETE CASCADE,
  summary       TEXT NOT NULL,
  changes       TEXT,
  delivered     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_digest_undelivered ON digest_entries(delivered, created_at);
```

---

## 14. Phase 1 Status (COMPLETE)

### What's Built

- 17 source files implementing the complete Phase 1 architecture
- 4-layer memory system (working, episodic, semantic, procedural)
- Post-turn consolidation (automatic fact extraction)
- 6 agent tools (remember, recall, forget, addRule, listRules, searchHistory)
- Dynamic system prompt with memory injection
- Pre-response memory retrieval (semantic + episodic)
- WebSocket chat UI with React 19
- Cloudflare Vite plugin integration
- D1 database created and migrations applied
- TypeScript: 0 errors
- Build: passes (both SSR worker bundle and client bundle)
- Dev server: starts and serves correctly

### What's NOT Built Yet

- Phase 2: Browser extraction, research tools, Discord bot
- Phase 3: Watch lists, scheduled crawler, digests, dashboard
- Phase 4: MCP server, export tools

---

## 15. Phase 2 Specification: Browser + Discord

### 15.1 Browser Extraction (`src/browser/extract.ts`)

**Dependencies**: `@cloudflare/puppeteer` (add to package.json)
**Binding**: `BROWSER` (add to wrangler.jsonc)

```typescript
interface ExtractedContent {
  url: string;
  title: string;
  description: string;
  content: string;           // Main text content
  publishedDate?: string;
  screenshotKey?: string;    // R2 key if screenshot taken
  rawKey?: string;           // R2 key for raw JSON archive
  extractedAt: string;
}

async function extractUrl(
  browser: Fetcher,          // BROWSER binding
  storage: R2Bucket,         // STORAGE binding
  url: string,
  options?: {
    screenshot?: boolean;
    archive?: boolean;
  }
): Promise<ExtractedContent>
```

**Implementation**:
1. Launch Puppeteer page via Browser Rendering binding
2. Navigate to URL, wait for network idle
3. Extract content priority: `article` > `main` > `body`
4. Extract `<title>`, `meta[name="description"]`, `meta[property="article:published_time"]`
5. Optional: screenshot → R2 (`screenshots/${hash}.png`)
6. Optional: raw JSON → R2 (`archives/${hash}.json`)
7. Close page, return `ExtractedContent`

**Content cleaning**: Strip `<script>`, `<style>`, `<nav>`, `<footer>`, `<header>` elements. Extract `textContent`. Collapse whitespace.

### 15.2 Embedding Pipeline Enhancement (`src/embeddings/generate.ts`)

The `chunkText()` function already exists. For Phase 2, add:

```typescript
async function embedDocument(
  ai: Ai,
  model: string,
  content: string
): Promise<{ chunks: string[]; embeddings: number[][]; avgEmbedding: number[] }>
```

- Chunk content into ~350-word pieces with 50-word overlap
- Batch-embed all chunks
- Compute average embedding for document-level similarity
- Return all chunks + embeddings + average

### 15.3 Research Tools (`src/agent/tools/research-tools.ts`)

```typescript
function createResearchTools(deps: {
  browser: Fetcher;
  storage: R2Bucket;
  semanticMemory: SemanticMemory;
  ai: Ai;
  chatModel: string;
  embeddingModel: string;
})
```

#### `readUrl`
- **Input**: `{ url: string, save?: boolean }`
- **Action**: Extract URL content via Puppeteer → summarize with LLM → optionally save to semantic memory
- **Returns**: `{ title, summary, content_preview, saved?: { id } }`

#### `research`
- **Input**: `{ urls: string[], topic: string }`
- **Action**: Extract all URLs → synthesize findings with LLM → save synthesis to semantic memory with `source: "research"`
- **Returns**: `{ synthesis, sources: [{ url, title, summary }], memory_id }`

### 15.4 Discord Bot

#### File: `src/discord/verify.ts`

```typescript
async function verifyDiscordRequest(
  request: Request,
  publicKey: string
): Promise<{ isValid: boolean; body: any }>
```

Uses Web Crypto API (`crypto.subtle.verify`) with Ed25519 to verify Discord interaction signatures.

#### File: `src/discord/commands.ts`

```typescript
const COMMANDS = [
  {
    name: "ask",
    description: "Ask Cortex a question",
    options: [{ name: "question", type: 3, required: true }],
  },
  {
    name: "remember",
    description: "Save something to Cortex's memory",
    options: [
      { name: "content", type: 3, required: true },
      { name: "type", type: 3, choices: [...] },
    ],
  },
  {
    name: "recall",
    description: "Search Cortex's memory",
    options: [{ name: "query", type: 3, required: true }],
  },
  {
    name: "research",
    description: "Research a URL",
    options: [{ name: "url", type: 3, required: true }],
  },
  {
    name: "digest",
    description: "Get your latest digest",
  },
];
```

#### File: `src/discord/index.ts`

```typescript
async function handleDiscordInteraction(
  request: Request,
  env: Env
): Promise<Response>
```

**Flow**:
1. Verify Ed25519 signature
2. Handle PING (type 1) → respond with PONG
3. Handle APPLICATION_COMMAND (type 2):
   - Respond with DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (type 5)
   - Process command in background via `ctx.waitUntil()`
   - Follow up with webhook: `PATCH /webhooks/{app_id}/{token}/messages/@original`

#### File: `src/discord/register.ts`

Script to register slash commands with Discord API. Run with `npx tsx src/discord/register.ts`.

```typescript
// PUT https://discord.com/api/v10/applications/{APP_ID}/commands
// Body: COMMANDS array
```

**Env vars needed** (add to wrangler.jsonc vars or `.dev.vars`):
```
DISCORD_PUBLIC_KEY=...
DISCORD_APP_ID=...
DISCORD_BOT_TOKEN=...
```

### 15.5 Server Routing Update

```typescript
// In src/server.ts
if (url.pathname.startsWith("/discord")) {
  return handleDiscordInteraction(request, env);
}
```

### 15.6 Wrangler Config Updates

```jsonc
// Add to wrangler.jsonc:
"browser": {
  "binding": "BROWSER"
}
```

Add to Env interface:
```typescript
BROWSER: Fetcher;
DISCORD_PUBLIC_KEY: string;
DISCORD_APP_ID: string;
DISCORD_BOT_TOKEN: string;
```

### 15.7 Phase 2 Verification Checklist

- [ ] Pass a URL to Cortex chat → verify content extracted and summarized
- [ ] `readUrl` tool saves to memory → verify with `recall`
- [ ] `research` tool with multiple URLs → verify synthesis quality
- [ ] Discord `/ask` command → verify response within 3 seconds
- [ ] Discord `/remember` → verify fact appears in subsequent `/recall`
- [ ] Screenshot + archive stored in R2

---

## 16. Phase 3 Specification: Proactive Intelligence

### 16.1 Watch List Manager (`src/monitor/watchlist.ts`)

```typescript
class WatchListManager {
  constructor(private db: D1Database)

  async add(item: { url: string; label: string; frequency: "hourly" | "daily" | "weekly" }): Promise<string>
  async remove(id: string): Promise<boolean>
  async list(activeOnly?: boolean): Promise<WatchItem[]>
  async get(id: string): Promise<WatchItem | null>
  async getDueItems(): Promise<WatchItem[]>    // Items needing a check based on frequency + last_checked
  async updateLastChecked(id: string, hash: string): Promise<void>
}
```

**`getDueItems()` logic**:
```sql
SELECT * FROM watch_items
WHERE active = 1
AND (
  last_checked IS NULL
  OR (frequency = 'hourly' AND last_checked < datetime('now', '-1 hour'))
  OR (frequency = 'daily' AND last_checked < datetime('now', '-1 day'))
  OR (frequency = 'weekly' AND last_checked < datetime('now', '-7 days'))
)
```

### 16.2 Scheduled Crawler (`src/monitor/crawler.ts`)

```typescript
async function runMonitoringCycle(env: Env): Promise<{
  checked: number;
  changed: number;
  errors: number;
}>
```

**Flow**:
1. `watchList.getDueItems()` → get items needing check
2. For each item:
   a. `extractUrl(env.BROWSER, env.STORAGE, item.url)`
   b. Compute SHA-256 hash of extracted content
   c. If hash !== `item.last_hash` (content changed):
      - Summarize changes with LLM
      - Insert `digest_entries` row with summary
   d. Update `last_checked` and `last_hash`
3. Return stats

**Wire to scheduled handler** in `src/server.ts`:
```typescript
export default {
  async fetch(request, env) { ... },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runMonitoringCycle(env));
  },
};
```

### 16.3 Digest Generation (`src/monitor/digest.ts`)

```typescript
class DigestManager {
  constructor(private db: D1Database)

  async getUndelivered(): Promise<DigestEntry[]>
  async getByWatchItem(watchItemId: string): Promise<DigestEntry[]>
  async markDelivered(ids: string[]): Promise<void>
  async generateDigest(ai: Ai, chatModel: string): Promise<string>  // AI-formatted digest
}
```

**`generateDigest()`**: Groups undelivered entries by watch item, sends to LLM for formatting, returns markdown digest.

### 16.4 Watch Tools (`src/agent/tools/watch-tools.ts`)

```typescript
function createWatchTools(deps: {
  watchList: WatchListManager;
  digestManager: DigestManager;
})
```

#### `watchAdd`
- **Input**: `{ url: string, label: string, frequency: "hourly"|"daily"|"weekly" }`
- **Action**: `watchList.add()`
- **Returns**: `{ success: true, id, message }`

#### `watchList`
- **Input**: `{}`
- **Action**: `watchList.list()`
- **Returns**: `{ count, items: [{ id, url, label, frequency, lastChecked }] }`

#### `watchRemove`
- **Input**: `{ id: string }`
- **Action**: `watchList.remove()`
- **Returns**: `{ success, message }`

#### `getDigest`
- **Input**: `{}`
- **Action**: `digestManager.generateDigest()` + `digestManager.markDelivered()`
- **Returns**: `{ hasUpdates, digest }`

### 16.5 Proactive Surfacing

In `cortex-agent.ts`, add to `onChatMessage()` after memory retrieval:

```typescript
// Check for relevant digest entries
const undelivered = await digestManager.getUndelivered();
if (undelivered.length > 0) {
  const relevant = undelivered.filter(entry =>
    workingMemory.getState().topics.some(topic =>
      entry.summary.toLowerCase().includes(topic.toLowerCase())
    )
  );
  if (relevant.length > 0) {
    memoryContext += "\n\n### New Updates\n" +
      relevant.map(e => `- ${e.summary}`).join("\n");
  }
}
```

### 16.6 Knowledge Graph Dashboard (`src/dashboard/`)

**Framework**: React + Tailwind + D3.js force-directed graph

**Components**:

#### `src/dashboard/app.tsx`
Main dashboard app with tabs: Knowledge Graph, Memory Explorer, Watch List, History.

#### `src/dashboard/components/KnowledgeGraph.tsx`
- D3.js force-directed graph
- Nodes = semantic memories (colored by type: fact/preference/event/note/summary)
- Edges = tag-based connections (memories sharing tags are linked)
- Click node → show full memory content
- Search/filter by type, tags, date range

#### `src/dashboard/components/MemoryExplorer.tsx`
- List/grid view of all semantic memories
- Search bar with real-time filtering
- Type/source filter chips
- Delete/edit actions
- Pagination

#### `src/dashboard/components/WatchList.tsx`
- CRUD interface for watch items
- Status indicators (last checked, next check)
- Digest preview
- Enable/disable toggle

#### `src/dashboard/components/SessionHistory.tsx`
- List of all sessions with timestamps
- Click to expand full conversation
- Search across sessions (FTS5)

**API routes** (add to `src/server.ts`):
```typescript
// Proxy API calls to the DO
if (url.pathname.startsWith("/api/")) {
  const doId = env.CortexAgent.idFromName("default");
  const stub = env.CortexAgent.get(doId);
  return stub.fetch(request);
}
```

**DO RPC methods** (add to `cortex-agent.ts`):
```typescript
// These methods are called via HTTP, not WebSocket
async handleApiRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/api/memories": return this.apiListMemories(url);
    case "/api/memories/search": return this.apiSearchMemories(url);
    case "/api/sessions": return this.apiListSessions();
    case "/api/rules": return this.apiListRules();
    case "/api/watchlist": return this.apiWatchList(request);
    case "/api/digest": return this.apiGetDigest();
  }
}
```

### 16.7 Wrangler Config Updates

```jsonc
// Add cron trigger:
"triggers": {
  "crons": ["0 */6 * * *"]    // Every 6 hours
}
```

### 16.8 Phase 3 Verification Checklist

- [ ] Add a watch item via chat: "Watch https://example.com/blog daily"
- [ ] Wait for cron cycle (or trigger manually) → verify digest appears
- [ ] `getDigest` tool returns formatted update summary
- [ ] Open dashboard → knowledge graph renders with real memories
- [ ] Memory explorer: search, filter by type, delete a memory
- [ ] Watch list UI: add, remove, toggle active
- [ ] Session history: browse past conversations, search by keyword
- [ ] Proactive surfacing: discuss a topic → add watch item for same topic → verify Cortex surfaces new findings

---

## 17. Phase 4 Specification: MCP + Export

### 17.1 MCP Server (`src/mcp/index.ts`)

**Dependencies**: `@modelcontextprotocol/sdk` (add to package.json)

```typescript
import { createMcpHandler } from "agents/mcp";  // or @cloudflare/agents

const mcpHandler = createMcpHandler({
  tools: {
    remember: {
      description: "Save a fact to Cortex's memory",
      inputSchema: z.object({
        content: z.string(),
        type: z.enum(["fact", "preference", "event", "note"]).default("fact"),
        tags: z.array(z.string()).default([]),
      }),
      handler: async (input, env) => {
        const semanticMemory = new SemanticMemory(env.DB, env.AI, env.EMBEDDING_MODEL);
        const id = await semanticMemory.write({ ...input, source: "user" });
        return { id, message: `Remembered: "${input.content}"` };
      },
    },
    recall: {
      description: "Search Cortex's memory",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().default(5),
      }),
      handler: async (input, env) => {
        const semanticMemory = new SemanticMemory(env.DB, env.AI, env.EMBEDDING_MODEL);
        return semanticMemory.search(input.query, input.limit);
      },
    },
    research_url: {
      description: "Extract and summarize a URL, save to memory",
      inputSchema: z.object({ url: z.string() }),
      handler: async (input, env) => {
        // Use browser extraction + summarize + save
      },
    },
  },
});
```

**Wire to server.ts**:
```typescript
if (url.pathname.startsWith("/mcp")) {
  return mcpHandler(request, env);
}
```

**Claude Desktop config** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "cortex": {
      "url": "https://cortex.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

### 17.2 Export Tools (`src/agent/tools/export-tools.ts`)

#### `exportMarkdown`
- **Input**: `{ format: "obsidian" | "plain" }`
- **Action**: Query all semantic memories → format as markdown files → create zip → upload to R2
- **Obsidian format**: One file per memory type (`Facts.md`, `Preferences.md`, etc.), with YAML frontmatter (tags, date, source)
- **Returns**: `{ key: string, url: string, count: number }`

#### `exportJson`
- **Input**: `{}`
- **Action**: Full knowledge base dump → JSON → R2
- **Returns**: `{ key: string, url: string, stats: { memories, rules, sessions } }`

**Download endpoint** (add to server.ts):
```typescript
if (url.pathname.startsWith("/api/export/")) {
  const key = url.pathname.replace("/api/export/", "");
  const object = await env.STORAGE.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: { "Content-Type": object.httpMetadata?.contentType || "application/octet-stream" },
  });
}
```

### 17.3 Shared Workspaces (Future)

- Multi-user memory spaces with attribution
- Separate DO instance per workspace: `env.CortexAgent.idFromName(workspaceId)`
- Each user's contributions tagged with their identity
- Shared procedural rules with voting/approval
- Access control via workspace membership

---

## 18. Critical Implementation Notes

### Gotchas Discovered During Phase 1

1. **DO binding name = class name**: `routeAgentRequest()` matches by binding name, not class_name. If they differ, WebSocket routing silently fails with no error.

2. **AI binding always remote**: Even in `wrangler dev --local`, Workers AI calls go to Cloudflare's API. Local dev requires internet + valid auth.

3. **`this.sql.bind(this)` required**: When passing the DO's `sql` tagged template function to other classes, you MUST bind it or `this` context is lost and queries fail silently.

4. **FTS5 `CREATE VIRTUAL TABLE IF NOT EXISTS`**: This is safe to call multiple times. The FTS5 triggers also use `IF NOT EXISTS`.

5. **`Float32Array.buffer` for D1 BLOB**: D1 stores embeddings as `BLOB`. Convert with `new Float32Array(embedding).buffer` on write, `new Float32Array(blob)` on read.

6. **Tags stored as JSON string**: D1 stores tags as `'["tag1","tag2"]'`. Always check `typeof tags === "string"` before `JSON.parse()` on read.

7. **Consolidation is fire-and-forget**: Called with `.catch(() => {})` — never blocks the response. If the LLM fails to extract facts, that's fine.

8. **`UIMessage.parts` vs `UIMessage.content`**: AI SDK v6 uses `parts` array. `content` no longer exists. Filter by `p.type === "text"` for text, `p.type === "tool-invocation"` for tools.

9. **`sendMessage({ text })` not `sendMessage(string)`**: v6 changed the API. Plain strings no longer work.

10. **`@cloudflare/vite-plugin` replaces `assets` config**: When using the Vite plugin, remove the `assets` block from wrangler.jsonc. The plugin handles static file serving.

### Performance Considerations

- **Semantic search loads all embeddings**: Fine for ~1000s. At ~10K+, migrate to Cloudflare Vectorize or add pagination.
- **Consolidation adds latency**: The AI extraction call happens after response streaming completes (in `onFinish`), so it doesn't block the user.
- **FTS5 search is fast**: DO SQLite FTS5 handles thousands of conversation turns without issue.
- **DO hibernation**: The `AIChatAgent` supports hibernatable WebSockets. Memory layers are re-initialized on wake via `ensureInit()`.

### Security Considerations

- **No auth yet**: Phase 1 has no authentication. Anyone with the URL can access the agent. Add auth in Phase 2 via `onBeforeConnect` in `routeAgentRequest`.
- **Discord signature verification**: Phase 2 MUST verify Ed25519 signatures on every interaction request.
- **SQL injection safe**: DO SQLite uses tagged template literals (parameterized). D1 uses `.prepare().bind()` (parameterized). No string concatenation.
- **XSS safe**: React auto-escapes content in JSX. Tool results are `JSON.stringify()`'d.

---

## 19. Development Workflow

### Commands

```bash
# Start dev server (Vite + Wrangler, hot reload)
npm run dev

# Build for production
npm run build

# Preview production build locally
npm run preview

# Apply D1 migrations locally
npm run db:migrate:local

# Apply D1 migrations to production
npm run db:migrate:remote

# Deploy to Cloudflare
npm run deploy

# TypeScript type checking
npx tsc --noEmit

# Run tests
npm test

# Generate Cloudflare types
npm run cf-typegen
```

### Local Dev Architecture

```
Browser (localhost:5173)
    │
    ├── Vite Dev Server (HMR for React UI)
    │
    └── Cloudflare Vite Plugin
          └── Miniflare (local Workers runtime)
                ├── CortexAgent DO (local SQLite)
                ├── D1 (local SQLite in .wrangler/)
                ├── R2 (local filesystem in .wrangler/)
                └── AI (REMOTE — connects to Cloudflare API)
```

### Adding New D1 Migrations

1. Create `migrations/NNNN_description.sql`
2. Run `npm run db:migrate:local` to apply locally
3. Test
4. Run `npm run db:migrate:remote` before deploying

### Adding New DO Schema Changes

1. Update DDL in `src/memory/schemas.ts`
2. All DDL uses `IF NOT EXISTS` — safe to re-run
3. For destructive changes, add a new migration tag in wrangler.jsonc

---

## 20. Testing Strategy

### Unit Tests (Vitest)

```typescript
// test/memory/working.test.ts
import { WorkingMemory } from "@/memory/working";

describe("WorkingMemory", () => {
  it("tracks topics without duplicates", () => {
    const wm = new WorkingMemory("test-session");
    wm.addTopic("AI");
    wm.addTopic("AI");
    expect(wm.getState().topics).toEqual(["AI"]);
  });

  it("keeps last 20 facts", () => {
    const wm = new WorkingMemory("test-session");
    for (let i = 0; i < 25; i++) wm.addFact(`fact-${i}`);
    expect(wm.getState().recentFacts).toHaveLength(20);
    expect(wm.getState().recentFacts[0]).toBe("fact-5");
  });
});
```

### Integration Tests

Use `wrangler dev` + `unstable_dev` API for testing against local Workers runtime with real D1/DO.

### Test Matrix

| Component | Test Type | What to Verify |
|-----------|-----------|---------------|
| WorkingMemory | Unit | Topic dedup, fact cap at 20, context string format |
| EpisodicMemory | Integration | logTurn + getSession roundtrip, FTS search accuracy |
| SemanticMemory | Integration | write + search roundtrip, cosine similarity ranking |
| ProceduralMemory | Integration | add + getActive, deactivate, toPromptString format |
| Consolidation | Integration | Fact extraction from known conversation, empty extraction |
| CosimeSimilarity | Unit | Known vectors, zero vectors, identical vectors |
| ChunkText | Unit | Short text (no chunking), long text (correct overlap) |
| ExtractKeywords | Unit | Stop word removal, length filter, max 5 keywords |
| BuildSystemPrompt | Unit | All sections present, empty sections omitted |
| Memory Tools | Integration | Each tool's happy path + error cases |

---

## 21. Deployment

### First Deploy

```bash
# 1. Create Cloudflare resources
wrangler d1 create cortex-db          # Already done: 2839c0c7-...
wrangler r2 bucket create cortex-storage

# 2. Apply remote migrations
npm run db:migrate:remote

# 3. Build and deploy
npm run deploy
```

### Production URL

After deploy: `https://cortex.<your-subdomain>.workers.dev`

### Environment Variables for Production

Set secrets via wrangler (Phase 2+):
```bash
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_APP_ID
wrangler secret put DISCORD_BOT_TOKEN
```

### Cost Estimate (~$5/month for personal use)

| Resource | Free Tier | Estimated Usage | Cost |
|----------|-----------|----------------|------|
| Workers | 100K req/day | ~1K req/day | $0 |
| Durable Objects | 1M requests/month | ~10K/month | ~$0 |
| D1 | 5M reads, 100K writes/month | ~50K reads, ~5K writes | $0 |
| R2 | 10GB storage, 10M reads | ~100MB, ~1K reads | $0 |
| Workers AI | Pay-per-use | ~1000 inferences/month | ~$2-5 |
| Browser Rendering | 2 min/day free | ~1 min/day | $0 |

---

## Appendix: File Dependency Graph

```
server.ts
  └── cortex-agent.ts
        ├── memory/schemas.ts ──► shared/types.ts (SqlFn)
        ├── memory/working.ts ──► shared/types.ts (WorkingMemoryState)
        ├── memory/episodic.ts ──► shared/types.ts (EpisodicEntry, SessionSummary, SqlFn)
        ├── memory/semantic.ts ──► shared/types.ts (SemanticEntry, MemorySearchResult)
        │     └── embeddings/generate.ts
        │     └── embeddings/search.ts
        ├── memory/procedural.ts ──► shared/types.ts (ProceduralRule, SqlFn)
        ├── memory/consolidation.ts ──► memory/semantic.ts
        ├── prompts/system.ts ──► memory/procedural.ts, memory/working.ts
        ├── prompts/memory-context.ts ──► memory/semantic.ts, memory/episodic.ts
        └── tools/memory-tools.ts ──► memory/* (all layers)

app.tsx ──► agents/react (useAgent), @cloudflare/ai-chat/react (useAgentChat)
main.tsx ──► app.tsx
```
