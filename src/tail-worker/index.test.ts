import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import tailWorker, {
  errorFingerprint,
  shouldAlert,
  formatErrorEmbeds,
  postToDiscord,
  clearRateLimits,
  type TailEvent,
  type TailWorkerEnv,
  type DiscordWebhookPayload,
} from "./index";

// ── Helpers ─────────────────────────────────────────────────────

function createTailEvent(overrides: Partial<TailEvent> = {}): TailEvent {
  return {
    scriptName: "cortex",
    event: { request: { url: "https://cortex.example.com/api/test", method: "GET" } },
    eventTimestamp: 1709700000000,
    logs: [],
    exceptions: [],
    outcome: "ok",
    ...overrides,
  };
}

function createErrorLog(message: string, timestamp = 1709700000000) {
  return {
    level: "error" as const,
    message: [message],
    timestamp,
  };
}

function createInfoLog(message: string, timestamp = 1709700000000) {
  return {
    level: "info" as const,
    message: [message],
    timestamp,
  };
}

function createException(name: string, message: string, timestamp = 1709700000000) {
  return { name, message, timestamp };
}

// ── Tests ───────────────────────────────────────────────────────

describe("Tail Worker", () => {
  // Clear rate-limit state between tests to avoid cross-test interference
  beforeEach(() => {
    clearRateLimits();
  });

  describe("errorFingerprint()", () => {
    it("normalizes UUIDs", () => {
      const fp1 = errorFingerprint("Failed for user 550e8400-e29b-41d4-a716-446655440000");
      const fp2 = errorFingerprint("Failed for user 123e4567-e89b-12d3-a456-426614174000");
      expect(fp1).toBe(fp2);
    });

    it("normalizes numeric timestamps", () => {
      const fp1 = errorFingerprint("Timeout at 1709700000000");
      const fp2 = errorFingerprint("Timeout at 1709700099999");
      expect(fp1).toBe(fp2);
    });

    it("normalizes plain numbers", () => {
      const fp1 = errorFingerprint("Error on line 42");
      const fp2 = errorFingerprint("Error on line 99");
      expect(fp1).toBe(fp2);
    });

    it("uses only the first line", () => {
      const fp1 = errorFingerprint("Connection refused\n  at connect()");
      const fp2 = errorFingerprint("Connection refused\n  at other()");
      expect(fp1).toBe(fp2);
    });

    it("returns different fingerprints for different errors", () => {
      const fp1 = errorFingerprint("Connection refused");
      const fp2 = errorFingerprint("Timeout waiting for response");
      expect(fp1).not.toBe(fp2);
    });
  });

  describe("shouldAlert()", () => {
    it("allows first alert for a new fingerprint", () => {
      const fp = "unique-test-error-" + Math.random();
      expect(shouldAlert(fp, Date.now())).toBe(true);
    });

    it("blocks duplicate within 1 minute", () => {
      const fp = "rate-limit-test-" + Math.random();
      const now = Date.now();
      expect(shouldAlert(fp, now)).toBe(true);
      expect(shouldAlert(fp, now + 30_000)).toBe(false); // 30 seconds later
    });

    it("allows after 1 minute cooldown", () => {
      const fp = "cooldown-test-" + Math.random();
      const now = Date.now();
      expect(shouldAlert(fp, now)).toBe(true);
      expect(shouldAlert(fp, now + 60_001)).toBe(true); // Just over 1 minute
    });

    it("tracks different fingerprints independently", () => {
      const fp1 = "independent-a-" + Math.random();
      const fp2 = "independent-b-" + Math.random();
      const now = Date.now();
      expect(shouldAlert(fp1, now)).toBe(true);
      expect(shouldAlert(fp2, now)).toBe(true);
      expect(shouldAlert(fp1, now + 10_000)).toBe(false);
      expect(shouldAlert(fp2, now + 10_000)).toBe(false);
    });
  });

  describe("formatErrorEmbeds()", () => {
    it("creates embeds for error-level logs", () => {
      const events: TailEvent[] = [
        createTailEvent({
          logs: [createErrorLog("Database connection failed")],
        }),
      ];

      const embeds = formatErrorEmbeds(events, Date.now());

      expect(embeds).toHaveLength(1);
      expect(embeds[0].title).toBe("Error in cortex");
      expect(embeds[0].color).toBe(0xff0000);
      expect(embeds[0].fields.some((f) => f.name === "console.error")).toBe(true);
      expect(embeds[0].fields.some((f) => f.name === "Request URL")).toBe(true);
      expect(embeds[0].fields.some((f) => f.name === "Outcome")).toBe(true);
    });

    it("creates embeds for uncaught exceptions", () => {
      const events: TailEvent[] = [
        createTailEvent({
          exceptions: [createException("TypeError", "Cannot read property 'x' of undefined")],
        }),
      ];

      const embeds = formatErrorEmbeds(events, Date.now());

      expect(embeds).toHaveLength(1);
      expect(embeds[0].fields.some((f) => f.name === "Uncaught TypeError")).toBe(true);
    });

    it("ignores non-error logs", () => {
      const events: TailEvent[] = [
        createTailEvent({
          logs: [
            createInfoLog("Request received"),
            { level: "log", message: ["Processing..."], timestamp: 1709700000000 },
            { level: "warn", message: ["Slow query"], timestamp: 1709700000000 },
            { level: "debug", message: ["Debug info"], timestamp: 1709700000000 },
          ],
        }),
      ];

      const embeds = formatErrorEmbeds(events, Date.now());
      expect(embeds).toHaveLength(0);
    });

    it("batches multiple errors from same invocation into one embed", () => {
      const events: TailEvent[] = [
        createTailEvent({
          logs: [
            createErrorLog("First error occurred"),
            createErrorLog("Second error occurred"),
          ],
          exceptions: [createException("Error", "Third error")],
        }),
      ];

      const embeds = formatErrorEmbeds(events, Date.now());

      // Should be one embed (one event) with multiple error fields
      expect(embeds).toHaveLength(1);
      const errorFields = embeds[0].fields.filter(
        (f) => f.name === "console.error" || f.name.startsWith("Uncaught")
      );
      expect(errorFields).toHaveLength(3);
    });

    it("handles events without request URL", () => {
      const events: TailEvent[] = [
        createTailEvent({
          event: { cron: "0 */6 * * *" },
          logs: [createErrorLog("Cron job failed")],
        }),
      ];

      const embeds = formatErrorEmbeds(events, Date.now());

      expect(embeds).toHaveLength(1);
      expect(embeds[0].fields.some((f) => f.name === "Request URL")).toBe(false);
    });

    it("handles null scriptName", () => {
      const events: TailEvent[] = [
        createTailEvent({
          scriptName: null,
          logs: [createErrorLog("Unknown worker error")],
        }),
      ];

      const embeds = formatErrorEmbeds(events, Date.now());

      expect(embeds).toHaveLength(1);
      expect(embeds[0].title).toBe("Error in unknown");
    });

    it("truncates long error messages to 1024 characters", () => {
      const longMessage = "A".repeat(2000);
      const events: TailEvent[] = [
        createTailEvent({
          logs: [createErrorLog(longMessage)],
        }),
      ];

      const embeds = formatErrorEmbeds(events, Date.now());

      const errorField = embeds[0].fields.find((f) => f.name === "console.error");
      expect(errorField).toBeDefined();
      expect(errorField!.value.length).toBeLessThanOrEqual(1024);
      expect(errorField!.value).toContain("...");
    });

    it("includes timestamp from event", () => {
      const events: TailEvent[] = [
        createTailEvent({
          eventTimestamp: 1709700000000,
          logs: [createErrorLog("Test error")],
        }),
      ];

      const embeds = formatErrorEmbeds(events, Date.now());

      expect(embeds[0].timestamp).toBe(new Date(1709700000000).toISOString());
    });

    it("deduplicates errors with the same fingerprint within one call", () => {
      const now = Date.now();
      const events: TailEvent[] = [
        createTailEvent({
          logs: [
            createErrorLog("Connection refused to host db.example.com"),
          ],
        }),
        createTailEvent({
          logs: [
            createErrorLog("Connection refused to host db.example.com"),
          ],
        }),
      ];

      const embeds = formatErrorEmbeds(events, now);

      // The second identical error should be rate-limited
      // First event produces an embed, second should not
      expect(embeds).toHaveLength(1);
    });

    it("returns empty array when no errors present", () => {
      const events: TailEvent[] = [
        createTailEvent({
          logs: [createInfoLog("All good")],
        }),
      ];

      const embeds = formatErrorEmbeds(events, Date.now());
      expect(embeds).toHaveLength(0);
    });
  });

  describe("postToDiscord()", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("OK", { status: 200 })
      );
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("sends embeds to the webhook URL", async () => {
      const embeds = [
        {
          title: "Error in cortex",
          color: 0xff0000,
          fields: [{ name: "console.error", value: "```\nTest\n```" }],
          timestamp: new Date().toISOString(),
        },
      ];

      await postToDiscord("https://discord.com/api/webhooks/test", embeds);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://discord.com/api/webhooks/test");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });

      const body = JSON.parse(init?.body as string) as DiscordWebhookPayload;
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0].title).toBe("Error in cortex");
    });

    it("chunks embeds into batches of 10", async () => {
      const embeds = Array.from({ length: 15 }, (_, i) => ({
        title: `Error ${i}`,
        color: 0xff0000,
        fields: [{ name: "error", value: `Error ${i}` }],
        timestamp: new Date().toISOString(),
      }));

      await postToDiscord("https://discord.com/api/webhooks/test", embeds);

      // Should have made 2 requests (10 + 5)
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const firstBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      const secondBody = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
      expect(firstBody.embeds).toHaveLength(10);
      expect(secondBody.embeds).toHaveLength(5);
    });

    it("logs error on webhook failure", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Bad Request", { status: 400 })
      );
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await postToDiscord("https://discord.com/api/webhooks/test", [
        {
          title: "Error",
          color: 0xff0000,
          fields: [],
          timestamp: new Date().toISOString(),
        },
      ]);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Discord webhook failed (400)")
      );
      consoleSpy.mockRestore();
    });
  });

  describe("tail() handler", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    const env: TailWorkerEnv = {
      DISCORD_ALERT_WEBHOOK_URL: "https://discord.com/api/webhooks/test/token",
    };

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("OK", { status: 200 })
      );
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("posts to Discord when events contain errors", async () => {
      const events: TailEvent[] = [
        createTailEvent({
          logs: [createErrorLog("Something went wrong: unique-error-" + Math.random())],
        }),
      ];

      await tailWorker.tail(events, env);

      expect(fetchSpy).toHaveBeenCalled();
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.embeds.length).toBeGreaterThan(0);
    });

    it("does nothing when no errors in events", async () => {
      const events: TailEvent[] = [
        createTailEvent({
          logs: [createInfoLog("All good")],
        }),
      ];

      await tailWorker.tail(events, env);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("does nothing when webhook URL is not configured", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const events: TailEvent[] = [
        createTailEvent({
          logs: [createErrorLog("This should not be posted")],
        }),
      ];

      await tailWorker.tail(events, { DISCORD_ALERT_WEBHOOK_URL: "" });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        "DISCORD_ALERT_WEBHOOK_URL is not configured"
      );
      consoleSpy.mockRestore();
    });

    it("handles events with only exceptions", async () => {
      const events: TailEvent[] = [
        createTailEvent({
          exceptions: [
            createException("RangeError", "Unique exception " + Math.random()),
          ],
        }),
      ];

      await tailWorker.tail(events, env);

      expect(fetchSpy).toHaveBeenCalled();
    });

    it("handles empty events array", async () => {
      await tailWorker.tail([], env);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("handles mixed error and non-error events", async () => {
      const events: TailEvent[] = [
        createTailEvent({
          logs: [createInfoLog("Normal operation")],
        }),
        createTailEvent({
          logs: [createErrorLog("Critical failure: unique-" + Math.random())],
        }),
      ];

      await tailWorker.tail(events, env);

      expect(fetchSpy).toHaveBeenCalled();
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      // Should only have embed for the error event
      expect(body.embeds).toHaveLength(1);
    });
  });
});
