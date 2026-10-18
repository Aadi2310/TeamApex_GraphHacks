"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, RefObject } from "react";
import type { ForceGraphMethods, ForceGraphProps, LinkObject, NodeObject } from "react-force-graph-2d";
import type { GraphNode, VisibleLink, VisibleNode } from "./graph-model";
import { relationshipLabel, statusKind, truncateLabel } from "./graph-model";
import { radiusFor, TYPE_COLORS } from "./graph-theme";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false, loading: () => <div className="graph-loading" role="status" aria-label="Preparing memory graph">{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</div> }) as unknown as ComponentType<ForceGraphProps<VisibleNode, VisibleLink> & { ref?: RefObject<ForceGraphMethods<NodeObject<VisibleNode>, LinkObject<VisibleNode, VisibleLink>> | undefined> }>;
type SimNode = VisibleNode & { x?: number; y?: number; vx?: number; vy?: number; fx?: number | null; fy?: number | null };
type SimLink = VisibleLink & { source: string | SimNode; target: string | SimNode };
type Controls = { zoomIn: () => void; zoomOut: () => void; fit: () => void; reset: () => void };
type Props = { nodes: VisibleNode[]; links: VisibleLink[]; allNodes: GraphNode[]; selectedId: string | null; onSelect: (id: string | null) => void; searchMatches: Set<string>; searchActive: boolean; announce: (text: string) => void; onNewNodePulse: (id: string) => boolean; resetVersion: number; onControls: (controls: Controls) => void; onPin: (id: string, x: number, y: number) => void; onSyncPositions: (nodes: VisibleNode[]) => void; searchTargetId?: string; onSearchTargetHandled: () => void; onReset: () => void };
type ForceApi = ForceGraphMethods<NodeObject<VisibleNode>, LinkObject<VisibleNode, VisibleLink>>;

const endpointId = (endpoint: string | SimNode): string => typeof endpoint === "string" ? endpoint : String(endpoint.id || "");

export function GraphCanvas({ nodes, links, allNodes, selectedId, onSelect, searchMatches, searchActive, announce, onNewNodePulse, resetVersion, onControls, onPin, onSyncPositions, searchTargetId, onSearchTargetHandled, onReset }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceApi | undefined>(undefined);
  const fitOnce = useRef(false);
  const hasMeasuredSize = useRef(false);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [pulseIds, setPulseIds] = useState<Set<string>>(new Set());
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const neighborhoodId = selectedId || hoveredId;
  const neighbors = useMemo(() => {
    const set = new Set<string>();
    if (neighborhoodId) {
      set.add(neighborhoodId);
      for (const edge of links) if (edge.source === neighborhoodId || edge.target === neighborhoodId) set.add(edge.source === neighborhoodId ? edge.target : edge.source);
    }
    return set;
  }, [links, neighborhoodId]);
  const graphData = useMemo(() => ({ nodes: nodes.map((node) => ({ ...node })) as NodeObject<VisibleNode>[], links: links.map((edge) => ({ ...edge })) as unknown as LinkObject<VisibleNode, VisibleLink>[] }), [nodes, links]);

  useEffect(() => () => { graphRef.current?.pauseAnimation(); }, []);

  useEffect(() => {
    onControls({
      zoomIn: () => graphRef.current?.zoom(graphRef.current.zoom() * 1.25, 160),
      zoomOut: () => graphRef.current?.zoom(graphRef.current.zoom() / 1.25, 160),
      fit: () => graphRef.current?.zoomToFit(400, 60),
      reset: onReset,
    });
  }, [graphData, onControls, onReset]);

  useEffect(() => {
    if (!searchTargetId) return;
    const ids = new Set([searchTargetId]);
    links.forEach((edge) => { if (edge.source === searchTargetId) ids.add(edge.target); if (edge.target === searchTargetId) ids.add(edge.source); });
    graphRef.current?.zoomToFit(450, 70, (node) => ids.has(String(node.id || "")));
    onSearchTargetHandled();
  }, [searchTargetId, links, onSearchTargetHandled]);

  useEffect(() => {
    if (!resetVersion) return;
    graphData.nodes.forEach((node) => { node.fx = undefined; node.fy = undefined; });
    fitOnce.current = false;
    graphRef.current?.d3ReheatSimulation();
  }, [graphData, resetVersion]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setSize({ width: Math.max(1, box.width), height: Math.max(380, box.height) });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hasMeasuredSize.current) { hasMeasuredSize.current = true; return; }
    let frame = 0;
    const fitAfterResize = () => {
      if (!graphRef.current) { frame = window.requestAnimationFrame(fitAfterResize); return; }
      graphRef.current.zoomToFit(reducedMotion ? 0 : 250, 60);
    };
    frame = window.requestAnimationFrame(fitAfterResize);
    return () => window.cancelAnimationFrame(frame);
  }, [size.width, size.height, reducedMotion]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(query.matches);
    const update = () => setReducedMotion(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const fresh = nodes.filter((node) => onNewNodePulse(node.id));
    if (!fresh.length) return;
    setPulseIds((old) => new Set([...old, ...fresh.map((node) => node.id)]));
    const timer = window.setTimeout(() => setPulseIds((old) => {
      const next = new Set(old);
      fresh.forEach((node) => next.delete(node.id));
      return next;
    }), 1500);
    return () => window.clearTimeout(timer);
  }, [nodes, onNewNodePulse]);

  useEffect(() => {
    let frame = 0;
    const configure = () => {
      const graph = graphRef.current;
      if (!graph) { frame = window.requestAnimationFrame(configure); return; }
      const linkForce = graph.d3Force("link");
      if (linkForce && "distance" in linkForce && typeof linkForce.distance === "function") {
        linkForce.distance(70);
        if (typeof linkForce.strength === "function") linkForce.strength((link: SimLink) => ["HAS_TASK", "BELONGS_TO"].includes(link.label) ? 0.82 : 0.42);
      }
      const charge = graph.d3Force("charge");
      if (charge && "strength" in charge && typeof charge.strength === "function") charge.strength(-220);
      const center = graph.d3Force("center");
      if (center && "strength" in center && typeof center.strength === "function") center.strength(0.08);
      let simulationNodes: NodeObject<VisibleNode>[] = [];
      const collide = Object.assign((alpha: number) => {
        for (let i = 0; i < simulationNodes.length; i++) for (let j = i + 1; j < simulationNodes.length; j++) {
          const a = simulationNodes[i]; const b = simulationNodes[j];
          let dx = (b.x || 0) - (a.x || 0); let dy = (b.y || 0) - (a.y || 0);
          const distance = Math.hypot(dx, dy) || 0.01;
          const minimum = radiusFor(a.type) + radiusFor(b.type) + 12;
          if (distance < minimum) {
            const push = ((minimum - distance) / distance) * 0.5 * alpha;
            dx *= push; dy *= push;
            a.vx = (a.vx || 0) - dx; a.vy = (a.vy || 0) - dy;
            b.vx = (b.vx || 0) + dx; b.vy = (b.vy || 0) + dy;
          }
        }
      }, { initialize: (simulation: NodeObject<VisibleNode>[]) => { simulationNodes = simulation; } });
      graph.d3Force("collide", collide);
      const workspaceBias = Object.assign((alpha: number) => {
        const workspace = simulationNodes.find((node) => node.type === "workspace");
        if (workspace) { workspace.vx = (workspace.vx || 0) - (workspace.x || 0) * alpha * 0.012; workspace.vy = (workspace.vy || 0) - (workspace.y || 0) * alpha * 0.012; }
      }, { initialize: (simulation: NodeObject<VisibleNode>[]) => { simulationNodes = simulation; } });
      graph.d3Force("workspace-bias", workspaceBias);
    };
    frame = window.requestAnimationFrame(configure);
    return () => window.cancelAnimationFrame(frame);
  }, [nodes.length, links.length]);

  const drawNode = useCallback((rawNode: NodeObject<VisibleNode>, ctx: CanvasRenderingContext2D, zoom: number) => {
    const node = rawNode as SimNode;
    const x = node.x || 0;
    const y = node.y || 0;
    const radius = radiusFor(node.type);
    const isFocused = !neighborhoodId || neighbors.has(node.id);
    const isMatch = !searchActive || searchMatches.has(node.id);
    const alpha = isFocused || searchActive && isMatch ? 1 : 0.15;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = TYPE_COLORS[node.type] || "#8A8D91";
    ctx.strokeStyle = TYPE_COLORS[node.type] || "#8A8D91";
    ctx.lineWidth = 2 / zoom;
    const status = node.type === "task" ? statusKind(node.status) : "none";
    if (status === "todo" || status === "blocked") {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = status === "blocked" ? "#D55E00" : TYPE_COLORS[node.type];
      ctx.setLineDash(status === "blocked" ? [3 / zoom, 2 / zoom] : []);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (status === "in_progress") {
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, radius, -Math.PI / 2, Math.PI / 2); ctx.lineWidth = 3 / zoom; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      if (status === "done") {
        ctx.strokeStyle = "#101112"; ctx.lineWidth = 2.2 / zoom; ctx.beginPath();
        ctx.moveTo(x - radius * 0.45, y); ctx.lineTo(x - radius * 0.08, y + radius * 0.35); ctx.lineTo(x + radius * 0.5, y - radius * 0.4); ctx.stroke();
      }
    }
    if (pulseIds.has(node.id)) {
      ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 1.5 / zoom; ctx.beginPath(); ctx.arc(x, y, radius + 4 / zoom, 0, Math.PI * 2); ctx.stroke();
    }
    const showLabel = node.id === selectedId || node.id === hoveredId || ["goal", "project", "workspace"].includes(node.type) || zoom >= 1.6;
    if (showLabel) {
      const label = truncateLabel(node.label, 28);
      ctx.font = `${11 / zoom}px system-ui, sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.lineJoin = "round";
      ctx.strokeStyle = "#101112"; ctx.lineWidth = 3 / zoom;
      ctx.strokeText(label, x, y + radius + 4 / zoom);
      ctx.fillStyle = "#E1E2E3"; ctx.fillText(label, x, y + radius + 4 / zoom);
    }
    ctx.restore();
  }, [hoveredId, neighborhoodId, neighbors, pulseIds, searchActive, searchMatches, selectedId]);

  const drawLink = useCallback((rawLink: VisibleLink, ctx: CanvasRenderingContext2D, zoom: number) => {
    const link = rawLink as SimLink;
    const source = typeof link.source === "object" ? link.source : nodeById.get(String(link.source));
    const target = typeof link.target === "object" ? link.target : nodeById.get(String(link.target));
    if (!source || !target) return;
    const sourceId = endpointId(link.source);
    const targetId = endpointId(link.target);
    const focused = !neighborhoodId || sourceId === neighborhoodId || targetId === neighborhoodId;
    const selectedEdge = Boolean(selectedId && (sourceId === selectedId || targetId === selectedId));
    const matched = !searchActive || searchMatches.has(sourceId) && searchMatches.has(targetId);
    const alpha = focused || searchActive && matched ? 1 : 0.15;
    const special = link.label === "CONTRADICTS" || link.label === "SUPERSEDES";
    const dx = (target.x || 0) - (source.x || 0);
    const dy = (target.y || 0) - (source.y || 0);
    const length = Math.max(1, Math.hypot(dx, dy));
    const curve = link.parallelCount > 1 ? (link.parallelIndex - (link.parallelCount - 1) / 2) * 13 : 0;
    const midX = ((source.x || 0) + (target.x || 0)) / 2 - (dy / length) * curve;
    const midY = ((source.y || 0) + (target.y || 0)) / 2 + (dx / length) * curve;
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = special && link.label === "CONTRADICTS" ? "#D55E00" : "rgba(255,255,255,0.18)"; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 1 / zoom;
    ctx.setLineDash(link.label === "CONTRADICTS" ? [4 / zoom, 3 / zoom] : link.label === "SUPERSEDES" ? [1 / zoom, 3 / zoom] : []);
    ctx.beginPath(); ctx.moveTo(source.x || 0, source.y || 0);
    if (curve) ctx.quadraticCurveTo(midX * 2 - ((source.x || 0) + (target.x || 0)) / 2, midY * 2 - ((source.y || 0) + (target.y || 0)) / 2, target.x || 0, target.y || 0);
    else ctx.lineTo(target.x || 0, target.y || 0);
    ctx.stroke(); ctx.setLineDash([]);
    if (selectedEdge) {
      const angle = Math.atan2(dy, dx); const arrow = 5 / zoom;
      ctx.beginPath(); ctx.moveTo(target.x || 0, target.y || 0);
      ctx.lineTo((target.x || 0) - arrow * Math.cos(angle - Math.PI / 6), (target.y || 0) - arrow * Math.sin(angle - Math.PI / 6));
      ctx.lineTo((target.x || 0) - arrow * Math.cos(angle + Math.PI / 6), (target.y || 0) - arrow * Math.sin(angle + Math.PI / 6));
      ctx.closePath(); ctx.fill();
      ctx.font = `${10 / zoom}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.strokeStyle = "#101112"; ctx.lineWidth = 3 / zoom; ctx.strokeText(relationshipLabel(link.label), midX, midY - 5 / zoom);
      ctx.fillStyle = "#C7C9CA"; ctx.fillText(relationshipLabel(link.label), midX, midY - 5 / zoom);
    }
    ctx.restore();
  }, [neighborhoodId, nodeById, searchActive, searchMatches, selectedId]);

  const onNodeClick = useCallback((node: NodeObject<VisibleNode>, event: MouseEvent) => {
    onSelect(node.id ? String(node.id) : null);
    const item = allNodes.find((entry) => entry.id === node.id);
    if (item) announce(`${String(item.name || item.title || item.content || `Untitled ${item.type || "node"}`)}, ${item.type || "record"} selected`);
    if (event.detail > 1) {
      const id = String(node.id || "");
      const ids = new Set([id]);
      links.forEach((edge) => { if (edge.source === id) ids.add(edge.target); if (edge.target === id) ids.add(edge.source); });
      graphRef.current?.zoomToFit(450, 60, (candidate) => ids.has(String(candidate.id || "")));
    }
  }, [allNodes, announce, links, onSelect]);

  return <div ref={hostRef} className="graph-canvas" tabIndex={0} aria-label="Interactive memory graph" onKeyDown={(event) => {
    if (event.key === "+" || event.key === "=") graphRef.current?.zoom(graphRef.current.zoom() * 1.2, 150);
    else if (event.key === "-") graphRef.current?.zoom(graphRef.current.zoom() / 1.2, 150);
    else if (event.key === "0") graphRef.current?.zoomToFit(400, 60);
    else if (event.key === "Escape") onSelect(null);
  }}>
    <ForceGraph2D ref={graphRef} width={size.width} height={size.height} graphData={graphData} backgroundColor="#101112" nodeId="id" nodeVal={(node: NodeObject<VisibleNode>) => radiusFor(node.type) * radiusFor(node.type) / 16} nodeCanvasObjectMode={() => "replace"} nodeCanvasObject={drawNode} linkCanvasObjectMode={() => "replace"} linkCanvasObject={drawLink} linkColor={() => "rgba(255,255,255,0.18)"} cooldownTime={reducedMotion ? 1 : 3000} cooldownTicks={reducedMotion ? 1 : undefined} warmupTicks={reducedMotion ? 0 : 1} onNodeHover={(node) => setHoveredId(node?.id ? String(node.id) : null)} onNodeClick={onNodeClick} onBackgroundClick={() => onSelect(null)} onNodeDragEnd={(node: NodeObject<VisibleNode>) => { if (typeof node.x === "number" && typeof node.y === "number") { node.fx = node.x; node.fy = node.y; onPin(String(node.id || ""), node.x, node.y); } }} onEngineStop={() => { onSyncPositions(graphData.nodes.map((node) => ({ ...node, x: node.x, y: node.y, fx: node.fx, fy: node.fy }))); if (!fitOnce.current) { fitOnce.current = true; graphRef.current?.zoomToFit(reducedMotion ? 0 : 400, 60); } }} />
    <span className="graph-sr-only">Graph with {nodes.length} visible nodes and {links.length} relationships.</span>
  </div>;
}
