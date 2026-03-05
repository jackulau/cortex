import { AIChatAgent } from "@cloudflare/ai-chat";
import { createWorkersAI } from "workers-ai-provider";
import { streamText, stepCountIs, type UIMessage } from "ai";
import type { Env } from "@/shared/types";
import { initDoSchemas } from "@/memory/schemas";
import { WorkingMemory } from "@/memory/working";
import { EpisodicMemory } from "@/memory/episodic";
import { SemanticMemory } from "@/memory/semantic";
import { ProceduralMemory } from "@/memory/procedural";
import { consolidateTurn } from "@/memory/consolidation";
import { buildSystemPrompt } from "@/agent/prompts/system";
import { retrieveMemoryContext } from "@/agent/prompts/memory-context";
import { createMemoryTools } from "@/agent/tools/memory-tools";

export class CortexAgent extends AIChatAgent<Env> {
  private workingMemory!: WorkingMemory;
  private episodicMemory!: EpisodicMemory;
  private semanticMemory!: SemanticMemory;
  private proceduralMemory!: ProceduralMemory;
  private initialized = false;

  private ensureInit() {
    if (this.initialized) return;

    // Init DO SQLite tables
    initDoSchemas(this.sql.bind(this));

    // Instantiate memory layers
    const sessionId = this.name || crypto.randomUUID();
    this.workingMemory = new WorkingMemory(sessionId);
    this.episodicMemory = new EpisodicMemory(this.sql.bind(this));
    this.semanticMemory = new SemanticMemory(
      this.env.DB,
      this.env.AI,
      this.env.EMBEDDING_MODEL
    );
    this.proceduralMemory = new ProceduralMemory(this.sql.bind(this));

    this.initialized = true;
  }

  async onChatMessage(
    onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0]
  ): Promise<Response> {
    this.ensureInit();

    // Get the latest user message text from parts
    const lastUserMsg = [...this.messages]
      .reverse()
      .find((m) => m.role === "user");
    const userText = lastUserMsg?.parts
      ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ") ?? "";

    // Pre-response: retrieve relevant memories
    const memoryContext = await retrieveMemoryContext(
      this.semanticMemory,
      this.episodicMemory,
      userText
    );

    // Build system prompt with injected memories + rules
    const systemPrompt = buildSystemPrompt(
      this.workingMemory,
      this.proceduralMemory,
      memoryContext
    );

    // Create tools
    const tools = createMemoryTools({
      semanticMemory: this.semanticMemory,
      episodicMemory: this.episodicMemory,
      proceduralMemory: this.proceduralMemory,
      workingMemory: this.workingMemory,
    });

    // Stream response
    const ai = createWorkersAI({ binding: this.env.AI });
    const turnIndex = this.episodicMemory.getTurnCount(
      this.workingMemory.getState().sessionId
    );

    const result = streamText({
      model: ai(this.env.CHAT_MODEL) as any,
      system: systemPrompt,
      messages: this.messages as any,
      tools,
      stopWhen: stepCountIs(5),
      onFinish: async (streamResult) => {
        const sessionId = this.workingMemory.getState().sessionId;

        // Log episodic turns
        this.episodicMemory.logTurn(
          sessionId,
          "user",
          userText,
          turnIndex
        );
        this.episodicMemory.logTurn(
          sessionId,
          "assistant",
          streamResult.text,
          turnIndex + 1
        );

        // Update session metadata
        this.episodicMemory.upsertSession(sessionId, {
          turnCount: turnIndex + 2,
        });

        // Post-turn consolidation (fire and forget)
        consolidateTurn(
          this.env.AI,
          this.env.CHAT_MODEL,
          this.semanticMemory,
          userText,
          streamResult.text
        ).catch(() => {});

        // Call the provided onFinish callback
        onFinish(streamResult as any);
      },
    });

    return result.toUIMessageStreamResponse();
  }
}
