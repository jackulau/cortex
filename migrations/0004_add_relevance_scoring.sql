-- Add relevance scoring columns to semantic_memories
ALTER TABLE semantic_memories ADD COLUMN relevance_score REAL NOT NULL DEFAULT 1.0;
ALTER TABLE semantic_memories ADD COLUMN last_accessed_at TEXT;
ALTER TABLE semantic_memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_semantic_relevance ON semantic_memories(relevance_score);
