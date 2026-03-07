-- Add memory versioning support for conflict detection.
-- When a new fact contradicts an existing memory, the old memory is superseded
-- rather than deleted, preserving an audit trail.
ALTER TABLE semantic_memories ADD COLUMN superseded_by TEXT;

CREATE INDEX IF NOT EXISTS idx_semantic_superseded ON semantic_memories(superseded_by);
