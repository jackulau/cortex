-- Namespace isolation: multi-tenant support for Cortex memory spaces.

CREATE TABLE IF NOT EXISTS namespaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  settings TEXT  -- JSON config per namespace
);

-- Seed the default namespace for backward compatibility
INSERT OR IGNORE INTO namespaces (id, name, owner) VALUES ('default', 'Default', 'system');

-- Add namespace_id column to semantic_memories
ALTER TABLE semantic_memories ADD COLUMN namespace_id TEXT DEFAULT 'default';
CREATE INDEX idx_memories_namespace ON semantic_memories(namespace_id);

-- Add namespace_id column to watch_items
ALTER TABLE watch_items ADD COLUMN namespace_id TEXT DEFAULT 'default';
CREATE INDEX idx_watch_items_namespace ON watch_items(namespace_id);

-- Add namespace_id column to digest_entries
ALTER TABLE digest_entries ADD COLUMN namespace_id TEXT DEFAULT 'default';
CREATE INDEX idx_digest_entries_namespace ON digest_entries(namespace_id);
