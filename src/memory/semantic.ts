import type { SemanticEntry, MemorySearchResult } from "@/shared/types";
import { generateEmbedding } from "@/embeddings/generate";

/**
 * Semantic memory — long-term knowledge stored in D1 with vector embeddings.
 * D1 is the source of truth for metadata; Vectorize provides fast ANN search.
 */
export class SemanticMemory {
  constructor(
    private db: D1Database,
    private ai: Ai,
    private embeddingModel: string,
    private vectorize: VectorizeIndex
  ) {}

  /** Write a new memory with auto-generated embedding. */
  async write(entry: {
    content: string;
    type: SemanticEntry["type"];
    source: SemanticEntry["source"];
    tags?: string[];
  }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const tags = JSON.stringify(entry.tags ?? []);

    // Generate embedding
    const embedding = await generateEmbedding(
      this.ai,
      this.embeddingModel,
      entry.content
    );

    // Store memory + embedding in D1 (source of truth)
    const stmts = [
      this.db
        .prepare(
          `INSERT INTO semantic_memories (id, content, type, source, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, entry.content, entry.type, entry.source, tags, now, now),
      this.db
        .prepare(
          `INSERT INTO memory_embeddings (memory_id, embedding, created_at)
         VALUES (?, ?, ?)`
        )
        .bind(id, embeddingToBlob(embedding), now),
    ];

    await this.db.batch(stmts);

    // Dual-write: insert vector into Vectorize for ANN search
    await this.vectorize.upsert([
      { id, values: embedding, metadata: { type: entry.type } },
    ]);

    return id;
  }

  /** Semantic similarity search using Vectorize ANN. */
  async search(
    query: string,
    limit = 5,
    typeFilter?: SemanticEntry["type"]
  ): Promise<MemorySearchResult[]> {
    const queryEmbedding = await generateEmbedding(
      this.ai,
      this.embeddingModel,
      query
    );

    // Query Vectorize for approximate nearest neighbors
    const vectorResults = await this.vectorize.query(queryEmbedding, {
      topK: limit,
      filter: typeFilter ? { type: typeFilter } : undefined,
    });

    if (!vectorResults.matches?.length) return [];

    // Fetch metadata from D1 for matched IDs
    const ids = vectorResults.matches.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(`SELECT * FROM semantic_memories WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all<SemanticEntry>();

    if (!results?.length) return [];

    // Build a lookup map for D1 rows
    const rowMap = new Map(results.map((r) => [r.id, r]));

    // Build scored results preserving Vectorize ranking
    const scored: MemorySearchResult[] = [];
    for (const match of vectorResults.matches) {
      const row = rowMap.get(match.id);
      if (!row) continue;
      scored.push({
        entry: {
          id: row.id,
          content: row.content,
          type: row.type,
          source: row.source,
          tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        } as SemanticEntry,
        score: match.score ?? 0,
        matchType: "semantic" as const,
      });
    }

    return scored;
  }

  /** Delete a memory by ID from both D1 and Vectorize. */
  async delete(id: string): Promise<boolean> {
    // Delete from D1 (embedding is cascade-deleted)
    const result = await this.db
      .prepare(`DELETE FROM semantic_memories WHERE id = ?`)
      .bind(id)
      .run();

    // Delete from Vectorize
    await this.vectorize.deleteByIds([id]);

    return (result.meta?.changes ?? 0) > 0;
  }

  /** List all memories, optionally filtered. */
  async list(
    opts: { type?: SemanticEntry["type"]; limit?: number } = {}
  ): Promise<SemanticEntry[]> {
    let sql = `SELECT * FROM semantic_memories`;
    const params: (string | number)[] = [];

    if (opts.type) {
      sql += ` WHERE type = ?`;
      params.push(opts.type);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(opts.limit ?? 50);

    const stmt = this.db.prepare(sql).bind(...params);
    const { results } = await stmt.all<SemanticEntry>();
    return (results ?? []).map((r) => ({
      ...r,
      tags: typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags,
    }));
  }

  /** Get a single memory by ID. */
  async get(id: string): Promise<SemanticEntry | null> {
    const row = await this.db
      .prepare(`SELECT * FROM semantic_memories WHERE id = ?`)
      .bind(id)
      .first<SemanticEntry>();
    if (!row) return null;
    return {
      ...row,
      tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────

function embeddingToBlob(embedding: number[]): ArrayBuffer {
  return new Float32Array(embedding).buffer;
}

function blobToEmbedding(blob: ArrayBuffer): number[] {
  return Array.from(new Float32Array(blob));
}
