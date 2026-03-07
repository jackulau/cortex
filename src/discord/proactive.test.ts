import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendProactiveDigest, postToDiscordChannel } from "./proactive";
import { formatDigestMessage } from "@/monitor/digest";
import type { DigestEntry } from "@/monitor/digest";

// ── Mock Data ────────────────────────────────────────────────

function makeEntry(overrides: Partial<DigestEntry & { label?: string; url?: string }> = {}): DigestEntry {
  return {
    id: overrides.id ?? "entry-1",
    watchItemId: overrides.watchItemId ?? "watch-1",
    summary: overrides.summary ?? "Page updated with new pricing",
    changes: overrides.changes ?? null,
    delivered: overrides.delivered ?? false,
    createdAt: overrides.createdAt ?? "2024-01-15T10:00:00Z",
    ...("label" in overrides ? { label: overrides.label } : { label: "Competitor Pricing" }),
    ...("url" in overrides ? { url: overrides.url } : { url: "https://competitor.com/pricing" }),
  } as DigestEntry;
}

const mockEntries: DigestEntry[] = [
  makeEntry({
    id: "entry-1",
    watchItemId: "watch-1",
    summary: "Page updated with new pricing",
    createdAt: "2024-01-15T10:00:00Z",
  }),
  makeEntry({
    id: "entry-2",
    watchItemId: "watch-1",
    summary: "New blog post about features",
    createdAt: "2024-01-15T11:00:00Z",
  }),
  makeEntry({
    id: "entry-3",
    watchItemId: "watch-2",
    summary: "API docs updated",
    createdAt: "2024-01-15T12:00:00Z",
    label: "API Docs",
    url: "https://api.example.com/docs",
  }),
];

// ── formatDigestMessage Tests ───────────────────────────────

describe("formatDigestMessage", () => {
  it("returns null for empty entries", () => {
    expect(formatDigestMessage([])).toBeNull();
  });

  it("formats entries grouped by watch item", () => {
    const message = formatDigestMessage(mockEntries);

    expect(message).not.toBeNull();
    expect(message).toContain("Cortex Daily Digest");
    expect(message).toContain("Competitor Pricing");
    expect(message).toContain("API Docs");
    expect(message).toContain("Page updated with new pricing");
    expect(message).toContain("New blog post about features");
    expect(message).toContain("API docs updated");
  });

  it("includes timestamps for each entry", () => {
    const message = formatDigestMessage(mockEntries);

    expect(message).not.toBeNull();
    // The message should contain time-formatted strings (exact format depends on locale)
    expect(message).toMatch(/\d{1,2}:\d{2}/);
  });

  it("includes total count", () => {
    const message = formatDigestMessage(mockEntries);
    expect(message).toContain("3 updates total");
  });

  it("uses singular for single entry", () => {
    const message = formatDigestMessage([mockEntries[0]]);
    expect(message).toContain("1 update total");
  });

  it("includes URLs in linked format", () => {
    const message = formatDigestMessage(mockEntries);
    expect(message).toContain("[Competitor Pricing](https://competitor.com/pricing)");
    expect(message).toContain("[API Docs](https://api.example.com/docs)");
  });

  it("truncates messages over 2000 characters", () => {
    const longEntries = Array.from({ length: 50 }, (_, i) =>
      makeEntry({
        id: `entry-${i}`,
        summary: `This is a very long summary that contains many words to pad the message length entry number ${i}`,
        createdAt: `2024-01-15T${String(i % 24).padStart(2, "0")}:00:00Z`,
      })
    );

    const message = formatDigestMessage(longEntries);
    expect(message).not.toBeNull();
    expect(message!.length).toBeLessThanOrEqual(2000);
    expect(message!.endsWith("...")).toBe(true);
  });
});

// ── postToDiscordChannel Tests ──────────────────────────────

describe("postToDiscordChannel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to the correct Discord API endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg-1" }), { status: 200 })
    );

    await postToDiscordChannel("bot-token-123", "channel-456", "Hello digest!");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/channels/channel-456/messages");
    expect(opts?.method).toBe("POST");
    expect(opts?.headers).toEqual({
      Authorization: "Bot bot-token-123",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(opts?.body as string)).toEqual({ content: "Hello digest!" });
  });

  it("throws on non-OK responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Forbidden", { status: 403 })
    );

    await expect(
      postToDiscordChannel("bad-token", "channel-456", "Hello")
    ).rejects.toThrow("Discord channel post failed (403)");
  });
});

// ── sendProactiveDigest Tests ───────────────────────────────

describe("sendProactiveDigest", () => {
  function createMockEnv(overrides: Record<string, unknown> = {}) {
    const mockStmt = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    };

    return {
      DB: {
        prepare: vi.fn().mockReturnValue(mockStmt),
        batch: vi.fn().mockResolvedValue([]),
        _stmt: mockStmt,
      },
      DISCORD_BOT_TOKEN: "test-bot-token",
      DISCORD_DIGEST_CHANNEL_ID: "test-channel-id",
      ...overrides,
    } as any;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("skips when DISCORD_DIGEST_CHANNEL_ID is not configured", async () => {
    const env = createMockEnv({ DISCORD_DIGEST_CHANNEL_ID: "" });

    const result = await sendProactiveDigest(env);

    expect(result).toEqual({ sent: false, entryCount: 0 });
  });

  it("skips when DISCORD_BOT_TOKEN is not configured", async () => {
    const env = createMockEnv({ DISCORD_BOT_TOKEN: "" });

    const result = await sendProactiveDigest(env);

    expect(result).toEqual({ sent: false, entryCount: 0 });
  });

  it("skips when no undelivered entries exist", async () => {
    const env = createMockEnv();
    env.DB._stmt.all.mockResolvedValue({ results: [] });

    const result = await sendProactiveDigest(env);

    expect(result).toEqual({ sent: false, entryCount: 0 });
  });

  it("posts digest and marks entries delivered", async () => {
    const rawEntries = [
      {
        id: "entry-1",
        watch_item_id: "watch-1",
        summary: "Pricing changed",
        changes: null,
        delivered: 0,
        created_at: "2024-01-15T10:00:00Z",
        label: "Competitor",
        url: "https://competitor.com",
      },
    ];

    const env = createMockEnv();
    env.DB._stmt.all.mockResolvedValue({ results: rawEntries });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg-1" }), { status: 200 })
    );

    const result = await sendProactiveDigest(env);

    expect(result).toEqual({ sent: true, entryCount: 1 });

    // Verify Discord API was called
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://discord.com/api/v10/channels/test-channel-id/messages"
    );

    // Verify markDelivered was called (batch update)
    expect(env.DB.batch).toHaveBeenCalledTimes(1);
  });

  it("does not mark entries delivered when Discord post fails", async () => {
    const rawEntries = [
      {
        id: "entry-1",
        watch_item_id: "watch-1",
        summary: "Update",
        changes: null,
        delivered: 0,
        created_at: "2024-01-15T10:00:00Z",
        label: "Test",
        url: "https://test.com",
      },
    ];

    const env = createMockEnv();
    env.DB._stmt.all.mockResolvedValue({ results: rawEntries });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server Error", { status: 500 })
    );

    await expect(sendProactiveDigest(env)).rejects.toThrow(
      "Discord channel post failed (500)"
    );

    // markDelivered should NOT have been called
    expect(env.DB.batch).not.toHaveBeenCalled();
  });
});
