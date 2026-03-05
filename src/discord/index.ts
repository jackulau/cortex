/**
 * Discord interaction handler for Cortex.
 * Handles incoming webhook interactions: PING/PONG handshake and slash commands.
 */

import type { Env } from "@/shared/types";
import { verifyDiscordRequest } from "./verify";
import { SemanticMemory } from "@/memory/semantic";
import type { CommandName } from "./commands";

// ── Discord Interaction Types ───────────────────────────────────
const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const;

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

// ── Discord Env Extension ───────────────────────────────────────
/** Discord-specific env bindings (added via wrangler secrets or .dev.vars) */
interface DiscordEnv extends Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APP_ID: string;
  DISCORD_BOT_TOKEN: string;
}

// ── Interaction Structures ──────────────────────────────────────
interface DiscordInteractionOption {
  name: string;
  type: number;
  value: string;
}

interface DiscordInteraction {
  type: number;
  data?: {
    name: string;
    options?: DiscordInteractionOption[];
  };
  token: string;
  application_id: string;
}

// ── Main Handler ────────────────────────────────────────────────

/**
 * Handle an incoming Discord interaction webhook request.
 * Verifies Ed25519 signature, handles PING, and routes slash commands.
 */
export async function handleDiscordInteraction(
  request: Request,
  env: DiscordEnv,
  ctx?: ExecutionContext
): Promise<Response> {
  // Verify Ed25519 signature
  const { isValid, body } = await verifyDiscordRequest(
    request,
    env.DISCORD_PUBLIC_KEY
  );

  if (!isValid) {
    return new Response("Invalid request signature", { status: 401 });
  }

  const interaction = body as DiscordInteraction;

  // Handle PING (required for Discord webhook URL registration)
  if (interaction.type === InteractionType.PING) {
    return jsonResponse({ type: InteractionResponseType.PONG });
  }

  // Handle APPLICATION_COMMAND
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    const commandName = interaction.data?.name as CommandName | undefined;

    if (!commandName) {
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Unknown command." },
      });
    }

    // Defer the response -- processing may take > 3 seconds
    if (ctx) {
      ctx.waitUntil(processCommand(commandName, interaction, env));
    } else {
      // No execution context available (e.g., in tests) -- process inline
      processCommand(commandName, interaction, env).catch(() => {});
    }

    return jsonResponse({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    });
  }

  // Unknown interaction type
  return new Response("Unknown interaction type", { status: 400 });
}

// ── Command Processing ──────────────────────────────────────────

/**
 * Process a slash command and send a follow-up message via webhook.
 */
async function processCommand(
  commandName: CommandName,
  interaction: DiscordInteraction,
  env: DiscordEnv
): Promise<void> {
  let content: string;

  try {
    const options = getOptions(interaction);

    switch (commandName) {
      case "ask":
        content = await handleAsk(options.get("question") ?? "", env);
        break;
      case "remember":
        content = await handleRemember(
          options.get("content") ?? "",
          (options.get("type") as "fact" | "preference" | "event" | "note") ??
            "fact",
          env
        );
        break;
      case "recall":
        content = await handleRecall(options.get("query") ?? "", env);
        break;
      case "research":
        content = await handleResearch(options.get("url") ?? "");
        break;
      case "digest":
        content = handleDigest();
        break;
      default:
        content = `Unknown command: ${commandName}`;
    }
  } catch (error) {
    content = `Error processing command: ${error instanceof Error ? error.message : "Unknown error"}`;
  }

  // Follow up via webhook
  await sendFollowUp(interaction.application_id, interaction.token, content);
}

/**
 * Extract options from a Discord interaction into a Map.
 */
function getOptions(
  interaction: DiscordInteraction
): Map<string, string> {
  const options = new Map<string, string>();
  for (const opt of interaction.data?.options ?? []) {
    options.set(opt.name, opt.value);
  }
  return options;
}

// ── Command Handlers ────────────────────────────────────────────

async function handleAsk(question: string, env: DiscordEnv): Promise<string> {
  if (!question) return "Please provide a question.";

  // Search semantic memory for relevant context
  const semanticMemory = new SemanticMemory(
    env.DB,
    env.AI,
    env.EMBEDDING_MODEL
  );
  const results = await semanticMemory.search(question, 3);

  if (results.length === 0) {
    return `**Q:** ${question}\n\nI don't have any relevant memories to answer this question. Try saving some information first with \`/remember\`.`;
  }

  const context = results
    .filter((r) => r.score > 0.5)
    .map((r) => `- ${r.entry.content} *(${r.entry.type}, ${(r.score * 100).toFixed(0)}% relevant)*`)
    .join("\n");

  if (!context) {
    return `**Q:** ${question}\n\nI found some memories but none were relevant enough. Try refining your question.`;
  }

  return `**Q:** ${question}\n\n**From my memory:**\n${context}`;
}

async function handleRemember(
  content: string,
  type: "fact" | "preference" | "event" | "note",
  env: DiscordEnv
): Promise<string> {
  if (!content) return "Please provide content to remember.";

  const semanticMemory = new SemanticMemory(
    env.DB,
    env.AI,
    env.EMBEDDING_MODEL
  );

  const id = await semanticMemory.write({
    content,
    type,
    source: "user",
    tags: ["discord"],
  });

  return `Remembered (${type}): "${content}"\n*Memory ID: \`${id}\`*`;
}

async function handleRecall(query: string, env: DiscordEnv): Promise<string> {
  if (!query) return "Please provide a search query.";

  const semanticMemory = new SemanticMemory(
    env.DB,
    env.AI,
    env.EMBEDDING_MODEL
  );

  const results = await semanticMemory.search(query, 5);

  if (results.length === 0) {
    return `No memories found for: "${query}"`;
  }

  const filtered = results.filter((r) => r.score > 0.5);
  if (filtered.length === 0) {
    return `No sufficiently relevant memories found for: "${query}"`;
  }

  const formatted = filtered
    .map(
      (r, i) =>
        `${i + 1}. **${r.entry.type}**: ${r.entry.content} *(${(r.score * 100).toFixed(0)}%)*`
    )
    .join("\n");

  return `**Search:** "${query}"\n\n${formatted}`;
}

async function handleResearch(_url: string): Promise<string> {
  if (!_url) return "Please provide a URL to research.";

  // Research tool is not yet fully implemented (requires browser extraction from Phase 2)
  return `Research for <${_url}> is queued. The browser extraction pipeline is not yet available -- this feature will be fully functional when the browser integration is complete.`;
}

function handleDigest(): string {
  // Digest is not yet fully implemented (requires Phase 3 watch lists)
  return "Digest is not yet available. The watch list and scheduled crawler features are coming in Phase 3.";
}

// ── Webhook Follow-up ───────────────────────────────────────────

/**
 * Send a follow-up message to Discord via the interaction webhook.
 * Uses PATCH to update the original deferred response.
 */
async function sendFollowUp(
  applicationId: string,
  interactionToken: string,
  content: string
): Promise<void> {
  const url = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`;

  // Discord message content limit is 2000 characters
  const truncated =
    content.length > 2000 ? content.slice(0, 1997) + "..." : content;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: truncated }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `Discord follow-up failed (${response.status}): ${errorText}`
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
