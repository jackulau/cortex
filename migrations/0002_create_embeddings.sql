-- Embeddings for semantic memory entries
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES semantic_memories(id) ON DELETE CASCADE,
  embedding  BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
