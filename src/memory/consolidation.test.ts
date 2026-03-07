import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyConflict,
  checkConflicts,
  consolidateTurn,
  CONFLICT_SIMILARITY_THRESHOLD,
} from "./consolidation";
import type { ChatProvider } from "@/ai/providers";
import type { SemanticEntry } from "@/shared/types";

// ── Mock factories ───────────────────────────────────────────

function createMockAi(responses: string[] = []) {
  let callIndex = 0;
  return {
    run: vi.fn(async () => {
      const response = responses[callIndex] ?? "[]";
      callIndex++;
      return { response };
    }),
  } as unknown as Ai;
}

function createMockSemanticMemory() {
  return {
    write: vi.fn().mockResolvedValue("new-mem-id"),
    search: vi.fn().mockResolvedValue([]),
    searchRaw: vi.fn().mockResolvedValue([]),
    supersedeMemory: vi.fn().mockResolvedValue(undefined),
    touch: vi.fn().mockResolvedValue(undefined),
  };
}

function mockEntry(overrides: Partial<SemanticEntry> = {}): SemanticEntry {
  return {
    id: "existing-mem-1",
    content: "User lives in San Francisco",
    type: "fact",
    source: "consolidated",
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    relevanceScore: 1.0,
    lastAccessedAt: null,
    accessCount: 0,
    supersededBy: null,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("classifyConflict()", () => {
  it("returns CONTRADICTS when AI says so", async () => {
    const ai = createMockAi(["CONTRADICTS"]);
    const result = await classifyConflict(
      ai,
      "User lives in SF",
      "User lives in NYC"
    );
    expect(result).toBe("CONTRADICTS");
  });

  it("returns SUPPLEMENTS when AI says so", async () => {
    const ai = createMockAi(["SUPPLEMENTS"]);
    const result = await classifyConflict(
      ai,
      "User likes TypeScript",
      "User also likes Rust"
    );
    expect(result).toBe("SUPPLEMENTS");
  });

  it("returns UNRELATED when AI says so", async () => {
    const ai = createMockAi(["UNRELATED"]);
    const result = await classifyConflict(
      ai,
      "User likes coffee",
      "User works at Acme Corp"
    );
    expect(result).toBe("UNRELATED");
  });

  it("defaults to UNRELATED for ambiguous response", async () => {
    const ai = createMockAi(["I'm not sure"]);
    const result = await classifyConflict(ai, "fact A", "fact B");
    expect(result).toBe("UNRELATED");
  });

  it("handles response with extra whitespace and casing", async () => {
    const ai = createMockAi(["  contradicts  "]);
    const result = await classifyConflict(ai, "fact A", "fact B");
    expect(result).toBe("CONTRADICTS");
  });

  it("uses the fast model tier", async () => {
    const ai = createMockAi(["UNRELATED"]);
    await classifyConflict(ai, "old", "new");

    const runCall = (ai.run as ReturnType<typeof vi.fn>).mock.calls[0];
    // The model should be the fast tier default
    expect(runCall[0]).toContain("8b");
  });
});

describe("checkConflicts()", () => {
  it("returns null when no similar memories exist", async () => {
    const ai = createMockAi([]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([]);

    const result = await checkConflicts(ai, memory as any, "User lives in NYC");
    expect(result).toBeNull();
  });

  it("returns null when similar memories are below threshold", async () => {
    const ai = createMockAi([]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([
      { entry: mockEntry(), vectorScore: 0.80 },
    ]);

    const result = await checkConflicts(ai, memory as any, "User lives in NYC");
    expect(result).toBeNull();
    // AI should not have been called since score < threshold
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("returns superseded entry when contradiction found", async () => {
    const existing = mockEntry({ id: "old-mem", content: "User lives in SF" });
    const ai = createMockAi(["CONTRADICTS"]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([
      { entry: existing, vectorScore: 0.90 },
    ]);

    const result = await checkConflicts(ai, memory as any, "User lives in NYC");
    expect(result).not.toBeNull();
    expect(result!.superseded.id).toBe("old-mem");
    expect(result!.superseded.content).toBe("User lives in SF");
  });

  it("returns null when classification is SUPPLEMENTS", async () => {
    const existing = mockEntry();
    const ai = createMockAi(["SUPPLEMENTS"]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([
      { entry: existing, vectorScore: 0.90 },
    ]);

    const result = await checkConflicts(ai, memory as any, "User also likes NYC");
    expect(result).toBeNull();
  });

  it("returns null when classification is UNRELATED", async () => {
    const existing = mockEntry();
    const ai = createMockAi(["UNRELATED"]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([
      { entry: existing, vectorScore: 0.90 },
    ]);

    const result = await checkConflicts(ai, memory as any, "something else");
    expect(result).toBeNull();
  });

  it("checks multiple similar memories and finds contradiction in second", async () => {
    const entry1 = mockEntry({ id: "mem-1", content: "User likes coffee" });
    const entry2 = mockEntry({ id: "mem-2", content: "User lives in SF" });
    // First: SUPPLEMENTS, second: CONTRADICTS
    const ai = createMockAi(["SUPPLEMENTS", "CONTRADICTS"]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([
      { entry: entry1, vectorScore: 0.90 },
      { entry: entry2, vectorScore: 0.88 },
    ]);

    const result = await checkConflicts(ai, memory as any, "User lives in NYC");
    expect(result).not.toBeNull();
    expect(result!.superseded.id).toBe("mem-2");
  });

  it("respects the CONFLICT_SIMILARITY_THRESHOLD constant", () => {
    expect(CONFLICT_SIMILARITY_THRESHOLD).toBe(0.85);
  });
});

describe("consolidateTurn() with conflict detection", () => {
  it("supersedes conflicting memory during consolidation", async () => {
    const existingEntry = mockEntry({ id: "old-mem", content: "User lives in SF" });

    // AI responses: 1) extraction, 2) conflict classification
    const ai = createMockAi([
      '[{"content": "User lives in NYC", "type": "fact", "tags": ["location"]}]',
      "CONTRADICTS",
    ]);

    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([
      { entry: existingEntry, vectorScore: 0.90 },
    ]);
    memory.write.mockResolvedValue("new-mem-id");

    const facts = await consolidateTurn(
      ai,
      "test-model",
      memory as any,
      "I moved to NYC",
      "Great, I've noted your move to NYC!",
      undefined
    );

    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("User lives in NYC");

    // write() should have been called for the new fact
    expect(memory.write).toHaveBeenCalledWith({
      content: "User lives in NYC",
      type: "fact",
      source: "consolidated",
      tags: ["location"],
    });

    // supersedeMemory should have been called with old -> new
    expect(memory.supersedeMemory).toHaveBeenCalledWith("old-mem", "new-mem-id");
  });

  it("keeps supplementary memories without superseding", async () => {
    const existingEntry = mockEntry({ id: "old-mem", content: "User likes TypeScript" });

    const ai = createMockAi([
      '[{"content": "User also likes Rust", "type": "preference", "tags": ["language"]}]',
      "SUPPLEMENTS",
    ]);

    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([
      { entry: existingEntry, vectorScore: 0.88 },
    ]);
    memory.write.mockResolvedValue("new-mem-id");

    await consolidateTurn(
      ai,
      "test-model",
      memory as any,
      "I also like Rust",
      "Nice, Rust is great!",
      undefined
    );

    // write() should still be called (normal path)
    expect(memory.write).toHaveBeenCalled();

    // supersedeMemory should NOT have been called
    expect(memory.supersedeMemory).not.toHaveBeenCalled();
  });

  it("handles no conflicts gracefully (normal dedup path)", async () => {
    const ai = createMockAi([
      '[{"content": "User works at Acme", "type": "fact", "tags": ["work"]}]',
    ]);

    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([]); // No similar memories
    memory.write.mockResolvedValue("new-id");

    await consolidateTurn(
      ai,
      "test-model",
      memory as any,
      "I work at Acme",
      "Got it!",
      undefined
    );

    expect(memory.write).toHaveBeenCalled();
    expect(memory.supersedeMemory).not.toHaveBeenCalled();
  });

  it("handles extraction failure gracefully", async () => {
    const ai = createMockAi(["invalid json {{"]);
    const memory = createMockSemanticMemory();

    const facts = await consolidateTurn(
      ai,
      "test-model",
      memory as any,
      "hello",
      "hi there",
      undefined
    );

    expect(facts).toEqual([]);
    expect(memory.write).not.toHaveBeenCalled();
  });

  it("handles empty extraction", async () => {
    const ai = createMockAi(["[]"]);
    const memory = createMockSemanticMemory();

    const facts = await consolidateTurn(
      ai,
      "test-model",
      memory as any,
      "hello",
      "hi",
      undefined
    );

    expect(facts).toEqual([]);
  });

  it("does not supersede when write returns null (dedup)", async () => {
    const existingEntry = mockEntry({ id: "old-mem", content: "User lives in SF" });

    const ai = createMockAi([
      '[{"content": "User lives in NYC", "type": "fact", "tags": []}]',
      "CONTRADICTS",
    ]);

    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([
      { entry: existingEntry, vectorScore: 0.90 },
    ]);
    // write returns null (near-duplicate found by write's own dedup)
    memory.write.mockResolvedValue(null);

    await consolidateTurn(
      ai,
      "test-model",
      memory as any,
      "I moved to NYC",
      "Noted!",
      undefined
    );

    // supersedeMemory should NOT be called since write returned null
    expect(memory.supersedeMemory).not.toHaveBeenCalled();
  });
});

describe("consolidateTurn() with ChatProvider", () => {
  it("uses ChatProvider for extraction when provided", async () => {
    const chatProvider: ChatProvider = {
      chat: vi.fn().mockResolvedValue(
        JSON.stringify([
          { content: "User likes TypeScript", type: "preference", tags: ["programming"] },
        ])
      ),
    };
    const ai = createMockAi([]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([]);

    const result = await consolidateTurn(
      ai,
      "ignored",
      memory as any,
      "I love TypeScript",
      "TypeScript is great!",
      undefined,
      chatProvider
    );

    // ChatProvider should have been called for extraction
    expect(chatProvider.chat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({ role: "user" }),
      ]),
      { maxTokens: 500 }
    );

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("User likes TypeScript");
  });

  it("does not use Workers AI for extraction when ChatProvider is given", async () => {
    const chatProvider: ChatProvider = {
      chat: vi.fn().mockResolvedValue("[]"),
    };
    const ai = createMockAi([]);
    const memory = createMockSemanticMemory();

    await consolidateTurn(
      ai,
      "model",
      memory as any,
      "hello",
      "hi",
      undefined,
      chatProvider
    );

    // ai.run should NOT have been called for extraction
    // (it may still be called for conflict classification)
    expect(chatProvider.chat).toHaveBeenCalled();
  });

  it("handles ChatProvider errors gracefully", async () => {
    const chatProvider: ChatProvider = {
      chat: vi.fn().mockRejectedValue(new Error("Claude API error")),
    };
    const ai = createMockAi([]);
    const memory = createMockSemanticMemory();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await consolidateTurn(
      ai,
      "model",
      memory as any,
      "test",
      "response",
      undefined,
      chatProvider
    );

    expect(result).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith("Consolidation failed, skipping");
    consoleSpy.mockRestore();
  });

  it("saves facts extracted by ChatProvider to semantic memory", async () => {
    const chatProvider: ChatProvider = {
      chat: vi.fn().mockResolvedValue(
        JSON.stringify([
          { content: "User's name is Alice", type: "fact", tags: ["identity"] },
          { content: "Alice prefers dark mode", type: "preference", tags: ["ui"] },
        ])
      ),
    };
    const ai = createMockAi([]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([]); // No conflicts

    await consolidateTurn(
      ai,
      "model",
      memory as any,
      "I'm Alice and I prefer dark mode",
      "Nice to meet you Alice!",
      undefined,
      chatProvider
    );

    expect(memory.write).toHaveBeenCalledTimes(2);
    expect(memory.write).toHaveBeenCalledWith({
      content: "User's name is Alice",
      type: "fact",
      source: "consolidated",
      tags: ["identity"],
    });
    expect(memory.write).toHaveBeenCalledWith({
      content: "Alice prefers dark mode",
      type: "preference",
      source: "consolidated",
      tags: ["ui"],
    });
  });

  it("handles markdown code blocks from ChatProvider", async () => {
    const chatProvider: ChatProvider = {
      chat: vi.fn().mockResolvedValue(
        '```json\n[{"content": "Test fact", "type": "fact", "tags": []}]\n```'
      ),
    };
    const ai = createMockAi([]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([]);

    const result = await consolidateTurn(
      ai,
      "model",
      memory as any,
      "test",
      "response",
      undefined,
      chatProvider
    );

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Test fact");
  });

  it("still uses Workers AI for conflict classification even with ChatProvider", async () => {
    const existingEntry = mockEntry({ id: "old-mem", content: "User lives in SF" });

    const chatProvider: ChatProvider = {
      chat: vi.fn().mockResolvedValue(
        '[{"content": "User lives in NYC", "type": "fact", "tags": []}]'
      ),
    };

    // Conflict classification response via Workers AI
    const ai = createMockAi(["CONTRADICTS"]);
    const memory = createMockSemanticMemory();
    memory.searchRaw.mockResolvedValue([
      { entry: existingEntry, vectorScore: 0.90 },
    ]);
    memory.write.mockResolvedValue("new-mem-id");

    await consolidateTurn(
      ai,
      "model",
      memory as any,
      "I moved to NYC",
      "Got it!",
      undefined,
      chatProvider
    );

    // ChatProvider used for extraction
    expect(chatProvider.chat).toHaveBeenCalled();

    // Workers AI used for conflict classification
    expect(ai.run).toHaveBeenCalled();

    // Supersede should have been called
    expect(memory.supersedeMemory).toHaveBeenCalledWith("old-mem", "new-mem-id");
  });
});
