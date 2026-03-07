/**
 * Re-export the graph builder from its canonical location.
 * The frontend fetches pre-built graph data from /api/knowledge-graph,
 * so this module is primarily available for client-side reuse if needed.
 */
export { buildKnowledgeGraphData } from "@/agent/graph-builder";
export type { KGNode, KGEdge, KGData } from "@/agent/graph-builder";
