/**
 * Tail Worker for Discord Error Alerts.
 *
 * Receives structured log events from the main Cortex worker after each
 * invocation. Filters for error-level events (console.error + uncaught
 * exceptions) and posts formatted alerts to a Discord webhook.
 *
 * Rate limits Discord posts to max 1 per minute per error type to avoid spam.
 */

// ── Types ───────────────────────────────────────────────────────

export interface TailWorkerEnv {
  DISCORD_ALERT_WEBHOOK_URL: string;
}

/** A single log message from a worker invocation. */
export interface TailLogMessage {
  level: "debug" | "info" | "log" | "warn" | "error";
  message: unknown[];
  timestamp: number;
}

/** An exception caught by the runtime. */
export interface TailException {
  name: string;
  message: string;
  timestamp: number;
}

/** A single tail event representing one worker invocation. */
export interface TailEvent {
  scriptName: string | null;
  event:
    | { request?: { url: string; method: string } }
    | { cron?: string }
    | Record<string, unknown>
    | null;
  eventTimestamp: number | null;
  logs: TailLogMessage[];
  exceptions: TailException[];
  outcome: string;
}

/** Discord embed field. */
interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Discord embed. */
interface DiscordEmbed {
  title: string;
  color: number;
  description?: string;
  fields: DiscordEmbedField[];
  timestamp: string;
  footer?: { text: string };
}

/** Discord webhook payload. */
export interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
}

// ── Rate Limiting ───────────────────────────────────────────────

/**
 * In-memory rate limit tracker. Keys are error fingerprints,
 * values are the last post timestamp in ms.
 *
 * Since Tail Workers are short-lived, this map resets per invocation.
 * We store timestamps per error type within a single tail batch to
 * deduplicate within one invocation. For cross-invocation deduplication,
 * we rely on the 1-minute cooldown check.
 */
const RATE_LIMIT_MS = 60_000; // 1 minute
const recentAlerts = new Map<string, number>();

/**
 * Generate a fingerprint for deduplication.
 * Uses the first line of the error message to group similar errors.
 */
export function errorFingerprint(message: string): string {
  const firstLine = message.split("\n")[0].trim();
  // Normalize dynamic parts (UUIDs, timestamps, IDs)
  return firstLine
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<UUID>")
    .replace(/\b\d{10,13}\b/g, "<TIMESTAMP>")
    .replace(/\b\d+\b/g, "<N>");
}

/**
 * Check whether an alert for this fingerprint should be sent.
 * Returns true if allowed, false if rate-limited.
 */
export function shouldAlert(fingerprint: string, now: number): boolean {
  const lastSent = recentAlerts.get(fingerprint);
  if (lastSent && now - lastSent < RATE_LIMIT_MS) {
    return false;
  }
  recentAlerts.set(fingerprint, now);
  return true;
}

/** Clear the rate-limit map (used in tests). */
export function clearRateLimits(): void {
  recentAlerts.clear();
}

// ── Formatting ──────────────────────────────────────────────────

/**
 * Extract a request URL from a tail event, if present.
 */
function getRequestUrl(event: TailEvent): string | null {
  if (event.event && "request" in event.event && event.event.request) {
    return event.event.request.url;
  }
  return null;
}

/**
 * Truncate a string to a maximum length, appending "..." if truncated.
 */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/**
 * Format error-level logs and exceptions from a TailEvent into Discord embeds.
 * Multiple errors from the same invocation are batched into one embed.
 */
export function formatErrorEmbeds(events: TailEvent[], now: number): DiscordEmbed[] {
  const embeds: DiscordEmbed[] = [];

  for (const event of events) {
    const fields: DiscordEmbedField[] = [];
    const requestUrl = getRequestUrl(event);
    const scriptName = event.scriptName ?? "unknown";

    // Collect error-level log messages
    for (const log of event.logs) {
      if (log.level !== "error") continue;

      const message = log.message.map((m) => String(m)).join(" ");
      const fingerprint = errorFingerprint(message);

      if (!shouldAlert(fingerprint, now)) continue;

      fields.push({
        name: "console.error",
        value: truncate(`\`\`\`\n${message}\n\`\`\``, 1024),
      });
    }

    // Collect uncaught exceptions
    for (const exception of event.exceptions) {
      const message = `${exception.name}: ${exception.message}`;
      const fingerprint = errorFingerprint(message);

      if (!shouldAlert(fingerprint, now)) continue;

      fields.push({
        name: `Uncaught ${exception.name}`,
        value: truncate(`\`\`\`\n${message}\n\`\`\``, 1024),
      });
    }

    // Nothing to report for this event
    if (fields.length === 0) continue;

    // Add request URL field if available
    if (requestUrl) {
      fields.unshift({
        name: "Request URL",
        value: truncate(requestUrl, 1024),
        inline: true,
      });
    }

    // Add outcome field
    fields.push({
      name: "Outcome",
      value: event.outcome,
      inline: true,
    });

    const timestamp = event.eventTimestamp
      ? new Date(event.eventTimestamp).toISOString()
      : new Date(now).toISOString();

    embeds.push({
      title: `Error in ${scriptName}`,
      color: 0xff0000, // Red
      fields,
      timestamp,
      footer: { text: `Worker: ${scriptName}` },
    });
  }

  return embeds;
}

// ── Discord Posting ─────────────────────────────────────────────

/**
 * Post embeds to the Discord webhook. Discord allows max 10 embeds per message.
 */
export async function postToDiscord(
  webhookUrl: string,
  embeds: DiscordEmbed[]
): Promise<void> {
  // Discord limit: max 10 embeds per message
  const chunks: DiscordEmbed[][] = [];
  for (let i = 0; i < embeds.length; i += 10) {
    chunks.push(embeds.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const payload: DiscordWebhookPayload = { embeds: chunk };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Discord webhook failed (${response.status}): ${errorText}`
      );
    }
  }
}

// ── Tail Handler ────────────────────────────────────────────────

export default {
  async tail(events: TailEvent[], env: TailWorkerEnv): Promise<void> {
    if (!env.DISCORD_ALERT_WEBHOOK_URL) {
      console.error("DISCORD_ALERT_WEBHOOK_URL is not configured");
      return;
    }

    // Check if any events contain errors or exceptions
    const hasErrors = events.some(
      (e) =>
        e.logs.some((l) => l.level === "error") || e.exceptions.length > 0
    );

    if (!hasErrors) return;

    const now = Date.now();
    const embeds = formatErrorEmbeds(events, now);

    if (embeds.length === 0) return;

    await postToDiscord(env.DISCORD_ALERT_WEBHOOK_URL, embeds);
  },
};
