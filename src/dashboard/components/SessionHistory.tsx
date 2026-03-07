import React, { useEffect, useState, useCallback } from "react";

interface Session {
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
  topics: string[];
  turnCount: number;
  summary: string | null;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  turnIndex: number;
}

const DEFAULT_LIMIT = 20;

/** Format a relative time string (e.g., "2 hours ago"). */
function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

/** Determine if a session is likely still active (no endedAt or ended recently). */
function isSessionActive(session: Session): boolean {
  if (!session.endedAt) return true;
  const endedMs = new Date(session.endedAt).getTime();
  const oneHourAgo = Date.now() - 3600000;
  return endedMs > oneHourAgo;
}

/**
 * Session History — browse past conversations with search, expand,
 * session continuity indicators, and cursor-based "Load More" pagination.
 */
export function SessionHistory() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionTurns, setSessionTurns] = useState<Turn[]>([]);
  const [loadingTurns, setLoadingTurns] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [resumedSession, setResumedSession] = useState<string | null>(null);

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions?limit=${DEFAULT_LIMIT}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions(data.data || []);
      setCursor(data.cursor ?? null);
      setHasMore(data.hasMore ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/sessions?limit=${DEFAULT_LIMIT}&cursor=${encodeURIComponent(cursor)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions((prev) => [...prev, ...(data.data || [])]);
      setCursor(data.cursor ?? null);
      setHasMore(data.hasMore ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const expandSession = async (sessionId: string) => {
    if (expandedSession === sessionId) {
      setExpandedSession(null);
      setSessionTurns([]);
      return;
    }

    setExpandedSession(sessionId);
    setLoadingTurns(true);
    try {
      const res = await fetch(`/api/sessions?id=${sessionId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessionTurns(data.turns || []);
    } catch {
      setSessionTurns([]);
    } finally {
      setLoadingTurns(false);
    }
  };

  const resumeSession = (sessionId: string) => {
    setResumedSession(sessionId);
    // Dispatch a custom event that the chat UI can listen for
    window.dispatchEvent(
      new CustomEvent("cortex:resume-session", { detail: { sessionId } })
    );
  };

  // Filter sessions by search
  let filtered = sessions;
  if (searchTerm) {
    const term = searchTerm.toLowerCase();
    filtered = filtered.filter(
      (s) =>
        (s.summary && s.summary.toLowerCase().includes(term)) ||
        s.topics.some((t) => t.toLowerCase().includes(term)) ||
        s.sessionId.toLowerCase().includes(term)
    );
  }

  if (loading) {
    return <div className="loading-text">Loading sessions...</div>;
  }

  if (error) {
    return (
      <div className="error-text">
        Error: {error}
        <br />
        <button className="btn" onClick={fetchSessions} style={{ marginTop: "1rem" }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <input
            className="search-input"
            placeholder="Search sessions by topic, summary, or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <span className="text-dim text-sm">
            {filtered.length} sessions{hasMore ? "+" : ""}
          </span>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state-text">
          {sessions.length === 0
            ? "No conversation history yet. Start chatting with Cortex to see sessions here."
            : "No sessions match your search."}
        </div>
      ) : (
        <div
          className="timeline"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            position: "relative",
            paddingLeft: "1.5rem",
          }}
        >
          {/* Vertical timeline connector */}
          <div
            style={{
              position: "absolute",
              left: "0.5rem",
              top: "0.5rem",
              bottom: "0.5rem",
              width: "2px",
              background: "#1e1e2e",
            }}
          />

          {filtered.map((session) => {
            const active = isSessionActive(session);
            const isResumed = resumedSession === session.sessionId;
            const lastActivity = session.endedAt || session.startedAt;

            return (
              <div
                key={session.sessionId}
                className="panel"
                style={{
                  position: "relative",
                  borderColor: active ? "#6366f1" : isResumed ? "#34d399" : undefined,
                }}
              >
                {/* Timeline dot */}
                <div
                  style={{
                    position: "absolute",
                    left: "-1.25rem",
                    top: "1rem",
                    width: "10px",
                    height: "10px",
                    borderRadius: "50%",
                    background: active ? "#6366f1" : "#1e1e2e",
                    border: `2px solid ${active ? "#6366f1" : "#8888a0"}`,
                    boxShadow: active ? "0 0 6px rgba(99, 102, 241, 0.5)" : "none",
                  }}
                />

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    cursor: "pointer",
                  }}
                  onClick={() => expandSession(session.sessionId)}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.25rem", flexWrap: "wrap" }}>
                      {active && (
                        <span
                          className="chip"
                          style={{
                            background: "#1a2e1a",
                            color: "#4ade80",
                            borderColor: "#166534",
                            animation: "pulse-glow 2s infinite",
                          }}
                        >
                          Active
                        </span>
                      )}
                      <strong style={{ fontSize: "0.9rem" }}>
                        {session.summary
                          ? session.summary.slice(0, 80)
                          : `Session ${session.sessionId.slice(0, 8)}`}
                      </strong>
                      <span className="chip" style={{ background: "#1e1e2e", color: "#8888a0" }}>
                        {session.turnCount} turns
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                      {session.topics.map((topic) => (
                        <span
                          key={topic}
                          className="chip chip-note"
                        >
                          {topic}
                        </span>
                      ))}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        gap: "1rem",
                        marginTop: "0.25rem",
                        alignItems: "center",
                      }}
                    >
                      <span className="text-dim text-sm">
                        {new Date(session.startedAt).toLocaleString()}
                        {session.endedAt &&
                          ` - ${new Date(session.endedAt).toLocaleString()}`}
                      </span>
                      <span className="text-dim text-sm" style={{ color: active ? "#4ade80" : "#8888a0" }}>
                        Last activity: {relativeTime(lastActivity)}
                      </span>
                    </div>
                    <span className="text-dim text-sm" style={{ display: "block", marginTop: "0.15rem" }}>
                      ID: {session.sessionId.slice(0, 12)}...
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: "0.25rem", flexShrink: 0 }}>
                    <button
                      className="btn btn-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        resumeSession(session.sessionId);
                      }}
                      title="Resume this session in the chat"
                      style={
                        isResumed
                          ? { background: "#34d399", borderColor: "#34d399", color: "#000" }
                          : undefined
                      }
                    >
                      {isResumed ? "Resumed" : "Resume"}
                    </button>
                    <button className="btn">
                      {expandedSession === session.sessionId
                        ? "Collapse"
                        : "Expand"}
                    </button>
                  </div>
                </div>

                {/* Expanded conversation */}
                {expandedSession === session.sessionId && (
                  <div
                    style={{
                      marginTop: "0.75rem",
                      paddingTop: "0.75rem",
                      borderTop: "1px solid #1e1e2e",
                    }}
                  >
                    {loadingTurns ? (
                      <p className="text-dim text-sm">Loading conversation...</p>
                    ) : sessionTurns.length === 0 ? (
                      <p className="text-dim text-sm">No turns recorded.</p>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "0.5rem",
                          maxHeight: "400px",
                          overflowY: "auto",
                        }}
                      >
                        {sessionTurns.map((turn, i) => (
                          <div
                            key={i}
                            style={{
                              padding: "0.5rem 0.75rem",
                              borderRadius: "0.375rem",
                              background:
                                turn.role === "user"
                                  ? "#1a1a2e"
                                  : "#12121c",
                              borderLeft: `3px solid ${turn.role === "user" ? "#6366f1" : "#34d399"}`,
                            }}
                          >
                            <div
                              style={{
                                fontSize: "0.7rem",
                                fontWeight: 600,
                                textTransform: "uppercase",
                                color: "#8888a0",
                                marginBottom: "0.25rem",
                              }}
                            >
                              {turn.role === "user" ? "You" : "Cortex"}
                              <span style={{ marginLeft: "0.5rem", fontWeight: 400 }}>
                                {new Date(turn.timestamp).toLocaleTimeString()}
                              </span>
                            </div>
                            <p
                              style={{
                                fontSize: "0.8rem",
                                lineHeight: 1.5,
                                margin: 0,
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              {turn.content}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
