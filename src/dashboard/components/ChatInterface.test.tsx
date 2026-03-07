import { describe, it, expect, beforeEach } from "vitest";

/**
 * Tests for the ChatInterface component's WebSocket message handling logic.
 * Since we're in a Node test environment without full DOM/WebSocket support,
 * we test the message parsing and state management logic extracted from
 * the component's patterns.
 */

// ── WebSocket message type definitions (mirror the component) ──

interface WsResponseMessage {
  type: "response";
  content: string;
  done: boolean;
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

interface WsThinkingMessage {
  type: "thinking";
  content: string;
}

interface WsErrorMessage {
  type: "error";
  message: string;
}

type WsIncomingMessage =
  | WsResponseMessage
  | WsToolCallMessage
  | WsToolResultMessage
  | WsMemoryFormedMessage
  | WsThinkingMessage
  | WsErrorMessage;

// ── Message parsing tests ──────────────────────────────────────

describe("ChatInterface message parsing", () => {
  function parseMessage(data: string): WsIncomingMessage | null {
    try {
      return JSON.parse(data) as WsIncomingMessage;
    } catch {
      return null;
    }
  }

  it("parses a streaming response chunk", () => {
    const msg = parseMessage(
      JSON.stringify({ type: "response", content: "Hello", done: false })
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("response");
    expect((msg as WsResponseMessage).content).toBe("Hello");
    expect((msg as WsResponseMessage).done).toBe(false);
  });

  it("parses a final response message", () => {
    const msg = parseMessage(
      JSON.stringify({ type: "response", content: "", done: true })
    );
    expect(msg).not.toBeNull();
    expect((msg as WsResponseMessage).done).toBe(true);
  });

  it("parses a tool call message", () => {
    const msg = parseMessage(
      JSON.stringify({
        type: "tool_call",
        tool: "recall",
        args: { query: "test" },
      })
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_call");
    expect((msg as WsToolCallMessage).tool).toBe("recall");
    expect((msg as WsToolCallMessage).args).toEqual({ query: "test" });
  });

  it("parses a tool result message", () => {
    const msg = parseMessage(
      JSON.stringify({
        type: "tool_result",
        tool: "recall",
        result: { memories: [] },
      })
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("tool_result");
    expect((msg as WsToolResultMessage).result).toEqual({ memories: [] });
  });

  it("parses a memory formed message", () => {
    const msg = parseMessage(
      JSON.stringify({
        type: "memory_formed",
        memory: {
          content: "User prefers dark mode",
          type: "preference",
          tags: ["ui", "settings"],
        },
      })
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("memory_formed");
    const mem = msg as WsMemoryFormedMessage;
    expect(mem.memory.content).toBe("User prefers dark mode");
    expect(mem.memory.type).toBe("preference");
    expect(mem.memory.tags).toEqual(["ui", "settings"]);
  });

  it("parses a thinking message", () => {
    const msg = parseMessage(
      JSON.stringify({ type: "thinking", content: "Analyzing the question..." })
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("thinking");
    expect((msg as WsThinkingMessage).content).toBe("Analyzing the question...");
  });

  it("parses an error message", () => {
    const msg = parseMessage(
      JSON.stringify({ type: "error", message: "Rate limited" })
    );
    expect(msg).not.toBeNull();
    expect(msg!.type).toBe("error");
    expect((msg as WsErrorMessage).message).toBe("Rate limited");
  });

  it("returns null for invalid JSON", () => {
    expect(parseMessage("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseMessage("")).toBeNull();
  });
});

// ── Chat message accumulation tests ────────────────────────────

interface ChatToolCall {
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ChatToolCall[];
  memoryEvents?: Array<{ content: string; type: string; tags?: string[] }>;
  thinking?: string;
  isStreaming?: boolean;
}

describe("Chat message accumulation", () => {
  let messages: ChatMessage[];
  let streamingMsgId: string | null;

  function ensureStreamingMessage(updater: (current: ChatMessage) => ChatMessage) {
    if (streamingMsgId) {
      messages = messages.map((m) =>
        m.id === streamingMsgId ? updater(m) : m
      );
    } else {
      const newId = `assistant-${Date.now()}`;
      streamingMsgId = newId;
      const newMsg: ChatMessage = {
        id: newId,
        role: "assistant",
        content: "",
        isStreaming: true,
      };
      messages = [...messages, updater(newMsg)];
    }
  }

  beforeEach(() => {
    messages = [];
    streamingMsgId = null;
  });

  it("creates a new streaming message on first response chunk", () => {
    ensureStreamingMessage((m) => ({
      ...m,
      content: m.content + "Hello",
    }));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("Hello");
    expect(messages[0].isStreaming).toBe(true);
  });

  it("appends subsequent chunks to the same message", () => {
    ensureStreamingMessage((m) => ({ ...m, content: m.content + "Hello" }));
    ensureStreamingMessage((m) => ({ ...m, content: m.content + " world" }));

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hello world");
  });

  it("accumulates tool calls on the streaming message", () => {
    ensureStreamingMessage((m) => ({
      ...m,
      toolCalls: [
        ...(m.toolCalls || []),
        { tool: "recall", args: { query: "test" } },
      ],
    }));

    expect(messages[0].toolCalls).toHaveLength(1);
    expect(messages[0].toolCalls![0].tool).toBe("recall");
  });

  it("accumulates memory events on the streaming message", () => {
    ensureStreamingMessage((m) => ({
      ...m,
      memoryEvents: [
        ...(m.memoryEvents || []),
        { content: "fact stored", type: "fact", tags: ["test"] },
      ],
    }));

    expect(messages[0].memoryEvents).toHaveLength(1);
    expect(messages[0].memoryEvents![0].content).toBe("fact stored");
  });

  it("accumulates thinking content on the streaming message", () => {
    ensureStreamingMessage((m) => ({
      ...m,
      thinking: (m.thinking || "") + "Step 1. ",
    }));
    ensureStreamingMessage((m) => ({
      ...m,
      thinking: (m.thinking || "") + "Step 2.",
    }));

    expect(messages[0].thinking).toBe("Step 1. Step 2.");
  });

  it("does not create a new message when user messages exist", () => {
    messages = [
      {
        id: "user-1",
        role: "user",
        content: "Hello",
      },
    ];

    ensureStreamingMessage((m) => ({
      ...m,
      content: m.content + "Hi there!",
    }));

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });
});

// ── Connection status tests ────────────────────────────────────

describe("Connection status logic", () => {
  it("calculates reconnect delay with exponential backoff", () => {
    const BASE = 1000;
    const MAX = 30000;

    const calcDelay = (attempt: number) =>
      Math.min(BASE * Math.pow(2, attempt), MAX);

    expect(calcDelay(0)).toBe(1000);
    expect(calcDelay(1)).toBe(2000);
    expect(calcDelay(2)).toBe(4000);
    expect(calcDelay(3)).toBe(8000);
    expect(calcDelay(4)).toBe(16000);
    expect(calcDelay(5)).toBe(30000); // capped
    expect(calcDelay(10)).toBe(30000); // capped
  });

  it("caps reconnect attempts at maximum", () => {
    const MAX_ATTEMPTS = 10;
    let attempt = 0;

    while (attempt < MAX_ATTEMPTS + 5) {
      if (attempt >= MAX_ATTEMPTS) {
        // Should stop trying
        break;
      }
      attempt++;
    }

    expect(attempt).toBe(MAX_ATTEMPTS);
  });
});

// ── WebSocket URL construction tests ───────────────────────────

describe("WebSocket URL construction", () => {
  it("builds ws:// URL for http:// pages", () => {
    const protocol = "http:";
    const host = "localhost:8787";
    const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
    const url = `${wsProtocol}//${host}/ws/chat`;
    expect(url).toBe("ws://localhost:8787/ws/chat");
  });

  it("builds wss:// URL for https:// pages", () => {
    const protocol = "https:";
    const host = "cortex.example.com";
    const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
    const url = `${wsProtocol}//${host}/ws/chat`;
    expect(url).toBe("wss://cortex.example.com/ws/chat");
  });

  it("appends token parameter when available", () => {
    const base = "wss://example.com/ws/chat";
    const token = "my-secret-key";
    const url = `${base}?token=${encodeURIComponent(token)}`;
    expect(url).toBe("wss://example.com/ws/chat?token=my-secret-key");
  });

  it("encodes special characters in token", () => {
    const base = "ws://localhost:8787/ws/chat";
    const token = "key with spaces&special=chars";
    const url = `${base}?token=${encodeURIComponent(token)}`;
    expect(url).toContain("key%20with%20spaces");
    expect(url).toContain("%26special%3Dchars");
  });
});

// ── Chat payload construction tests ────────────────────────────

describe("Chat payload construction", () => {
  it("constructs a valid chat message payload", () => {
    const content = "Hello, Cortex!";
    const payload = { type: "chat", content };
    const serialized = JSON.stringify(payload);

    const parsed = JSON.parse(serialized);
    expect(parsed.type).toBe("chat");
    expect(parsed.content).toBe("Hello, Cortex!");
  });

  it("trims whitespace from content before sending", () => {
    const content = "  Hello, Cortex!  ";
    const trimmed = content.trim();
    expect(trimmed).toBe("Hello, Cortex!");
  });

  it("rejects empty content after trimming", () => {
    const content = "   ";
    const trimmed = content.trim();
    expect(trimmed).toBe("");
    expect(!trimmed).toBe(true);
  });
});

// ── Tool call expansion toggle tests ───────────────────────────

describe("Tool call expansion toggle", () => {
  it("adds a key to the expanded set", () => {
    const expanded = new Set<string>();
    const key = "msg-1-0";

    const next = new Set(expanded);
    next.add(key);

    expect(next.has(key)).toBe(true);
    expect(next.size).toBe(1);
  });

  it("removes a key from the expanded set (toggle off)", () => {
    const expanded = new Set<string>(["msg-1-0"]);
    const key = "msg-1-0";

    const next = new Set(expanded);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }

    expect(next.has(key)).toBe(false);
    expect(next.size).toBe(0);
  });

  it("toggles independently for different tool calls", () => {
    const expanded = new Set<string>();

    // Expand first tool call
    expanded.add("msg-1-0");
    expect(expanded.has("msg-1-0")).toBe(true);
    expect(expanded.has("msg-1-1")).toBe(false);

    // Expand second tool call
    expanded.add("msg-1-1");
    expect(expanded.has("msg-1-0")).toBe(true);
    expect(expanded.has("msg-1-1")).toBe(true);
  });
});
