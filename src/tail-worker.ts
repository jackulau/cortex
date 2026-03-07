/**
 * Tail Worker — forwards error-level logs to Discord via webhook.
 *
 * This worker is configured as a tail consumer for the main Cortex worker.
 * It receives TraceItem[] from every invocation and filters for errors,
 * batching them into a single Discord message per tail invocation.
 */

export interface TailEnv {
  DISCORD_ERROR_WEBHOOK: string;
}

interface TailLogEntry {
  level: string;
  message: unknown[];
  timestamp: number;
}

interface TailException {
  name: string;
  message: string;
  timestamp: number;
}

interface TraceItem {
  scriptName?: string | null;
  outcome: string;
  eventTimestamp?: number | null;
  event?: Record<string, unknown> | null;
  logs: TailLogEntry[];
  exceptions: TailException[];
}

/** Maximum Discord message length (2000 chars). We leave room for formatting. */
const MAX_DISCORD_LENGTH = 1900;

/** Format a single error log entry into a readable string. */
export function formatLogEntry(log: TailLogEntry): string {
  const ts = new Date(log.timestamp).toISOString();
  const msg = log.message.map((m) => (typeof m === "string" ? m : JSON.stringify(m))).join(" ");
  return `[${ts}] ${msg}`;
}

/** Format an exception into a readable string. */
export function formatException(exc: TailException): string {
  const ts = new Date(exc.timestamp).toISOString();
  return `[${ts}] ${exc.name}: ${exc.message}`;
}

/** Collect all error-level information from a list of trace items. */
export function collectErrors(traces: TraceItem[]): string[] {
  const errors: string[] = [];

  for (const trace of traces) {
    const scriptLabel = trace.scriptName ?? "unknown";

    // Collect error-level logs
    for (const log of trace.logs) {
      if (log.level === "error") {
        errors.push(`**${scriptLabel}** ${formatLogEntry(log)}`);
      }
    }

    // Collect exceptions (always errors)
    for (const exc of trace.exceptions) {
      errors.push(`**${scriptLabel}** EXCEPTION ${formatException(exc)}`);
    }

    // If the invocation itself failed (outcome !== "ok"), note it
    if (trace.outcome !== "ok" && trace.outcome !== "canceled") {
      const ts = trace.eventTimestamp
        ? new Date(trace.eventTimestamp).toISOString()
        : "unknown time";
      errors.push(`**${scriptLabel}** Worker outcome: \`${trace.outcome}\` at ${ts}`);
    }
  }

  return errors;
}

/** Build a Discord-friendly message payload from error lines. */
export function buildDiscordPayload(errors: string[]): { content: string } {
  const header = ":rotating_light: **Cortex Error Alert**\n\n";
  let body = errors.join("\n");

  // Truncate if necessary to fit within Discord limits
  if (header.length + body.length > MAX_DISCORD_LENGTH) {
    const available = MAX_DISCORD_LENGTH - header.length - 30; // room for truncation notice
    body = body.slice(0, available) + "\n\n... (truncated)";
  }

  return { content: header + body };
}

/** Post an error payload to the Discord webhook. */
export async function postToDiscord(
  webhookUrl: string,
  payload: { content: string }
): Promise<Response> {
  return fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export default {
  async tail(traces: TraceItem[], env: TailEnv): Promise<void> {
    if (!env.DISCORD_ERROR_WEBHOOK) {
      return; // No webhook configured — silently skip
    }

    const errors = collectErrors(traces);
    if (errors.length === 0) {
      return; // No errors to report
    }

    const payload = buildDiscordPayload(errors);
    const resp = await postToDiscord(env.DISCORD_ERROR_WEBHOOK, payload);

    if (!resp.ok) {
      // Log but don't throw — tail workers should not fail noisily
      console.error(
        `Discord webhook failed: ${resp.status} ${resp.statusText}`
      );
    }
  },
};
