import { tool } from "ai";
import { z } from "zod";

/**
 * Create a thinking tool that lets the agent reason through
 * intermediate steps without side effects.
 *
 * This is useful in multi-step agentic loops where the model
 * needs to plan its next action or synthesize information from
 * previous tool results before deciding what to do next.
 */
export function createThinkingTool() {
  return {
    thinking: tool({
      description:
        "Think through a problem step by step. Use this to reason about intermediate results, plan next actions, or synthesize information before providing a final answer. This tool has no side effects.",
      inputSchema: z.object({
        thought: z
          .string()
          .describe(
            "Your reasoning, analysis, or plan for the next step"
          ),
      }),
      execute: async ({ thought }) => {
        return {
          thought,
          message:
            "Thinking complete. Proceed with your next action or provide a final answer.",
        };
      },
    }),
  };
}
