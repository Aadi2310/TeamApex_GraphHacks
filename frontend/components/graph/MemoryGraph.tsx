"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { DEFAULT_TYPES, VISIBLE_TYPES } from "./graph-theme";
import { GraphLegend } from "./GraphLegend";
import { GraphToolbar } from "./GraphToolbar";
import { GraphCanvas } from "./GraphCanvas";
import { NodeDetailPanel } from "./NodeDetailPanel";
import { chatRelatedNodeIds, mergeGraphPositions, normalizeGraph, relationshipLabel } from "./graph-model";
import type { GraphEdge, GraphNode, VisibleNode } from "./graph-model";

type Controls = { zoomIn: () => void; zoomOut: () => void; fit: () => void; reset: () => void };
type Props = { nodes: GraphNode[]; edges: GraphEdge[]; loading?: boolean; error?: string; onRetry?: () => void };

export function MemoryGraph({ nodes, edges, loading = false, error, onRetry }: Props) {
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(() => new Set(DEFAULT_TYPES));
  const [showNoise, setShowNoise] = useState(false);
  const [showMemories, setShowMemories] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [controls, setControls] = useState<Controls | null>(null);
  const [resetVersion, setResetVersion] = useState(0);
  const [searchTargetId, setSearchTargetId] = useState<string>();
  const [announce, setAnnounce] = useState("");
  const displayRef = useRef<VisibleNode[]>([]);
  const knownIds = useRef(new Set(nodes.map((node) => node.id)));
  const searchRef = useRef<HTMLInputElement>(null);
  const graphCardRef = useRef<HTMLElement>(null);
  const warnedEdges = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const update = () => setIsFullscreen(document.fullscreenElement === graphCardRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  const chatNodeIds = useMemo(() => chatRelatedNodeIds(nodes, edges), [nodes, edges]);
  const chatNodes = useMemo(() => nodes.filter((node) => chatNodeIds.has(node.id)), [nodes, chatNodeIds]);
  const graph = useMemo(() => normalizeGraph(nodes, edges, { enabledTypes, showNoise, showMemories, neighborhoodId: selectedId, searchQuery: debouncedQuery, limit: 80 }), [nodes, edges, enabledTypes, showNoise, showMemories, selectedId, debouncedQuery]);
  const displayNodes = useMemo(() => mergeGraphPositions(displayRef.current, graph.nodes, graph.links), [graph.nodes, graph.links]);
  useEffect(() => { displayRef.current = displayNodes; }, [displayNodes]);
  useEffect(() => {
    if (graph.droppedEdges && process.env.NODE_ENV === "development" && !warnedEdges.current) {
      console.warn("Memory graph: dropped dangling or self-loop edges.");
      warnedEdges.current = true;
    }
  }, [graph.droppedEdges]);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const detailEdges = useMemo(() => edges.filter((edge) => (edge.source === selectedId && chatNodeIds.has(edge.target)) || (edge.target === selectedId && chatNodeIds.has(edge.source))), [edges, selectedId, chatNodeIds]);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = Object.fromEntries(VISIBLE_TYPES.map((type) => [type, 0]));
    chatNodes.forEach((node) => {
      const rawType = node.user_id && node.id === node.user_id ? "workspace" : String(node.type || node.id.split("-")[0]).toLowerCase();
      const type = rawType === "user" ? "workspace" : rawType;
      counts[type] = (counts[type] || 0) + 1;
    });
    return counts;
  }, [chatNodes]);
  const searchMatches = useMemo(() => new Set(displayNodes.filter((node) => !debouncedQuery || `${node.name || ""} ${node.title || ""} ${node.content || ""} ${node.label}`.toLowerCase().includes(debouncedQuery)).map((node) => node.id)), [debouncedQuery, displayNodes]);
  const searchActive = Boolean(debouncedQuery);

  useEffect(() => {
    if (selectedId && !graph.nodes.some((node) => node.id === selectedId)) setSelectedId(null);
  }, [graph.nodes, selectedId]);

  const setAllTypes = useCallback((enabled: boolean) => {
    setEnabledTypes(enabled ? new Set(VISIBLE_TYPES) : new Set());
    setShowNoise(enabled);
    setShowMemories(enabled);
  }, []);
  const toggleType = useCallback((type: string) => {
    const wasEnabled = enabledTypes.has(type);
    if (["session", "message", "activity"].includes(type)) setShowNoise((current) => current || !wasEnabled);
    if (type === "memory") setShowMemories(!wasEnabled);
    setEnabledTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }, [enabledTypes]);
  const changeNoiseVisibility = useCallback((visible: boolean) => {
    setShowNoise(visible);
    if (visible) setEnabledTypes((current) => new Set([...current, "session", "message", "activity"]));
  }, []);
  const onNewNodePulse = useCallback((id: string) => {
    if (knownIds.current.has(id)) return false;
    knownIds.current.add(id);
    return true;
  }, []);
  const onReset = useCallback(() => {
    displayRef.current = displayRef.current.map((node) => ({ ...node, fx: undefined, fy: undefined }));
    setEnabledTypes((current) => new Set(current));
    setResetVersion((version) => version + 1);
  }, []);
  const onPin = useCallback((id: string, x: number, y: number) => {
    displayRef.current = displayRef.current.map((node) => node.id === id ? { ...node, x, y, fx: x, fy: y } : node);
  }, []);
  const onSyncPositions = useCallback((updated: VisibleNode[]) => {
    const positions = new Map(updated.map((node) => [node.id, node]));
    displayRef.current = displayRef.current.map((node) => {
      const position = positions.get(node.id);
      return position ? { ...node, x: position.x, y: position.y, fx: position.fx, fy: position.fy } : node;
    });
  }, []);
  const selectNode = useCallback((id: string | null) => {
    if (id) {
      const target = byId.get(id);
      if (target) {
        const rawType = target.user_id && target.id === target.user_id ? "workspace" : String(target.type || target.id.split("-")[0]).toLowerCase();
        const type = rawType === "user" ? "workspace" : rawType;
        setEnabledTypes((current) => current.has(type) ? current : new Set([...current, type]));
        if (["session", "message", "activity"].includes(type)) setShowNoise(true);
      }
    }
    setSelectedId(id);
  }, [byId]);
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { setQuery(""); setDebouncedQuery(""); }
    if (event.key === "Enter") {
      const needle = query.trim().toLowerCase();
      const match = chatNodes.find((node) => `${node.name || ""} ${node.title || ""} ${node.content || ""}`.toLowerCase().includes(needle));
      if (match && needle) {
        const rawType = match.user_id && match.id === match.user_id ? "workspace" : String(match.type || match.id.split("-")[0]).toLowerCase();
        const type = rawType === "user" ? "workspace" : rawType;
        setEnabledTypes((current) => current.has(type) ? current : new Set([...current, type]));
        if (["session", "message", "activity"].includes(type)) setShowNoise(true);
        if (type === "memory") setShowMemories(true);
        setDebouncedQuery(needle); setSearchTargetId(match.id);
      }
    }
  };
  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await graphCardRef.current?.requestFullscreen();
  };

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)) {
        event.preventDefault(); searchRef.current?.focus();
      }
      if (event.key === "Escape" && selectedId) setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const onlyWorkspace = nodes.length === 0 || nodes.every((node) => node.user_id && node.id === node.user_id || node.type?.toLowerCase() === "user" || node.id.split("-")[0] === "user");
  const controlsApi: Controls = controls || { zoomIn: () => {}, zoomOut: () => {}, fit: () => {}, reset: onReset };

  return <section ref={graphCardRef} className="memory-graph-view" aria-label="Memory graph">
    <header className="memory-graph-heading"><div><h2>Memory graph</h2><p>{graph.nodes.length} nodes · {graph.links.length} relationships</p></div></header>
    <GraphToolbar query={query} onQuery={setQuery} showNoise={showNoise} onShowNoise={changeNoiseVisibility} counts={typeCounts} enabled={enabledTypes} onToggleType={toggleType} onSetAll={setAllTypes} onZoomIn={controlsApi.zoomIn} onZoomOut={controlsApi.zoomOut} onFit={controlsApi.fit} onReset={onReset} searchRef={searchRef} onSearchKeyDown={onSearchKeyDown} isFullscreen={isFullscreen} onToggleFullscreen={toggleFullscreen} />
    {error && <div className="graph-error" role="alert">{error}{onRetry && <button onClick={onRetry}>Retry</button>}</div>}
    {loading ? <div className="graph-loading" role="status" aria-label="Loading memory graph">{Array.from({ length: 6 }, (_, index) => <i key={index} />)}</div> : onlyWorkspace ? <div className="graph-empty">Nothing remembered yet. Tell the chat about a goal or a task.</div> : <>
      {graph.truncated && <p className="graph-cap-notice">Showing 80 of {graph.totalNodes}. Use search or filters to find others.</p>}
      {graph.nodes.length ? <div className="graph-content-shell"><GraphCanvas nodes={displayNodes} links={graph.links} allNodes={nodes} selectedId={selectedId} onSelect={selectNode} searchMatches={searchMatches} searchActive={searchActive} announce={setAnnounce} onNewNodePulse={onNewNodePulse} resetVersion={resetVersion} onControls={setControls} onPin={onPin} onSyncPositions={onSyncPositions} searchTargetId={searchTargetId} onSearchTargetHandled={() => setSearchTargetId(undefined)} onReset={onReset} />
        {selected && <NodeDetailPanel node={selected} edges={detailEdges} byId={byId} onSelect={selectNode} onClose={() => setSelectedId(null)} />}
      </div> : <div className="graph-empty">No nodes match the current filters. Choose a type chip or select All.</div>}
      <ul className="graph-sr-only" aria-label="Visible memory graph nodes">{graph.nodes.map((node) => <li key={node.id}>{node.label}, {node.type}. {graph.links.filter((link) => link.source === node.id || link.target === node.id).map((link) => `${relationshipLabel(link.label)} ${byId.get(link.source === node.id ? link.target : link.source)?.title || byId.get(link.source === node.id ? link.target : link.source)?.name || "connected item"}`).join("; ")}</li>)}</ul>
      <span className="graph-sr-only" aria-live="polite">{announce}</span>
      <GraphLegend />
    </>}
  </section>;
}
