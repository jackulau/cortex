import React, { useEffect, useState, useCallback } from "react";
import type { SemanticEntry } from "@/shared/types";

const TYPES = ["fact", "preference", "event", "note", "summary"] as const;
const SOURCES = ["user", "consolidated", "research"] as const;
const DEFAULT_LIMIT = 50;

/** Visual indicator for memory relevance score. */
function RelevanceBadge({ score }: { score: number }) {
  // Clamp to [0, 2] range for display
  const clamped = Math.max(0, Math.min(score, 2));
  // Map score to opacity: 0.3 (low) to 1.0 (high)
  const opacity = 0.3 + (clamped / 2) * 0.7;
  // Color: green for high relevance, yellow for medium, red for low
  const color =
    clamped >= 1.0 ? "#4ade80" : clamped >= 0.5 ? "#facc15" : "#f87171";

  return (
    <span
      className="chip"
      title={`Relevance: ${score.toFixed(2)}`}
      style={{
        background: color,
        color: "#000",
        opacity,
        fontSize: "0.7rem",
        fontWeight: 600,
      }}
    >
      {score.toFixed(2)}
    </span>
  );
}

/** Visual indicator for similarity score from search results. */
function SimilarityBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = score > 0.8 ? "#4ade80" : score >= 0.6 ? "#facc15" : "#fb923c";
  const barWidth = `${pct}%`;

  return (
    <span
      className="score-badge"
      title={`Similarity: ${score.toFixed(3)} (${pct}%)`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.35rem",
        fontSize: "0.7rem",
        fontWeight: 600,
        color,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: "40px",
          height: "6px",
          background: "#1e1e2e",
          borderRadius: "3px",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            display: "block",
            width: barWidth,
            height: "100%",
            background: color,
            borderRadius: "3px",
          }}
        />
      </span>
      {pct}%
    </span>
  );
}

/** Inline tag editor with add/remove chip functionality. */
function TagEditor({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState("");

  const addTag = () => {
    const trimmed = input.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap", alignItems: "center" }}>
      {tags.map((tag) => (
        <span
          key={tag}
          className="chip"
          style={{
            background: "#1e1e2e",
            color: "#8888a0",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
          }}
          onClick={() => removeTag(tag)}
          title="Click to remove"
        >
          {tag}
          <span style={{ color: "#f87171", fontWeight: 700 }}>x</span>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            addTag();
          }
        }}
        placeholder="Add tag..."
        style={{
          padding: "0.15rem 0.4rem",
          background: "#0a0a0f",
          border: "1px solid #1e1e2e",
          borderRadius: "999px",
          color: "#e4e4ef",
          fontSize: "0.7rem",
          width: "80px",
          outline: "none",
        }}
      />
    </div>
  );
}

/** Extended memory type that can include a similarity score from search. */
interface MemoryWithScore extends SemanticEntry {
  score?: number;
  matchType?: string;
}

/**
 * Memory Explorer — list/grid view of all semantic memories
 * with search, filter, inline editing, and cursor-based "Load More" pagination.
 */
export function MemoryExplorer() {
  const [memories, setMemories] = useState<MemoryWithScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isSearchMode, setIsSearchMode] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editType, setEditType] = useState<string>("fact");
  const [editTags, setEditTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Archive state
  const [archivedCount, setArchivedCount] = useState(0);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    fetchMemories();
    fetchArchivedCount();
  }, [showArchived]);

  const fetchArchivedCount = async () => {
    try {
      const res = await fetch("/api/memories/archived-count");
      if (res.ok) {
        const data = await res.json();
        setArchivedCount(data.count ?? 0);
      }
    } catch {
      // Non-critical — archive count is informational only
    }
  };

  const fetchMemories = async () => {
    setLoading(true);
    setError(null);
    setIsSearchMode(false);
    try {
      const url = showArchived
        ? `/api/memories?limit=${DEFAULT_LIMIT}&includeArchived=true`
        : `/api/memories?limit=${DEFAULT_LIMIT}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMemories(data.data || []);
      setCursor(data.cursor ?? null);
      setHasMore(data.hasMore ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

  const searchMemories = async (query: string) => {
    if (!query.trim()) {
      fetchMemories();
      return;
    }
    setLoading(true);
    setError(null);
    setIsSearchMode(true);
    try {
      const res = await fetch(
        `/api/memories/search?q=${encodeURIComponent(query)}&limit=20`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMemories(data.results || []);
      setCursor(null);
      setHasMore(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search");
    } finally {
      setLoading(false);
    }
  };

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/memories?limit=${DEFAULT_LIMIT}&cursor=${encodeURIComponent(cursor)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMemories((prev) => [...prev, ...(data.data || [])]);
      setCursor(data.cursor ?? null);
      setHasMore(data.hasMore ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const deleteMemory = async (id: string) => {
    try {
      const res = await fetch(`/api/memories?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setMemories((prev) => prev.filter((m) => m.id !== id));
      }
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const startEdit = (memory: MemoryWithScore) => {
    setEditingId(memory.id);
    setEditContent(memory.content);
    setEditType(memory.type);
    setEditTags([...memory.tags]);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditContent("");
    setEditType("fact");
    setEditTags([]);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    try {
      const res = await fetch("/api/memories", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          content: editContent,
          type: editType,
          tags: editTags,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Update local state with the returned memory
      if (data.memory) {
        setMemories((prev) =>
          prev.map((m) =>
            m.id === editingId
              ? { ...data.memory, score: m.score, matchType: m.matchType }
              : m
          )
        );
      }
      cancelEdit();
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setSaving(false);
    }
  };

  // Handle search with debounce-like behavior on Enter
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      searchMemories(searchTerm);
    }
  };

  // Apply client-side filters on loaded data (only in list mode, not search mode)
  let filtered = memories;
  if (!isSearchMode) {
    if (typeFilter !== "all") {
      filtered = filtered.filter((m) => m.type === typeFilter);
    }
    if (sourceFilter !== "all") {
      filtered = filtered.filter((m) => m.source === sourceFilter);
    }
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.content.toLowerCase().includes(term) ||
          m.tags.some((t) => t.toLowerCase().includes(term))
      );
    }
  }

  if (loading) {
    return <div className="loading-text">Loading memories...</div>;
  }

  if (error) {
    return (
      <div className="error-text">
        Error: {error}
        <br />
        <button className="btn" onClick={fetchMemories} style={{ marginTop: "1rem" }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* Search and filters */}
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="search-input"
            placeholder="Search memories... (Enter for semantic search)"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {isSearchMode && (
            <button className="btn" onClick={fetchMemories}>
              Clear Search
            </button>
          )}
          <span className="text-dim text-sm">
            {filtered.length} memories{hasMore ? "+" : ""}
            {archivedCount > 0 && <> | {archivedCount} archived</>}
            {isSearchMode ? " (search results)" : ""}
          </span>
          {archivedCount > 0 && (
            <button
              className={`btn ${showArchived ? "btn-primary" : ""}`}
              onClick={() => {
                setShowArchived((prev) => !prev);
                setCursor(null);
              }}
            >
              {showArchived ? "Hide Archived" : "Show Archived"}
            </button>
          )}
        </div>

        <div style={{ display: "flex", gap: "1rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
            <span className="text-dim text-sm" style={{ marginRight: "0.25rem" }}>
              Type:
            </span>
            {["all", ...TYPES].map((type) => (
              <button
                key={type}
                className={`btn ${typeFilter === type ? "btn-primary" : ""}`}
                onClick={() => setTypeFilter(type)}
              >
                {type}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
            <span className="text-dim text-sm" style={{ marginRight: "0.25rem" }}>
              Source:
            </span>
            {["all", ...SOURCES].map((source) => (
              <button
                key={source}
                className={`btn ${sourceFilter === source ? "btn-primary" : ""}`}
                onClick={() => setSourceFilter(source)}
              >
                {source}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Memory list */}
      {filtered.length === 0 ? (
        <div className="empty-state-text">
          {memories.length === 0
            ? "No memories yet. Start chatting with Cortex to build your knowledge base."
            : "No memories match your filters."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {filtered.map((memory) => {
            const isEditing = editingId === memory.id;

            return (
              <div
                key={memory.id}
                className="panel"
                style={isEditing ? { borderColor: "#6366f1" } : undefined}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                    {isEditing ? (
                      <select
                        value={editType}
                        onChange={(e) => setEditType(e.target.value)}
                        style={{
                          padding: "0.2rem 0.4rem",
                          background: "#0a0a0f",
                          border: "1px solid #6366f1",
                          borderRadius: "0.375rem",
                          color: "#e4e4ef",
                          fontSize: "0.7rem",
                          outline: "none",
                        }}
                      >
                        {TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={`chip chip-${memory.type}`}>
                        {memory.type}
                      </span>
                    )}
                    <span className="chip" style={{ background: "#1e1e2e", color: "#8888a0" }}>
                      {memory.source}
                    </span>
                    <RelevanceBadge score={memory.relevanceScore ?? 1.0} />
                    {isSearchMode && memory.score !== undefined && (
                      <SimilarityBadge score={memory.score} />
                    )}
                    {memory.archivedAt && (
                      <span
                        className="chip"
                        style={{ background: "#7f1d1d", color: "#fca5a5", fontSize: "0.7rem" }}
                      >
                        Archived
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "0.25rem" }}>
                    {isEditing ? (
                      <>
                        <button
                          className="btn btn-primary"
                          onClick={saveEdit}
                          disabled={saving}
                        >
                          {saving ? "Saving..." : "Save"}
                        </button>
                        <button
                          className="btn"
                          onClick={cancelEdit}
                          disabled={saving}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn"
                          onClick={() => startEdit(memory)}
                          title="Edit memory"
                        >
                          Edit
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => {
                            if (confirm("Delete this memory?")) {
                              deleteMemory(memory.id);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {isEditing ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    style={{
                      width: "100%",
                      minHeight: "80px",
                      padding: "0.5rem",
                      background: "#0a0a0f",
                      border: "1px solid #6366f1",
                      borderRadius: "0.375rem",
                      color: "#e4e4ef",
                      fontSize: "0.875rem",
                      lineHeight: 1.5,
                      resize: "vertical",
                      outline: "none",
                      fontFamily: "inherit",
                    }}
                  />
                ) : (
                  <p style={{ fontSize: "0.875rem", lineHeight: 1.5, margin: 0 }}>
                    {memory.content}
                  </p>
                )}

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginTop: "0.5rem",
                  }}
                >
                  {isEditing ? (
                    <TagEditor tags={editTags} onChange={setEditTags} />
                  ) : (
                    <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                      {memory.tags.map((tag) => (
                        <span
                          key={tag}
                          className="chip"
                          style={{ background: "#1e1e2e", color: "#8888a0" }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  <span className="text-dim text-sm">
                    {new Date(memory.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Load More */}
      {hasMore && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginTop: "1rem",
          }}
        >
          <button
            className="btn"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      )}
    </div>
  );
}
