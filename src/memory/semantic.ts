import type {
  SemanticEntry,
  MemorySearchResult,
  PaginatedResponse,
} from "@/shared/types";
import { DEFAULT_NAMESPACE_ID } from "@/shared/types";
import { generateEmbedding } from "@/embeddings/generate";

/**
 * Semantic memory — long-term knowledge stored in D1 with vector embeddings.
 * D1 is the source of truth for metadata; Vectorize provides fast ANN search.
 *
 * All operations are scoped to a namespace for multi-tenant isolation.
 */
export class SemanticMemory {
  constructor(
    private db: D1Database,
    private ai: Ai,
    private embeddingModel: string,
    private vectorize: VectorizeIndex,
    private namespaceId: string = DEFAULT_NAMESPACE_ID
  ) {}

  /** Write a new memory with auto-generated embedding. Returns null if a near-duplicate exists. */
  async write(entry: {
    content: string;
    type: SemanticEntry["type"];
    source: SemanticEntry["source"];
    tags?: string[];
  }): Promise<string | null> {
    // Check for near-duplicates before writing
    const existing = await this.search(entry.content, 3, entry.type);
    const duplicate = existing.find((r) => r.score > 0.92);
    if (duplicate) {
      // Update the existing memory's timestamp instead of creating a new one
      await this.touch(duplicate.entry.id);
      return null;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const tags = JSON.stringify(entry.tags ?? []);

    // Generate embedding
    const embedding = await generateEmbedding(
      this.ai,
      this.embeddingModel,
      entry.content
    );

    // Store memory metadata in D1 (source of truth)
    await this.db
      .prepare(
        `INSERT INTO semantic_memories (id, content, type, source, tags, created_at, updated_at, relevance_score, last_accessed_at, access_count, namespace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, NULL, 0, ?)`
      )
      .bind(id, entry.content, entry.type, entry.source, tags, now, now, this.namespaceId)
      .run();

    // Insert vector into Vectorize for ANN search with namespace metadata
    await this.vectorize.upsert([
      { id, values: embedding, metadata: { type: entry.type, namespace_id: this.namespaceId } },
    ]);

    return id;
  }

  /** Update the timestamp and relevance tracking of an existing memory. */
  async touch(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `UPDATE semantic_memories
         SET updated_at = ?,
             last_accessed_at = ?,
             access_count = access_count + 1,
             relevance_score = MIN(relevance_score + 0.1, 2.0)
         WHERE id = ? AND namespace_id = ?`
      )
      .bind(now, now, id, this.namespaceId)
      .run();
  }

  /** Update memory content, re-generate embedding, and sync D1 + Vectorize. */
  async update(
    id: string,
    content: string,
    tags?: string[]
  ): Promise<boolean> {
    const now = new Date().toISOString();

    // Re-generate embedding for updated content
    const embedding = await generateEmbedding(
      this.ai,
      this.embeddingModel,
      content
    );

    // Update D1 row metadata (scoped to namespace)
    const stmt = tags !== undefined
      ? this.db
          .prepare(
            `UPDATE semantic_memories SET content = ?, tags = ?, updated_at = ? WHERE id = ? AND namespace_id = ?`
          )
          .bind(content, JSON.stringify(tags), now, id, this.namespaceId)
      : this.db
          .prepare(
            `UPDATE semantic_memories SET content = ?, updated_at = ? WHERE id = ? AND namespace_id = ?`
          )
          .bind(content, now, id, this.namespaceId);

    const result = await stmt.run();
    const updated = (result.meta?.changes ?? 0) > 0;

    if (updated) {
      // Fetch existing row to get the type for Vectorize metadata
      const row = await this.db
        .prepare(`SELECT type FROM semantic_memories WHERE id = ? AND namespace_id = ?`)
        .bind(id, this.namespaceId)
        .first<{ type: string }>();

      // Update Vectorize vector with namespace metadata
      await this.vectorize.upsert([
        { id, values: embedding, metadata: { type: row?.type ?? "fact", namespace_id: this.namespaceId } },
      ]);
    }

    return updated;
  }

  /** Semantic similarity search using Vectorize ANN, scoped to namespace. */
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

    // Build Vectorize filter with namespace scoping
    const filter: Record<string, string> = { namespace_id: this.namespaceId };
    if (typeFilter) {
      filter.type = typeFilter;
    }

    // Query Vectorize for approximate nearest neighbors
    const vectorResults = await this.vectorize.query(queryEmbedding, {
      topK: limit,
      filter,
    });

    if (!vectorResults.matches?.length) return [];

    // Fetch metadata from D1 for matched IDs, excluding superseded and archived memories, scoped to namespace
    const ids = vectorResults.matches.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT * FROM semantic_memories WHERE id IN (${placeholders}) AND superseded_by IS NULL AND archived_at IS NULL AND namespace_id = ?`
      )
      .bind(...ids, this.namespaceId)
      .all<SemanticEntry>();

    if (!results?.length) return [];

    // Build a lookup map for D1 rows
    const rowMap = new Map(results.map((r) => [r.id, r]));

    // Find max relevance score for normalization
    const relevanceValues = results.map((r) => r.relevanceScore ?? 1.0);
    const maxRelevance = Math.max(...relevanceValues, 1.0);

    // Build scored results blending vector similarity with relevance
    const scored: MemorySearchResult[] = [];
    for (const match of vectorResults.matches) {
      const row = rowMap.get(match.id);
      if (!row) continue;
      const vectorScore = match.score ?? 0;
      const normalizedRelevance =
        maxRelevance > 0 ? (row.relevanceScore ?? 1.0) / maxRelevance : 1.0;
      const finalScore = vectorScore * 0.7 + normalizedRelevance * 0.3;

      scored.push({
        entry: {
          id: row.id,
          content: row.content,
          type: row.type,
          source: row.source,
          tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          relevanceScore: row.relevanceScore ?? 1.0,
          lastAccessedAt: row.lastAccessedAt ?? null,
          accessCount: row.accessCount ?? 0,
          supersededBy: row.supersededBy ?? null,
        } as SemanticEntry,
        score: finalScore,
        matchType: "semantic" as const,
      });
    }

    // Re-sort by blended score (highest first)
    scored.sort((a, b) => b.score - a.score);

    // Update access tracking for returned results (fire-and-forget)
    if (scored.length > 0) {
      const now = new Date().toISOString();
      const returnedIds = scored.map((s) => s.entry.id);
      const updatePlaceholders = returnedIds.map(() => "?").join(", ");
      this.db
        .prepare(
          `UPDATE semantic_memories
           SET last_accessed_at = ?,
               access_count = access_count + 1,
               relevance_score = MIN(relevance_score + 0.1, 2.0)
           WHERE id IN (${updatePlaceholders}) AND namespace_id = ?`
        )
        .bind(now, ...returnedIds, this.namespaceId)
        .run()
        .catch(() => {
          /* best-effort access tracking */
        });
    }

    return scored;
  }

  /** Delete a memory by ID from both D1 and Vectorize, scoped to namespace. */
  async delete(id: string): Promise<boolean> {
    // Delete from D1 (scoped to namespace)
    const result = await this.db
      .prepare(`DELETE FROM semantic_memories WHERE id = ? AND namespace_id = ?`)
      .bind(id, this.namespaceId)
      .run();

    // Delete from Vectorize
    await this.vectorize.deleteByIds([id]);

    return (result.meta?.changes ?? 0) > 0;
  }

  /** List all memories, optionally filtered with cursor-based pagination, scoped to namespace. */
  async list(
    opts: {
      type?: SemanticEntry["type"];
      limit?: number;
      cursor?: string;
      includeArchived?: boolean;
    } = {}
  ): Promise<PaginatedResponse<SemanticEntry>> {
    const limit = opts.limit ?? 50;
    const conditions: string[] = ["superseded_by IS NULL", "namespace_id = ?"];
    if (!opts.includeArchived) {
      conditions.push("archived_at IS NULL");
    }
    const params: (string | number)[] = [this.namespaceId];

    if (opts.type) {
      conditions.push(`type = ?`);
      params.push(opts.type);
    }
    if (opts.cursor) {
      conditions.push(`created_at < ?`);
      params.push(opts.cursor);
    }

    let sql = `SELECT * FROM semantic_memories`;
    sql += ` WHERE ${conditions.join(" AND ")}`;
    // Fetch limit + 1 to determine if there are more results
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit + 1);

    const stmt = this.db.prepare(sql).bind(...params);
    const { results } = await stmt.all<SemanticEntry>();
    const rows = results ?? [];

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map((r) => ({
      ...r,
      tags: typeof r.tags === "string" ? JSON.parse(r.tags) : r.tags,
    }));

    return {
      data,
      cursor: hasMore && data.length > 0 ? data[data.length - 1].createdAt : null,
      hasMore,
    };
  }

  /** Get a single memory by ID, scoped to namespace. */
  async get(id: string): Promise<SemanticEntry | null> {
    const row = await this.db
      .prepare(`SELECT * FROM semantic_memories WHERE id = ? AND namespace_id = ?`)
      .bind(id, this.namespaceId)
      .first<SemanticEntry>();
    if (!row) return null;
    return {
      ...row,
      tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
    };
  }

  /** Count archived memories. */
  async countArchived(): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) as count FROM semantic_memories WHERE archived_at IS NOT NULL AND namespace_id = ?`)
      .bind(this.namespaceId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  /**
   * Supersede an old memory by pointing it at the new one.
   * Sets superseded_by on the old memory, zeros its relevance score,
   * and removes its vector from the Vectorize index so it no longer
   * appears in similarity searches.
   */
  async supersedeMemory(oldId: string, newId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `UPDATE semantic_memories
         SET superseded_by = ?, relevance_score = 0, updated_at = ?
         WHERE id = ? AND namespace_id = ?`
      )
      .bind(newId, now, oldId, this.namespaceId)
      .run();

    // Remove superseded memory's vector so Vectorize won't return it
    await this.vectorize.deleteByIds([oldId]);
  }

  /**
   * Raw vector similarity search that includes all memories (even superseded).
   * Used internally by conflict detection to find potential contradictions
   * before filtering. Returns raw Vectorize scores (not blended).
   * Scoped to the current namespace.
   */
  async searchRaw(
    query: string,
    limit = 5,
    typeFilter?: SemanticEntry["type"]
  ): Promise<{ entry: SemanticEntry; vectorScore: number }[]> {
    const queryEmbedding = await generateEmbedding(
      this.ai,
      this.embeddingModel,
      query
    );

    // Build Vectorize filter with namespace scoping
    const filter: Record<string, string> = { namespace_id: this.namespaceId };
    if (typeFilter) {
      filter.type = typeFilter;
    }

    const vectorResults = await this.vectorize.query(queryEmbedding, {
      topK: limit,
      filter,
    });

    if (!vectorResults.matches?.length) return [];

    const ids = vectorResults.matches.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT * FROM semantic_memories WHERE id IN (${placeholders}) AND superseded_by IS NULL AND namespace_id = ?`
      )
      .bind(...ids, this.namespaceId)
      .all<SemanticEntry>();

    if (!results?.length) return [];

    const rowMap = new Map(results.map((r) => [r.id, r]));
    const out: { entry: SemanticEntry; vectorScore: number }[] = [];

    for (const match of vectorResults.matches) {
      const row = rowMap.get(match.id);
      if (!row) continue;
      out.push({
        entry: {
          ...row,
          tags: typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags,
          supersededBy: row.supersededBy ?? null,
        },
        vectorScore: match.score ?? 0,
      });
    }

    return out;
  }

  /** Get the namespace ID this instance is scoped to. */
  getNamespaceId(): string {
    return this.namespaceId;
  }
}

// ── Decay ─────────────────────────────────────────────────────

/**
 * Apply exponential decay to all relevance scores.
 * Called from the cron handler to gradually reduce stale memories' scores.
 * Decay factor: 0.95 per cycle (memories below 0.01 are left alone to avoid noise).
 */
export async function decayRelevanceScores(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE semantic_memories SET relevance_score = relevance_score * 0.95 WHERE relevance_score > 0.01`
    )
    .run();
}
