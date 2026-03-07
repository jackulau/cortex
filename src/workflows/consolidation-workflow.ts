/**
 * Consolidation Workflow — durable multi-step pipeline for extracting facts
 * from conversation turns and writing them to semantic memory.
 *
 * Steps:
 *   1. Extract facts from user/assistant messages via AI
 *   2. Generate embeddings for extracted facts
 *   3. Write facts to D1 semantic memory
 *   4. Upsert vectors to Vectorize index
 *
 * Each step has its own retry policy and state persists between steps,
 * so a failure in step 2 (embedding) won't re-run step 1 (extraction).
 */
import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from "cloudflare:workers";
import type { Env } from "@/shared/types";
import { generateEmbedding } from "@/embeddings/generate";
import { runAI } from "@/ai/model-router";

// ── Types ───────────────────────────────────────────────────────

export interface ConsolidationParams {
  userMessage: string;
  assistantMessage: string;
  sessionId: string;
}

export interface ExtractedFact {
  content: string;
  type: "fact" | "preference" | "event" | "note";
  tags: string[];
}

interface FactWithId extends ExtractedFact {
  id: string;
}

interface FactWithEmbedding extends FactWithId {
  embedding: number[];
}

// ── Extraction prompt ───────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a fact extraction system. Given a conversation exchange, extract any facts, preferences, or important information worth remembering long-term.

Rules:
- Extract only concrete, specific facts (not vague statements)
- Each fact should be self-contained and understandable without context
- Include who/what the fact is about
- Skip greetings, filler, and meta-conversation
- Return valid JSON only

Return a JSON array of objects:
[{ "content": "fact text", "type": "fact|preference|event|note", "tags": ["tag1"] }]

If nothing worth extracting, return: []`;

// ── Workflow ────────────────────────────────────────────────────

export class ConsolidationWorkflow extends WorkflowEntrypoint<
  Env,
  ConsolidationParams
> {
  async run(
    event: WorkflowEvent<ConsolidationParams>,
    step: WorkflowStep
  ): Promise<void> {
    const { userMessage, assistantMessage } = event.payload;

    // Step 1: Extract facts from conversation
    const facts = await step.do(
      "extract-facts",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "30 seconds" },
      async () => {
        const conversationText = `User: ${userMessage}\nAssistant: ${assistantMessage}`;

        const text = await runAI(
          this.env.AI,
          "light",
          [
            { role: "system", content: EXTRACTION_PROMPT },
            { role: "user", content: conversationText },
          ],
          { max_tokens: 500, env: this.env }
        );

        if (!text) return [];

        const jsonStr = text.replace(/```json?\s*|\s*```/g, "").trim();
        const parsed: ExtractedFact[] = JSON.parse(jsonStr);

        if (!Array.isArray(parsed) || parsed.length === 0) return [];

        // Assign IDs to each fact for idempotent writes
        return parsed.map((f) => ({
          id: crypto.randomUUID(),
          content: f.content,
          type: f.type || "fact",
          tags: f.tags || [],
        })) as FactWithId[];
      }
    );

    if (facts.length === 0) return;

    // Step 2: Generate embeddings for each extracted fact
    const factsWithEmbeddings = await step.do(
      "generate-embeddings",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "30 seconds" },
      async () => {
        const results: FactWithEmbedding[] = [];

        for (const fact of facts) {
          const embedding = await generateEmbedding(
            this.env.AI,
            this.env.EMBEDDING_MODEL,
            fact.content
          );
          results.push({ ...fact, embedding });
        }

        return results;
      }
    );

    // Step 3: Check for duplicates and write facts to D1
    const newFacts = await step.do(
      "write-to-d1",
      { retries: { limit: 3, delay: "3 seconds", backoff: "exponential" }, timeout: "15 seconds" },
      async () => {
        const written: FactWithEmbedding[] = [];

        for (const fact of factsWithEmbeddings) {
          // Check for near-duplicates using Vectorize ANN search
          const vectorResults = await this.env.VECTORIZE.query(
            fact.embedding,
            { topK: 3, filter: { type: fact.type } }
          );

          const duplicate = vectorResults.matches?.find(
            (m) => (m.score ?? 0) > 0.92
          );

          if (duplicate) {
            // Update existing memory timestamp instead of creating new one
            const now = new Date().toISOString();
            try {
              await this.env.DB.prepare(
                `UPDATE semantic_memories SET updated_at = ?, access_count = access_count + 1 WHERE id = ?`
              )
                .bind(now, duplicate.id)
                .run();
            } catch {
              await this.env.DB.prepare(
                `UPDATE semantic_memories SET updated_at = ? WHERE id = ?`
              )
                .bind(now, duplicate.id)
                .run();
            }
            continue;
          }

          // Insert new memory + embedding into D1
          const now = new Date().toISOString();
          const tags = JSON.stringify(fact.tags);

          await this.env.DB.batch([
            this.env.DB.prepare(
              `INSERT INTO semantic_memories (id, content, type, source, tags, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              fact.id,
              fact.content,
              fact.type,
              "consolidated",
              tags,
              now,
              now
            ),
            this.env.DB.prepare(
              `INSERT INTO memory_embeddings (memory_id, embedding, created_at)
               VALUES (?, ?, ?)`
            ).bind(fact.id, embeddingToBlob(fact.embedding), now),
          ]);

          written.push(fact);
        }

        // Return the facts that were actually written (non-duplicate)
        return written;
      }
    );

    // Step 4: Upsert vectors to Vectorize index
    if (newFacts.length > 0) {
      await step.do(
        "upsert-vectors",
        { retries: { limit: 3, delay: "3 seconds", backoff: "exponential" }, timeout: "15 seconds" },
        async () => {
          await this.env.VECTORIZE.upsert(
            newFacts.map((f) => ({
              id: f.id,
              values: f.embedding,
              metadata: { type: f.type },
            }))
          );
        }
      );
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function embeddingToBlob(embedding: number[]): ArrayBuffer {
  return new Float32Array(embedding).buffer;
}
