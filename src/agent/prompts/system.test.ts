import { describe, it, expect, vi } from "vitest";
import { buildSystemPrompt } from "./system";

// ── Mock Dependencies ──────────────────────────────────────────

function createMockWorkingMemory() {
  return {
    getState: vi.fn().mockReturnValue({
      sessionId: "test-session",
      startedAt: "2024-01-01T00:00:00Z",
      topics: [],
      recentFacts: [],
      pendingActions: [],
    }),
    toContextString: vi.fn().mockReturnValue(""),
    addFact: vi.fn(),
    addTopic: vi.fn(),
    addPendingAction: vi.fn(),
    removePendingAction: vi.fn(),
  } as any;
}

function createMockProceduralMemory() {
  return {
    toPromptString: vi.fn().mockReturnValue(""),
    getAll: vi.fn().mockReturnValue([]),
    getActive: vi.fn().mockReturnValue([]),
    add: vi.fn(),
  } as any;
}

// ── Tests ────────────────────────────────────────────────────

describe("buildSystemPrompt", () => {
  it("includes core prompt with multi-step reasoning guidance", () => {
    const working = createMockWorkingMemory();
    const procedural = createMockProceduralMemory();

    const prompt = buildSystemPrompt(working, procedural, "");

    expect(prompt).toContain("You are Cortex");
    expect(prompt).toContain("Multi-Step Reasoning");
    expect(prompt).toContain("chain multiple tool calls");
    expect(prompt).toContain("Think step by step");
    expect(prompt).toContain("thinking");
  });

  it("includes memory tools section", () => {
    const working = createMockWorkingMemory();
    const procedural = createMockProceduralMemory();

    const prompt = buildSystemPrompt(working, procedural, "");

    expect(prompt).toContain("Memory Tools");
    expect(prompt).toContain("remember");
    expect(prompt).toContain("recall");
    expect(prompt).toContain("forget");
  });

  it("injects memory context when provided", () => {
    const working = createMockWorkingMemory();
    const procedural = createMockProceduralMemory();

    const prompt = buildSystemPrompt(
      working,
      procedural,
      "User prefers dark mode"
    );

    expect(prompt).toContain("Relevant Memories");
    expect(prompt).toContain("User prefers dark mode");
  });

  it("injects procedural rules when present", () => {
    const working = createMockWorkingMemory();
    const procedural = createMockProceduralMemory();
    procedural.toPromptString.mockReturnValue("Always respond in English");

    const prompt = buildSystemPrompt(working, procedural, "");

    expect(prompt).toContain("Always respond in English");
  });

  it("injects working memory context when present", () => {
    const working = createMockWorkingMemory();
    working.toContextString.mockReturnValue("Current topic: TypeScript");
    const procedural = createMockProceduralMemory();

    const prompt = buildSystemPrompt(working, procedural, "");

    expect(prompt).toContain("Current Session Context");
    expect(prompt).toContain("Current topic: TypeScript");
  });
});
