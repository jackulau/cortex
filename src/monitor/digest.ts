import { DEFAULT_NAMESPACE_ID } from "@/shared/types";

/**
 * Digest Manager — manages digest entries and generates AI-formatted digests.
 * Groups undelivered entries by watch item and uses Workers AI for formatting.
 * All operations are scoped to a namespace for multi-tenant isolation.
 */

export interface DigestEntry {
  id: string;
  watchItemId: string;
  summary: string;
  changes: string | null;
  delivered: boolean;
  createdAt: string;
  namespaceId: string;
}

export class DigestManager {
  constructor(
    private db: D1Database,
    private namespaceId: string = DEFAULT_NAMESPACE_ID
  ) {}

  /** Get all undelivered digest entries, ordered by creation time. */
  async getUndelivered(): Promise<DigestEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT de.*, wi.label, wi.url
         FROM digest_entries de
         JOIN watch_items wi ON de.watch_item_id = wi.id
         WHERE de.delivered = 0 AND de.namespace_id = ?
         ORDER BY de.created_at DESC`
      )
      .bind(this.namespaceId)
      .all<RawDigestRow>();
    return (results ?? []).map(rowToDigestEntry);
  }

  /** Get digest entries for a specific watch item. */
  async getByWatchItem(watchItemId: string): Promise<DigestEntry[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM digest_entries WHERE watch_item_id = ? AND namespace_id = ? ORDER BY created_at DESC`
      )
      .bind(watchItemId, this.namespaceId)
      .all<RawDigestRow>();
    return (results ?? []).map(rowToDigestEntry);
  }

  /** Mark a set of digest entries as delivered. */
  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    // Use a batch of updates for reliability
    const stmts = ids.map((id) =>
      this.db
        .prepare(`UPDATE digest_entries SET delivered = 1 WHERE id = ? AND namespace_id = ?`)
        .bind(id, this.namespaceId)
    );
    await this.db.batch(stmts);
  }

  /** Generate a formatted digest from undelivered entries using Workers AI. */
  async generateDigest(ai: Ai, chatModel: string): Promise<string> {
    const entries = await this.getUndelivered();

    if (entries.length === 0) {
      return "No new updates to report.";
    }

    // Group entries by watch item
    const grouped = new Map<string, { label: string; url: string; entries: DigestEntry[] }>();
    for (const entry of entries) {
      const raw = entry as DigestEntry & { label?: string; url?: string };
      const key = entry.watchItemId;
      if (!grouped.has(key)) {
        grouped.set(key, {
          label: raw.label ?? key,
          url: raw.url ?? "",
          entries: [],
        });
      }
      grouped.get(key)!.entries.push(entry);
    }

    // Build content for LLM
    const sections: string[] = [];
    for (const [, group] of grouped) {
      const summaries = group.entries.map((e) => `- ${e.summary}`).join("\n");
      sections.push(`## ${group.label}\nURL: ${group.url}\n${summaries}`);
    }

    const response = await ai.run(chatModel as any, {
      messages: [
        {
          role: "system",
          content:
            "You are a digest formatter. Take the following monitoring updates and create a clean, readable markdown digest. Group by source, highlight important changes, and keep it concise.",
        },
        {
          role: "user",
          content: `Format these monitoring updates into a digest:\n\n${sections.join("\n\n")}`,
        },
      ],
    });

    let digest: string;
    if (typeof response === "object" && response !== null && "response" in response) {
      digest = (response as { response: string }).response;
    } else {
      digest = String(response);
    }

    // Mark all as delivered
    await this.markDelivered(entries.map((e) => e.id));

    return digest;
  }

  /** Add a new digest entry. */
  async addEntry(entry: {
    watchItemId: string;
    summary: string;
    changes?: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO digest_entries (id, watch_item_id, summary, changes, namespace_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(id, entry.watchItemId, entry.summary, entry.changes ?? null, this.namespaceId)
      .run();
    return id;
  }

  /** Get the namespace ID this instance is scoped to. */
  getNamespaceId(): string {
    return this.namespaceId;
  }
}

// ── Formatting ──────────────────────────────────────────────────

/**
 * Format digest entries into a Discord-friendly markdown message.
 * Groups entries by watch item label and includes summaries + timestamps.
 * Returns null when there are no entries (caller should skip posting).
 */
export function formatDigestMessage(
  entries: DigestEntry[]
): string | null {
  if (entries.length === 0) return null;

  // Group entries by watch item
  const grouped = new Map<
    string,
    { label: string; url: string; entries: DigestEntry[] }
  >();
  for (const entry of entries) {
    const raw = entry as DigestEntry & { label?: string; url?: string };
    const key = entry.watchItemId;
    if (!grouped.has(key)) {
      grouped.set(key, {
        label: raw.label ?? key,
        url: raw.url ?? "",
        entries: [],
      });
    }
    grouped.get(key)!.entries.push(entry);
  }

  // Build markdown sections
  const lines: string[] = [
    `**Cortex Daily Digest** — ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    "",
  ];

  for (const [, group] of grouped) {
    const header = group.url
      ? `**[${group.label}](${group.url})**`
      : `**${group.label}**`;
    lines.push(header);

    for (const e of group.entries) {
      const ts = new Date(e.createdAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(`> • ${e.summary} _(${ts})_`);
    }
    lines.push("");
  }

  lines.push(`_${entries.length} update${entries.length === 1 ? "" : "s"} total_`);

  // Discord message content limit is 2000 characters
  const message = lines.join("\n");
  if (message.length > 2000) {
    return message.slice(0, 1997) + "...";
  }
  return message;
}

// ── Helpers ────────────────────────────────────────────────────

/** Raw row shape from D1. */
interface RawDigestRow {
  id: string;
  watch_item_id: string;
  summary: string;
  changes: string | null;
  delivered: number;
  created_at: string;
  namespace_id: string;
  label?: string;
  url?: string;
}

function rowToDigestEntry(row: RawDigestRow): DigestEntry {
  // Preserve extra fields (label, url) from JOINs for grouping
  const entry: DigestEntry & { label?: string; url?: string } = {
    id: row.id,
    watchItemId: row.watch_item_id,
    summary: row.summary,
    changes: row.changes,
    delivered: row.delivered === 1,
    createdAt: row.created_at,
    namespaceId: row.namespace_id ?? DEFAULT_NAMESPACE_ID,
  };
  if (row.label) entry.label = row.label;
  if (row.url) entry.url = row.url;
  return entry;
}
