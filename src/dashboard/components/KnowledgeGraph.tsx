import React, { useEffect, useRef, useState, useCallback } from "react";
import type { SemanticEntry } from "@/shared/types";

interface GraphNode {
  id: string;
  content: string;
  type: SemanticEntry["type"];
  tags: string[];
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphEdge {
  source: string;
  target: string;
  sharedTag: string;
}

const TYPE_COLORS: Record<string, string> = {
  fact: "#60a5fa",
  preference: "#c084fc",
  event: "#fbbf24",
  note: "#34d399",
  summary: "#fb7185",
};

const NODE_RADIUS = 8;
const WIDTH = 900;
const HEIGHT = 600;

/**
 * Knowledge Graph — D3-inspired force-directed graph rendered with React SVG.
 * Nodes represent semantic memories, edges connect memories sharing tags.
 */
export function KnowledgeGraph() {
  const [memories, setMemories] = useState<SemanticEntry[]>([]);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const animationRef = useRef<number>(0);
  const nodesRef = useRef<GraphNode[]>([]);

  // Fetch memories from API
  useEffect(() => {
    fetchMemories();
  }, []);

  const fetchMemories = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/memories");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMemories(data.memories || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch memories");
    } finally {
      setLoading(false);
    }
  };

  // Build graph from memories
  useEffect(() => {
    if (memories.length === 0) return;

    // Filter memories
    let filtered = memories;
    if (typeFilter !== "all") {
      filtered = filtered.filter((m) => m.type === typeFilter);
    }
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.content.toLowerCase().includes(term) ||
          m.tags.some((t) => t.toLowerCase().includes(term))
      );
    }

    // Create nodes with random initial positions
    const graphNodes: GraphNode[] = filtered.map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      tags: m.tags,
      x: WIDTH / 2 + (Math.random() - 0.5) * 300,
      y: HEIGHT / 2 + (Math.random() - 0.5) * 200,
      vx: 0,
      vy: 0,
    }));

    // Create edges based on shared tags
    const graphEdges: GraphEdge[] = [];
    const nodeIds = new Set(graphNodes.map((n) => n.id));

    for (let i = 0; i < graphNodes.length; i++) {
      for (let j = i + 1; j < graphNodes.length; j++) {
        const shared = graphNodes[i].tags.filter((t) =>
          graphNodes[j].tags.includes(t)
        );
        if (shared.length > 0) {
          graphEdges.push({
            source: graphNodes[i].id,
            target: graphNodes[j].id,
            sharedTag: shared[0],
          });
        }
      }
    }

    nodesRef.current = graphNodes;
    setNodes(graphNodes);
    setEdges(graphEdges);

    // Start force simulation
    startSimulation(graphNodes, graphEdges);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [memories, searchTerm, typeFilter]);

  const startSimulation = useCallback(
    (simNodes: GraphNode[], simEdges: GraphEdge[]) => {
      let iteration = 0;
      const maxIterations = 200;
      const alpha = 0.3;
      const repulsion = 500;
      const springLength = 80;
      const springStrength = 0.05;
      const centerForce = 0.01;
      const damping = 0.9;

      const nodeMap = new Map(simNodes.map((n) => [n.id, n]));

      const tick = () => {
        if (iteration >= maxIterations) return;

        // Apply forces
        for (const node of simNodes) {
          // Center gravity
          node.vx += (WIDTH / 2 - node.x) * centerForce;
          node.vy += (HEIGHT / 2 - node.y) * centerForce;

          // Repulsion between all nodes
          for (const other of simNodes) {
            if (node.id === other.id) continue;
            const dx = node.x - other.x;
            const dy = node.y - other.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = repulsion / (dist * dist);
            node.vx += (dx / dist) * force * alpha;
            node.vy += (dy / dist) * force * alpha;
          }
        }

        // Spring forces along edges
        for (const edge of simEdges) {
          const source = nodeMap.get(edge.source);
          const target = nodeMap.get(edge.target);
          if (!source || !target) continue;

          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = (dist - springLength) * springStrength;

          source.vx += (dx / dist) * force;
          source.vy += (dy / dist) * force;
          target.vx -= (dx / dist) * force;
          target.vy -= (dy / dist) * force;
        }

        // Apply velocity and damping
        for (const node of simNodes) {
          node.vx *= damping;
          node.vy *= damping;
          node.x += node.vx;
          node.y += node.vy;

          // Constrain to bounds
          node.x = Math.max(NODE_RADIUS, Math.min(WIDTH - NODE_RADIUS, node.x));
          node.y = Math.max(
            NODE_RADIUS,
            Math.min(HEIGHT - NODE_RADIUS, node.y)
          );
        }

        setNodes([...simNodes]);
        iteration++;

        if (iteration < maxIterations) {
          animationRef.current = requestAnimationFrame(tick);
        }
      };

      animationRef.current = requestAnimationFrame(tick);
    },
    []
  );

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  if (loading) {
    return <div className="loading-text">Loading knowledge graph...</div>;
  }

  if (error) {
    return (
      <div className="error-text">
        Error loading graph: {error}
        <br />
        <button className="btn" onClick={fetchMemories} style={{ marginTop: "1rem" }}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="search-input"
            placeholder="Search memories..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <div style={{ display: "flex", gap: "0.25rem" }}>
            {["all", "fact", "preference", "event", "note", "summary"].map(
              (type) => (
                <button
                  key={type}
                  className={`btn ${typeFilter === type ? "btn-primary" : ""}`}
                  onClick={() => setTypeFilter(type)}
                >
                  {type}
                </button>
              )
            )}
          </div>
          <span className="text-dim text-sm">
            {nodes.length} nodes, {edges.length} connections
          </span>
        </div>
      </div>

      <div className="panel" style={{ display: "flex", gap: "1rem" }}>
        <div style={{ flex: 1, overflow: "hidden" }}>
          {nodes.length === 0 ? (
            <div className="empty-state-text">
              No memories to display. Start chatting with Cortex to build your knowledge graph.
            </div>
          ) : (
            <svg
              width={WIDTH}
              height={HEIGHT}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              style={{
                width: "100%",
                height: "auto",
                maxHeight: "600px",
                background: "#0a0a0f",
                borderRadius: "0.375rem",
              }}
            >
              {/* Edges */}
              {edges.map((edge) => {
                const source = nodeMap.get(edge.source);
                const target = nodeMap.get(edge.target);
                if (!source || !target) return null;
                return (
                  <line
                    key={`${edge.source}-${edge.target}`}
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    stroke="#1e1e2e"
                    strokeWidth={1}
                    strokeOpacity={0.6}
                  />
                );
              })}

              {/* Nodes */}
              {nodes.map((node) => (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelectedNode(node)}
                >
                  <circle
                    r={NODE_RADIUS}
                    fill={TYPE_COLORS[node.type] || "#6366f1"}
                    stroke={
                      selectedNode?.id === node.id ? "#fff" : "transparent"
                    }
                    strokeWidth={2}
                    opacity={0.85}
                  />
                  <title>{node.content.slice(0, 100)}</title>
                </g>
              ))}
            </svg>
          )}
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div
            style={{
              width: "280px",
              flexShrink: 0,
              borderLeft: "1px solid #1e1e2e",
              paddingLeft: "1rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
              <span className={`chip chip-${selectedNode.type}`}>
                {selectedNode.type}
              </span>
              <button
                className="btn"
                onClick={() => setSelectedNode(null)}
                style={{ padding: "0.2rem 0.5rem", fontSize: "0.7rem" }}
              >
                Close
              </button>
            </div>
            <p style={{ fontSize: "0.875rem", lineHeight: 1.5, marginBottom: "0.75rem" }}>
              {selectedNode.content}
            </p>
            {selectedNode.tags.length > 0 && (
              <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                {selectedNode.tags.map((tag) => (
                  <span
                    key={tag}
                    className="chip"
                    style={{ background: "#1e1e2e", color: "#8888a0" }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: "1rem",
          marginTop: "0.75rem",
          justifyContent: "center",
        }}
      >
        {Object.entries(TYPE_COLORS).map(([type, color]) => (
          <div
            key={type}
            style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: color,
              }}
            />
            <span className="text-dim text-sm">{type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
