import { describe, it, expect, vi } from "vitest";
import {
  formatLogEntry,
  formatException,
  collectErrors,
  buildDiscordPayload,
  postToDiscord,
} from "./tail-worker";
import tailWorker from "./tail-worker";

// ── formatLogEntry ──────────────────────────────────────────────

describe("formatLogEntry", () => {
  it("formats a string log message with timestamp", () => {
    const result = formatLogEntry({
      level: "error",
      message: ["Something went wrong"],
      timestamp: 1700000000000,
    });
    expect(result).toContain("2023-11-");
    expect(result).toContain("Something went wrong");
  });

  it("stringifies non-string message parts", () => {
    const result = formatLogEntry({
      level: "error",
      message: ["error:", { code: 500 }],
      timestamp: 1700000000000,
    });
    expect(result).toContain("error:");
    expect(result).toContain('{"code":500}');
  });

  it("handles multiple message parts", () => {
    const result = formatLogEntry({
      level: "error",
      message: ["part1", "part2", "part3"],
      timestamp: 1700000000000,
    });
    expect(result).toContain("part1 part2 part3");
  });
});

// ── formatException ─────────────────────────────────────────────

describe("formatException", () => {
  it("formats an exception with name and message", () => {
    const result = formatException({
      name: "TypeError",
      message: "Cannot read property 'x' of undefined",
      timestamp: 1700000000000,
    });
    expect(result).toContain("TypeError");
    expect(result).toContain("Cannot read property 'x' of undefined");
    expect(result).toContain("2023-11-");
  });
});

// ── collectErrors ───────────────────────────────────────────────

describe("collectErrors", () => {
  it("returns empty array when no errors exist", () => {
    const traces = [
      {
        scriptName: "cortex",
        outcome: "ok",
        eventTimestamp: 1700000000000,
        event: null,
        logs: [
          { level: "log", message: ["all good"], timestamp: 1700000000000 },
        ],
        exceptions: [],
      },
    ];
    expect(collectErrors(traces)).toEqual([]);
  });

  it("collects error-level logs", () => {
    const traces = [
      {
        scriptName: "cortex",
        outcome: "ok",
        eventTimestamp: 1700000000000,
        event: null,
        logs: [
          { level: "error", message: ["DB timeout"], timestamp: 1700000000000 },
          { level: "log", message: ["info msg"], timestamp: 1700000000001 },
        ],
        exceptions: [],
      },
    ];
    const errors = collectErrors(traces);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("cortex");
    expect(errors[0]).toContain("DB timeout");
  });

  it("collects exceptions", () => {
    const traces = [
      {
        scriptName: "cortex",
        outcome: "ok",
        eventTimestamp: 1700000000000,
        event: null,
        logs: [],
        exceptions: [
          {
            name: "RangeError",
            message: "out of bounds",
            timestamp: 1700000000000,
          },
        ],
      },
    ];
    const errors = collectErrors(traces);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("EXCEPTION");
    expect(errors[0]).toContain("RangeError");
    expect(errors[0]).toContain("out of bounds");
  });

  it("collects failed outcomes", () => {
    const traces = [
      {
        scriptName: "cortex",
        outcome: "exceededCpu",
        eventTimestamp: 1700000000000,
        event: null,
        logs: [],
        exceptions: [],
      },
    ];
    const errors = collectErrors(traces);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("exceededCpu");
  });

  it("does not flag canceled outcomes as errors", () => {
    const traces = [
      {
        scriptName: "cortex",
        outcome: "canceled",
        eventTimestamp: 1700000000000,
        event: null,
        logs: [],
        exceptions: [],
      },
    ];
    expect(collectErrors(traces)).toEqual([]);
  });

  it("uses 'unknown' when scriptName is null", () => {
    const traces = [
      {
        scriptName: null,
        outcome: "ok",
        eventTimestamp: 1700000000000,
        event: null,
        logs: [
          {
            level: "error",
            message: ["fail"],
            timestamp: 1700000000000,
          },
        ],
        exceptions: [],
      },
    ];
    const errors = collectErrors(traces);
    expect(errors[0]).toContain("unknown");
  });

  it("collects errors from multiple traces", () => {
    const traces = [
      {
        scriptName: "worker-a",
        outcome: "ok",
        eventTimestamp: null,
        event: null,
        logs: [
          { level: "error", message: ["err1"], timestamp: 1700000000000 },
        ],
        exceptions: [],
      },
      {
        scriptName: "worker-b",
        outcome: "ok",
        eventTimestamp: null,
        event: null,
        logs: [
          { level: "error", message: ["err2"], timestamp: 1700000000001 },
        ],
        exceptions: [],
      },
    ];
    const errors = collectErrors(traces);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("worker-a");
    expect(errors[1]).toContain("worker-b");
  });
});

// ── buildDiscordPayload ─────────────────────────────────────────

describe("buildDiscordPayload", () => {
  it("includes error alert header", () => {
    const payload = buildDiscordPayload(["error line 1"]);
    expect(payload.content).toContain("Cortex Error Alert");
  });

  it("includes error lines in body", () => {
    const payload = buildDiscordPayload(["error A", "error B"]);
    expect(payload.content).toContain("error A");
    expect(payload.content).toContain("error B");
  });

  it("truncates excessively long messages", () => {
    const longErrors = Array.from({ length: 200 }, (_, i) => `error line ${i} ${"x".repeat(50)}`);
    const payload = buildDiscordPayload(longErrors);
    expect(payload.content.length).toBeLessThanOrEqual(1950);
    expect(payload.content).toContain("truncated");
  });
});

// ── postToDiscord ───────────────────────────────────────────────

describe("postToDiscord", () => {
  it("sends POST request with JSON payload to webhook URL", async () => {
    const mockResponse = new Response(null, { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    const payload = { content: "test error" };
    const resp = await postToDiscord("https://discord.com/api/webhooks/test", payload);

    expect(fetchSpy).toHaveBeenCalledWith("https://discord.com/api/webhooks/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(resp.status).toBe(200);

    fetchSpy.mockRestore();
  });
});

// ── tail handler ────────────────────────────────────────────────

describe("tail handler", () => {
  it("does nothing when no webhook is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await tailWorker.tail(
      [
        {
          scriptName: "cortex",
          outcome: "ok",
          eventTimestamp: null,
          event: null,
          logs: [
            { level: "error", message: ["fail"], timestamp: 1700000000000 },
          ],
          exceptions: [],
        },
      ],
      { DISCORD_ERROR_WEBHOOK: "" }
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does nothing when there are no errors", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await tailWorker.tail(
      [
        {
          scriptName: "cortex",
          outcome: "ok",
          eventTimestamp: null,
          event: null,
          logs: [
            { level: "log", message: ["info"], timestamp: 1700000000000 },
          ],
          exceptions: [],
        },
      ],
      { DISCORD_ERROR_WEBHOOK: "https://discord.com/api/webhooks/test" }
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("posts to Discord when errors are found", async () => {
    const mockResponse = new Response(null, { status: 200 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);

    await tailWorker.tail(
      [
        {
          scriptName: "cortex",
          outcome: "ok",
          eventTimestamp: null,
          event: null,
          logs: [
            { level: "error", message: ["DB crashed"], timestamp: 1700000000000 },
          ],
          exceptions: [],
        },
      ],
      { DISCORD_ERROR_WEBHOOK: "https://discord.com/api/webhooks/test" }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://discord.com/api/webhooks/test");
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.content).toContain("DB crashed");

    fetchSpy.mockRestore();
  });

  it("logs error but does not throw when Discord returns non-ok", async () => {
    const mockResponse = new Response("rate limited", { status: 429 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockResponse);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await tailWorker.tail(
      [
        {
          scriptName: "cortex",
          outcome: "exceededCpu",
          eventTimestamp: 1700000000000,
          event: null,
          logs: [],
          exceptions: [],
        },
      ],
      { DISCORD_ERROR_WEBHOOK: "https://discord.com/api/webhooks/test" }
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Discord webhook failed: 429")
    );

    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
