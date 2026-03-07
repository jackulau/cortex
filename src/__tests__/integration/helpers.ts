/**
 * Shared helpers for integration tests.
 *
 * Provides:
 * - D1 table creation (semantic_memories, memory_embeddings, watch_items, digest_entries)
 * - Mock Vectorize adapter backed by in-memory cosine similarity
 * - Mock AI adapter for embedding generation and chat completions
 */

// ── D1 Schema Setup ──────────────────────────────────────────────

/** Create all D1 tables required by integration tests. */
export async function setupD1Tables(db: D1Database): Promise<void> {
  // Enable foreign key enforcement for cascade deletes
  await db.prepare("PRAGMA foreign_keys = ON").run();

  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS semantic_memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('fact', 'preference', 'event', 'note', 'summary')),
        source TEXT NOT NULL CHECK(source IN ('user', 'consolidated', 'research')),
        tags TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES semantic_memories(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS watch_items (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        label TEXT NOT NULL,
        frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('hourly', 'daily', 'weekly')),
        last_checked TEXT,
        last_hash TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS digest_entries (
        id TEXT PRIMARY KEY,
        watch_item_id TEXT NOT NULL REFERENCES watch_items(id),
        summary TEXT NOT NULL,
        changes TEXT,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `),
  ]);
}

/** Drop all test tables (for cleanup). */
export async function teardownD1Tables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`DROP TABLE IF EXISTS memory_embeddings`),
    db.prepare(`DROP TABLE IF EXISTS semantic_memories`),
    db.prepare(`DROP TABLE IF EXISTS digest_entries`),
    db.prepare(`DROP TABLE IF EXISTS watch_items`),
  ]);
}

// ── Mock Vectorize (in-memory cosine similarity) ─────────────────

interface StoredVector {
  id: string;
  values: number[];
  metadata?: Record<string, string>;
}

/**
 * In-memory Vectorize mock that uses cosine similarity for ANN search.
 * Used in integration tests since Miniflare does not support Vectorize.
 */
export function createMockVectorize(): VectorizeIndex {
  const vectors: Map<string, StoredVector> = new Map();

  return {
    async upsert(entries: VectorizeVector[]) {
      for (const entry of entries) {
        vectors.set(entry.id, {
          id: entry.id,
          values: Array.from(entry.values),
          metadata: entry.metadata as Record<string, string> | undefined,
        });
      }
      return { count: entries.length } as VectorizeMutationResult;
    },

    async query(queryVector: number[] | Float32Array, options?: VectorizeQueryOptions) {
      const queryArr = Array.from(queryVector);
      const topK = options?.topK ?? 5;

      let candidates = Array.from(vectors.values());

      // Apply metadata filter if provided
      if (options?.filter) {
        const filterEntries = Object.entries(options.filter);
        candidates = candidates.filter((v) =>
          filterEntries.every(
            ([key, value]) => v.metadata?.[key] === value
          )
        );
      }

      // Score by cosine similarity
      const scored = candidates.map((v) => ({
        id: v.id,
        score: cosineSimilarity(queryArr, v.values),
      }));

      // Sort descending by score, take topK
      scored.sort((a, b) => b.score - a.score);
      const matches = scored.slice(0, topK).map((s) => ({
        id: s.id,
        score: s.score,
      }));

      return { matches, count: matches.length } as VectorizeMatches;
    },

    async deleteByIds(ids: string[]) {
      for (const id of ids) {
        vectors.delete(id);
      }
      return { count: ids.length } as VectorizeMutationResult;
    },

    async getByIds(ids: string[]) {
      const found = ids
        .filter((id) => vectors.has(id))
        .map((id) => vectors.get(id)!);
      return found as unknown as VectorizeVector[];
    },

    async describe() {
      return {
        name: "mock-index",
        dimensions: 384,
        metric: "cosine",
        vectorCount: vectors.size,
      } as unknown as VectorizeIndexDetails;
    },

    async insert(entries: VectorizeVector[]) {
      for (const entry of entries) {
        if (!vectors.has(entry.id)) {
          vectors.set(entry.id, {
            id: entry.id,
            values: Array.from(entry.values),
            metadata: entry.metadata as Record<string, string> | undefined,
          });
        }
      }
      return { count: entries.length } as VectorizeMutationResult;
    },
  } as unknown as VectorizeIndex;
}

// ── Mock AI (embedding + chat) ───────────────────────────────────

const MOCK_EMBEDDING_DIM = 384;

/**
 * Create a deterministic mock embedding from text.
 * Same text always produces the same embedding, enabling meaningful similarity tests.
 */
function textToMockEmbedding(text: string): number[] {
  const embedding = new Array<number>(MOCK_EMBEDDING_DIM).fill(0);
  for (let i = 0; i < text.length; i++) {
    embedding[i % MOCK_EMBEDDING_DIM] += text.charCodeAt(i) / 1000;
  }
  // Normalize
  const magnitude = Math.sqrt(
    embedding.reduce((sum, v) => sum + v * v, 0)
  );
  if (magnitude > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= magnitude;
    }
  }
  return embedding;
}

/**
 * Mock AI binding for integration tests.
 * Handles embedding model calls and chat model calls.
 */
export function createMockAi(
  chatResponses?: Map<string, string>
): Ai {
  return {
    async run(model: string, input: unknown) {
      const inp = input as Record<string, unknown>;

      // Embedding model: input has { text: string[] }
      if (inp.text && Array.isArray(inp.text)) {
        return {
          data: (inp.text as string[]).map((t: string) =>
            textToMockEmbedding(t)
          ),
        };
      }

      // Chat model: input has { messages: [...] }
      if (inp.messages && Array.isArray(inp.messages)) {
        const userMsg = (
          inp.messages as Array<{ role: string; content: string }>
        )
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join(" ");

        // Check for custom response
        if (chatResponses) {
          for (const [key, value] of chatResponses) {
            if (userMsg.includes(key)) {
              return { response: value };
            }
          }
        }

        // Default: return empty extraction for consolidation prompts
        return { response: "[]" };
      }

      return {};
    },
  } as unknown as Ai;
}

// ── Math Helpers ─────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
