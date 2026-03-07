import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createClaudeProvider,
  createWorkersAIProvider,
  getChatProvider,
  getChatModel,
  type ChatProvider,
} from "./providers";
import type { Env } from "@/shared/types";

// Mock @anthropic-ai/sdk
vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Claude response" }],
  });
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
    __mockCreate: mockCreate,
  };
});

// Mock @ai-sdk/anthropic
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn().mockReturnValue(
    vi.fn().mockReturnValue({ type: "anthropic-model" })
  ),
}));

// Mock workers-ai-provider
vi.mock("workers-ai-provider", () => ({
  createWorkersAI: vi.fn().mockReturnValue(
    vi.fn().mockReturnValue({ type: "workers-ai-model" })
  ),
}));

describe("providers", () => {
  describe("createClaudeProvider", () => {
    it("creates a provider with chat method", () => {
      const provider = createClaudeProvider("test-api-key");
      expect(provider).toBeDefined();
      expect(typeof provider.chat).toBe("function");
    });

    it("calls Anthropic SDK with correct parameters", async () => {
      const provider = createClaudeProvider("test-api-key", "claude-sonnet-4-6");

      const result = await provider.chat(
        [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
        { maxTokens: 200 }
      );

      expect(result).toBe("Claude response");

      // Verify the SDK was instantiated with the API key
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      expect(Anthropic).toHaveBeenCalledWith({ apiKey: "test-api-key" });
    });

    it("separates system messages from chat messages", async () => {
      const provider = createClaudeProvider("test-key");

      await provider.chat([
        { role: "system", content: "System instruction" },
        { role: "user", content: "User message" },
        { role: "assistant", content: "Assistant reply" },
        { role: "user", content: "Follow-up" },
      ]);

      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const instance = new Anthropic({ apiKey: "test-key" });
      const mockCreate = instance.messages.create as any;

      // The last call should have system separated
      const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
      expect(lastCall.system).toBe("System instruction");
      expect(lastCall.messages).toEqual([
        { role: "user", content: "User message" },
        { role: "assistant", content: "Assistant reply" },
        { role: "user", content: "Follow-up" },
      ]);
    });

    it("uses default model when none specified", async () => {
      const provider = createClaudeProvider("test-key");
      await provider.chat([{ role: "user", content: "Hi" }]);

      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const instance = new Anthropic({ apiKey: "test-key" });
      const mockCreate = instance.messages.create as any;

      const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
      expect(lastCall.model).toBe("claude-sonnet-4-6");
    });

    it("uses custom model when specified", async () => {
      const provider = createClaudeProvider("test-key", "claude-opus-4-6");
      await provider.chat([{ role: "user", content: "Hi" }]);

      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const instance = new Anthropic({ apiKey: "test-key" });
      const mockCreate = instance.messages.create as any;

      const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
      expect(lastCall.model).toBe("claude-opus-4-6");
    });

    it("uses default maxTokens of 1024 when not specified", async () => {
      const provider = createClaudeProvider("test-key");
      await provider.chat([{ role: "user", content: "Hi" }]);

      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const instance = new Anthropic({ apiKey: "test-key" });
      const mockCreate = instance.messages.create as any;

      const lastCall = mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0];
      expect(lastCall.max_tokens).toBe(1024);
    });
  });

  describe("createWorkersAIProvider", () => {
    function createMockAi(responseText: string) {
      return {
        run: vi.fn().mockResolvedValue({ response: responseText }),
      } as unknown as Ai;
    }

    it("creates a provider with chat method", () => {
      const mockAi = createMockAi("test");
      const provider = createWorkersAIProvider(mockAi);
      expect(provider).toBeDefined();
      expect(typeof provider.chat).toBe("function");
    });

    it("calls Workers AI with correct model and messages", async () => {
      const mockAi = createMockAi("Workers AI response");
      const provider = createWorkersAIProvider(mockAi);

      const result = await provider.chat([
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hello" },
      ]);

      expect(result).toBe("Workers AI response");
      expect(mockAi.run).toHaveBeenCalled();
    });

    it("passes maxTokens when provided", async () => {
      const mockAi = createMockAi("response");
      const provider = createWorkersAIProvider(mockAi);

      await provider.chat(
        [{ role: "user", content: "Hello" }],
        { maxTokens: 500 }
      );

      const call = (mockAi.run as any).mock.calls[0];
      expect(call[1].max_tokens).toBe(500);
    });

    it("omits max_tokens when not provided", async () => {
      const mockAi = createMockAi("response");
      const provider = createWorkersAIProvider(mockAi);

      await provider.chat([{ role: "user", content: "Hello" }]);

      const call = (mockAi.run as any).mock.calls[0];
      expect(call[1].max_tokens).toBeUndefined();
    });

    it("trims whitespace from response", async () => {
      const mockAi = createMockAi("  padded  ");
      const provider = createWorkersAIProvider(mockAi);

      const result = await provider.chat([{ role: "user", content: "Hi" }]);
      expect(result).toBe("padded");
    });

    it("returns empty string when response is undefined", async () => {
      const mockAi = {
        run: vi.fn().mockResolvedValue({ response: undefined }),
      } as unknown as Ai;
      const provider = createWorkersAIProvider(mockAi);

      const result = await provider.chat([{ role: "user", content: "Hi" }]);
      expect(result).toBe("");
    });

    it("uses env overrides for model selection", async () => {
      const mockAi = createMockAi("response");
      const env = { AI_MODEL_LIGHT: "@cf/custom/light" };
      const provider = createWorkersAIProvider(mockAi, env);

      await provider.chat([{ role: "user", content: "Hi" }]);

      const call = (mockAi.run as any).mock.calls[0];
      expect(call[0]).toBe("@cf/custom/light");
    });
  });

  describe("getChatProvider", () => {
    it("returns Claude provider when ANTHROPIC_API_KEY is set", () => {
      const env = {
        ANTHROPIC_API_KEY: "sk-test-key",
        CLAUDE_MODEL: "claude-sonnet-4-6",
        AI: {} as Ai,
      } as unknown as Env;

      const provider = getChatProvider(env);
      expect(provider).toBeDefined();
      expect(typeof provider.chat).toBe("function");
    });

    it("returns Workers AI provider when ANTHROPIC_API_KEY is not set", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const env = {
        AI: { run: vi.fn() } as unknown as Ai,
      } as unknown as Env;

      const provider = getChatProvider(env);
      expect(provider).toBeDefined();
      expect(typeof provider.chat).toBe("function");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Workers AI fallback")
      );
      warnSpy.mockRestore();
    });

    it("logs warning when falling back to Workers AI", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const env = {
        AI: { run: vi.fn() } as unknown as Ai,
      } as unknown as Env;

      getChatProvider(env);

      expect(warnSpy).toHaveBeenCalledWith(
        "Using Workers AI fallback — set ANTHROPIC_API_KEY for better quality"
      );
      warnSpy.mockRestore();
    });

    it("does not log warning when ANTHROPIC_API_KEY is set", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const env = {
        ANTHROPIC_API_KEY: "sk-test",
        AI: {} as Ai,
      } as unknown as Env;

      getChatProvider(env);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("getChatModel", () => {
    it("returns Anthropic model when ANTHROPIC_API_KEY is set", async () => {
      const env = {
        ANTHROPIC_API_KEY: "sk-test-key",
        CLAUDE_MODEL: "claude-sonnet-4-6",
        AI: {} as Ai,
      } as unknown as Env;

      const model = await getChatModel(env);
      expect(model).toBeDefined();
      expect((model as any).type).toBe("anthropic-model");
    });

    it("returns Workers AI model when ANTHROPIC_API_KEY is not set", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const env = {
        AI: {} as Ai,
      } as unknown as Env;

      const model = await getChatModel(env);
      expect(model).toBeDefined();
      expect((model as any).type).toBe("workers-ai-model");
      warnSpy.mockRestore();
    });

    it("uses CLAUDE_MODEL env var for model selection", async () => {
      const mod = await import("@ai-sdk/anthropic");
      const mockFactory = vi.fn().mockReturnValue({ type: "custom-model" });
      vi.mocked(mod.createAnthropic).mockReturnValue(mockFactory as any);

      const env = {
        ANTHROPIC_API_KEY: "sk-test-key",
        CLAUDE_MODEL: "claude-opus-4-6",
        AI: {} as Ai,
      } as unknown as Env;

      await getChatModel(env);

      expect(mockFactory).toHaveBeenCalledWith("claude-opus-4-6");
    });

    it("uses default Claude model when CLAUDE_MODEL is not set", async () => {
      const mod = await import("@ai-sdk/anthropic");
      const mockFactory = vi.fn().mockReturnValue({ type: "default-model" });
      vi.mocked(mod.createAnthropic).mockReturnValue(mockFactory as any);

      const env = {
        ANTHROPIC_API_KEY: "sk-test-key",
        AI: {} as Ai,
      } as unknown as Env;

      await getChatModel(env);

      expect(mockFactory).toHaveBeenCalledWith("claude-sonnet-4-6");
    });
  });
});
