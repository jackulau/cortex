import React, { useEffect, useState, useMemo } from "react";

interface DigestEntry {
  id: string;
  watchItemId: string;
  summary: string;
  createdAt: string;
  changes?: string | null;
  delivered?: boolean;
  label?: string;
  url?: string;
}

interface WatchItem {
  id: string;
  url: string;
  label: string;
  frequency: string;
  active: boolean;
}

type GroupBy = "watchItem" | "date";

/**
 * Digest Viewer — browse crawl digest history grouped by watch item or date.
 * Shows summaries, change indicators, and delivery status.
 */
export function DigestViewer() {
  const [entries, setEntries] = useState<DigestEntry[]>([]);
  const [watchItems, setWatchItems] = useState<WatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>("watchItem");
  const [markedIds, setMarkedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [digestRes, watchRes] = await Promise.all([
        fetch("/api/digest"),
        fetch("/api/watchlist"),
      ]);
      if (!digestRes.ok) throw new Error(`Digest: HTTP ${digestRes.status}`);
      if (!watchRes.ok) throw new Error(`Watchlist: HTTP ${watchRes.status}`);

      const digestData = await digestRes.json();
      const watchData = await watchRes.json();

      setEntries(digestData.entries || []);
      setWatchItems(watchData.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

  // Build a label lookup from watch items
  const watchItemLabels = useMemo(() => {
    const map = new Map<string, { label: string; url: string }>();
    for (const item of watchItems) {
      map.set(item.id, { label: item.label, url: item.url });
    }
    return map;
  }, [watchItems]);

  // Group entries by selected mode
  const groups = useMemo(() => {
    const grouped = new Map<string, { label: string; url?: string; entries: DigestEntry[] }>();

    for (const entry of entries) {
      let key: string;
      let label: string;
      let url: string | undefined;

      if (groupBy === "watchItem") {
        key = entry.watchItemId;
        const watchInfo = watchItemLabels.get(entry.watchItemId);
        label = entry.label || watchInfo?.label || entry.watchItemId.slice(0, 8);
        url = entry.url || watchInfo?.url;
      } else {
        // Group by date
        const date = new Date(entry.createdAt).toLocaleDateString();
        key = date;
        label = date;
      }

      if (!grouped.has(key)) {
        grouped.set(key, { label, url, entries: [] });
      }
      grouped.get(key)!.entries.push(entry);
    }

    return grouped;
  }, [entries, groupBy, watchItemLabels]);

  const markAsRead = (id: string) => {
    setMarkedIds((prev) => new Set(prev).add(id));
  };

  const markAllAsRead = () => {
    setMarkedIds(new Set(entries.map((e) => e.id)));
  };

  if (loading) {
    return <div className="loading-text">Loading digest...</div>;
  }

  if (error) {
    return (
      <div className="error-text">
        Error: {error}
        <br />
        <button className="btn" onClick={fetchData} style={{ marginTop: "1rem" }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Controls */}
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <span className="text-dim text-sm">
            {entries.length} digest {entries.length === 1 ? "entry" : "entries"}
          </span>

          <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
            <span className="text-dim text-sm" style={{ marginRight: "0.25rem" }}>
              Group by:
            </span>
            <button
              className={`btn ${groupBy === "watchItem" ? "btn-primary" : ""}`}
              onClick={() => setGroupBy("watchItem")}
            >
              Watch Item
            </button>
            <button
              className={`btn ${groupBy === "date" ? "btn-primary" : ""}`}
              onClick={() => setGroupBy("date")}
            >
              Date
            </button>
          </div>

          {entries.length > 0 && (
            <button
              className="btn"
              onClick={markAllAsRead}
            >
              Mark All Read
            </button>
          )}
        </div>
      </div>

      {/* Digest entries */}
      {entries.length === 0 ? (
        <div className="empty-state-text">
          No digest entries yet. Add URLs to your Watch List to start receiving updates.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {Array.from(groups.entries()).map(([key, group]) => (
            <div key={key} className="panel">
              {/* Group header */}
              <div className="panel-header">
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <h3 className="panel-title">{group.label}</h3>
                  {group.url && (
                    <a
                      href={group.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-dim text-sm"
                      style={{ textDecoration: "underline" }}
                    >
                      {group.url.length > 40
                        ? group.url.slice(0, 40) + "..."
                        : group.url}
                    </a>
                  )}
                </div>
                <span className="chip" style={{ background: "#1e1e2e", color: "#8888a0" }}>
                  {group.entries.length} {group.entries.length === 1 ? "update" : "updates"}
                </span>
              </div>

              {/* Individual entries */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {group.entries.map((entry) => {
                  const isRead = markedIds.has(entry.id) || entry.delivered;
                  const hasChanges = entry.changes && entry.changes !== "unchanged";

                  return (
                    <div
                      key={entry.id}
                      style={{
                        padding: "0.5rem 0.75rem",
                        borderRadius: "0.375rem",
                        background: isRead ? "#0e0e18" : "#1a1a2e",
                        borderLeft: `3px solid ${hasChanges ? "#fbbf24" : "#34d399"}`,
                        opacity: isRead ? 0.7 : 1,
                        transition: "opacity 0.2s",
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1 }}>
                          <p
                            style={{
                              fontSize: "0.85rem",
                              lineHeight: 1.5,
                              margin: "0 0 0.25rem 0",
                            }}
                          >
                            {entry.summary}
                          </p>
                          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                            <span
                              className="chip"
                              style={{
                                background: hasChanges ? "#3b2f1a" : "#1a3b2f",
                                color: hasChanges ? "#fbbf24" : "#34d399",
                                borderColor: hasChanges ? "#3b2f1a" : "#1a3b2f",
                              }}
                            >
                              {hasChanges ? "Changed" : "Unchanged"}
                            </span>
                            <span className="text-dim text-sm">
                              {new Date(entry.createdAt).toLocaleString()}
                            </span>
                            {isRead && (
                              <span className="text-dim text-sm" style={{ color: "#34d399" }}>
                                Read
                              </span>
                            )}
                          </div>
                        </div>
                        {!isRead && (
                          <button
                            className="btn"
                            onClick={() => markAsRead(entry.id)}
                            style={{ flexShrink: 0, marginLeft: "0.5rem" }}
                          >
                            Mark Read
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
