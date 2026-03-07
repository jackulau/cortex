/**
 * Chat Provider Abstraction — enables switching between Claude API and Workers AI.
 *
 * The getChatProvider() factory picks the provider based on env config:
 * - If ANTHROPIC_API_KEY is set, uses Claude API via Anthropic SDK
 * - Otherwise, falls back to Workers AI (Llama models)
 *
 * For Vercel AI SDK integration (streaming in cortex-agent), use getChatModel()
 * which returns a LanguageModel compatible with streamText().
 */

import { createWorkersAI } from "workers-ai-provider";
import { getModel, type AIMessage } from "./model-router";
import type { Env } from "@/shared/types";

// Default Claude model when CLAUDE_MODEL env var is not set
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

// ── ChatProvider interface — for direct (non-streaming) chat calls ──

export interface ChatProvider {
  chat(
    messages: AIMessage[],
    options?: { maxTokens?: number }
  ): Promise<string>;
}

// ── Claude Provider ─────────────────────────────────────────────────

export function createClaudeProvider(apiKey: string, model?: string): ChatProvider {
  const modelId = model || DEFAULT_CLAUDE_MODEL;

  return {
    async chat(messages, options) {
      // Use dynamic import to avoid issues if the SDK isn't available
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey });

      // Separate system messages from user/assistant messages
      const systemMessages = messages.filter((m) => m.role === "system");
      const chatMessages = messages.filter((m) => m.role !== "system");

      const response = await client.messages.create({
        model: modelId,
        max_tokens: options?.maxTokens ?? 1024,
        system: systemMessages.map((m) => m.content).join("\n\n") || undefined,
        messages: chatMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      });

      // Extract text from content blocks
      const text = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("");

      return text.trim();
    },
  };
}

// ── Workers AI Provider (fallback) ──────────────────────────────────

export function createWorkersAIProvider(
  ai: Ai,
  env?: { AI_MODEL_HEAVY?: string; AI_MODEL_LIGHT?: string }
): ChatProvider {
  return {
    async chat(messages, options) {
      const model = getModel("light", env);

      const response = (await ai.run(model as any, {
        messages,
        ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      })) as { response?: string };

      return response.response?.trim() ?? "";
    },
  };
}

// ── Factory: getChatProvider ────────────────────────────────────────

/**
 * Pick the best available chat provider based on environment config.
 * Prefers Claude API when ANTHROPIC_API_KEY is set; falls back to Workers AI.
 */
export function getChatProvider(env: Env): ChatProvider {
  if (env.ANTHROPIC_API_KEY) {
    return createClaudeProvider(env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL);
  }

  console.warn(
    "Using Workers AI fallback — set ANTHROPIC_API_KEY for better quality"
  );
  return createWorkersAIProvider(env.AI, env);
}

// ── Vercel AI SDK model helper ──────────────────────────────────────

/**
 * Get a Vercel AI SDK LanguageModel for use with streamText().
 * Returns an Anthropic model when ANTHROPIC_API_KEY is set,
 * otherwise a Workers AI model.
 */
export async function getChatModel(env: Env) {
  if (env.ANTHROPIC_API_KEY) {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const modelId = env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
    return anthropic(modelId);
  }

  console.warn(
    "Using Workers AI fallback for streaming — set ANTHROPIC_API_KEY for better quality"
  );
  const workersAI = createWorkersAI({ binding: env.AI });
  return workersAI(getModel("heavy", env));
}
