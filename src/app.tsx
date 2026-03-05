import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import React, { useRef, useEffect } from "react";

export function Chat() {
  const agent = useAgent({ agent: "CortexAgent" });

  const { messages, sendMessage, status } = useAgentChat({ agent });
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    const input = inputRef.current;
    if (!input || !input.value.trim()) return;
    sendMessage({ text: input.value });
    input.value = "";
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Cortex</h1>
        <span className="subtitle">Personal AI with persistent memory</span>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            <p>Hello! I'm Cortex, your AI with persistent memory.</p>
            <p>I remember everything across conversations. Try telling me your name.</p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-role">
              {msg.role === "user" ? "You" : "Cortex"}
            </div>
            <div className="message-content">
              {msg.parts
                ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
                .map((p, i) => <span key={i}>{p.text}</span>)}
            </div>

            {/* Show tool invocations */}
            {msg.parts
              ?.filter((p): p is any => p.type === "tool-invocation")
              .map((inv: any) => (
                <div key={inv.toolInvocation.toolCallId} className="tool-call">
                  <span className="tool-name">{inv.toolInvocation.toolName}</span>
                  {inv.toolInvocation.state === "result" && (
                    <span className="tool-result">
                      {typeof inv.toolInvocation.result === "string"
                        ? inv.toolInvocation.result
                        : JSON.stringify(inv.toolInvocation.result)}
                    </span>
                  )}
                </div>
              ))}
          </div>
        ))}

        {status === "streaming" && (
          <div className="message assistant streaming">
            <div className="message-role">Cortex</div>
            <div className="typing-indicator">
              <span></span><span></span><span></span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <input
          ref={inputRef}
          type="text"
          placeholder="Message Cortex..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={status === "streaming"}
        />
        <button
          onClick={handleSend}
          disabled={status === "streaming"}
        >
          Send
        </button>
      </div>
    </div>
  );
}
