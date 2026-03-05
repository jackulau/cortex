/**
 * Generate embeddings via Workers AI.
 */

/** Generate a single embedding vector for a text string. */
export async function generateEmbedding(
  ai: Ai,
  model: string,
  text: string
): Promise<number[]> {
  const result = (await ai.run(model as any, {
    text: [text],
  })) as { data: number[][] };
  return Array.from(result.data[0]);
}

/** Generate embeddings for multiple texts in a batch. */
export async function generateEmbeddings(
  ai: Ai,
  model: string,
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const result = (await ai.run(model as any, {
    text: texts,
  })) as { data: number[][] };
  return result.data.map((d) => Array.from(d));
}

/**
 * Chunk text for embedding long content.
 * Uses ~350 word chunks with ~50 word overlap.
 */
export function chunkText(
  text: string,
  chunkSize = 350,
  overlap = 50
): string[] {
  const words = text.split(/\s+/);
  if (words.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(" "));
    start += chunkSize - overlap;
  }

  return chunks;
}
