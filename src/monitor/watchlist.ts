/**
 * Watch List Manager — CRUD for monitored URLs stored in D1.
 * Supports frequency-based scheduling (hourly, daily, weekly).
 */
export interface WatchItem {
  id: string;
  url: string;
  label: string;
  frequency: "hourly" | "daily" | "weekly";
  lastChecked: string | null;
  lastHash: string | null;
  active: boolean;
  createdAt: string;
}

export class WatchListManager {
  constructor(private db: D1Database) {}

  /** Add a new watch item. Returns the generated ID. */
  async add(item: {
    url: string;
    label: string;
    frequency: "hourly" | "daily" | "weekly";
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO watch_items (id, url, label, frequency)
         VALUES (?, ?, ?, ?)`
      )
      .bind(id, item.url, item.label, item.frequency)
      .run();
    return id;
  }

  /** Remove a watch item by ID. Returns true if a row was deleted. */
  async remove(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM watch_items WHERE id = ?`)
      .bind(id)
      .run();
    return (result.meta?.changes ?? 0) > 0;
  }

  /** List watch items. If activeOnly is true (default), only active items are returned. */
  async list(activeOnly = true): Promise<WatchItem[]> {
    let sql = `SELECT * FROM watch_items`;
    if (activeOnly) {
      sql += ` WHERE active = 1`;
    }
    sql += ` ORDER BY created_at DESC`;

    const { results } = await this.db.prepare(sql).all<RawWatchRow>();
    return (results ?? []).map(rowToWatchItem);
  }

  /** Get a single watch item by ID, or null if not found. */
  async get(id: string): Promise<WatchItem | null> {
    const row = await this.db
      .prepare(`SELECT * FROM watch_items WHERE id = ?`)
      .bind(id)
      .first<RawWatchRow>();
    if (!row) return null;
    return rowToWatchItem(row);
  }

  /** Get items that are due for a check based on their frequency and last_checked timestamp. */
  async getDueItems(): Promise<WatchItem[]> {
    const sql = `
      SELECT * FROM watch_items
      WHERE active = 1
      AND (
        last_checked IS NULL
        OR (frequency = 'hourly' AND last_checked < datetime('now', '-1 hour'))
        OR (frequency = 'daily' AND last_checked < datetime('now', '-1 day'))
        OR (frequency = 'weekly' AND last_checked < datetime('now', '-7 days'))
      )
    `;
    const { results } = await this.db.prepare(sql).all<RawWatchRow>();
    return (results ?? []).map(rowToWatchItem);
  }

  /** Update last_checked timestamp and content hash after a crawl. */
  async updateLastChecked(id: string, hash: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE watch_items SET last_checked = datetime('now'), last_hash = ? WHERE id = ?`
      )
      .bind(hash, id)
      .run();
  }
}

// ── Helpers ────────────────────────────────────────────────────

/** Raw row shape from D1 (snake_case columns). */
interface RawWatchRow {
  id: string;
  url: string;
  label: string;
  frequency: string;
  last_checked: string | null;
  last_hash: string | null;
  active: number;
  created_at: string;
}

function rowToWatchItem(row: RawWatchRow): WatchItem {
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    frequency: row.frequency as WatchItem["frequency"],
    lastChecked: row.last_checked,
    lastHash: row.last_hash,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}
