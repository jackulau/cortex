/**
 * Model Router — tier-based model selection for Workers AI calls.
 *
 * Maps task types to model tiers, allowing smaller/faster models for simple tasks
 * (consolidation, summarization) and the large model for complex reasoning.
 *
 * Model IDs are configurable via env vars (AI_MODEL_HEAVY, AI_MODEL_LIGHT).
 */

// ── Default model IDs ────────────────────────────────────────────
const DEFAULT_MODELS = {
  heavy: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", // complex reasoning, chat
  light: "@cf/meta/llama-3.1-8b-instruct-fp8", // consolidation, summarization
  fast: "@cf/meta/llama-3.1-8b-instruct-fp8", // classification, conflict detection
} as const;

export type ModelTier = keyof typeof DEFAULT_MODELS;

// ── Message type for AI calls ────────────────────────────────────
export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── Model resolution ─────────────────────────────────────────────

/**
 * Get the model ID for a given tier, with optional env var overrides.
 * Falls back to default model IDs if env vars are not set.
 */
export function getModel(
  tier: ModelTier,
  env?: { AI_MODEL_HEAVY?: string; AI_MODEL_LIGHT?: string }
): string {
  if (env) {
    if (tier === "heavy" && env.AI_MODEL_HEAVY) {
      return env.AI_MODEL_HEAVY;
    }
    if ((tier === "light" || tier === "fast") && env.AI_MODEL_LIGHT) {
      return env.AI_MODEL_LIGHT;
    }
  }
  return DEFAULT_MODELS[tier];
}

/**
 * Run an AI inference call using the appropriate model for the given tier.
 * Wraps env.AI.run() with tier-based model selection.
 */
export async function runAI(
  ai: Ai,
  tier: ModelTier,
  messages: AIMessage[],
  options?: {
    max_tokens?: number;
    env?: { AI_MODEL_HEAVY?: string; AI_MODEL_LIGHT?: string };
  }
): Promise<string> {
  const model = getModel(tier, options?.env);

  const response = (await ai.run(model as any, {
    messages,
    ...(options?.max_tokens ? { max_tokens: options.max_tokens } : {}),
  })) as { response?: string };

  return response.response?.trim() ?? "";
}

// ── Task-to-tier mapping reference ───────────────────────────────
// | Task                 | Tier  | Rationale                   |
// |----------------------|-------|-----------------------------|
// | Chat (agent loop)    | heavy | Complex reasoning needed    |
// | Consolidation        | light | Simple fact extraction      |
// | Conflict detection   | fast  | Binary classification       |
// | Memory merging       | light | Summarization               |
// | Research synthesis   | heavy | Complex analysis            |
// | Content summarizing  | light | Simple summarization        |
// | Digest formatting    | light | Simple formatting           |
