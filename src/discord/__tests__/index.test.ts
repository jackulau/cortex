import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleDiscordInteraction } from "../index";

// Mock the verify module
vi.mock("../verify", () => ({
  verifyDiscordRequest: vi.fn(),
}));

// Mock the semantic memory module
vi.mock("@/memory/semantic", () => ({
  SemanticMemory: vi.fn().mockImplementation(() => ({
    write: vi.fn().mockResolvedValue("test-memory-id"),
    search: vi.fn().mockResolvedValue([]),
  })),
}));

import { verifyDiscordRequest } from "../verify";

const mockVerify = vi.mocked(verifyDiscordRequest);

// Minimal env for Discord interactions
function createMockEnv() {
  return {
    CortexAgent: {} as any,
    DB: {} as any,
    STORAGE: {} as any,
    AI: {} as any,
    EMBEDDING_MODEL: "@cf/baai/bge-large-en-v1.5",
    CHAT_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    DISCORD_PUBLIC_KEY: "test-public-key",
    DISCORD_APP_ID: "test-app-id",
    DISCORD_BOT_TOKEN: "test-bot-token",
  };
}

function createRequest(body: unknown): Request {
  return new Request("https://example.com/discord", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": "test-sig",
      "X-Signature-Timestamp": "1234567890",
    },
    body: JSON.stringify(body),
  });
}

describe("handleDiscordInteraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress fetch calls to Discord webhook
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );
  });

  it("returns 401 for invalid signature", async () => {
    mockVerify.mockResolvedValue({ isValid: false, body: null });

    const request = createRequest({ type: 1 });
    const env = createMockEnv();

    const response = await handleDiscordInteraction(request, env);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid request signature");
  });

  it("responds with PONG for PING interaction (type 1)", async () => {
    mockVerify.mockResolvedValue({ isValid: true, body: { type: 1 } });

    const request = createRequest({ type: 1 });
    const env = createMockEnv();

    const response = await handleDiscordInteraction(request, env);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ type: 1 }); // PONG
  });

  it("returns deferred response for APPLICATION_COMMAND (type 2)", async () => {
    mockVerify.mockResolvedValue({
      isValid: true,
      body: {
        type: 2,
        data: {
          name: "ask",
          options: [{ name: "question", type: 3, value: "What is Cortex?" }],
        },
        token: "test-token",
        application_id: "test-app-id",
      },
    });

    const request = createRequest({});
    const env = createMockEnv();

    const response = await handleDiscordInteraction(request, env);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  });

  it("returns 400 for unknown interaction type", async () => {
    mockVerify.mockResolvedValue({
      isValid: true,
      body: { type: 99 },
    });

    const request = createRequest({});
    const env = createMockEnv();

    const response = await handleDiscordInteraction(request, env);
    expect(response.status).toBe(400);
  });

  it("handles APPLICATION_COMMAND with no data gracefully", async () => {
    mockVerify.mockResolvedValue({
      isValid: true,
      body: {
        type: 2,
        token: "test-token",
        application_id: "test-app-id",
      },
    });

    const request = createRequest({});
    const env = createMockEnv();

    const response = await handleDiscordInteraction(request, env);
    expect(response.status).toBe(200);

    const data = await response.json();
    // Should return CHANNEL_MESSAGE_WITH_SOURCE with "Unknown command"
    expect(data.type).toBe(4);
    expect(data.data.content).toBe("Unknown command.");
  });

  it("sends follow-up via PATCH for /ask command", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );

    mockVerify.mockResolvedValue({
      isValid: true,
      body: {
        type: 2,
        data: {
          name: "ask",
          options: [{ name: "question", type: 3, value: "Hello?" }],
        },
        token: "interaction-token",
        application_id: "app-123",
      },
    });

    const request = createRequest({});
    const env = createMockEnv();

    // No ctx, so processCommand runs inline (fire-and-forget)
    await handleDiscordInteraction(request, env);

    // Allow the async processCommand to complete
    await new Promise((r) => setTimeout(r, 100));

    // Check that a PATCH was made to the Discord webhook
    const patchCalls = fetchSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as RequestInit).method === "PATCH"
    );
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);

    const [url, opts] = patchCalls[0];
    expect(url).toBe(
      "https://discord.com/api/v10/webhooks/app-123/interaction-token/messages/@original"
    );
    expect((opts as RequestInit).method).toBe("PATCH");
  });

  it("sends follow-up via PATCH for /remember command", async () => {
    const { SemanticMemory } = await import("@/memory/semantic");
    const mockWrite = vi.fn().mockResolvedValue("new-memory-id");
    vi.mocked(SemanticMemory).mockImplementation(
      () =>
        ({
          write: mockWrite,
          search: vi.fn().mockResolvedValue([]),
        }) as any
    );

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );

    mockVerify.mockResolvedValue({
      isValid: true,
      body: {
        type: 2,
        data: {
          name: "remember",
          options: [
            { name: "content", type: 3, value: "I like TypeScript" },
            { name: "type", type: 3, value: "preference" },
          ],
        },
        token: "interaction-token",
        application_id: "app-123",
      },
    });

    const request = createRequest({});
    const env = createMockEnv();

    await handleDiscordInteraction(request, env);
    await new Promise((r) => setTimeout(r, 100));

    // Check the follow-up was sent
    const patchCalls = fetchSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as RequestInit).method === "PATCH"
    );
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);

    const body = JSON.parse((patchCalls[0][1] as RequestInit).body as string);
    expect(body.content).toContain("Remembered");
    expect(body.content).toContain("I like TypeScript");
  });

  it("sends follow-up for /recall command with no results", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );

    mockVerify.mockResolvedValue({
      isValid: true,
      body: {
        type: 2,
        data: {
          name: "recall",
          options: [{ name: "query", type: 3, value: "TypeScript" }],
        },
        token: "interaction-token",
        application_id: "app-123",
      },
    });

    const request = createRequest({});
    const env = createMockEnv();

    await handleDiscordInteraction(request, env);
    await new Promise((r) => setTimeout(r, 100));

    const patchCalls = fetchSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as RequestInit).method === "PATCH"
    );
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);

    const body = JSON.parse((patchCalls[0][1] as RequestInit).body as string);
    expect(body.content).toContain("No memories found");
  });

  it("sends follow-up for /research command (stubbed)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );

    mockVerify.mockResolvedValue({
      isValid: true,
      body: {
        type: 2,
        data: {
          name: "research",
          options: [
            { name: "url", type: 3, value: "https://example.com" },
          ],
        },
        token: "interaction-token",
        application_id: "app-123",
      },
    });

    const request = createRequest({});
    const env = createMockEnv();

    await handleDiscordInteraction(request, env);
    await new Promise((r) => setTimeout(r, 100));

    const patchCalls = fetchSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as RequestInit).method === "PATCH"
    );
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);

    const body = JSON.parse((patchCalls[0][1] as RequestInit).body as string);
    expect(body.content).toContain("https://example.com");
  });

  it("sends follow-up for /digest command (stubbed)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 })
    );

    mockVerify.mockResolvedValue({
      isValid: true,
      body: {
        type: 2,
        data: {
          name: "digest",
        },
        token: "interaction-token",
        application_id: "app-123",
      },
    });

    const request = createRequest({});
    const env = createMockEnv();

    await handleDiscordInteraction(request, env);
    await new Promise((r) => setTimeout(r, 100));

    const patchCalls = fetchSpy.mock.calls.filter(
      (call) =>
        typeof call[1] === "object" &&
        (call[1] as RequestInit).method === "PATCH"
    );
    expect(patchCalls.length).toBeGreaterThanOrEqual(1);

    const body = JSON.parse((patchCalls[0][1] as RequestInit).body as string);
    expect(body.content).toContain("Digest");
  });

  it("uses ctx.waitUntil when execution context is provided", async () => {
    mockVerify.mockResolvedValue({
      isValid: true,
      body: {
        type: 2,
        data: {
          name: "digest",
        },
        token: "interaction-token",
        application_id: "app-123",
      },
    });

    const request = createRequest({});
    const env = createMockEnv();
    const ctx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    await handleDiscordInteraction(request, env, ctx);

    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    expect(ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });
});
