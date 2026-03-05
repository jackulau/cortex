-- Watch items for proactive monitoring (Phase 3)
CREATE TABLE IF NOT EXISTS watch_items (
  id           TEXT PRIMARY KEY,
  url          TEXT NOT NULL,
  label        TEXT NOT NULL,
  frequency    TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('hourly', 'daily', 'weekly')),
  last_checked TEXT,
  last_hash    TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Digest entries produced by crawl cycles
CREATE TABLE IF NOT EXISTS digest_entries (
  id            TEXT PRIMARY KEY,
  watch_item_id TEXT NOT NULL REFERENCES watch_items(id) ON DELETE CASCADE,
  summary       TEXT NOT NULL,
  changes       TEXT,
  delivered     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_digest_undelivered ON digest_entries(delivered, created_at);
