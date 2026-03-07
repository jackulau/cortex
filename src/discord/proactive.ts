/**
 * Proactive Digest — pushes undelivered digest entries to a Discord channel.
 * Called on a schedule (cron) so Cortex is genuinely proactive.
 */

import { DigestManager, formatDigestMessage } from "@/monitor/digest";
import type { Env } from "@/shared/types";

/**
 * Post undelivered digest entries to the configured Discord channel.
 * Marks entries as delivered after a successful post.
 * No-ops gracefully when there are no entries or no channel is configured.
 */
export async function sendProactiveDigest(env: Env): Promise<{
  sent: boolean;
  entryCount: number;
}> {
  const channelId = env.DISCORD_DIGEST_CHANNEL_ID;

  if (!channelId) {
    console.log("Proactive digest: DISCORD_DIGEST_CHANNEL_ID not configured, skipping.");
    return { sent: false, entryCount: 0 };
  }

  if (!env.DISCORD_BOT_TOKEN) {
    console.log("Proactive digest: DISCORD_BOT_TOKEN not configured, skipping.");
    return { sent: false, entryCount: 0 };
  }

  const digestManager = new DigestManager(env.DB);
  const entries = await digestManager.getUndelivered();

  if (entries.length === 0) {
    return { sent: false, entryCount: 0 };
  }

  const message = formatDigestMessage(entries);
  if (!message) {
    return { sent: false, entryCount: 0 };
  }

  // Post to Discord channel via bot API
  await postToDiscordChannel(env.DISCORD_BOT_TOKEN, channelId, message);

  // Mark all entries as delivered after successful post
  const ids = entries.map((e) => e.id);
  await digestManager.markDelivered(ids);

  console.log(
    `Proactive digest: posted ${entries.length} entries to channel ${channelId}`
  );

  return { sent: true, entryCount: entries.length };
}

/**
 * Post a message to a Discord channel using the bot token.
 * Throws on non-OK responses for the caller to handle.
 */
export async function postToDiscordChannel(
  botToken: string,
  channelId: string,
  content: string
): Promise<void> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Discord channel post failed (${response.status}): ${errorText}`
    );
  }
}
