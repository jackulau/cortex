import { describe, it, expect, vi } from "vitest";
import { chunkText, embedDocument } from "./generate";

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const text = "Hello world this is a short text";
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("chunks long text with overlap", () => {
    // Create text with 400 words
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const chunks = chunkText(text, 350, 50);
    expect(chunks.length).toBeGreaterThan(1);

    // First chunk should have 350 words
    expect(chunks[0].split(/\s+/).length).toBe(350);

    // Second chunk should start at word 300 (350 - 50 overlap)
    expect(chunks[1]).toContain("word300");
  });

  it("handles exact chunk size", () => {
    const words = Array.from({ length: 350 }, (_, i) => `word${i}`);
    const text = words.join(" ");

    const chunks = chunkText(text, 350, 50);
    expect(chunks).toHaveLength(1);
  });

  it("handles empty text", () => {
    const chunks = chunkText("");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("");
  });
});

describe("embedDocument", () => {
  function createMockAi(dim = 4): Ai {
    return {
      run: vi.fn(async (_model: string, input: { text: string[] }) => {
        // Return mock embeddings — one per text
        return {
          data: input.text.map(() =>
            Array.from({ length: dim }, () => Math.random())
          ),
        };
      }),
    } as unknown as Ai;
  }

  it("embeds a short document as single chunk", async () => {
    const ai = createMockAi(4);
    const result = await embedDocument(ai, "test-model", "short content here");

    expect(result.chunks).toHaveLength(1);
    expect(result.embeddings).toHaveLength(1);
    expect(result.avgEmbedding).toHaveLength(4);
    // With one chunk, average should equal the single embedding
    expect(result.avgEmbedding).toEqual(result.embeddings[0]);
  });

  it("embeds a long document into multiple chunks", async () => {
    const ai = createMockAi(4);
    const longContent = Array.from({ length: 800 }, (_, i) => `word${i}`).join(
      " "
    );

    const result = await embedDocument(ai, "test-model", longContent);

    expect(result.chunks.length).toBeGreaterThan(1);
    expect(result.embeddings.length).toBe(result.chunks.length);
    expect(result.avgEmbedding).toHaveLength(4);
  });

  it("computes correct average embedding", async () => {
    // Use deterministic embeddings
    const ai = {
      run: vi.fn(async (_model: string, input: { text: string[] }) => ({
        data: input.text.map((_, i) =>
          i === 0 ? [1, 2, 3, 4] : [3, 4, 5, 6]
        ),
      })),
    } as unknown as Ai;

    // Create text long enough for 2 chunks
    const longContent = Array.from({ length: 400 }, (_, i) => `word${i}`).join(
      " "
    );

    const result = await embedDocument(ai, "test-model", longContent);

    // Average of [1,2,3,4] and [3,4,5,6] = [2,3,4,5]
    expect(result.avgEmbedding).toEqual([2, 3, 4, 5]);
  });

  it("handles empty content", async () => {
    const ai = createMockAi(4);
    const result = await embedDocument(ai, "test-model", "");

    // Empty string is still one chunk (single word "" is <= 350)
    expect(result.chunks).toHaveLength(1);
    expect(result.embeddings).toHaveLength(1);
  });
});
