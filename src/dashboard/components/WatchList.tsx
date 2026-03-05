import React, { useEffect, useState } from "react";

interface WatchItem {
  id: string;
  url: string;
  label: string;
  frequency: "hourly" | "daily" | "weekly";
  lastChecked: string | null;
  active: boolean;
  createdAt: string;
}

interface DigestEntry {
  id: string;
  watchItemId: string;
  summary: string;
  createdAt: string;
}

/**
 * Watch List — CRUD interface for URL monitoring.
 * Shows status indicators, digest previews, and enable/disable toggles.
 */
export function WatchList() {
  const [items, setItems] = useState<WatchItem[]>([]);
  const [digests, setDigests] = useState<DigestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newFrequency, setNewFrequency] = useState<"hourly" | "daily" | "weekly">("daily");
  const [expandedItem, setExpandedItem] = useState<string | null>(null);

  useEffect(() => {
    fetchWatchList();
    fetchDigest();
  }, []);

  const fetchWatchList = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/watchlist");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

  const fetchDigest = async () => {
    try {
      const res = await fetch("/api/digest");
      if (!res.ok) return;
      const data = await res.json();
      setDigests(data.entries || []);
    } catch {
      // Non-critical
    }
  };

  const addItem = async () => {
    if (!newUrl || !newLabel) return;
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: newUrl,
          label: newLabel,
          frequency: newFrequency,
        }),
      });
      if (res.ok) {
        setNewUrl("");
        setNewLabel("");
        setShowAddForm(false);
        fetchWatchList();
      }
    } catch (err) {
      console.error("Add failed:", err);
    }
  };

  const removeItem = async (id: string) => {
    try {
      const res = await fetch(`/api/watchlist?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setItems((prev) => prev.filter((i) => i.id !== id));
      }
    } catch (err) {
      console.error("Remove failed:", err);
    }
  };

  const toggleActive = async (id: string, active: boolean) => {
    try {
      const res = await fetch("/api/watchlist", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, active }),
      });
      if (res.ok) {
        setItems((prev) =>
          prev.map((i) => (i.id === id ? { ...i, active } : i))
        );
      }
    } catch (err) {
      console.error("Toggle failed:", err);
    }
  };

  const getNextCheck = (item: WatchItem): string => {
    if (!item.lastChecked) return "Pending first check";
    const last = new Date(item.lastChecked);
    const intervals: Record<string, number> = {
      hourly: 60 * 60 * 1000,
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
    };
    const next = new Date(last.getTime() + intervals[item.frequency]);
    const now = new Date();
    if (next <= now) return "Due now";
    const diffMs = next.getTime() - now.getTime();
    const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
    if (diffHours < 1) return "Less than 1 hour";
    if (diffHours < 24) return `In ${diffHours}h`;
    return `In ${Math.floor(diffHours / 24)}d`;
  };

  const itemDigests = (watchItemId: string) =>
    digests.filter((d) => d.watchItemId === watchItemId);

  if (loading) {
    return <div className="loading-text">Loading watch list...</div>;
  }

  if (error) {
    return (
      <div className="error-text">
        Error: {error}
        <br />
        <button className="btn" onClick={fetchWatchList} style={{ marginTop: "1rem" }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <div className="panel-header">
          <h2 className="panel-title">Watched URLs</h2>
          <button
            className="btn btn-primary"
            onClick={() => setShowAddForm(!showAddForm)}
          >
            {showAddForm ? "Cancel" : "Add Watch Item"}
          </button>
        </div>

        {showAddForm && (
          <div
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "flex-end",
              flexWrap: "wrap",
              marginBottom: "1rem",
              paddingBottom: "1rem",
              borderBottom: "1px solid #1e1e2e",
            }}
          >
            <div style={{ flex: 1, minWidth: "200px" }}>
              <label className="text-dim text-sm" style={{ display: "block", marginBottom: "0.25rem" }}>
                URL
              </label>
              <input
                className="search-input"
                placeholder="https://..."
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                style={{ maxWidth: "none" }}
              />
            </div>
            <div style={{ flex: 1, minWidth: "150px" }}>
              <label className="text-dim text-sm" style={{ display: "block", marginBottom: "0.25rem" }}>
                Label
              </label>
              <input
                className="search-input"
                placeholder="Short description..."
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                style={{ maxWidth: "none" }}
              />
            </div>
            <div>
              <label className="text-dim text-sm" style={{ display: "block", marginBottom: "0.25rem" }}>
                Frequency
              </label>
              <select
                className="search-input"
                value={newFrequency}
                onChange={(e) =>
                  setNewFrequency(
                    e.target.value as "hourly" | "daily" | "weekly"
                  )
                }
                style={{ maxWidth: "150px" }}
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <button className="btn btn-primary" onClick={addItem}>
              Add
            </button>
          </div>
        )}

        <span className="text-dim text-sm">{items.length} items watched</span>
      </div>

      {items.length === 0 ? (
        <div className="empty-state-text">
          No watched URLs yet. Add a URL to start monitoring for changes.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {items.map((item) => (
            <div key={item.id} className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.25rem" }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: item.active ? "#34d399" : "#f87171",
                        display: "inline-block",
                      }}
                    />
                    <strong style={{ fontSize: "0.9rem" }}>{item.label}</strong>
                    <span className="chip" style={{ background: "#1e1e2e", color: "#8888a0" }}>
                      {item.frequency}
                    </span>
                  </div>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "#6366f1", fontSize: "0.8rem", textDecoration: "none" }}
                  >
                    {item.url}
                  </a>
                  <div style={{ display: "flex", gap: "1rem", marginTop: "0.5rem" }}>
                    <span className="text-dim text-sm">
                      Last checked:{" "}
                      {item.lastChecked
                        ? new Date(item.lastChecked).toLocaleString()
                        : "Never"}
                    </span>
                    <span className="text-dim text-sm">
                      Next: {getNextCheck(item)}
                    </span>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "0.25rem" }}>
                  <button
                    className="btn"
                    onClick={() => toggleActive(item.id, !item.active)}
                  >
                    {item.active ? "Disable" : "Enable"}
                  </button>
                  <button
                    className="btn"
                    onClick={() =>
                      setExpandedItem(
                        expandedItem === item.id ? null : item.id
                      )
                    }
                  >
                    {expandedItem === item.id ? "Hide" : "Digest"}
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      if (confirm("Remove this watch item?")) {
                        removeItem(item.id);
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>

              {/* Digest preview */}
              {expandedItem === item.id && (
                <div
                  style={{
                    marginTop: "0.75rem",
                    paddingTop: "0.75rem",
                    borderTop: "1px solid #1e1e2e",
                  }}
                >
                  <h4 className="text-dim text-sm" style={{ marginBottom: "0.5rem" }}>
                    Recent Digest Entries
                  </h4>
                  {itemDigests(item.id).length === 0 ? (
                    <p className="text-dim text-sm">No digest entries yet.</p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                      {itemDigests(item.id).map((entry) => (
                        <div
                          key={entry.id}
                          style={{
                            fontSize: "0.8rem",
                            padding: "0.4rem",
                            background: "#0a0a0f",
                            borderRadius: "0.25rem",
                          }}
                        >
                          <span>{entry.summary}</span>
                          <span className="text-dim" style={{ marginLeft: "0.5rem" }}>
                            {new Date(entry.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
