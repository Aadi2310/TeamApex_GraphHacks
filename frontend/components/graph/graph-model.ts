import { DEFAULT_TYPES, NOISE_TYPES } from "./graph-theme";

export type GraphNode = {
  id: string;
  type?: string;
  user_id?: string;
  title?: string;
  name?: string;
  content?: string;
  status?: string;
  operation?: string;
  prevention_rule?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
};

export type GraphEdge = { source: string; target: string; label?: string; [key: string]: unknown };
export type VisibleNode = GraphNode & { type: string; label: string; degree: number; x?: number; y?: number; fx?: number; fy?: number; createdAt?: number };
export type VisibleLink = GraphEdge & { source: string; target: string; label: string; parallelIndex: number; parallelCount: number };
export type GraphData = { nodes: VisibleNode[]; links: VisibleLink[]; totalNodes: number; truncated: boolean; droppedEdges: boolean };
export type GraphOptions = { enabledTypes?: Set<string>; showNoise?: boolean; showMemories?: boolean; neighborhoodId?: string | null; searchQuery?: string; limit?: number; chatOnly?: boolean };

const typeOf = (node: GraphNode): string => {
  const type = node.user_id && node.id === node.user_id ? "workspace" : (node.type || node.id.split("-")[0] || "record").toLowerCase();
  return type === "user" ? "workspace" : type;
};
const textOf = (node: GraphNode): string => String(node.name || node.title || node.content || node.pattern || node.description || `Untitled ${typeOf(node)}`);
const timestamp = (node: GraphNode): number => {
  const value = Date.parse(String(node.updated_at || node.created_at || ""));
  return Number.isFinite(value) ? value : 0;
};

export function truncateLabel(value: string, max = 28): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function statusKind(status?: string): "done" | "in_progress" | "blocked" | "todo" | "none" {
  const normalized = status?.toLowerCase().replaceAll("-", "_");
  if (normalized === "done" || normalized === "completed" || normalized === "complete" || normalized === "succeeded") return "done";
  if (normalized === "in_progress" || normalized === "running" || normalized === "active") return "in_progress";
  if (normalized === "blocked") return "blocked";
  if (normalized === "pending" || normalized === "todo" || normalized === "to_do") return "todo";
  return "none";
}

const LABELS: Record<string, string> = {
  HAS_GOAL: "tracks goal", HAS_TASK: "includes task", HAS_MEMORY: "stores memory", HAS_SESSION: "has conversation",
  CONTAINS_MESSAGE: "contains message", RELATED_TO: "related to", DEPENDS_ON: "depends on", ASSIGNED_TO: "assigned to",
  WORKS_ON: "works on", BELONGS_TO: "belongs to", MADE_MISTAKE: "made mistake", WARNS_AGAINST: "warns against",
  HAS_HABIT: "tracks habit", SUPERSEDES: "supersedes", CONTRADICTS: "contradicts", KNOWS: "knows",
  COLLABORATES_ON: "collaborates on",
};

export function relationshipLabel(label?: string): string {
  const upper = (label || "RELATED_TO").toUpperCase();
  return LABELS[upper] || upper.toLowerCase().replaceAll("_", " ");
}

/**
 * Resolve graph records that have explicit provenance in a saved conversation.
 * The API also returns workspace-wide records, so those must not be treated as
 * chat memories unless a session is connected to them.
 */
export function chatRelatedNodeIds(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const types = new Map(nodes.map((node) => [node.id, typeOf(node)]));
  const related = new Set<string>();
  const sessionIds = new Set(nodes.filter((node) => typeOf(node) === "session").map((node) => node.id));
  const memoryIds = new Set<string>();

  for (const edge of edges) {
    const sourceType = types.get(edge.source);
    const targetType = types.get(edge.target);
    if (sourceType === "session" && targetType === "message") {
      related.add(edge.source);
      related.add(edge.target);
    } else if (sourceType === "message" && targetType === "session") {
      related.add(edge.source);
      related.add(edge.target);
    }
    if (sourceType === "session" && targetType === "memory") memoryIds.add(edge.target);
    if (sourceType === "memory" && targetType === "session") memoryIds.add(edge.source);
  }

  for (const edge of edges) {
    if (memoryIds.has(edge.source) && !sessionIds.has(edge.target) && types.get(edge.target) !== "workspace") related.add(edge.target);
    if (memoryIds.has(edge.target) && !sessionIds.has(edge.source) && types.get(edge.source) !== "workspace") related.add(edge.source);
  }
  for (const id of memoryIds) related.add(id);
  return related;
}

export function normalizeGraph(nodes: GraphNode[], edges: GraphEdge[], options: GraphOptions = {}): GraphData {
  const allById = new Map(nodes.map((node) => [node.id, node]));
  const uniqueEdges = new Map<string, GraphEdge>();
  let droppedEdges = false;
  for (const edge of edges) {
    if (!allById.has(edge.source) || !allById.has(edge.target) || edge.source === edge.target) {
      droppedEdges = true;
      continue;
    }
    uniqueEdges.set(`${edge.source}\0${edge.target}\0${edge.label || "RELATED_TO"}`, edge);
  }
  const degrees = new Map<string, number>();
  for (const edge of uniqueEdges.values()) {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  }
  const selectedTypes = options.enabledTypes || DEFAULT_TYPES;
  const chatRelatedIds = options.chatOnly === false ? null : chatRelatedNodeIds(nodes, [...uniqueEdges.values()]);
  const neighborhoodIds = new Set<string>(options.neighborhoodId ? [options.neighborhoodId] : []);
  if (options.neighborhoodId) for (const edge of uniqueEdges.values()) {
    if (edge.source === options.neighborhoodId) neighborhoodIds.add(edge.target);
    if (edge.target === options.neighborhoodId) neighborhoodIds.add(edge.source);
  }
  const eligible = nodes.filter((node) => {
    const type = typeOf(node);
    if (chatRelatedIds && !chatRelatedIds.has(node.id)) return false;
    if (type === "memory" ? !selectedTypes.has(type) && !neighborhoodIds.has(node.id) : !selectedTypes.has(type)) return false;
    if (NOISE_TYPES.has(type) && !options.showNoise) return false;
    if (type === "memory" && !options.showMemories && !neighborhoodIds.has(node.id)) return false;
    if (type === "memory" && /\btask\b.+\bis\b.+\b(pending|todo)\b/i.test(String(node.content || ""))) return false;
    return true;
  });
  const totalNodes = eligible.length;
  const limit = options.limit ?? 80;
  const query = options.searchQuery?.trim().toLowerCase() || "";
  const matchesSearch = (node: GraphNode) => !query || `${node.name || ""} ${node.title || ""} ${node.content || ""}`.toLowerCase().includes(query);
  const ranked = [...eligible].sort((a, b) => Number(matchesSearch(b)) - Number(matchesSearch(a)) || (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0) || timestamp(b) - timestamp(a));
  const limited = ranked.slice(0, limit);
  const visibleIds = new Set(limited.map((node) => node.id));
  const visibleNodes = limited.map((node) => ({
    ...node, type: typeOf(node), label: textOf(node), degree: degrees.get(node.id) || 0,
    createdAt: timestamp(node),
  }));
  const visibleEdges = [...uniqueEdges.values()].filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const grouped = new Map<string, GraphEdge[]>();
  for (const edge of visibleEdges) {
    const pair = [edge.source, edge.target].sort().join("\0");
    grouped.set(pair, [...(grouped.get(pair) || []), edge]);
  }
  const links: VisibleLink[] = [];
  for (const pairEdges of grouped.values()) pairEdges.forEach((edge, parallelIndex) => links.push({
    ...edge, label: String(edge.label || "RELATED_TO"), parallelIndex, parallelCount: pairEdges.length,
  }));
  return { nodes: visibleNodes, links, totalNodes, truncated: totalNodes > limit, droppedEdges };
}

export function mergeGraphPositions(previous: VisibleNode[], incoming: VisibleNode[], edges: VisibleLink[]): VisibleNode[] {
  const oldById = new Map(previous.map((node) => [node.id, node]));
  const positioned = new Map(previous.map((node) => [node.id, node]));
  return incoming.map((node, index) => {
    const old = oldById.get(node.id);
    if (old) {
      const preserved = { ...node, x: old.x, y: old.y, fx: old.fx, fy: old.fy };
      positioned.set(node.id, preserved);
      return preserved;
    }
    const edge = edges.find((link) => link.source === node.id || link.target === node.id);
    const neighborId = edge ? edge.source === node.id ? edge.target : edge.source : undefined;
    const neighbor = neighborId ? positioned.get(neighborId) : undefined;
    const angle = index * 2.39996;
    const placed = neighbor
      ? { ...node, x: (neighbor.x || 0) + Math.cos(angle) * 24, y: (neighbor.y || 0) + Math.sin(angle) * 24 }
      : { ...node, x: 360 + Math.cos(angle) * 36, y: Math.sin(angle) * 36 };
    positioned.set(node.id, placed);
    return placed;
  });
}

export function rankNodes(nodes: GraphNode[], edges: GraphEdge[], limit = 80): GraphNode[] {
  return normalizeGraph(nodes, edges, { enabledTypes: new Set(nodes.map(typeOf)), showNoise: true, showMemories: true, limit }).nodes;
}
