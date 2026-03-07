/**
 * Integration tests for the consolidation pipeline.
 *
 * Tests the end-to-end flow:
 *   User message + Assistant response
 *   -> AI fact extraction (mocked)
 *   -> SemanticMemory.write() to real D1
 *   -> Vectorize upsert (mock)
 *
 * The AI binding is mocked to return deterministic fact extractions,
 * while D1 and the rest of the pipeline use real Miniflare bindings.
 *
 * Setup: D1 tables created in beforeAll.
 * Teardown: Tables dropped in afterAll.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { env } from "cloudflare:test";
import { consolidateTurn } from "@/memory/consolidation";
import { SemanticMemory } from "@/memory/semantic";
import {
  setupD1Tables,
  teardownD1Tables,
  createMockVectorize,
  createMockAi,
} from "./helpers";

describe("Consolidation Pipeline — D1 Integration", () => {
  let semanticMemory: SemanticMemory;
  let mockVectorize: VectorizeIndex;

  beforeAll(async () => {
    await setupD1Tables(env.DB);
  });

  afterAll(async () => {
    await teardownD1Tables(env.DB);
  });

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM memory_embeddings"),
      env.DB.prepare("DELETE FROM semantic_memories"),
    ]);
    mockVectorize = createMockVectorize();
  });

  it("extracts facts from conversation and stores in D1", async () => {
    // Mock AI that returns specific facts for the conversation content
    const chatResponses = new Map<string, string>();
    chatResponses.set(
      "My name is Alice",
      JSON.stringify([
        {
          content: "User's name is Alice",
          type: "fact",
          tags: ["identity"],
        },
        {
          content: "User works as a software engineer",
          type: "fact",
          tags: ["work"],
        },
      ])
    );

    const mockAi = createMockAi(chatResponses);
    semanticMemory = new SemanticMemory(
      env.DB,
      mockAi,
      "@cf/baai/bge-large-en-v1.5",
      mockVectorize
    );

    const facts = await consolidateTurn(
      mockAi,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      semanticMemory,
      "My name is Alice and I'm a software engineer",
      "Nice to meet you, Alice! What kind of software engineering do you focus on?"
    );

    // Should have extracted 2 facts
    expect(facts).toHaveLength(2);
    expect(facts[0].content).toBe("User's name is Alice");
    expect(facts[1].content).toBe("User works as a software engineer");

    // Verify facts are persisted in D1
    const stored = await semanticMemory.list();
    expect(stored).toHaveLength(2);

    // All stored memories should have source "consolidated"
    stored.forEach((m) => {
      expect(m.source).toBe("consolidated");
    });
  });

  it("stores extracted facts with correct type and tags", async () => {
    const chatResponses = new Map<string, string>();
    chatResponses.set(
      "I prefer dark mode",
      JSON.stringify([
        {
          content: "User prefers dark mode for all applications",
          type: "preference",
          tags: ["ui", "preferences"],
        },
      ])
    );

    const mockAi = createMockAi(chatResponses);
    semanticMemory = new SemanticMemory(
      env.DB,
      mockAi,
      "@cf/baai/bge-large-en-v1.5",
      mockVectorize
    );

    await consolidateTurn(
      mockAi,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      semanticMemory,
      "I prefer dark mode in all my applications",
      "Noted! I'll remember that you prefer dark mode."
    );

    const stored = await semanticMemory.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].type).toBe("preference");
    expect(stored[0].tags).toEqual(["ui", "preferences"]);
  });

  it("handles empty extraction gracefully", async () => {
    // Default mock AI returns "[]" for chat completions
    const mockAi = createMockAi();
    semanticMemory = new SemanticMemory(
      env.DB,
      mockAi,
      "@cf/baai/bge-large-en-v1.5",
      mockVectorize
    );

    const facts = await consolidateTurn(
      mockAi,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      semanticMemory,
      "Hello!",
      "Hi there! How can I help you today?"
    );

    expect(facts).toEqual([]);

    // Nothing stored in D1
    const stored = await semanticMemory.list();
    expect(stored).toHaveLength(0);
  });

  it("generates embeddings and upserts to Vectorize for each fact", async () => {
    const chatResponses = new Map<string, string>();
    chatResponses.set(
      "I use Neovim",
      JSON.stringify([
        {
          content: "User uses Neovim as their primary editor",
          type: "fact",
          tags: ["tools"],
        },
      ])
    );

    const mockAi = createMockAi(chatResponses);
    semanticMemory = new SemanticMemory(
      env.DB,
      mockAi,
      "@cf/baai/bge-large-en-v1.5",
      mockVectorize
    );

    await consolidateTurn(
      mockAi,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      semanticMemory,
      "I use Neovim for all my coding",
      "Great choice! Neovim is a powerful editor."
    );

    // Verify embedding is stored in D1 memory_embeddings
    const { results } = await env.DB
      .prepare("SELECT * FROM memory_embeddings")
      .all<{ memory_id: string }>();
    expect(results).toHaveLength(1);

    // Verify the memory is searchable through Vectorize
    const searchResults = await semanticMemory.search("Neovim editor");
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults[0].entry.content).toContain("Neovim");
  });

  it("handles multiple conversation turns sequentially", async () => {
    const chatResponses = new Map<string, string>();
    chatResponses.set(
      "favorite color is blue",
      JSON.stringify([
        {
          content: "User's favorite color is blue",
          type: "preference",
          tags: ["color"],
        },
      ])
    );
    chatResponses.set(
      "birthday is March 15",
      JSON.stringify([
        {
          content: "User's birthday is March 15",
          type: "fact",
          tags: ["personal"],
        },
      ])
    );

    const mockAi = createMockAi(chatResponses);
    semanticMemory = new SemanticMemory(
      env.DB,
      mockAi,
      "@cf/baai/bge-large-en-v1.5",
      mockVectorize
    );

    // Turn 1
    await consolidateTurn(
      mockAi,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      semanticMemory,
      "My favorite color is blue",
      "Blue is a lovely color!"
    );

    // Turn 2
    await consolidateTurn(
      mockAi,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      semanticMemory,
      "My birthday is March 15",
      "I'll remember that! Happy early or belated birthday!"
    );

    const stored = await semanticMemory.list();
    expect(stored).toHaveLength(2);

    // Verify both types exist
    const types = stored.map((m) => m.type);
    expect(types).toContain("preference");
    expect(types).toContain("fact");
  });

  it("survives AI extraction failure without corrupting D1", async () => {
    // Create an AI mock that throws on chat completions
    const failingAi = {
      async run(model: string, input: unknown) {
        const inp = input as Record<string, unknown>;
        if (inp.text && Array.isArray(inp.text)) {
          // Embedding calls still work
          return {
            data: (inp.text as string[]).map(() =>
              new Array(384).fill(0).map(() => Math.random())
            ),
          };
        }
        // Chat calls throw
        throw new Error("AI service unavailable");
      },
    } as unknown as Ai;

    semanticMemory = new SemanticMemory(
      env.DB,
      failingAi,
      "@cf/baai/bge-large-en-v1.5",
      mockVectorize
    );

    // Should not throw — consolidation catches errors internally
    const facts = await consolidateTurn(
      failingAi,
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      semanticMemory,
      "This should fail gracefully",
      "Response text"
    );

    expect(facts).toEqual([]);

    // D1 should be untouched
    const stored = await semanticMemory.list();
    expect(stored).toHaveLength(0);
  });
});
