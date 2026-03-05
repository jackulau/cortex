import type { SemanticEntry, MemorySearchResult } from "@/shared/types";
import { generateEmbedding } from "@/embeddings/generate";
import { cosineSimilarity } from "@/embeddings/search";

/**
 * Semantic memory — long-term knowledge stored in D1 with vector embeddings.
 * Facts, preferences, events, notes, and summaries that persist across sessions.
 */
export class SemanticMemory {
  constructor(
    private db: D1Database,
    private ai: Ai,
    private embeddingModel: string
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

    // Store memory + embedding in a batch
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
    return id;
  }

  /** Semantic similarity search using cosine distance. */
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

    // Load all embeddings (fine for personal use with ~1000s of memories)
    let sql = `SELECT m.*, e.embedding
      FROM semantic_memories m
      JOIN memory_embeddings e ON m.id = e.memory_id`;
    const params: string[] = [];

    if (typeFilter) {
      sql += ` WHERE m.type = ?`;
      params.push(typeFilter);
    }

    const stmt = params.length
      ? this.db.prepare(sql).bind(...params)
      : this.db.prepare(sql);

    const { results } = await stmt.all<SemanticEntry & { embedding: ArrayBuffer }>();
    if (!results?.length) return [];

    // Compute similarities
    const scored = results.map((row) => ({
      entry: {
        id: row.id,
        content: row.content,
        type: row.type,
        source: row.source,
        tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      } as SemanticEntry,
      score: cosineSimilarity(queryEmbedding, blobToEmbedding(row.embedding)),
      matchType: "semantic" as const,
    }));

    // Sort by similarity descending, return top N
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /** Delete a memory by ID. */
  async delete(id: string): Promise<boolean> {
    // Embedding is cascade-deleted
    const result = await this.db
      .prepare(`DELETE FROM semantic_memories WHERE id = ?`)
      .bind(id)
      .run();
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
