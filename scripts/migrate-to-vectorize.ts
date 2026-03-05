/**
 * Migration script: Backfill Vectorize index from D1 memory_embeddings.
 *
 * Reads all rows from D1 memory_embeddings, converts stored blobs back to
 * float arrays, and upserts them into the Vectorize index in batches.
 *
 * Usage:
 *   Run via wrangler in a worker context with --remote:
 *     npx wrangler dev --remote
 *   Then POST to /api/admin/migrate-vectorize
 *
 *   Or adapt this script to run as a standalone worker.
 */

/** Maximum vectors per Vectorize upsert batch. */
const BATCH_SIZE = 250;

interface MigrationRow {
  memory_id: string;
  embedding: ArrayBuffer;
}

interface MemoryTypeRow {
  id: string;
  type: string;
}

/**
 * Migrate all embeddings from D1 to Vectorize.
 *
 * @param db - D1 database binding
 * @param vectorize - Vectorize index binding
 * @returns Migration stats
 */
export async function migrateToVectorize(
  db: D1Database,
  vectorize: VectorizeIndex
): Promise<{ migrated: number; batches: number; errors: string[] }> {
  const errors: string[] = [];

  // Step 1: Read all embeddings from D1
  const { results: embeddings } = await db
    .prepare(`SELECT memory_id, embedding FROM memory_embeddings`)
    .all<MigrationRow>();

  if (!embeddings?.length) {
    return { migrated: 0, batches: 0, errors: [] };
  }

  // Step 2: Read type metadata for each memory (for Vectorize metadata filter)
  const ids = embeddings.map((e) => e.memory_id);
  const typeMap = new Map<string, string>();

  // Fetch types in batches to avoid overly large IN clauses
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batchIds = ids.slice(i, i + BATCH_SIZE);
    const placeholders = batchIds.map(() => "?").join(", ");
    const { results: typeRows } = await db
      .prepare(
        `SELECT id, type FROM semantic_memories WHERE id IN (${placeholders})`
      )
      .bind(...batchIds)
      .all<MemoryTypeRow>();

    for (const row of typeRows ?? []) {
      typeMap.set(row.id, row.type);
    }
  }

  // Step 3: Batch upsert into Vectorize
  let migrated = 0;
  let batches = 0;

  for (let i = 0; i < embeddings.length; i += BATCH_SIZE) {
    const batch = embeddings.slice(i, i + BATCH_SIZE);
    const vectors: { id: string; values: number[]; metadata: Record<string, string> }[] = [];

    for (const row of batch) {
      const values = Array.from(new Float32Array(row.embedding));
      const memType = typeMap.get(row.memory_id) ?? "note";
      vectors.push({
        id: row.memory_id,
        values,
        metadata: { type: memType },
      });
    }

    try {
      await vectorize.upsert(vectors);
      migrated += vectors.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Batch ${batches}: ${msg}`);
    }

    batches++;
  }

  // Step 4: Verify count
  const expectedCount = embeddings.length;
  if (migrated !== expectedCount) {
    errors.push(
      `Count mismatch: expected ${expectedCount}, migrated ${migrated}`
    );
  }

  return { migrated, batches, errors };
}
