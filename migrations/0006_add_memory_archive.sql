-- Add archived_at column for soft-delete archival of stale memories
ALTER TABLE semantic_memories ADD COLUMN archived_at TEXT;

-- Add superseded_by column to track memory deduplication/merging lineage
ALTER TABLE semantic_memories ADD COLUMN superseded_by TEXT;

-- Index on archived_at for efficient filtering of active vs archived memories
CREATE INDEX IF NOT EXISTS idx_semantic_memories_archived_at ON semantic_memories(archived_at);

-- Index on superseded_by for lineage queries
CREATE INDEX IF NOT EXISTS idx_semantic_memories_superseded_by ON semantic_memories(superseded_by);
