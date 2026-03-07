import React, { useState, useEffect, useRef, useCallback } from "react";

// ── WebSocket message types ─────────────────────────────────────
interface WsChatMessage {
  type: "chat";
  content: string;
}

interface WsThinkingMessage {
  type: "thinking";
  content: string;
}

interface WsToolCallMessage {
  type: "tool_call";
  tool: string;
  args: Record<string, unknown>;
}

interface WsToolResultMessage {
  type: "tool_result";
  tool: string;
  result: unknown;
}

interface WsMemoryFormedMessage {
  type: "memory_formed";
  memory: {
    content: string;
    type: string;
    tags?: string[];
  };
}

interface WsResponseMessage {
  type: "response";
  content: string;
  done: boolean;
}

interface WsErrorMessage {
  type: "error";
  message: string;
}

type WsIncomingMessage =
  | WsThinkingMessage
  | WsToolCallMessage
  | WsToolResultMessage
  | WsMemoryFormedMessage
  | WsResponseMessage
  | WsErrorMessage;

// ── Chat display types ──────────────────────────────────────────

interface ChatToolCall {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
}

interface ChatMemoryEvent {
  content: string;
  type: string;
  tags?: string[];
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  toolCalls?: ChatToolCall[];
  memoryEvents?: ChatMemoryEvent[];
  thinking?: string;
  isStreaming?: boolean;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting";

// ── Constants ───────────────────────────────────────────────────
const RECONNECT_BASE_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * ChatInterface — real-time WebSocket chat with streaming responses,
 * tool call visibility, and memory formation indicators.
 */
export function ChatInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set());

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track current streaming assistant message id for appending chunks
  const streamingMsgIdRef = useRef<string | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Build WS URL
  const getWsUrl = useCallback(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const base = `${protocol}//${window.location.host}/ws/chat`;
    // Pass auth token if the page was loaded with one in the URL
    const pageParams = new URLSearchParams(window.location.search);
    const token = pageParams.get("token");
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }, []);

  // ── WebSocket connection management ──────────────────────────
  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    setConnectionStatus("connecting");
    const ws = new WebSocket(getWsUrl());

    ws.addEventListener("open", () => {
      setConnectionStatus("connected");
      reconnectAttemptRef.current = 0;
    });

    ws.addEventListener("message", (event) => {
      try {
        const msg: WsIncomingMessage = JSON.parse(event.data);
        handleIncomingMessage(msg);
      } catch {
        // Ignore non-JSON frames
      }
    });

    ws.addEventListener("close", () => {
      setConnectionStatus("disconnected");
      wsRef.current = null;
      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // error events don't carry useful info; close event will fire next
    });

    wsRef.current = ws;
  }, [getWsUrl]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectAttemptRef.current >= MAX_RECONNECT_ATTEMPTS) return;

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttemptRef.current),
      MAX_RECONNECT_DELAY_MS
    );

    setConnectionStatus("reconnecting");
    reconnectAttemptRef.current++;

    reconnectTimerRef.current = setTimeout(() => {
      connect();
    }, delay);
  }, [connect]);

  // Connect on mount, cleanup on unmount
  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  // ── Handle incoming WebSocket messages ───────────────────────

  const handleIncomingMessage = useCallback((msg: WsIncomingMessage) => {
    switch (msg.type) {
      case "thinking":
        // Update or create the streaming assistant message with thinking content
        ensureStreamingMessage((current) => ({
          ...current,
          thinking: (current.thinking || "") + msg.content,
        }));
        break;

      case "tool_call":
        ensureStreamingMessage((current) => ({
          ...current,
          toolCalls: [
            ...(current.toolCalls || []),
            { tool: msg.tool, args: msg.args },
          ],
        }));
        break;

      case "tool_result":
        // Attach result to the most recent matching tool call
        setMessages((prev) => {
          const updated = [...prev];
          const streamIdx = updated.findIndex(
            (m) => m.id === streamingMsgIdRef.current
          );
          if (streamIdx === -1) return prev;
          const current = { ...updated[streamIdx] };
          const toolCalls = [...(current.toolCalls || [])];
          // Find last tool call with matching name that has no result yet
          for (let i = toolCalls.length - 1; i >= 0; i--) {
            if (toolCalls[i].tool === msg.tool && toolCalls[i].result === undefined) {
              toolCalls[i] = { ...toolCalls[i], result: msg.result };
              break;
            }
          }
          current.toolCalls = toolCalls;
          updated[streamIdx] = current;
          return updated;
        });
        break;

      case "memory_formed":
        ensureStreamingMessage((current) => ({
          ...current,
          memoryEvents: [
            ...(current.memoryEvents || []),
            {
              content: msg.memory.content,
              type: msg.memory.type,
              tags: msg.memory.tags,
            },
          ],
        }));
        break;

      case "response":
        if (msg.done) {
          // Finalize the streaming message
          setMessages((prev) =>
            prev.map((m) =>
              m.id === streamingMsgIdRef.current
                ? { ...m, isStreaming: false }
                : m
            )
          );
          streamingMsgIdRef.current = null;
        } else {
          // Append text chunk
          ensureStreamingMessage((current) => ({
            ...current,
            content: current.content + msg.content,
          }));
        }
        break;

      case "error":
        ensureStreamingMessage((current) => ({
          ...current,
          content: current.content + `\n[Error: ${msg.message}]`,
          isStreaming: false,
        }));
        streamingMsgIdRef.current = null;
        break;
    }
  }, []);

  /**
   * Ensure a streaming assistant message exists. If one is active, update it
   * with the provided updater. If not, create a new one.
   */
  const ensureStreamingMessage = (
    updater: (current: ChatMessage) => ChatMessage
  ) => {
    setMessages((prev) => {
      if (streamingMsgIdRef.current) {
        return prev.map((m) =>
          m.id === streamingMsgIdRef.current ? updater(m) : m
        );
      }

      // No current streaming message — create one
      const newId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      streamingMsgIdRef.current = newId;
      const newMsg: ChatMessage = {
        id: newId,
        role: "assistant",
        content: "",
        timestamp: new Date(),
        isStreaming: true,
      };
      return [...prev, updater(newMsg)];
    });
  };

  // ── Send message ─────────────────────────────────────────────

  const sendMessage = useCallback(() => {
    const text = inputValue.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      content: text,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputValue("");

    const payload: WsChatMessage = { type: "chat", content: text };
    wsRef.current.send(JSON.stringify(payload));

    // Focus input after sending
    inputRef.current?.focus();
  }, [inputValue]);

  // ── Toggle tool call expansion ───────────────────────────────

  const toggleToolCall = (msgId: string, toolIdx: number) => {
    const key = `${msgId}-${toolIdx}`;
    setExpandedToolCalls((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // ── Render ───────────────────────────────────────────────────

  const isInputDisabled =
    connectionStatus !== "connected" ||
    streamingMsgIdRef.current !== null;

  return (
    <div className="chat-interface">
      {/* Connection status bar */}
      <div className={`chat-status chat-status-${connectionStatus}`}>
        <span className="chat-status-dot" />
        <span className="chat-status-text">
          {connectionStatus === "connected" && "Connected"}
          {connectionStatus === "connecting" && "Connecting..."}
          {connectionStatus === "reconnecting" &&
            `Reconnecting (attempt ${reconnectAttemptRef.current})...`}
          {connectionStatus === "disconnected" && "Disconnected"}
        </span>
        {connectionStatus === "disconnected" && (
          <button className="btn" onClick={connect} style={{ marginLeft: "0.5rem" }}>
            Reconnect
          </button>
        )}
      </div>

      {/* Messages area */}
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty-state">
            <p style={{ fontSize: "1.1rem", fontWeight: 500 }}>Chat with Cortex</p>
            <p className="text-dim text-sm">
              Send a message to start a conversation. You will see tool calls
              and memory formation in real-time.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-message chat-message-${msg.role}`}
          >
            <div className="chat-message-header">
              <span className="chat-message-sender">
                {msg.role === "user" ? "You" : "Cortex"}
              </span>
              <span className="text-dim text-sm">
                {msg.timestamp.toLocaleTimeString()}
              </span>
            </div>

            {/* Thinking indicator */}
            {msg.thinking && (
              <div className="chat-thinking">
                <span className="chat-thinking-label">Thinking</span>
                <span className="chat-thinking-content">{msg.thinking}</span>
              </div>
            )}

            {/* Tool calls */}
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <div className="chat-tool-calls">
                {msg.toolCalls.map((tc, idx) => {
                  const key = `${msg.id}-${idx}`;
                  const isExpanded = expandedToolCalls.has(key);
                  return (
                    <div key={key} className="chat-tool-call">
                      <button
                        className="chat-tool-call-header"
                        onClick={() => toggleToolCall(msg.id, idx)}
                      >
                        <span className="chat-tool-call-name">{tc.tool}</span>
                        <span className="chat-tool-call-status">
                          {tc.result !== undefined ? "completed" : "running..."}
                        </span>
                        <span className="chat-tool-call-toggle">
                          {isExpanded ? "[-]" : "[+]"}
                        </span>
                      </button>
                      {isExpanded && (
                        <div className="chat-tool-call-details">
                          <div className="chat-tool-call-section">
                            <span className="text-dim text-sm">Arguments:</span>
                            <pre className="chat-code-block">
                              {JSON.stringify(tc.args, null, 2)}
                            </pre>
                          </div>
                          {tc.result !== undefined && (
                            <div className="chat-tool-call-section">
                              <span className="text-dim text-sm">Result:</span>
                              <pre className="chat-code-block">
                                {typeof tc.result === "string"
                                  ? tc.result
                                  : JSON.stringify(tc.result, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Memory formed events */}
            {msg.memoryEvents && msg.memoryEvents.length > 0 && (
              <div className="chat-memory-events">
                {msg.memoryEvents.map((mem, idx) => (
                  <div key={idx} className="chat-memory-event">
                    <span className="chat-memory-event-icon">*</span>
                    <span className="chat-memory-event-text">
                      Memory formed ({mem.type}): {mem.content}
                    </span>
                    {mem.tags && mem.tags.length > 0 && (
                      <span className="chat-memory-event-tags">
                        {mem.tags.map((tag) => (
                          <span key={tag} className="chip" style={{ background: "#1e1e2e", color: "#8888a0", marginLeft: "0.25rem" }}>
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Message content */}
            {msg.content && (
              <div className="chat-message-content">
                {msg.content}
                {msg.isStreaming && <span className="chat-cursor" />}
              </div>
            )}

            {/* Empty streaming indicator */}
            {msg.isStreaming && !msg.content && !msg.thinking && (!msg.toolCalls || msg.toolCalls.length === 0) && (
              <div className="chat-typing-indicator">
                <span /><span /><span />
              </div>
            )}
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="chat-input-area">
        <textarea
          ref={inputRef}
          className="chat-input"
          placeholder={
            connectionStatus !== "connected"
              ? "Waiting for connection..."
              : "Message Cortex..."
          }
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          disabled={connectionStatus !== "connected"}
          rows={1}
        />
        <button
          className="btn btn-primary chat-send-btn"
          onClick={sendMessage}
          disabled={isInputDisabled || !inputValue.trim()}
        >
          Send
        </button>
      </div>

      <style>{chatStyles}</style>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────

const chatStyles = `
  .chat-interface {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 120px);
    max-height: 800px;
    background: #0a0a0f;
    border: 1px solid #1e1e2e;
    border-radius: 0.5rem;
    overflow: hidden;
  }

  /* Connection status bar */
  .chat-status {
    display: flex;
    align-items: center;
    padding: 0.4rem 0.75rem;
    font-size: 0.75rem;
    border-bottom: 1px solid #1e1e2e;
  }

  .chat-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 0.5rem;
    flex-shrink: 0;
  }

  .chat-status-connected .chat-status-dot { background: #34d399; }
  .chat-status-connecting .chat-status-dot { background: #fbbf24; animation: pulse 1.5s infinite; }
  .chat-status-reconnecting .chat-status-dot { background: #fbbf24; animation: pulse 1.5s infinite; }
  .chat-status-disconnected .chat-status-dot { background: #f87171; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  /* Messages area */
  .chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .chat-empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: #8888a0;
  }

  /* Message bubbles */
  .chat-message {
    max-width: 85%;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .chat-message-user {
    align-self: flex-end;
  }

  .chat-message-assistant {
    align-self: flex-start;
  }

  .chat-message-header {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }

  .chat-message-user .chat-message-header {
    flex-direction: row-reverse;
  }

  .chat-message-sender {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    color: #8888a0;
  }

  .chat-message-content {
    padding: 0.6rem 0.85rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .chat-message-user .chat-message-content {
    background: #6366f1;
    color: #fff;
    border-bottom-right-radius: 0.125rem;
  }

  .chat-message-assistant .chat-message-content {
    background: #14141f;
    color: #e4e4ef;
    border: 1px solid #1e1e2e;
    border-bottom-left-radius: 0.125rem;
  }

  /* Streaming cursor */
  .chat-cursor {
    display: inline-block;
    width: 2px;
    height: 1em;
    background: #6366f1;
    margin-left: 2px;
    animation: blink 1s step-end infinite;
    vertical-align: text-bottom;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  /* Typing indicator */
  .chat-typing-indicator {
    display: flex;
    gap: 4px;
    padding: 0.6rem 0.85rem;
    background: #14141f;
    border: 1px solid #1e1e2e;
    border-radius: 0.5rem;
    width: fit-content;
  }

  .chat-typing-indicator span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #8888a0;
    animation: typing-bounce 1.4s infinite ease-in-out;
  }

  .chat-typing-indicator span:nth-child(1) { animation-delay: 0s; }
  .chat-typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
  .chat-typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes typing-bounce {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
    40% { transform: scale(1); opacity: 1; }
  }

  /* Thinking block */
  .chat-thinking {
    padding: 0.4rem 0.75rem;
    background: #1a1a2e;
    border-left: 3px solid #6366f1;
    border-radius: 0.25rem;
    font-size: 0.8rem;
    color: #8888a0;
    font-style: italic;
  }

  .chat-thinking-label {
    font-weight: 600;
    color: #6366f1;
    margin-right: 0.5rem;
    font-style: normal;
  }

  .chat-thinking-content {
    white-space: pre-wrap;
  }

  /* Tool calls */
  .chat-tool-calls {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .chat-tool-call {
    border: 1px solid #1e1e2e;
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .chat-tool-call-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.65rem;
    background: #14141f;
    border: none;
    color: #e4e4ef;
    font-size: 0.8rem;
    cursor: pointer;
    width: 100%;
    text-align: left;
    transition: background 0.15s;
  }

  .chat-tool-call-header:hover {
    background: #1a1a2e;
  }

  .chat-tool-call-name {
    font-weight: 600;
    color: #6366f1;
  }

  .chat-tool-call-status {
    font-size: 0.7rem;
    color: #8888a0;
  }

  .chat-tool-call-toggle {
    margin-left: auto;
    color: #8888a0;
    font-family: monospace;
  }

  .chat-tool-call-details {
    padding: 0.5rem 0.65rem;
    background: #0a0a0f;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .chat-tool-call-section {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .chat-code-block {
    font-family: "SF Mono", "Fira Code", monospace;
    font-size: 0.75rem;
    background: #14141f;
    border: 1px solid #1e1e2e;
    border-radius: 0.25rem;
    padding: 0.5rem;
    overflow-x: auto;
    margin: 0;
    color: #e4e4ef;
    max-height: 200px;
    overflow-y: auto;
  }

  /* Memory formed events */
  .chat-memory-events {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .chat-memory-event {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.65rem;
    background: #1a3b2f;
    border: 1px solid #2d5a47;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    color: #34d399;
    flex-wrap: wrap;
  }

  .chat-memory-event-icon {
    font-weight: 700;
    font-size: 0.9rem;
  }

  .chat-memory-event-text {
    flex: 1;
  }

  .chat-memory-event-tags {
    display: flex;
    gap: 0.15rem;
    flex-wrap: wrap;
  }

  /* Input area */
  .chat-input-area {
    display: flex;
    gap: 0.5rem;
    padding: 0.75rem;
    border-top: 1px solid #1e1e2e;
    background: #14141f;
    align-items: flex-end;
  }

  .chat-input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    background: #0a0a0f;
    border: 1px solid #1e1e2e;
    border-radius: 0.375rem;
    color: #e4e4ef;
    font-size: 0.875rem;
    font-family: inherit;
    outline: none;
    resize: none;
    min-height: 38px;
    max-height: 120px;
    transition: border-color 0.15s;
  }

  .chat-input:focus {
    border-color: #6366f1;
  }

  .chat-input::placeholder {
    color: #8888a0;
  }

  .chat-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .chat-send-btn {
    flex-shrink: 0;
    min-width: 60px;
    height: 38px;
  }

  .chat-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Responsive */
  @media (max-width: 640px) {
    .chat-interface {
      height: calc(100vh - 100px);
      max-height: none;
      border-radius: 0;
      border-left: none;
      border-right: none;
    }

    .chat-message {
      max-width: 95%;
    }

    .chat-input-area {
      padding: 0.5rem;
    }
  }
`;
