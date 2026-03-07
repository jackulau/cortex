import type { SemanticEntry } from "@/shared/types";

// ── Graph data types ────────────────────────────────────────────

export interface KGNode {
  id: string;
  label: string;
  type: string;
  tags: string[];
  relevanceScore: number;
  createdAt: string;
  source: string;
}

export interface KGEdge {
  source: string;
  target: string;
  relationship: "tag" | "source" | "temporal";
  weight: number;
}

export interface KGData {
  nodes: KGNode[];
  edges: KGEdge[];
}

// ── Constants ───────────────────────────────────────────────────

const TEMPORAL_THRESHOLD_MS = 60 * 60 * 1000;

// ── Builder ─────────────────────────────────────────────────────

/**
 * Build graph nodes and edges from a list of semantic memories.
 * Edges are created based on:
 *  - Shared tags (weight = number of shared tags)
 *  - Same source (weight = 1)
 *  - Temporal proximity within 1 hour (weight = 1)
 */
export function buildKnowledgeGraphData(
  memories: SemanticEntry[]
): KGData {
  const nodes: KGNode[] = memories.map((m) => ({
    id: m.id,
    label: m.content.length > 60 ? m.content.slice(0, 57) + "..." : m.content,
    type: m.type,
    tags: m.tags,
    relevanceScore: 1,
    createdAt: m.createdAt,
    source: m.source,
  }));

  const edges: KGEdge[] = [];
  const edgeSet = new Set<string>();

  const addEdge = (
    src: string,
    tgt: string,
    rel: KGEdge["relationship"],
    weight: number
  ) => {
    const key = [src, tgt].sort().join(":") + ":" + rel;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ source: src, target: tgt, relationship: rel, weight });
  };

  // Tag edges
  const tagIndex = new Map<string, string[]>();
  for (const m of memories) {
    for (const tag of m.tags) {
      const list = tagIndex.get(tag);
      if (list) list.push(m.id);
      else tagIndex.set(tag, [m.id]);
    }
  }

  for (const [, ids] of tagIndex) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = memories.find((m) => m.id === ids[i]);
        const b = memories.find((m) => m.id === ids[j]);
        if (!a || !b) continue;
        const shared = a.tags.filter((t) => b.tags.includes(t)).length;
        addEdge(ids[i], ids[j], "tag", shared);
      }
    }
  }

  // Source edges (skip large groups to avoid edge explosion)
  const sourceIndex = new Map<string, string[]>();
  for (const m of memories) {
    const list = sourceIndex.get(m.source);
    if (list) list.push(m.id);
    else sourceIndex.set(m.source, [m.id]);
  }

  for (const [, ids] of sourceIndex) {
    if (ids.length > 50) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        addEdge(ids[i], ids[j], "source", 1);
      }
    }
  }

  // Temporal edges (within 1 hour)
  const timestamps = new Map(
    memories.map((m) => [m.id, new Date(m.createdAt).getTime()])
  );
  const sorted = [...memories].sort(
    (a, b) => timestamps.get(a.id)! - timestamps.get(b.id)!
  );

  for (let i = 0; i < sorted.length; i++) {
    const tA = timestamps.get(sorted[i].id)!;
    for (let j = i + 1; j < sorted.length; j++) {
      const tB = timestamps.get(sorted[j].id)!;
      if (tB - tA > TEMPORAL_THRESHOLD_MS) break;
      addEdge(sorted[i].id, sorted[j].id, "temporal", 1);
    }
  }

  return { nodes, edges };
}
