import { generateEmbedding } from "@/embeddings/generate";

/**
 * Memory Cleanup / Garbage Collection
 *
 * Three maintenance operations that run periodically via cron:
 * 1. Duplicate Detection — find and deduplicate near-identical memories
 * 2. Staleness Pruning — archive memories with low relevance and no recent access
 * 3. Consolidation Merging — cluster related memories and merge into summaries
 */

// ── Types ─────────────────────────────────────────────────────────

export interface CleanupResult {
  duplicatesRemoved: number;
  memoriesArchived: number;
  clustersMerged: number;
  errors: string[];
}

export interface CleanupEnv {
  DB: D1Database;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  STORAGE: R2Bucket;
  EMBEDDING_MODEL: string;
  CHAT_MODEL: string;
}

/** D1 row shape (snake_case columns from the database). */
interface D1MemoryRow {
  id: string;
  content: string;
  type: string;
  source: string;
  tags: string;
  created_at: string;
  updated_at: string;
  relevance_score: number | null;
  last_accessed_at: string | null;
  access_count: number | null;
  archived_at: string | null;
  superseded_by: string | null;
}

// ── Constants ─────────────────────────────────────────────────────

/** Cosine similarity threshold — above this, two memories are considered duplicates. */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.95;

/** Memories inactive for longer than this are candidates for archival. */
const STALENESS_DAYS = 90;

/** Relevance score below this threshold marks a memory as stale. */
const STALENESS_RELEVANCE_THRESHOLD = 0.1;

/** Batch size for processing memories during duplicate detection. */
const DEDUP_BATCH_SIZE = 50;

/** Min/max cluster size for consolidation merging. */
const MIN_CLUSTER_SIZE = 3;
const MAX_CLUSTER_SIZE = 10;

/** Similarity threshold for clustering related memories (lower than dedup). */
const CLUSTER_SIMILARITY_THRESHOLD = 0.80;

// ── Main Orchestrator ─────────────────────────────────────────────

/**
 * Run all memory cleanup operations.
 * Called from the cron handler — designed to be non-blocking.
 */
export async function runMemoryCleanup(env: CleanupEnv): Promise<CleanupResult> {
  const result: CleanupResult = {
    duplicatesRemoved: 0,
    memoriesArchived: 0,
    clustersMerged: 0,
    errors: [],
  };

  // 1. Duplicate detection
  try {
    result.duplicatesRemoved = await detectAndRemoveDuplicates(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Duplicate detection failed: ${msg}`);
    console.error("Duplicate detection error:", msg);
  }

  // 2. Staleness pruning
  try {
    result.memoriesArchived = await pruneStaleMemories(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Staleness pruning failed: ${msg}`);
    console.error("Staleness pruning error:", msg);
  }

  // 3. Consolidation merging
  try {
    result.clustersMerged = await mergeRelatedClusters(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Consolidation merging failed: ${msg}`);
    console.error("Consolidation merging error:", msg);
  }

  console.log(
    `Memory cleanup complete: ${result.duplicatesRemoved} duplicates, ` +
      `${result.memoriesArchived} archived, ${result.clustersMerged} clusters merged` +
      (result.errors.length > 0 ? ` (${result.errors.length} errors)` : "")
  );

  return result;
}

// ── 1. Duplicate Detection ────────────────────────────────────────

/**
 * Find memories with cosine similarity > 0.95 and supersede the weaker one.
 * Processes in batches to avoid O(n^2) comparisons.
 */
export async function detectAndRemoveDuplicates(env: CleanupEnv): Promise<number> {
  const { DB, VECTORIZE } = env;
  let removed = 0;

  // Track already-processed IDs to avoid re-checking superseded memories
  const processed = new Set<string>();

  // Fetch active (non-archived, non-superseded) memories in batches
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { results: batch } = await DB.prepare(
      `SELECT id, content, relevance_score FROM semantic_memories
       WHERE archived_at IS NULL AND superseded_by IS NULL
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(DEDUP_BATCH_SIZE, offset)
      .all<{ id: string; content: string; relevance_score: number | null }>();

    if (!batch || batch.length === 0) break;
    hasMore = batch.length === DEDUP_BATCH_SIZE;
    offset += batch.length;

    for (const memory of batch) {
      if (processed.has(memory.id)) continue;

      // Query Vectorize for nearest neighbors
      let matches: { id: string; score: number }[];
      try {
        const embedding = await generateEmbedding(
          env.AI,
          env.EMBEDDING_MODEL,
          memory.content
        );
        const vectorResults = await VECTORIZE.query(embedding, { topK: 5 });
        matches = (vectorResults.matches ?? [])
          .filter(
            (m) =>
              m.id !== memory.id &&
              (m.score ?? 0) > DUPLICATE_SIMILARITY_THRESHOLD &&
              !processed.has(m.id)
          )
          .map((m) => ({ id: m.id, score: m.score ?? 0 }));
      } catch {
        // Skip this memory if embedding/query fails
        continue;
      }

      for (const match of matches) {
        // Fetch the duplicate's relevance score
        const dupRow = await DB.prepare(
          `SELECT id, relevance_score FROM semantic_memories
           WHERE id = ? AND archived_at IS NULL AND superseded_by IS NULL`
        )
          .bind(match.id)
          .first<{ id: string; relevance_score: number | null }>();

        if (!dupRow) continue;

        // Keep the one with the higher relevance score
        const keepId =
          (memory.relevance_score ?? 1.0) >= (dupRow.relevance_score ?? 1.0)
            ? memory.id
            : dupRow.id;
        const supersedeId = keepId === memory.id ? dupRow.id : memory.id;

        await DB.prepare(
          `UPDATE semantic_memories SET superseded_by = ?, updated_at = ? WHERE id = ?`
        )
          .bind(keepId, new Date().toISOString(), supersedeId)
          .run();

        processed.add(supersedeId);
        removed++;
      }

      processed.add(memory.id);
    }
  }

  return removed;
}

// ── 2. Staleness Pruning ──────────────────────────────────────────

/**
 * Archive memories that have not been accessed in 90 days and have
 * very low relevance scores. Backs up to R2 before marking archived.
 */
export async function pruneStaleMemories(env: CleanupEnv): Promise<number> {
  const { DB, STORAGE } = env;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - STALENESS_DAYS);
  const cutoffStr = cutoff.toISOString();

  // Find stale memories:
  // - last_accessed_at older than cutoff OR null (never accessed)
  // - created_at older than cutoff (so new memories that were never accessed aren't pruned)
  // - relevance_score below threshold
  // - not already archived or superseded
  const { results: staleMemories } = await DB.prepare(
    `SELECT * FROM semantic_memories
     WHERE (last_accessed_at < ? OR (last_accessed_at IS NULL AND created_at < ?))
       AND (relevance_score IS NOT NULL AND relevance_score < ?)
       AND superseded_by IS NULL
       AND archived_at IS NULL
     LIMIT 100`
  )
    .bind(cutoffStr, cutoffStr, STALENESS_RELEVANCE_THRESHOLD)
    .all<D1MemoryRow>();

  if (!staleMemories || staleMemories.length === 0) return 0;

  const now = new Date().toISOString();
  let archived = 0;

  for (const memory of staleMemories) {
    try {
      // Back up to R2 before archiving
      const backupKey = `memory-archive/${memory.id}.json`;
      const backupPayload = JSON.stringify({
        ...memory,
        archivedAt: now,
        reason: "staleness_pruning",
      });
      await STORAGE.put(backupKey, backupPayload, {
        httpMetadata: { contentType: "application/json" },
      });

      // Mark as archived in D1
      await DB.prepare(
        `UPDATE semantic_memories SET archived_at = ?, updated_at = ? WHERE id = ?`
      )
        .bind(now, now, memory.id)
        .run();

      archived++;
    } catch (err) {
      console.error(
        `Failed to archive memory ${memory.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return archived;
}

// ── 3. Consolidation Merging ──────────────────────────────────────

const MERGE_PROMPT = `You are a knowledge consolidation system. Given a cluster of related memory facts, merge them into a single comprehensive summary that preserves all important information.

Rules:
- Combine all facts into one cohesive statement
- Don't lose any specific details or data points
- Make the merged fact self-contained and understandable
- Keep it concise but complete
- Return only the merged text, no JSON or formatting`;

/**
 * Find clusters of related memories and merge them into summaries.
 * Uses tag overlap and embedding similarity to identify clusters.
 */
export async function mergeRelatedClusters(env: CleanupEnv): Promise<number> {
  const { DB, AI, VECTORIZE, CHAT_MODEL, EMBEDDING_MODEL } = env;

  // Fetch active memories with tags for clustering
  const { results: candidates } = await DB.prepare(
    `SELECT id, content, type, source, tags, relevance_score FROM semantic_memories
     WHERE archived_at IS NULL AND superseded_by IS NULL
     ORDER BY created_at DESC
     LIMIT 200`
  )
    .all<{
      id: string;
      content: string;
      type: string;
      source: string;
      tags: string;
      relevance_score: number | null;
    }>();

  if (!candidates || candidates.length < MIN_CLUSTER_SIZE) return 0;

  // Parse tags and build tag-based groups
  const tagGroups = new Map<string, typeof candidates>();
  for (const mem of candidates) {
    const tags: string[] =
      typeof mem.tags === "string" ? JSON.parse(mem.tags) : [];
    for (const tag of tags) {
      const normalized = tag.toLowerCase().trim();
      if (!normalized) continue;
      if (!tagGroups.has(normalized)) {
        tagGroups.set(normalized, []);
      }
      tagGroups.get(normalized)!.push(mem);
    }
  }

  // Filter to groups with 3-10 members of the same type
  const clusters: typeof candidates[] = [];
  const usedIds = new Set<string>();

  for (const [, group] of tagGroups) {
    // Group by type within the tag group
    const byType = new Map<string, typeof candidates>();
    for (const mem of group) {
      if (usedIds.has(mem.id)) continue;
      if (!byType.has(mem.type)) byType.set(mem.type, []);
      byType.get(mem.type)!.push(mem);
    }

    for (const [, typeGroup] of byType) {
      if (typeGroup.length >= MIN_CLUSTER_SIZE) {
        const cluster = typeGroup.slice(0, MAX_CLUSTER_SIZE);

        // Verify cluster coherence via embedding similarity
        const coherent = await verifyClusterCoherence(
          env,
          cluster.map((m) => m.content)
        );
        if (!coherent) continue;

        clusters.push(cluster);
        for (const mem of cluster) usedIds.add(mem.id);
      }
    }
  }

  if (clusters.length === 0) return 0;

  let merged = 0;

  for (const cluster of clusters) {
    try {
      // Build the content to merge
      const clusterContent = cluster
        .map((m, i) => `${i + 1}. ${m.content}`)
        .join("\n");

      // Ask AI to merge the cluster
      const response = (await AI.run(CHAT_MODEL as any, {
        messages: [
          { role: "system", content: MERGE_PROMPT },
          { role: "user", content: clusterContent },
        ],
        max_tokens: 500,
      })) as { response?: string };

      const mergedContent = response.response?.trim();
      if (!mergedContent) continue;

      // Combine tags from all cluster members
      const allTags = new Set<string>();
      for (const mem of cluster) {
        const tags: string[] =
          typeof mem.tags === "string" ? JSON.parse(mem.tags) : [];
        for (const tag of tags) allTags.add(tag);
      }

      // Create merged memory
      const mergedId = crypto.randomUUID();
      const now = new Date().toISOString();
      const tagsJson = JSON.stringify([...allTags]);

      // Generate embedding for the merged content
      const embedding = await generateEmbedding(AI, EMBEDDING_MODEL, mergedContent);

      // Insert merged memory into D1
      await DB.prepare(
        `INSERT INTO semantic_memories (id, content, type, source, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          mergedId,
          mergedContent,
          cluster[0].type, // Use the type from the cluster
          "consolidated",
          tagsJson,
          now,
          now
        )
        .run();

      // Insert into Vectorize
      await VECTORIZE.upsert([
        { id: mergedId, values: embedding, metadata: { type: cluster[0].type } },
      ]);

      // Supersede the original memories
      for (const mem of cluster) {
        await DB.prepare(
          `UPDATE semantic_memories SET superseded_by = ?, updated_at = ? WHERE id = ?`
        )
          .bind(mergedId, now, mem.id)
          .run();
      }

      merged++;
    } catch (err) {
      console.error(
        "Cluster merge failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  return merged;
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Verify that a cluster of texts is semantically coherent
 * by checking pairwise similarity of first and last items.
 */
async function verifyClusterCoherence(
  env: CleanupEnv,
  contents: string[]
): Promise<boolean> {
  if (contents.length < 2) return false;

  try {
    // Quick check: embed first and last items and compare
    const firstEmbedding = await generateEmbedding(
      env.AI,
      env.EMBEDDING_MODEL,
      contents[0]
    );
    const lastEmbedding = await generateEmbedding(
      env.AI,
      env.EMBEDDING_MODEL,
      contents[contents.length - 1]
    );

    const similarity = cosineSimilarity(firstEmbedding, lastEmbedding);
    return similarity >= CLUSTER_SIMILARITY_THRESHOLD;
  } catch {
    return false;
  }
}

/** Compute cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// Export for testing
export { cosineSimilarity, verifyClusterCoherence, MERGE_PROMPT };
