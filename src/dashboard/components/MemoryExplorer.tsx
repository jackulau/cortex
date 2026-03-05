import React, { useEffect, useState } from "react";
import type { SemanticEntry } from "@/shared/types";

const TYPES = ["fact", "preference", "event", "note", "summary"] as const;
const SOURCES = ["user", "consolidated", "research"] as const;
const PAGE_SIZE = 20;

/**
 * Memory Explorer — list/grid view of all semantic memories
 * with search, filter, and CRUD operations.
 */
export function MemoryExplorer() {
  const [memories, setMemories] = useState<SemanticEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  useEffect(() => {
    fetchMemories();
  }, []);

  const fetchMemories = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/memories");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMemories(data.memories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

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

  // Apply filters
  let filtered = memories;
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

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

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
            placeholder="Search memories..."
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setPage(0);
            }}
          />
          <span className="text-dim text-sm">
            {filtered.length} memories
          </span>
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
                onClick={() => {
                  setTypeFilter(type);
                  setPage(0);
                }}
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
                onClick={() => {
                  setSourceFilter(source);
                  setPage(0);
                }}
              >
                {source}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Memory list */}
      {paginated.length === 0 ? (
        <div className="empty-state-text">
          {memories.length === 0
            ? "No memories yet. Start chatting with Cortex to build your knowledge base."
            : "No memories match your filters."}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {paginated.map((memory) => (
            <div key={memory.id} className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span className={`chip chip-${memory.type}`}>
                    {memory.type}
                  </span>
                  <span className="chip" style={{ background: "#1e1e2e", color: "#8888a0" }}>
                    {memory.source}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "0.25rem" }}>
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
                </div>
              </div>

              <p style={{ fontSize: "0.875rem", lineHeight: 1.5, margin: 0 }}>
                {memory.content}
              </p>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: "0.5rem",
                }}
              >
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
                <span className="text-dim text-sm">
                  {new Date(memory.createdAt).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: "0.5rem",
            marginTop: "1rem",
          }}
        >
          <button
            className="btn"
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span className="text-dim text-sm" style={{ alignSelf: "center" }}>
            Page {page + 1} of {totalPages}
          </span>
          <button
            className="btn"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
