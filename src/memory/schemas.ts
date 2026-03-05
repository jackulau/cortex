import type { SqlFn } from "@/shared/types";

/**
 * DO SQLite schemas — run once on agent initialization.
 * These tables live inside the CortexAgent Durable Object's embedded SQLite.
 */
export function initDoSchemas(sql: SqlFn): void {
  // Episodic memory: full conversation turns
  sql`CREATE TABLE IF NOT EXISTS episodic_memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    turn_index  INTEGER NOT NULL
  )`;

  // FTS5 virtual table for full-text search over episodic memory
  sql`CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
    content,
    content=episodic_memory,
    content_rowid=id
  )`;

  // Triggers to keep FTS index in sync
  sql`CREATE TRIGGER IF NOT EXISTS episodic_ai AFTER INSERT ON episodic_memory BEGIN
    INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
  END`;

  sql`CREATE TRIGGER IF NOT EXISTS episodic_ad AFTER DELETE ON episodic_memory BEGIN
    INSERT INTO episodic_fts(episodic_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END`;

  // Session tracking
  sql`CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    started_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT,
    topics      TEXT DEFAULT '[]',
    turn_count  INTEGER DEFAULT 0,
    summary     TEXT
  )`;

  // Procedural memory: user-defined rules and preferences
  sql`CREATE TABLE IF NOT EXISTS procedural_memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rule        TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user', 'system')),
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`;

  // Indexes
  sql`CREATE INDEX IF NOT EXISTS idx_episodic_session ON episodic_memory(session_id)`;
  sql`CREATE INDEX IF NOT EXISTS idx_episodic_timestamp ON episodic_memory(timestamp)`;
}
