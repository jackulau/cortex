import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as d3 from "d3";

// ── Types ───────────────────────────────────────────────────────

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  tags: string[];
  relevanceScore: number;
  createdAt: string;
  source: string;
}

interface GraphEdge extends d3.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
  relationship: "tag" | "source" | "temporal";
  weight: number;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Constants ───────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  fact: "#60a5fa",
  preference: "#c084fc",
  event: "#fbbf24",
  note: "#34d399",
  summary: "#fb7185",
};

const EDGE_STYLES: Record<string, string> = {
  tag: "6,4",       // dashed
  source: "none",   // solid
  temporal: "2,3",  // dotted
};

const EDGE_COLORS: Record<string, string> = {
  tag: "#4a4a6a",
  source: "#3a3a5a",
  temporal: "#2a2a4a",
};

const BASE_NODE_RADIUS = 6;
const MAX_NODE_RADIUS = 18;

/**
 * Knowledge Graph — Force-directed graph visualization using D3.
 * Fetches from /api/knowledge-graph and renders memories as nodes
 * connected by tag, source, and temporal relationships.
 */
export function KnowledgeGraph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<d3.Simulation<GraphNode, GraphEdge> | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [timeRange, setTimeRange] = useState<number>(0); // 0 = all time

  // Selection
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeData, setSelectedNodeData] = useState<GraphNode | null>(null);

  // ── Fetch graph data ────────────────────────────────────────

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/knowledge-graph?limit=200");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: GraphData = await res.json();
      setGraphData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch graph data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  // ── Derive available tags from data ─────────────────────────

  const availableTags = useMemo(() => {
    if (!graphData) return [];
    const tagSet = new Set<string>();
    for (const node of graphData.nodes) {
      for (const tag of node.tags) {
        tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  }, [graphData]);

  // ── Apply filters ───────────────────────────────────────────

  const filteredData = useMemo((): GraphData | null => {
    if (!graphData) return null;

    let nodes = graphData.nodes;

    // Type filter
    if (typeFilter !== "all") {
      nodes = nodes.filter((n) => n.type === typeFilter);
    }

    // Tag filter
    if (tagFilter !== "all") {
      nodes = nodes.filter((n) => n.tags.includes(tagFilter));
    }

    // Time range filter (days ago)
    if (timeRange > 0) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - timeRange);
      const cutoffStr = cutoff.toISOString();
      nodes = nodes.filter((n) => n.createdAt >= cutoffStr);
    }

    // Search filter
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      nodes = nodes.filter(
        (n) =>
          n.label.toLowerCase().includes(term) ||
          n.tags.some((t) => t.toLowerCase().includes(term))
      );
    }

    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges = graphData.edges.filter((e) => {
      const srcId = typeof e.source === "string" ? e.source : e.source.id;
      const tgtId = typeof e.target === "string" ? e.target : e.target.id;
      return nodeIds.has(srcId) && nodeIds.has(tgtId);
    });

    // Deep copy nodes so D3 can mutate x/y without affecting state
    const nodesCopy = nodes.map((n) => ({ ...n }));

    return { nodes: nodesCopy, edges: edges.map((e) => ({ ...e })) };
  }, [graphData, typeFilter, tagFilter, timeRange, searchTerm]);

  // ── D3 rendering ────────────────────────────────────────────

  useEffect(() => {
    if (!filteredData || !svgRef.current || !containerRef.current) return;

    const svg = d3.select(svgRef.current);
    const container = containerRef.current;
    const width = container.clientWidth;
    const height = Math.max(500, container.clientHeight);

    // Clear previous content
    svg.selectAll("*").remove();
    if (simulationRef.current) {
      simulationRef.current.stop();
    }

    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const { nodes, edges } = filteredData;

    if (nodes.length === 0) return;

    // Create a group for zoom/pan
    const g = svg.append("g").attr("class", "graph-container");

    // Zoom behavior
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });

    svg.call(zoom);

    // Double-click to reset zoom
    svg.on("dblclick.zoom", () => {
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    });

    // Defs for arrow markers
    const defs = svg.append("defs");

    // Edge line style definitions
    defs
      .append("filter")
      .attr("id", "glow")
      .append("feGaussianBlur")
      .attr("stdDeviation", 3)
      .attr("result", "coloredBlur");

    // Compute node radius from relevance
    const maxRelevance = d3.max(nodes, (n) => n.relevanceScore) || 1;
    const radiusScale = d3
      .scaleLinear()
      .domain([0, maxRelevance])
      .range([BASE_NODE_RADIUS, MAX_NODE_RADIUS]);

    // ── Links ──────────────────────────────────────────────

    const linkGroup = g.append("g").attr("class", "links");

    const link = linkGroup
      .selectAll("line")
      .data(edges)
      .enter()
      .append("line")
      .attr("stroke", (d) => EDGE_COLORS[d.relationship] || "#2a2a4a")
      .attr("stroke-width", (d) => Math.max(1, d.weight * 0.5))
      .attr("stroke-opacity", 0.5)
      .attr("stroke-dasharray", (d) => EDGE_STYLES[d.relationship] || "none");

    // ── Nodes ──────────────────────────────────────────────

    const nodeGroup = g.append("g").attr("class", "nodes");

    const node = nodeGroup
      .selectAll("g")
      .data(nodes)
      .enter()
      .append("g")
      .attr("class", "node")
      .style("cursor", "pointer")
      .call(
        d3
          .drag<SVGGElement, GraphNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    // Node circles
    node
      .append("circle")
      .attr("r", (d) => radiusScale(d.relevanceScore))
      .attr("fill", (d) => TYPE_COLORS[d.type] || "#6366f1")
      .attr("stroke", "transparent")
      .attr("stroke-width", 2)
      .attr("opacity", 0.85);

    // Hover tooltip
    node
      .on("mouseover", function (event, d) {
        const tooltip = tooltipRef.current;
        if (!tooltip) return;

        tooltip.style.display = "block";
        tooltip.style.left = `${event.pageX + 12}px`;
        tooltip.style.top = `${event.pageY - 12}px`;
        tooltip.innerHTML = `
          <div style="font-weight:600;margin-bottom:4px;color:${TYPE_COLORS[d.type] || "#6366f1"}">${d.type}</div>
          <div style="margin-bottom:4px">${d.label}</div>
          ${d.tags.length > 0 ? `<div style="color:#8888a0;font-size:0.7rem">${d.tags.join(", ")}</div>` : ""}
          <div style="color:#8888a0;font-size:0.65rem;margin-top:4px">${new Date(d.createdAt).toLocaleString()}</div>
        `;

        // Highlight this node
        d3.select(this).select("circle").attr("stroke", "#fff").attr("opacity", 1);
      })
      .on("mousemove", function (event) {
        const tooltip = tooltipRef.current;
        if (!tooltip) return;
        tooltip.style.left = `${event.pageX + 12}px`;
        tooltip.style.top = `${event.pageY - 12}px`;
      })
      .on("mouseout", function (event, d) {
        const tooltip = tooltipRef.current;
        if (tooltip) tooltip.style.display = "none";

        const isSelected = selectedNodeId === d.id;
        d3.select(this)
          .select("circle")
          .attr("stroke", isSelected ? "#fff" : "transparent")
          .attr("opacity", 0.85);
      })
      .on("click", function (event, d) {
        event.stopPropagation();
        handleNodeClick(d, nodes, edges, node, link, radiusScale);
      });

    // Search highlight
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      node.each(function (d) {
        const matches =
          d.label.toLowerCase().includes(term) ||
          d.tags.some((t) => t.toLowerCase().includes(term));
        if (matches) {
          d3.select(this)
            .select("circle")
            .attr("stroke", "#fff")
            .attr("stroke-width", 3)
            .attr("filter", "url(#glow)");
        }
      });
    }

    // ── Force simulation ───────────────────────────────────

    const simulation = d3
      .forceSimulation<GraphNode>(nodes)
      .force(
        "link",
        d3
          .forceLink<GraphNode, GraphEdge>(edges)
          .id((d) => d.id)
          .distance(80)
          .strength((d) => Math.min(0.3, d.weight * 0.1))
      )
      .force("charge", d3.forceManyBody().strength(-120).distanceMax(300))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide<GraphNode>().radius((d) => radiusScale(d.relevanceScore) + 2))
      .alphaDecay(0.02);

    simulationRef.current = simulation;

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
        .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
        .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
        .attr("y2", (d) => (d.target as GraphNode).y ?? 0);

      node.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    // Click on background to deselect
    svg.on("click", () => {
      setSelectedNodeId(null);
      setSelectedNodeData(null);
      // Reset all visual states
      node
        .select("circle")
        .attr("stroke", "transparent")
        .attr("opacity", 0.85)
        .attr("filter", null);
      link.attr("stroke-opacity", 0.5);
    });

    return () => {
      simulation.stop();
    };
  }, [filteredData, searchTerm]);

  // ── Node click handler ──────────────────────────────────────

  const handleNodeClick = useCallback(
    (
      d: GraphNode,
      nodes: GraphNode[],
      edges: GraphEdge[],
      nodeSelection: d3.Selection<SVGGElement, GraphNode, SVGGElement, unknown>,
      linkSelection: d3.Selection<SVGLineElement, GraphEdge, SVGGElement, unknown>,
      radiusScale: d3.ScaleLinear<number, number>
    ) => {
      setSelectedNodeId(d.id);
      setSelectedNodeData(d);

      // Find connected node IDs
      const connectedIds = new Set<string>();
      connectedIds.add(d.id);
      for (const edge of edges) {
        const srcId = typeof edge.source === "string" ? edge.source : edge.source.id;
        const tgtId = typeof edge.target === "string" ? edge.target : edge.target.id;
        if (srcId === d.id) connectedIds.add(tgtId);
        if (tgtId === d.id) connectedIds.add(srcId);
      }

      // Dim unconnected nodes
      nodeSelection.each(function (n) {
        const isConnected = connectedIds.has(n.id);
        d3.select(this)
          .select("circle")
          .transition()
          .duration(200)
          .attr("opacity", isConnected ? 1 : 0.15)
          .attr("stroke", n.id === d.id ? "#fff" : "transparent");
      });

      // Dim unconnected edges
      linkSelection
        .transition()
        .duration(200)
        .attr("stroke-opacity", (e) => {
          const srcId = typeof e.source === "string" ? e.source : e.source.id;
          const tgtId = typeof e.target === "string" ? e.target : e.target.id;
          return srcId === d.id || tgtId === d.id ? 0.8 : 0.05;
        });
    },
    []
  );

  // ── Connection count for selected node ──────────────────────

  const connectionCount = useMemo(() => {
    if (!selectedNodeData || !filteredData) return 0;
    return filteredData.edges.filter((e) => {
      const srcId = typeof e.source === "string" ? e.source : e.source.id;
      const tgtId = typeof e.target === "string" ? e.target : e.target.id;
      return srcId === selectedNodeData.id || tgtId === selectedNodeData.id;
    }).length;
  }, [selectedNodeData, filteredData]);

  // ── Render ──────────────────────────────────────────────────

  if (loading) {
    return <div className="loading-text">Loading knowledge graph...</div>;
  }

  if (error) {
    return (
      <div className="error-text">
        Error loading graph: {error}
        <br />
        <button className="btn" onClick={fetchGraph} style={{ marginTop: "1rem" }}>
          Retry
        </button>
      </div>
    );
  }

  const nodeCount = filteredData?.nodes.length ?? 0;
  const edgeCount = filteredData?.edges.length ?? 0;

  return (
    <div>
      {/* Controls panel */}
      <div className="panel" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="search-input"
            placeholder="Search memories..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <span className="text-dim text-sm">
            {nodeCount} nodes, {edgeCount} connections
          </span>
        </div>

        <div style={{ display: "flex", gap: "1rem", marginTop: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
          {/* Type filter */}
          <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
            <span className="text-dim text-sm" style={{ marginRight: "0.25rem" }}>
              Type:
            </span>
            {["all", "fact", "preference", "event", "note", "summary"].map((type) => (
              <button
                key={type}
                className={`btn ${typeFilter === type ? "btn-primary" : ""}`}
                onClick={() => setTypeFilter(type)}
              >
                {type}
              </button>
            ))}
          </div>

          {/* Tag filter */}
          {availableTags.length > 0 && (
            <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
              <span className="text-dim text-sm" style={{ marginRight: "0.25rem" }}>
                Tag:
              </span>
              <select
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                style={{
                  padding: "0.4rem 0.75rem",
                  borderRadius: "0.375rem",
                  border: "1px solid #1e1e2e",
                  background: "#14141f",
                  color: "#e4e4ef",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                <option value="all">all tags</option>
                {availableTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Time range slider */}
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <span className="text-dim text-sm">Time:</span>
            <input
              type="range"
              min="0"
              max="365"
              value={timeRange}
              onChange={(e) => setTimeRange(parseInt(e.target.value, 10))}
              style={{ width: "120px", accentColor: "#6366f1" }}
            />
            <span className="text-dim text-sm" style={{ minWidth: "60px" }}>
              {timeRange === 0 ? "all" : `${timeRange}d`}
            </span>
          </div>
        </div>
      </div>

      {/* Graph + detail panel */}
      <div className="panel" style={{ display: "flex", gap: "1rem" }}>
        <div ref={containerRef} style={{ flex: 1, overflow: "hidden", position: "relative", minHeight: "500px" }}>
          {nodeCount === 0 ? (
            <div className="empty-state-text">
              No memories to display. Start chatting with Cortex to build your knowledge graph.
            </div>
          ) : (
            <svg
              ref={svgRef}
              style={{
                width: "100%",
                height: "100%",
                minHeight: "500px",
                background: "#0a0a0f",
                borderRadius: "0.375rem",
              }}
            />
          )}
        </div>

        {/* Detail panel */}
        {selectedNodeData && (
          <div
            style={{
              width: "280px",
              flexShrink: 0,
              borderLeft: "1px solid #1e1e2e",
              paddingLeft: "1rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
              <span className={`chip chip-${selectedNodeData.type}`}>
                {selectedNodeData.type}
              </span>
              <button
                className="btn"
                onClick={() => {
                  setSelectedNodeId(null);
                  setSelectedNodeData(null);
                }}
                style={{ padding: "0.2rem 0.5rem", fontSize: "0.7rem" }}
              >
                Close
              </button>
            </div>
            <p style={{ fontSize: "0.875rem", lineHeight: 1.5, marginBottom: "0.75rem" }}>
              {selectedNodeData.label}
            </p>
            <div className="text-dim text-sm" style={{ marginBottom: "0.5rem" }}>
              {connectionCount} connections
            </div>
            <div className="text-dim text-sm" style={{ marginBottom: "0.5rem" }}>
              Source: {selectedNodeData.source}
            </div>
            <div className="text-dim text-sm" style={{ marginBottom: "0.75rem" }}>
              {new Date(selectedNodeData.createdAt).toLocaleString()}
            </div>
            {selectedNodeData.tags.length > 0 && (
              <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                {selectedNodeData.tags.map((tag) => (
                  <span
                    key={tag}
                    className="chip"
                    style={{
                      background: "#1e1e2e",
                      color: "#8888a0",
                      cursor: "pointer",
                    }}
                    onClick={() => setTagFilter(tag)}
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
          gap: "1.5rem",
          marginTop: "0.75rem",
          justifyContent: "center",
          flexWrap: "wrap",
        }}
      >
        {/* Node types */}
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
        <span className="text-dim text-sm" style={{ margin: "0 0.25rem" }}>|</span>
        {/* Edge types */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
          <svg width="20" height="10"><line x1="0" y1="5" x2="20" y2="5" stroke="#4a4a6a" strokeWidth="2" strokeDasharray="6,4" /></svg>
          <span className="text-dim text-sm">tag</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
          <svg width="20" height="10"><line x1="0" y1="5" x2="20" y2="5" stroke="#3a3a5a" strokeWidth="2" /></svg>
          <span className="text-dim text-sm">source</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
          <svg width="20" height="10"><line x1="0" y1="5" x2="20" y2="5" stroke="#2a2a4a" strokeWidth="2" strokeDasharray="2,3" /></svg>
          <span className="text-dim text-sm">temporal</span>
        </div>
      </div>

      {/* Tooltip (portal-style positioned div) */}
      <div
        ref={tooltipRef}
        style={{
          display: "none",
          position: "fixed",
          pointerEvents: "none",
          background: "#1a1a2e",
          border: "1px solid #2a2a4a",
          borderRadius: "0.375rem",
          padding: "0.5rem 0.75rem",
          fontSize: "0.8rem",
          color: "#e4e4ef",
          maxWidth: "300px",
          zIndex: 9999,
          boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
        }}
      />
    </div>
  );
}
