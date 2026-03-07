import { describe, it, expect } from "vitest";
import { buildKnowledgeGraphData } from "./graph-builder";
import type { SemanticEntry } from "@/shared/types";

// ── Test helpers ────────────────────────────────────────────────

function makeMemory(overrides: Partial<SemanticEntry> = {}): SemanticEntry {
  return {
    id: crypto.randomUUID(),
    content: "Test memory content",
    type: "fact",
    source: "user",
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("buildKnowledgeGraphData", () => {
  it("returns empty graph for no memories", () => {
    const result = buildKnowledgeGraphData([]);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("creates nodes from memories", () => {
    const memories = [
      makeMemory({ id: "m1", content: "First memory", type: "fact" }),
      makeMemory({ id: "m2", content: "Second memory", type: "preference" }),
    ];

    const result = buildKnowledgeGraphData(memories);

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].id).toBe("m1");
    expect(result.nodes[0].type).toBe("fact");
    expect(result.nodes[1].id).toBe("m2");
    expect(result.nodes[1].type).toBe("preference");
  });

  it("truncates long labels to 60 characters", () => {
    const longContent = "A".repeat(100);
    const memories = [makeMemory({ content: longContent })];

    const result = buildKnowledgeGraphData(memories);

    expect(result.nodes[0].label).toBe("A".repeat(57) + "...");
    expect(result.nodes[0].label.length).toBe(60);
  });

  it("keeps short labels unchanged", () => {
    const memories = [makeMemory({ content: "Short content" })];
    const result = buildKnowledgeGraphData(memories);
    expect(result.nodes[0].label).toBe("Short content");
  });

  describe("tag edges", () => {
    it("creates edges for memories sharing tags", () => {
      const memories = [
        makeMemory({ id: "m1", tags: ["typescript", "coding"] }),
        makeMemory({ id: "m2", tags: ["typescript", "web"] }),
      ];

      const result = buildKnowledgeGraphData(memories);

      const tagEdges = result.edges.filter((e) => e.relationship === "tag");
      expect(tagEdges).toHaveLength(1);
      expect(tagEdges[0].weight).toBe(1); // 1 shared tag
    });

    it("weights edges by number of shared tags", () => {
      const memories = [
        makeMemory({ id: "m1", tags: ["typescript", "coding", "web"] }),
        makeMemory({ id: "m2", tags: ["typescript", "coding", "testing"] }),
      ];

      const result = buildKnowledgeGraphData(memories);

      const tagEdges = result.edges.filter((e) => e.relationship === "tag");
      expect(tagEdges).toHaveLength(1);
      expect(tagEdges[0].weight).toBe(2); // 2 shared tags
    });

    it("does not create edges for memories with no shared tags", () => {
      const memories = [
        makeMemory({ id: "m1", tags: ["typescript"] }),
        makeMemory({ id: "m2", tags: ["python"] }),
      ];

      const result = buildKnowledgeGraphData(memories);

      const tagEdges = result.edges.filter((e) => e.relationship === "tag");
      expect(tagEdges).toHaveLength(0);
    });

    it("does not duplicate edges for multiple shared tags", () => {
      const memories = [
        makeMemory({ id: "m1", tags: ["a", "b", "c"] }),
        makeMemory({ id: "m2", tags: ["a", "b", "c"] }),
      ];

      const result = buildKnowledgeGraphData(memories);

      const tagEdges = result.edges.filter((e) => e.relationship === "tag");
      // Should be exactly 1 edge between m1 and m2
      expect(tagEdges).toHaveLength(1);
      expect(tagEdges[0].weight).toBe(3);
    });
  });

  describe("source edges", () => {
    it("creates edges for memories with same source", () => {
      const memories = [
        makeMemory({ id: "m1", source: "research" }),
        makeMemory({ id: "m2", source: "research" }),
      ];

      const result = buildKnowledgeGraphData(memories);

      const sourceEdges = result.edges.filter(
        (e) => e.relationship === "source"
      );
      expect(sourceEdges).toHaveLength(1);
      expect(sourceEdges[0].weight).toBe(1);
    });

    it("does not create source edges for different sources", () => {
      const memories = [
        makeMemory({ id: "m1", source: "user" }),
        makeMemory({ id: "m2", source: "research" }),
      ];

      const result = buildKnowledgeGraphData(memories);

      const sourceEdges = result.edges.filter(
        (e) => e.relationship === "source"
      );
      expect(sourceEdges).toHaveLength(0);
    });

    it("skips source groups larger than 50 to prevent edge explosion", () => {
      const memories = Array.from({ length: 51 }, (_, i) =>
        makeMemory({ id: `m${i}`, source: "user" })
      );

      const result = buildKnowledgeGraphData(memories);

      const sourceEdges = result.edges.filter(
        (e) => e.relationship === "source"
      );
      expect(sourceEdges).toHaveLength(0);
    });
  });

  describe("temporal edges", () => {
    it("creates edges for memories within 1 hour of each other", () => {
      const now = new Date();
      const memories = [
        makeMemory({
          id: "m1",
          createdAt: new Date(now.getTime()).toISOString(),
        }),
        makeMemory({
          id: "m2",
          createdAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(), // 30 min later
        }),
      ];

      const result = buildKnowledgeGraphData(memories);

      const temporalEdges = result.edges.filter(
        (e) => e.relationship === "temporal"
      );
      expect(temporalEdges).toHaveLength(1);
    });

    it("does not create edges for memories more than 1 hour apart", () => {
      const now = new Date();
      const memories = [
        makeMemory({
          id: "m1",
          createdAt: new Date(now.getTime()).toISOString(),
        }),
        makeMemory({
          id: "m2",
          createdAt: new Date(
            now.getTime() + 2 * 60 * 60 * 1000
          ).toISOString(), // 2 hours later
        }),
      ];

      const result = buildKnowledgeGraphData(memories);

      const temporalEdges = result.edges.filter(
        (e) => e.relationship === "temporal"
      );
      expect(temporalEdges).toHaveLength(0);
    });

    it("uses sliding window for temporal proximity", () => {
      const now = new Date();
      const memories = [
        makeMemory({
          id: "m1",
          createdAt: new Date(now.getTime()).toISOString(),
        }),
        makeMemory({
          id: "m2",
          createdAt: new Date(now.getTime() + 40 * 60 * 1000).toISOString(), // 40 min
        }),
        makeMemory({
          id: "m3",
          createdAt: new Date(now.getTime() + 80 * 60 * 1000).toISOString(), // 80 min from m1
        }),
      ];

      const result = buildKnowledgeGraphData(memories);

      const temporalEdges = result.edges.filter(
        (e) => e.relationship === "temporal"
      );
      // m1-m2 (40 min apart), m2-m3 (40 min apart), but NOT m1-m3 (80 min apart)
      expect(temporalEdges).toHaveLength(2);
    });
  });

  describe("edge deduplication", () => {
    it("does not create duplicate edges across relationship types", () => {
      const now = new Date();
      const memories = [
        makeMemory({
          id: "m1",
          source: "research",
          tags: ["shared"],
          createdAt: now.toISOString(),
        }),
        makeMemory({
          id: "m2",
          source: "research",
          tags: ["shared"],
          createdAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        }),
      ];

      const result = buildKnowledgeGraphData(memories);

      // Should have 3 separate edges: tag, source, temporal
      expect(result.edges).toHaveLength(3);
      const rels = result.edges.map((e) => e.relationship).sort();
      expect(rels).toEqual(["source", "tag", "temporal"]);
    });
  });

  it("sets relevanceScore to 1 for all nodes", () => {
    const memories = [
      makeMemory({ id: "m1" }),
      makeMemory({ id: "m2" }),
    ];

    const result = buildKnowledgeGraphData(memories);

    for (const node of result.nodes) {
      expect(node.relevanceScore).toBe(1);
    }
  });

  it("preserves source and createdAt on nodes", () => {
    const createdAt = "2026-01-15T10:30:00Z";
    const memories = [
      makeMemory({ id: "m1", source: "research", createdAt }),
    ];

    const result = buildKnowledgeGraphData(memories);

    expect(result.nodes[0].source).toBe("research");
    expect(result.nodes[0].createdAt).toBe(createdAt);
  });
});
