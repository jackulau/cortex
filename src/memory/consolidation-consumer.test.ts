import { describe, it, expect, vi, beforeEach } from "vitest";
import { processConsolidationMessage } from "./consolidation-consumer";
import type { ConsolidationMessage } from "@/monitor/queue-types";

// Mock the consolidation module
vi.mock("./consolidation", () => ({
  consolidateTurn: vi.fn(),
}));

// Mock the semantic memory module
vi.mock("./semantic", () => ({
  SemanticMemory: vi.fn().mockImplementation(() => ({
    write: vi.fn(),
    search: vi.fn(),
  })),
}));

import { consolidateTurn } from "./consolidation";
import { SemanticMemory } from "./semantic";

// ── Mock Env ─────────────────────────────────────────────────

function createMockEnv() {
  return {
    DB: {} as any,
    AI: { run: vi.fn() } as any,
    CHAT_MODEL: "test-model",
    EMBEDDING_MODEL: "test-embed",
    STORAGE: {} as any,
    BROWSER: {} as any,
    CortexAgent: {} as any,
    CRAWL_QUEUE: { send: vi.fn() },
    CONSOLIDATION_QUEUE: { send: vi.fn() },
    DISCORD_PUBLIC_KEY: "",
    DISCORD_APP_ID: "",
    DISCORD_BOT_TOKEN: "",
  } as any;
}

// ── Tests ────────────────────────────────────────────────────

describe("processConsolidationMessage", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    env = createMockEnv();
  });

  it("creates SemanticMemory and calls consolidateTurn with message data", async () => {
    const mockConsolidate = consolidateTurn as unknown as ReturnType<typeof vi.fn>;
    mockConsolidate.mockResolvedValue([]);

    const message: ConsolidationMessage = {
      type: "consolidate",
      userMessage: "What is TypeScript?",
      assistantMessage: "TypeScript is a typed superset of JavaScript.",
      sessionId: "session-123",
    };

    await processConsolidationMessage(message, env);

    // SemanticMemory should be constructed with env bindings
    expect(SemanticMemory).toHaveBeenCalledWith(
      env.DB,
      env.AI,
      env.EMBEDDING_MODEL
    );

    // consolidateTurn should be called with correct arguments
    expect(mockConsolidate).toHaveBeenCalledWith(
      env.AI,
      env.CHAT_MODEL,
      expect.any(Object), // SemanticMemory instance
      "What is TypeScript?",
      "TypeScript is a typed superset of JavaScript."
    );
  });

  it("propagates errors to allow queue retry", async () => {
    const mockConsolidate = consolidateTurn as unknown as ReturnType<typeof vi.fn>;
    mockConsolidate.mockRejectedValue(new Error("AI service unavailable"));

    const message: ConsolidationMessage = {
      type: "consolidate",
      userMessage: "Hello",
      assistantMessage: "Hi there!",
      sessionId: "session-456",
    };

    await expect(
      processConsolidationMessage(message, env)
    ).rejects.toThrow("AI service unavailable");
  });

  it("does not swallow errors like the old fire-and-forget pattern", async () => {
    const mockConsolidate = consolidateTurn as unknown as ReturnType<typeof vi.fn>;
    mockConsolidate.mockRejectedValue(new Error("Extraction failed"));

    const message: ConsolidationMessage = {
      type: "consolidate",
      userMessage: "test",
      assistantMessage: "test response",
      sessionId: "session-789",
    };

    // The consumer should NOT catch errors — they should propagate
    let threw = false;
    try {
      await processConsolidationMessage(message, env);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
