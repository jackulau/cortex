import { describe, it, expect, vi } from "vitest";
import { MAX_AGENT_LOOPS } from "./constants";
import { createThinkingTool } from "./tools/thinking-tool";
import { createMemoryTools } from "./tools/memory-tools";

// ── MAX_AGENT_LOOPS Constant ────────────────────────────────

describe("MAX_AGENT_LOOPS", () => {
  it("is set to 5 to prevent runaway loops", () => {
    expect(MAX_AGENT_LOOPS).toBe(5);
  });

  it("is a positive integer", () => {
    expect(MAX_AGENT_LOOPS).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_AGENT_LOOPS)).toBe(true);
  });
});

// ── Multi-Turn Tool Chaining ────────────────────────────────

describe("multi-turn tool chaining", () => {
  it("thinking tool can be used alongside memory tools", async () => {
    const thinkingTools = createThinkingTool();
    const memoryTools = createMemoryTools({
      semanticMemory: {
        write: vi.fn().mockResolvedValue("mem-1"),
        search: vi.fn().mockResolvedValue([]),
        delete: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
      } as any,
      episodicMemory: {
        search: vi.fn().mockReturnValue([]),
        logTurn: vi.fn(),
        getSession: vi.fn(),
        upsertSession: vi.fn(),
        getTurnCount: vi.fn(),
        getRecentTurns: vi.fn(),
        listSessions: vi.fn(),
      } as any,
      proceduralMemory: {
        getAll: vi.fn().mockReturnValue([]),
        getActive: vi.fn().mockReturnValue([]),
        add: vi.fn(),
        deactivate: vi.fn(),
        toPromptString: vi.fn(),
      } as any,
      workingMemory: {
        getState: vi.fn().mockReturnValue({
          sessionId: "test",
          startedAt: "2024-01-01T00:00:00Z",
          topics: [],
          recentFacts: [],
          pendingActions: [],
        }),
        addFact: vi.fn(),
        toContextString: vi.fn().mockReturnValue(""),
      } as any,
    });

    // All tools can be combined into a single tools object
    const allTools = { ...thinkingTools, ...memoryTools };

    expect(allTools.thinking).toBeDefined();
    expect(allTools.remember).toBeDefined();
    expect(allTools.recall).toBeDefined();

    // Simulate a multi-step chain:
    // Step 1: Think about what to do
    const thinkResult = await allTools.thinking.execute(
      {
        thought:
          "The user asked me to research and save findings. I should first recall if I already know about this topic.",
      },
      { messages: [], toolCallId: "tc-1", abortSignal: undefined as any }
    );
    expect(thinkResult.thought).toContain("research and save");

    // Step 2: Recall existing knowledge
    const recallResult = await allTools.recall.execute(
      { query: "TypeScript performance", limit: 5 },
      { messages: [], toolCallId: "tc-2", abortSignal: undefined as any }
    );
    expect(recallResult.found).toBe(false);

    // Step 3: Save new finding
    const rememberResult = await allTools.remember.execute(
      {
        content: "TypeScript 5.0 introduced decorators for better performance",
        type: "fact",
        tags: ["typescript", "performance"],
      },
      { messages: [], toolCallId: "tc-3", abortSignal: undefined as any }
    );
    expect(rememberResult.success).toBe(true);
    expect(rememberResult.id).toBe("mem-1");
  });

  it("all tool results are structured for LLM reasoning", async () => {
    const thinkingTools = createThinkingTool();

    // Thinking tool returns structured result
    const result = await thinkingTools.thinking.execute(
      { thought: "I need to analyze the data." },
      { messages: [], toolCallId: "tc-1", abortSignal: undefined as any }
    );

    // Result must be JSON-serializable for the LLM to reason about
    const serialized = JSON.stringify(result);
    const parsed = JSON.parse(serialized);
    expect(parsed.thought).toBe("I need to analyze the data.");
    expect(parsed.message).toBeDefined();
  });
});
