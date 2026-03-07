import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createExportTools,
  groupByType,
  formatObsidian,
  formatPlain,
} from "./export-tools";
import type { SemanticEntry } from "@/shared/types";

// ── Mock Data ──────────────────────────────────────────────────

const mockMemories: SemanticEntry[] = [
  {
    id: "mem-1",
    content: "User prefers TypeScript over JavaScript",
    type: "preference",
    source: "user",
    tags: ["programming", "typescript"],
    createdAt: "2024-01-15T10:30:00Z",
    updatedAt: "2024-01-15T10:30:00Z",
    relevanceScore: 1.0,
    lastAccessedAt: null,
    accessCount: 0,
  },
  {
    id: "mem-2",
    content: "The sky is blue",
    type: "fact",
    source: "consolidated",
    tags: ["science"],
    createdAt: "2024-01-16T11:00:00Z",
    updatedAt: "2024-01-16T11:00:00Z",
    relevanceScore: 1.0,
    lastAccessedAt: null,
    accessCount: 0,
  },
  {
    id: "mem-3",
    content: "Had a meeting with the team about project Cortex",
    type: "event",
    source: "user",
    tags: ["work", "cortex"],
    createdAt: "2024-01-17T09:00:00Z",
    updatedAt: "2024-01-17T09:00:00Z",
    relevanceScore: 1.0,
    lastAccessedAt: null,
    accessCount: 0,
  },
];

const mockRules = [
  {
    id: 1,
    rule: "Always respond in English",
    source: "user" as const,
    active: true,
    createdAt: "2024-01-10T00:00:00Z",
  },
  {
    id: 2,
    rule: "Never use emojis",
    source: "user" as const,
    active: false,
    createdAt: "2024-01-11T00:00:00Z",
  },
];

const mockSessions = [
  {
    sessionId: "session-1",
    startedAt: "2024-01-15T10:00:00Z",
    endedAt: "2024-01-15T11:00:00Z",
    topics: ["typescript", "cortex"],
    turnCount: 10,
    summary: "Discussed TypeScript preferences",
  },
];

// ── Mock Dependencies ──────────────────────────────────────────

function createMockDeps() {
  const putCalls: { key: string; body: string; options: any }[] = [];

  return {
    deps: {
      semanticMemory: {
        list: vi.fn().mockResolvedValue({ data: mockMemories, cursor: null, hasMore: false }),
        write: vi.fn(),
        search: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
      } as any,
      episodicMemory: {
        listSessions: vi.fn().mockReturnValue(mockSessions),
        search: vi.fn(),
        logTurn: vi.fn(),
        getSession: vi.fn(),
        upsertSession: vi.fn(),
        getTurnCount: vi.fn(),
        getRecentTurns: vi.fn(),
      } as any,
      proceduralMemory: {
        getAll: vi.fn().mockReturnValue(mockRules),
        getActive: vi.fn(),
        add: vi.fn(),
        deactivate: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        toPromptString: vi.fn(),
      } as any,
      storage: {
        put: vi.fn().mockImplementation(async (key: string, body: string, options: any) => {
          putCalls.push({ key, body: typeof body === "string" ? body : "binary", options });
        }),
        get: vi.fn(),
      } as any,
    },
    putCalls,
  };
}

// ── Helper Tests ───────────────────────────────────────────────

describe("groupByType", () => {
  it("groups memories by their type field", () => {
    const grouped = groupByType(mockMemories);
    expect(Object.keys(grouped)).toHaveLength(3);
    expect(grouped["preference"]).toHaveLength(1);
    expect(grouped["fact"]).toHaveLength(1);
    expect(grouped["event"]).toHaveLength(1);
  });

  it("returns empty object for empty array", () => {
    const grouped = groupByType([]);
    expect(Object.keys(grouped)).toHaveLength(0);
  });

  it("groups multiple entries of same type together", () => {
    const entries: SemanticEntry[] = [
      { ...mockMemories[0], id: "a" },
      { ...mockMemories[0], id: "b" },
    ];
    const grouped = groupByType(entries);
    expect(grouped["preference"]).toHaveLength(2);
  });
});

describe("formatObsidian", () => {
  it("produces markdown with YAML frontmatter", () => {
    const result = formatObsidian("Fact", [mockMemories[1]]);
    expect(result).toContain("# Facts");
    expect(result).toContain("---");
    expect(result).toContain('id: "mem-2"');
    expect(result).toContain("type: fact");
    expect(result).toContain("source: consolidated");
    expect(result).toContain('tags: ["science"]');
    expect(result).toContain("created: 2024-01-16T11:00:00Z");
    expect(result).toContain("The sky is blue");
  });

  it("handles entries with multiple tags", () => {
    const result = formatObsidian("Preference", [mockMemories[0]]);
    expect(result).toContain('tags: ["programming", "typescript"]');
  });

  it("handles entries with empty tags", () => {
    const entry: SemanticEntry = { ...mockMemories[0], tags: [] };
    const result = formatObsidian("Test", [entry]);
    expect(result).toContain("tags: []");
  });
});

describe("formatPlain", () => {
  it("produces plain markdown without frontmatter", () => {
    const result = formatPlain("Fact", [mockMemories[1]]);
    expect(result).toContain("# Facts");
    expect(result).toContain("## The sky is blue");
    expect(result).toContain("*Tags: science*");
    expect(result).toContain("*Created: 2024-01-16T11:00:00Z*");
    expect(result).not.toContain("---");
  });

  it("omits tags line when no tags", () => {
    const entry: SemanticEntry = { ...mockMemories[0], tags: [] };
    const result = formatPlain("Test", [entry]);
    expect(result).not.toContain("*Tags:");
  });
});

// ── Export Tool Integration Tests ──────────────────────────────

describe("createExportTools", () => {
  let tools: ReturnType<typeof createExportTools>;
  let putCalls: { key: string; body: string; options: any }[];

  beforeEach(() => {
    const mock = createMockDeps();
    tools = createExportTools(mock.deps);
    putCalls = mock.putCalls;
  });

  describe("exportMarkdown", () => {
    it("is defined with correct description", () => {
      expect(tools.exportMarkdown).toBeDefined();
    });

    it("exports obsidian format with YAML frontmatter", async () => {
      const result = await tools.exportMarkdown.execute(
        { format: "obsidian" },
        { messages: [], toolCallId: "test", abortSignal: undefined as any }
      );

      expect(result.count).toBe(3);
      expect(result.key).toMatch(/^exports\/markdown-obsidian-.+\.md$/);
      expect(result.url).toMatch(/^\/api\/export\/exports\/markdown-obsidian/);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].options.httpMetadata.contentType).toBe("text/markdown");

      // Verify content includes frontmatter
      const content = putCalls[0].body;
      expect(content).toContain("---");
      expect(content).toContain("type: preference");
      expect(content).toContain("type: fact");
    });

    it("exports plain format without frontmatter", async () => {
      const result = await tools.exportMarkdown.execute(
        { format: "plain" },
        { messages: [], toolCallId: "test", abortSignal: undefined as any }
      );

      expect(result.count).toBe(3);
      expect(result.key).toMatch(/^exports\/markdown-plain-.+\.md$/);

      const content = putCalls[0].body;
      expect(content).toContain("## User prefers TypeScript");
      expect(content).toContain("*Created:");
    });

    it("handles empty memory list", async () => {
      const mock = createMockDeps();
      (mock.deps.semanticMemory.list as any).mockResolvedValue({ data: [], cursor: null, hasMore: false });
      const emptyTools = createExportTools(mock.deps);

      const result = await emptyTools.exportMarkdown.execute(
        { format: "obsidian" },
        { messages: [], toolCallId: "test", abortSignal: undefined as any }
      );

      expect(result.count).toBe(0);
      expect(result.message).toBe("No memories to export.");
    });
  });

  describe("exportJson", () => {
    it("is defined with correct description", () => {
      expect(tools.exportJson).toBeDefined();
    });

    it("exports complete knowledge base as JSON", async () => {
      const result = await tools.exportJson.execute(
        {},
        { messages: [], toolCallId: "test", abortSignal: undefined as any }
      );

      expect(result.stats.memories).toBe(3);
      expect(result.stats.rules).toBe(2);
      expect(result.stats.sessions).toBe(1);
      expect(result.key).toMatch(/^exports\/knowledge-base-.+\.json$/);
      expect(result.url).toMatch(/^\/api\/export\/exports\/knowledge-base/);

      // Verify upload
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].options.httpMetadata.contentType).toBe(
        "application/json"
      );

      // Verify JSON content
      const parsed = JSON.parse(putCalls[0].body);
      expect(parsed.version).toBe("1.0");
      expect(parsed.exportedAt).toBeDefined();
      expect(parsed.data.memories).toHaveLength(3);
      expect(parsed.data.rules).toHaveLength(2);
      expect(parsed.data.sessions).toHaveLength(1);
    });

    it("includes correct memory data in export", async () => {
      await tools.exportJson.execute(
        {},
        { messages: [], toolCallId: "test", abortSignal: undefined as any }
      );

      const parsed = JSON.parse(putCalls[0].body);
      const firstMemory = parsed.data.memories[0];
      expect(firstMemory.id).toBe("mem-1");
      expect(firstMemory.content).toBe(
        "User prefers TypeScript over JavaScript"
      );
      expect(firstMemory.type).toBe("preference");
      expect(firstMemory.tags).toEqual(["programming", "typescript"]);
    });

    it("includes rules with correct fields", async () => {
      await tools.exportJson.execute(
        {},
        { messages: [], toolCallId: "test", abortSignal: undefined as any }
      );

      const parsed = JSON.parse(putCalls[0].body);
      const firstRule = parsed.data.rules[0];
      expect(firstRule.id).toBe(1);
      expect(firstRule.rule).toBe("Always respond in English");
      expect(firstRule.active).toBe(true);
    });
  });
});
