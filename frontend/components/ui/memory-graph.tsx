"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type GraphNode = {
  id: string;
  type?: string;
  user_id?: string;
  title?: string;
  content?: string;
  name?: string;
  operation?: string;
  status?: string;
};

type GraphEdge = { source: string; target: string; label?: string };

const SLOT_WIDTH = 230;
const NODE_WIDTH = 194;
const NODE_HEIGHT = 88;
const LEVEL_HEIGHT = 168;
const TOP_GUTTER = 34;
const SIDE_GUTTER = 110;

function nodeKind(node: GraphNode) {
  if (node.user_id && node.id === node.user_id) return "workspace";
  const prefix = node.id.split("-")[0].toLowerCase();
  const names: Record<string, string> = {
    goal: "goal",
    task: "task",
    mem: "memory",
    session: "conversation",
    msg: "message",
    activity: "agent run",
    user: "workspace",
  };
  return names[prefix] || node.type?.toLowerCase() || "record";
}

function relationshipLabel(edge: GraphEdge, source: GraphNode, target: GraphNode) {
  const label = edge.label?.toUpperCase();
  if (label === "HAS_GOAL") return "tracks goal";
  if (label === "HAS_SESSION") return "has conversation";
  if (label === "HAS_MEMORY") return "stores memory";
  if (label === "HAS_TASK") return "includes task";
  if (label === "CONTAINS_MESSAGE") return "contains message";
  if (label === "RELATED_TO") {
    const from = nodeKind(source);
    const to = nodeKind(target);
    if (from === "conversation" && to === "memory") return "saved from chat";
    if (from === "memory" && to === "task") return "describes task";
    if (from === "workspace" && to === "agent run") return "agent activity";
    return "connected context";
  }
  return "connected to";
}

function edgePriority(edge: GraphEdge, source: GraphNode, target: GraphNode) {
  const label = edge.label?.toUpperCase();
  const from = nodeKind(source);
  const to = nodeKind(target);
  if (label === "HAS_GOAL" || label === "HAS_SESSION") return 0;
  if (label === "HAS_TASK" && from === "goal") return 0;
  if (label === "CONTAINS_MESSAGE") return 0;
  if (label === "RELATED_TO" && from === "conversation" && to === "memory") return 1;
  if (label === "RELATED_TO" && from === "memory" && to === "task") return 2;
  if (label === "RELATED_TO" && to === "agent run") return 3;
  return 4;
}

function statusLabel(status?: string) {
  if (!status) return "";
  const labels: Record<string, string> = {
    succeeded: "Complete",
    running: "Running",
    completed: "Complete",
    in_progress: "In progress",
    pending: "Pending",
    blocked: "Blocked",
    active: "Active",
  };
  return labels[status.toLowerCase()] || status.replaceAll("_", " ");
}

export function MemoryGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const layout = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const uniqueEdges = edges.filter((edge, index) =>
      byId.has(edge.source) && byId.has(edge.target) &&
      edges.findIndex((item) => item.source === edge.source && item.target === edge.target && item.label === edge.label) === index,
    );
    const incoming = new Set(uniqueEdges.map((edge) => edge.target));
    const preferredRoot = nodes.find((node) => node.user_id && node.id === node.user_id)
      || nodes.find((node) => node.type?.toLowerCase() === "user")
      || nodes.find((node) => !incoming.has(node.id))
      || nodes[0];
    const roots = preferredRoot ? [preferredRoot] : [];
    const children = new Map<string, { edge: GraphEdge; node: GraphNode }[]>();
    const treeEdges = new Set<GraphEdge>();
    const depth = new Map<string, number>();
    const visited = new Set<string>();
    const pending: { source: GraphNode; edge: GraphEdge; priority: number }[] = [];

    const enqueue = (source: GraphNode) => {
      uniqueEdges.filter((edge) => edge.source === source.id).forEach((edge) => {
        const target = byId.get(edge.target);
        if (target) pending.push({ source, edge, priority: edgePriority(edge, source, target) });
      });
    };

    let rootCursor = 0;
    while (visited.size < nodes.length) {
      if (!pending.length) {
        const nextRoot = rootCursor === 0 ? roots[0] : nodes.find((node) => !visited.has(node.id));
        rootCursor++;
        if (!nextRoot || visited.has(nextRoot.id)) break;
        roots.push(nextRoot);
        visited.add(nextRoot.id);
        depth.set(nextRoot.id, 0);
        enqueue(nextRoot);
        continue;
      }

      pending.sort((a, b) => a.priority - b.priority || (depth.get(a.source.id) || 0) - (depth.get(b.source.id) || 0));
      const candidate = pending.shift()!;
      if (visited.has(candidate.edge.target)) continue;
      const target = byId.get(candidate.edge.target);
      if (!target) continue;
      visited.add(target.id);
      depth.set(target.id, (depth.get(candidate.source.id) || 0) + 1);
      treeEdges.add(candidate.edge);
      const siblings = children.get(candidate.source.id) || [];
      siblings.push({ edge: candidate.edge, node: target });
      children.set(candidate.source.id, siblings);
      enqueue(target);
    }

    const orderedChildren = (id: string) => (children.get(id) || []).sort((a, b) => {
      const rank: Record<string, number> = { goal: 0, conversation: 1, task: 2, memory: 3, message: 4, "agent run": 5 };
      return (rank[nodeKind(a.node)] ?? 6) - (rank[nodeKind(b.node)] ?? 6);
    });

    let leafIndex = 0;
    const xCenter = new Map<string, number>();
    const placeSubtree = (node: GraphNode): number => {
      const childNodes = orderedChildren(node.id).map((entry) => entry.node);
      if (!childNodes.length) {
        const center = SIDE_GUTTER + leafIndex * SLOT_WIDTH + NODE_WIDTH / 2;
        leafIndex++;
        xCenter.set(node.id, center);
        return center;
      }
      const childCenters = childNodes.map(placeSubtree);
      const center = childCenters.reduce((sum, item) => sum + item, 0) / childCenters.length;
      xCenter.set(node.id, center);
      return center;
    };

    roots.forEach((root, index) => {
      if (visited.has(root.id) && !xCenter.has(root.id)) {
        if (index > 0) leafIndex += 1;
        placeSubtree(root);
      }
    });
    const positionedNodes = nodes.filter((node) => xCenter.has(node.id)).map((node) => ({
      node,
      x: xCenter.get(node.id)! - NODE_WIDTH / 2,
      y: TOP_GUTTER + (depth.get(node.id) || 0) * LEVEL_HEIGHT,
    }));
    const positions = new Map(positionedNodes.map((item) => [item.node.id, item]));
    const maxDepth = Math.max(0, ...Array.from(depth.values()));
    const naturalWidth = SIDE_GUTTER * 2 + Math.max(leafIndex - 1, 0) * SLOT_WIDTH + NODE_WIDTH;
    const width = Math.max(900, naturalWidth);
    const centerOffset = (width - naturalWidth) / 2;
    positionedNodes.forEach((item) => { item.x += centerOffset; });
    const height = TOP_GUTTER * 2 + maxDepth * LEVEL_HEIGHT + NODE_HEIGHT;

    return { edges: uniqueEdges, treeEdges, positions, positionedNodes, width, height, rootId: preferredRoot?.id };
  }, [nodes, edges]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showAdditionalLinks, setShowAdditionalLinks] = useState(false);

  useEffect(() => {
    const viewport = scrollRef.current;
    const root = layout.rootId ? layout.positions.get(layout.rootId) : undefined;
    if (!viewport || !root) return;
    viewport.scrollLeft = Math.max(0, root.x + NODE_WIDTH / 2 - viewport.clientWidth / 2);
    viewport.scrollTop = 0;
  }, [layout.rootId, nodes.length]);

  return (
    <section className="memory-graph-card card" aria-label="Memory graph">
      <header className="memory-graph-header">
        <div>
          <h2>Memory graph</h2>
          <p>Follow how conversations, goals, tasks, and saved memories connect.</p>
        </div>
        <div className="memory-graph-actions">
          <span className="graph-count">{nodes.length} items <i /> {edges.length} links</span>
          <button type="button" className="graph-toggle" aria-pressed={showAdditionalLinks} onClick={() => setShowAdditionalLinks((shown) => !shown)}>
            {showAdditionalLinks ? "Hide" : "Show"} extra links
          </button>
        </div>
      </header>
      {!nodes.length ? (
        <div className="empty graph-empty">No graph nodes yet. Add a goal in Chat to build your memory graph.</div>
      ) : (
        <div ref={scrollRef} className="memory-graph-scroll">
          <div className="memory-graph-canvas" style={{ width: layout.width, height: layout.height }}>
            <svg className="memory-graph-links" width={layout.width} height={layout.height} aria-hidden="true">
              <defs><marker id="memory-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z" fill="#696c6e" /></marker></defs>
              {layout.edges.map((edge, index) => {
                const source = layout.positions.get(edge.source);
                const target = layout.positions.get(edge.target);
                if (!source || !target) return null;
                const sourceNode = source.node;
                const targetNode = target.node;
                const treeEdge = layout.treeEdges.has(edge);
                if (!treeEdge && !showAdditionalLinks) return null;
                const x1 = source.x + NODE_WIDTH / 2;
                const y1 = source.y + NODE_HEIGHT;
                const x2 = target.x + NODE_WIDTH / 2;
                const y2 = target.y;
                const distance = Math.max(24, (y2 - y1) / 2);
                const d = treeEdge
                  ? `M ${x1} ${y1} C ${x1} ${y1 + distance}, ${x2} ${y2 - distance}, ${x2} ${y2}`
                  : `M ${x1} ${y1} C ${x1 + 58} ${y1 + 30}, ${x2 + 58} ${y2 - 30}, ${x2} ${y2}`;
                const label = relationshipLabel(edge, sourceNode, targetNode);
                return (
                  <g key={`${edge.source}-${edge.target}-${edge.label}-${index}`} className={treeEdge ? "graph-link" : "graph-link graph-link-secondary"}>
                    <title>{label}</title>
                    <path d={d} />
                    {treeEdge && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} textAnchor="middle">{label}</text>}
                  </g>
                );
              })}
            </svg>
            {layout.positionedNodes.map(({ node, x, y }) => {
              const kind = nodeKind(node);
              const title = node.title || node.content || node.name || node.id;
              const secondary = kind === "agent run" ? node.operation : undefined;
              return (
                <article className={`memory-node memory-node-${kind.replaceAll(" ", "-")}`} key={node.id} style={{ left: x, top: y }} title={title}>
                  <div className="memory-node-top"><span>{kind}</span>{node.status && <span className={`memory-node-status status-${node.status.toLowerCase()}`}>{statusLabel(node.status)}</span>}</div>
                  <div className="memory-node-title">{node.name || title}</div>
                  {secondary && <div className="memory-node-detail">{secondary}</div>}
                </article>
              );
            })}
          </div>
        </div>
      )}
      <footer className="memory-graph-legend"><span><i className="legend-line" /> Main connection</span><span><i className="legend-line legend-line-dashed" /> Additional context</span><span>Top to bottom follows the saved graph links</span></footer>
    </section>
  );
}
