import { describe, it, expect } from "vitest";
import { createThinkingTool } from "./thinking-tool";

describe("createThinkingTool", () => {
  const tools = createThinkingTool();

  it("creates a thinking tool", () => {
    expect(tools.thinking).toBeDefined();
  });

  it("returns the thought and a completion message", async () => {
    const result = await tools.thinking.execute(
      { thought: "I should first read the URL, then save findings to memory." },
      { messages: [], toolCallId: "test", abortSignal: undefined as any }
    );

    expect(result.thought).toBe(
      "I should first read the URL, then save findings to memory."
    );
    expect(result.message).toBe(
      "Thinking complete. Proceed with your next action or provide a final answer."
    );
  });

  it("handles empty thought", async () => {
    const result = await tools.thinking.execute(
      { thought: "" },
      { messages: [], toolCallId: "test", abortSignal: undefined as any }
    );

    expect(result.thought).toBe("");
    expect(result.message).toBeDefined();
  });

  it("preserves complex reasoning in the thought field", async () => {
    const complexThought =
      "Step 1: Read the article about React performance.\n" +
      "Step 2: Extract the key optimization techniques.\n" +
      "Step 3: Save each technique as a separate memory.\n" +
      "Step 4: Provide a summary to the user.";

    const result = await tools.thinking.execute(
      { thought: complexThought },
      { messages: [], toolCallId: "test", abortSignal: undefined as any }
    );

    expect(result.thought).toBe(complexThought);
  });
});
