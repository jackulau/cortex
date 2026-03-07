import type {
  EpisodicEntry,
  SessionSummary,
  PaginatedResponse,
  SqlFn,
} from "@/shared/types";

/**
 * Episodic memory — full conversation history stored in DO SQLite.
 * Supports FTS5 full-text search over past conversations.
 */
export class EpisodicMemory {
  constructor(private sql: SqlFn) {}

  /** Log a single conversation turn. */
  logTurn(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    turnIndex: number
  ): void {
    this.sql`INSERT INTO episodic_memory (session_id, role, content, turn_index)
       VALUES (${sessionId}, ${role}, ${content}, ${turnIndex})`;
  }

  /** Get all turns for a session. */
  getSession(sessionId: string): EpisodicEntry[] {
    return this.sql<EpisodicEntry>`
      SELECT id, session_id as sessionId, role, content, timestamp, turn_index as turnIndex
      FROM episodic_memory WHERE session_id = ${sessionId} ORDER BY turn_index`;
  }

  /** Full-text search across all conversations. */
  search(query: string, limit = 10): EpisodicEntry[] {
    return this.sql<EpisodicEntry>`
      SELECT e.id, e.session_id as sessionId, e.role, e.content, e.timestamp, e.turn_index as turnIndex
      FROM episodic_memory e
      JOIN episodic_fts f ON e.id = f.rowid
      WHERE episodic_fts MATCH ${query}
      ORDER BY rank
      LIMIT ${limit}`;
  }

  /** List all sessions with metadata. */
  listSessions(limit = 20): SessionSummary[] {
    return this.sql<SessionSummary>`
      SELECT id as sessionId, started_at as startedAt, ended_at as endedAt,
             topics, turn_count as turnCount, summary
      FROM sessions ORDER BY started_at DESC LIMIT ${limit}`;
  }

  /** List sessions with cursor-based pagination. */
  listSessionsPaginated(
    limit = 20,
    cursor?: string
  ): PaginatedResponse<SessionSummary> {
    const fetchLimit = limit + 1;
    const rows = cursor
      ? this.sql<SessionSummary>`
          SELECT id as sessionId, started_at as startedAt, ended_at as endedAt,
                 topics, turn_count as turnCount, summary
          FROM sessions WHERE started_at < ${cursor}
          ORDER BY started_at DESC LIMIT ${fetchLimit}`
      : this.sql<SessionSummary>`
          SELECT id as sessionId, started_at as startedAt, ended_at as endedAt,
                 topics, turn_count as turnCount, summary
          FROM sessions ORDER BY started_at DESC LIMIT ${fetchLimit}`;

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit);

    return {
      data,
      cursor:
        hasMore && data.length > 0
          ? data[data.length - 1].startedAt
          : null,
      hasMore,
    };
  }

  /** Create or update a session record. */
  upsertSession(
    sessionId: string,
    updates: {
      topics?: string[];
      turnCount?: number;
      summary?: string;
      endedAt?: string;
    }
  ): void {
    // Insert if not exists
    this.sql`INSERT OR IGNORE INTO sessions (id) VALUES (${sessionId})`;

    if (updates.topics !== undefined) {
      const topics = JSON.stringify(updates.topics);
      this.sql`UPDATE sessions SET topics = ${topics} WHERE id = ${sessionId}`;
    }
    if (updates.turnCount !== undefined) {
      this.sql`UPDATE sessions SET turn_count = ${updates.turnCount} WHERE id = ${sessionId}`;
    }
    if (updates.summary !== undefined) {
      this.sql`UPDATE sessions SET summary = ${updates.summary} WHERE id = ${sessionId}`;
    }
    if (updates.endedAt !== undefined) {
      this.sql`UPDATE sessions SET ended_at = ${updates.endedAt} WHERE id = ${sessionId}`;
    }
  }

  /** Get total turn count for a session. */
  getTurnCount(sessionId: string): number {
    const result = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM episodic_memory WHERE session_id = ${sessionId}`;
    return result[0]?.count ?? 0;
  }

  /** Get recent turns across all sessions. */
  getRecentTurns(limit = 50): EpisodicEntry[] {
    return this.sql<EpisodicEntry>`
      SELECT id, session_id as sessionId, role, content, timestamp, turn_index as turnIndex
      FROM episodic_memory ORDER BY timestamp DESC LIMIT ${limit}`;
  }
}
