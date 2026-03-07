import { describe, it, expect, vi } from "vitest";
import { getModel, runAI, type ModelTier, type AIMessage } from "./model-router";

describe("model-router", () => {
  describe("getModel", () => {
    it("returns the default heavy model when no env overrides", () => {
      expect(getModel("heavy")).toBe(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      );
    });

    it("returns the default light model when no env overrides", () => {
      expect(getModel("light")).toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
    });

    it("returns the default fast model when no env overrides", () => {
      expect(getModel("fast")).toBe("@cf/meta/llama-3.1-8b-instruct-fp8");
    });

    it("uses AI_MODEL_HEAVY env var override for heavy tier", () => {
      const env = {
        AI_MODEL_HEAVY: "@cf/custom/heavy-model",
        AI_MODEL_LIGHT: "@cf/custom/light-model",
      };
      expect(getModel("heavy", env)).toBe("@cf/custom/heavy-model");
    });

    it("uses AI_MODEL_LIGHT env var override for light tier", () => {
      const env = {
        AI_MODEL_HEAVY: "@cf/custom/heavy-model",
        AI_MODEL_LIGHT: "@cf/custom/light-model",
      };
      expect(getModel("light", env)).toBe("@cf/custom/light-model");
    });

    it("uses AI_MODEL_LIGHT env var override for fast tier", () => {
      const env = {
        AI_MODEL_HEAVY: "@cf/custom/heavy-model",
        AI_MODEL_LIGHT: "@cf/custom/light-model",
      };
      expect(getModel("fast", env)).toBe("@cf/custom/light-model");
    });

    it("falls back to default when env vars are empty strings", () => {
      const env = { AI_MODEL_HEAVY: "", AI_MODEL_LIGHT: "" };
      expect(getModel("heavy", env)).toBe(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      );
      expect(getModel("light", env)).toBe(
        "@cf/meta/llama-3.1-8b-instruct-fp8"
      );
    });

    it("falls back to default when env vars are undefined", () => {
      const env = { AI_MODEL_HEAVY: undefined, AI_MODEL_LIGHT: undefined };
      expect(getModel("heavy", env)).toBe(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      );
      expect(getModel("light", env)).toBe(
        "@cf/meta/llama-3.1-8b-instruct-fp8"
      );
    });

    it("partial env overrides only affect their tier", () => {
      const envOnlyHeavy = { AI_MODEL_HEAVY: "@cf/custom/heavy-only" };
      expect(getModel("heavy", envOnlyHeavy)).toBe("@cf/custom/heavy-only");
      expect(getModel("light", envOnlyHeavy)).toBe(
        "@cf/meta/llama-3.1-8b-instruct-fp8"
      );

      const envOnlyLight = { AI_MODEL_LIGHT: "@cf/custom/light-only" };
      expect(getModel("heavy", envOnlyLight)).toBe(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
      );
      expect(getModel("light", envOnlyLight)).toBe("@cf/custom/light-only");
    });
  });

  describe("runAI", () => {
    function createMockAi(responseText: string) {
      return {
        run: vi.fn().mockResolvedValue({ response: responseText }),
      } as unknown as Ai;
    }

    const testMessages: AIMessage[] = [
      { role: "system", content: "You are a test assistant." },
      { role: "user", content: "Hello" },
    ];

    it("calls ai.run with the correct heavy model", async () => {
      const mockAi = createMockAi("Hello back!");
      const result = await runAI(mockAi, "heavy", testMessages);

      expect(result).toBe("Hello back!");
      expect(mockAi.run).toHaveBeenCalledWith(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        { messages: testMessages }
      );
    });

    it("calls ai.run with the correct light model", async () => {
      const mockAi = createMockAi("Light response");
      const result = await runAI(mockAi, "light", testMessages);

      expect(result).toBe("Light response");
      expect(mockAi.run).toHaveBeenCalledWith(
        "@cf/meta/llama-3.1-8b-instruct-fp8",
        { messages: testMessages }
      );
    });

    it("calls ai.run with the correct fast model", async () => {
      const mockAi = createMockAi("Fast response");
      const result = await runAI(mockAi, "fast", testMessages);

      expect(result).toBe("Fast response");
      expect(mockAi.run).toHaveBeenCalledWith(
        "@cf/meta/llama-3.1-8b-instruct-fp8",
        { messages: testMessages }
      );
    });

    it("passes max_tokens when provided", async () => {
      const mockAi = createMockAi("Capped response");
      await runAI(mockAi, "light", testMessages, { max_tokens: 500 });

      expect(mockAi.run).toHaveBeenCalledWith(
        "@cf/meta/llama-3.1-8b-instruct-fp8",
        { messages: testMessages, max_tokens: 500 }
      );
    });

    it("does not include max_tokens when not provided", async () => {
      const mockAi = createMockAi("No cap");
      await runAI(mockAi, "heavy", testMessages);

      expect(mockAi.run).toHaveBeenCalledWith(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        { messages: testMessages }
      );
    });

    it("uses env overrides for model selection", async () => {
      const mockAi = createMockAi("Custom model response");
      const env = { AI_MODEL_LIGHT: "@cf/custom/light" };
      await runAI(mockAi, "light", testMessages, { env });

      expect(mockAi.run).toHaveBeenCalledWith("@cf/custom/light", {
        messages: testMessages,
      });
    });

    it("returns empty string when response is undefined", async () => {
      const mockAi = {
        run: vi.fn().mockResolvedValue({ response: undefined }),
      } as unknown as Ai;

      const result = await runAI(mockAi, "heavy", testMessages);
      expect(result).toBe("");
    });

    it("trims whitespace from response", async () => {
      const mockAi = createMockAi("  padded response  ");
      const result = await runAI(mockAi, "heavy", testMessages);
      expect(result).toBe("padded response");
    });

    it("returns empty string when response is null", async () => {
      const mockAi = {
        run: vi.fn().mockResolvedValue({ response: null }),
      } as unknown as Ai;

      const result = await runAI(mockAi, "heavy", testMessages);
      expect(result).toBe("");
    });
  });

  describe("tier mapping correctness", () => {
    it("heavy tier uses the 70b model by default", () => {
      expect(getModel("heavy")).toContain("70b");
    });

    it("light tier uses the 8b model by default", () => {
      expect(getModel("light")).toContain("8b");
    });

    it("fast tier uses the 8b model by default", () => {
      expect(getModel("fast")).toContain("8b");
    });

    it("light and fast tiers use the same default model", () => {
      expect(getModel("light")).toBe(getModel("fast"));
    });

    it("heavy and light tiers use different default models", () => {
      expect(getModel("heavy")).not.toBe(getModel("light"));
    });
  });
});
