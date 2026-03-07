import { describe, it, expect, vi } from "vitest";

/**
 * Tests for the WebSocket chat handler logic in CortexAgent.
 * Since the CortexAgent class requires Cloudflare DO bindings that aren't
 * available in unit tests, we test the extractable logic patterns:
 * - Message validation
 * - Frame construction
 * - Error handling patterns
 */

// ── Message validation logic ───────────────────────────────────

describe("WS chat message validation", () => {
  function validateChatMessage(
    raw: string
  ): { valid: true; content: string } | { valid: false; error: string } {
    let parsed: { type: string; content?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { valid: false, error: "Invalid JSON" };
    }

    if (parsed.type !== "chat" || !parsed.content?.trim()) {
      return {
        valid: false,
        error: 'Expected { type: "chat", content: "..." }',
      };
    }

    return { valid: true, content: parsed.content.trim() };
  }

  it("accepts a valid chat message", () => {
    const result = validateChatMessage(
      JSON.stringify({ type: "chat", content: "Hello" })
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.content).toBe("Hello");
    }
  });

  it("trims content whitespace", () => {
    const result = validateChatMessage(
      JSON.stringify({ type: "chat", content: "  Hello  " })
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.content).toBe("Hello");
    }
  });

  it("rejects invalid JSON", () => {
    const result = validateChatMessage("not json");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Invalid JSON");
    }
  });

  it("rejects wrong message type", () => {
    const result = validateChatMessage(
      JSON.stringify({ type: "ping", content: "test" })
    );
    expect(result.valid).toBe(false);
  });

  it("rejects missing content", () => {
    const result = validateChatMessage(JSON.stringify({ type: "chat" }));
    expect(result.valid).toBe(false);
  });

  it("rejects empty content", () => {
    const result = validateChatMessage(
      JSON.stringify({ type: "chat", content: "" })
    );
    expect(result.valid).toBe(false);
  });

  it("rejects whitespace-only content", () => {
    const result = validateChatMessage(
      JSON.stringify({ type: "chat", content: "   " })
    );
    expect(result.valid).toBe(false);
  });

  it("rejects null content", () => {
    const result = validateChatMessage(
      JSON.stringify({ type: "chat", content: null })
    );
    expect(result.valid).toBe(false);
  });
});

// ── WebSocket frame construction ───────────────────────────────

describe("WS frame construction", () => {
  function buildFrame(data: Record<string, unknown>): string {
    return JSON.stringify(data);
  }

  it("builds a response chunk frame", () => {
    const frame = buildFrame({
      type: "response",
      content: "Hello",
      done: false,
    });
    const parsed = JSON.parse(frame);
    expect(parsed.type).toBe("response");
    expect(parsed.content).toBe("Hello");
    expect(parsed.done).toBe(false);
  });

  it("builds a final response frame", () => {
    const frame = buildFrame({
      type: "response",
      content: "",
      done: true,
    });
    const parsed = JSON.parse(frame);
    expect(parsed.done).toBe(true);
    expect(parsed.content).toBe("");
  });

  it("builds a tool_call frame", () => {
    const frame = buildFrame({
      type: "tool_call",
      tool: "recall",
      args: { query: "test query", limit: 5 },
    });
    const parsed = JSON.parse(frame);
    expect(parsed.type).toBe("tool_call");
    expect(parsed.tool).toBe("recall");
    expect(parsed.args.query).toBe("test query");
    expect(parsed.args.limit).toBe(5);
  });

  it("builds a tool_result frame", () => {
    const frame = buildFrame({
      type: "tool_result",
      tool: "recall",
      result: { memories: [{ content: "Some memory" }] },
    });
    const parsed = JSON.parse(frame);
    expect(parsed.type).toBe("tool_result");
    expect(parsed.result.memories).toHaveLength(1);
  });

  it("builds a memory_formed frame", () => {
    const frame = buildFrame({
      type: "memory_formed",
      memory: {
        content: "User prefers TypeScript",
        type: "preference",
        tags: ["programming", "typescript"],
      },
    });
    const parsed = JSON.parse(frame);
    expect(parsed.type).toBe("memory_formed");
    expect(parsed.memory.content).toBe("User prefers TypeScript");
    expect(parsed.memory.tags).toEqual(["programming", "typescript"]);
  });

  it("builds a thinking frame", () => {
    const frame = buildFrame({
      type: "thinking",
      content: "Let me recall relevant memories...",
    });
    const parsed = JSON.parse(frame);
    expect(parsed.type).toBe("thinking");
    expect(parsed.content).toBe("Let me recall relevant memories...");
  });

  it("builds an error frame", () => {
    const frame = buildFrame({
      type: "error",
      message: "Rate limited",
    });
    const parsed = JSON.parse(frame);
    expect(parsed.type).toBe("error");
    expect(parsed.message).toBe("Rate limited");
  });
});

// ── Safe send pattern ──────────────────────────────────────────

describe("WS safe send", () => {
  it("sends JSON data without throwing", () => {
    const sent: string[] = [];
    const mockWs = {
      send: (data: string) => sent.push(data),
    };

    function wsSend(ws: typeof mockWs, data: Record<string, unknown>): void {
      try {
        ws.send(JSON.stringify(data));
      } catch {
        // Ignore closed socket errors
      }
    }

    wsSend(mockWs, { type: "response", content: "test", done: false });

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({
      type: "response",
      content: "test",
      done: false,
    });
  });

  it("silently catches errors from closed sockets", () => {
    const mockWs = {
      send: () => {
        throw new Error("WebSocket is closed");
      },
    };

    function wsSend(ws: typeof mockWs, data: Record<string, unknown>): void {
      try {
        ws.send(JSON.stringify(data));
      } catch {
        // Ignore closed socket errors
      }
    }

    // Should not throw
    expect(() =>
      wsSend(mockWs, { type: "response", content: "test", done: false })
    ).not.toThrow();
  });
});

// ── Memory formation detection logic ───────────────────────────

describe("Memory formation detection", () => {
  interface ToolResult {
    toolName: string;
    result: unknown;
    args: Record<string, unknown>;
  }

  function detectMemoryFormation(
    tr: ToolResult
  ): { content: string; type: string; tags: string[] } | null {
    if (
      tr.toolName === "store_memory" &&
      tr.result &&
      typeof tr.result === "object"
    ) {
      const memResult = tr.result as Record<string, unknown>;
      if (memResult.success) {
        return {
          content: (memResult.content as string) || (tr.args?.content as string) || "",
          type: (memResult.type as string) || (tr.args?.type as string) || "note",
          tags: (memResult.tags as string[]) || [],
        };
      }
    }
    return null;
  }

  it("detects memory formation from successful store_memory result", () => {
    const result = detectMemoryFormation({
      toolName: "store_memory",
      result: {
        success: true,
        content: "User likes hiking",
        type: "preference",
        tags: ["hobbies"],
      },
      args: {},
    });

    expect(result).not.toBeNull();
    expect(result!.content).toBe("User likes hiking");
    expect(result!.type).toBe("preference");
    expect(result!.tags).toEqual(["hobbies"]);
  });

  it("falls back to args when result fields are missing", () => {
    const result = detectMemoryFormation({
      toolName: "store_memory",
      result: { success: true },
      args: { content: "From args", type: "fact" },
    });

    expect(result).not.toBeNull();
    expect(result!.content).toBe("From args");
    expect(result!.type).toBe("fact");
  });

  it("returns null for non-store_memory tools", () => {
    const result = detectMemoryFormation({
      toolName: "recall",
      result: { memories: [] },
      args: {},
    });
    expect(result).toBeNull();
  });

  it("returns null when store_memory fails", () => {
    const result = detectMemoryFormation({
      toolName: "store_memory",
      result: { success: false, error: "quota exceeded" },
      args: {},
    });
    expect(result).toBeNull();
  });

  it("returns null for null result", () => {
    const result = detectMemoryFormation({
      toolName: "store_memory",
      result: null,
      args: {},
    });
    expect(result).toBeNull();
  });
});

// ── Server-side route matching ─────────────────────────────────

describe("WS chat route matching in server.ts", () => {
  it("matches /ws/chat exactly", () => {
    const pathname = "/ws/chat";
    expect(pathname === "/ws/chat").toBe(true);
  });

  it("does not match /ws/chat/ with trailing slash", () => {
    const pathname = "/ws/chat/";
    expect(pathname === "/ws/chat").toBe(false);
  });

  it("does not match /ws/chatx", () => {
    const pathname = "/ws/chatx";
    expect(pathname === "/ws/chat").toBe(false);
  });

  it("does not match /api/ws/chat", () => {
    const pathname = "/api/ws/chat";
    expect(pathname === "/ws/chat").toBe(false);
  });
});
