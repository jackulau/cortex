import type { WorkingMemoryState } from "@/shared/types";

/**
 * Working memory — ephemeral per-session state stored in the DO instance.
 * Tracks current topics, recent facts, and user context for the active conversation.
 */
export class WorkingMemory {
  private state: WorkingMemoryState;

  constructor(sessionId: string) {
    this.state = {
      sessionId,
      startedAt: new Date().toISOString(),
      topics: [],
      recentFacts: [],
      pendingActions: [],
    };
  }

  getState(): WorkingMemoryState {
    return { ...this.state };
  }

  setUserName(name: string) {
    this.state.userName = name;
  }

  setUserContext(key: string, value: string) {
    this.state.userContext = { ...this.state.userContext, [key]: value };
  }

  addTopic(topic: string) {
    if (!this.state.topics.includes(topic)) {
      this.state.topics.push(topic);
    }
  }

  addFact(fact: string) {
    this.state.recentFacts.push(fact);
    // Keep last 20 facts in working memory
    if (this.state.recentFacts.length > 20) {
      this.state.recentFacts = this.state.recentFacts.slice(-20);
    }
  }

  addPendingAction(action: string) {
    this.state.pendingActions.push(action);
  }

  removePendingAction(action: string) {
    this.state.pendingActions = this.state.pendingActions.filter(
      (a) => a !== action
    );
  }

  /** Serialize for inclusion in system prompt context. */
  toContextString(): string {
    const parts: string[] = [];

    if (this.state.userName) {
      parts.push(`User: ${this.state.userName}`);
    }

    if (this.state.userContext) {
      const ctx = Object.entries(this.state.userContext)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      if (ctx) parts.push(`Context: ${ctx}`);
    }

    if (this.state.topics.length > 0) {
      parts.push(`Current topics: ${this.state.topics.join(", ")}`);
    }

    if (this.state.recentFacts.length > 0) {
      parts.push(
        `Recent facts from this session:\n${this.state.recentFacts.map((f) => `- ${f}`).join("\n")}`
      );
    }

    return parts.join("\n\n");
  }
}
