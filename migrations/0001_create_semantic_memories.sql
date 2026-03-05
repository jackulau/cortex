-- Semantic memories (facts, preferences, events, notes, summaries)
CREATE TABLE IF NOT EXISTS semantic_memories (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  type       TEXT NOT NULL CHECK(type IN ('fact', 'preference', 'event', 'note', 'summary')),
  source     TEXT NOT NULL CHECK(source IN ('user', 'consolidated', 'research')),
  tags       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_semantic_type ON semantic_memories(type);
CREATE INDEX IF NOT EXISTS idx_semantic_source ON semantic_memories(source);
CREATE INDEX IF NOT EXISTS idx_semantic_created ON semantic_memories(created_at);
