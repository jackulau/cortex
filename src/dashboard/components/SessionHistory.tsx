import React, { useEffect, useState } from "react";

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

/**
 * Session History — browse past conversations with search and expand.
 */
export function SessionHistory() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionTurns, setSessionTurns] = useState<Turn[]>([]);
  const [loadingTurns, setLoadingTurns] = useState(false);

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchSessions = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

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
            {filtered.length} sessions
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
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {filtered.map((session) => (
            <div key={session.sessionId} className="panel">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  cursor: "pointer",
                }}
                onClick={() => expandSession(session.sessionId)}
              >
                <div>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.25rem" }}>
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
                  <span className="text-dim text-sm" style={{ marginTop: "0.25rem", display: "block" }}>
                    {new Date(session.startedAt).toLocaleString()}
                    {session.endedAt &&
                      ` - ${new Date(session.endedAt).toLocaleString()}`}
                  </span>
                </div>
                <button className="btn">
                  {expandedSession === session.sessionId
                    ? "Collapse"
                    : "Expand"}
                </button>
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
          ))}
        </div>
      )}
    </div>
  );
}
