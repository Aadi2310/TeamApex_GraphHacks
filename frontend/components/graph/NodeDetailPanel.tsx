"use client";

import { TYPE_COLORS } from "./graph-theme";
import { relationshipLabel } from "./graph-model";
import type { GraphEdge, GraphNode } from "./graph-model";

function timeAgo(value?: string) {
  if (!value) return "";
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return value;
  const days = Math.round((Date.now() - date) / 86400000);
  if (Math.abs(days) < 1) return "today";
  if (Math.abs(days) < 30) return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
  if (Math.abs(days) < 365) return `${Math.round(Math.abs(days) / 30)} month${Math.round(Math.abs(days) / 30) === 1 ? "" : "s"} ago`;
  return `${Math.round(Math.abs(days) / 365)} year${Math.round(Math.abs(days) / 365) === 1 ? "" : "s"} ago`;
}

type Props = { node: GraphNode; edges: GraphEdge[]; byId: Map<string, GraphNode>; onSelect: (id: string) => void; onClose: () => void };

export function NodeDetailPanel({ node, edges, byId, onSelect, onClose }: Props) {
  const title = String(node.name || node.title || node.content || `Untitled ${node.type || "node"}`);
  const detail = node.type === "memory" ? node.content : node.type === "mistake" ? node.prevention_rule || node.content || node.title : node.content || node.description;
  const groups = new Map<string, GraphNode[]>();
  for (const edge of edges) {
    const other = byId.get(edge.source === node.id ? edge.target : edge.source);
    if (!other) continue;
    const label = relationshipLabel(edge.label);
    groups.set(label, [...(groups.get(label) || []), other]);
  }
  return <aside className="graph-detail-panel" aria-label="Selected node details">
    <div className="graph-detail-head"><div><span className="graph-detail-type" style={{ color: TYPE_COLORS[node.type || ""] || "#e1e2e3" }}>{node.type || "record"}</span><h3>{title}</h3></div><button onClick={onClose} aria-label="Close details">×</button></div>
    {typeof detail === "string" && detail.length > 0 && <p className="graph-detail-content">{detail}</p>}
    {(node.type === "task" || node.type === "goal") && node.status && <p className="graph-detail-status">Status <b>{node.status.replaceAll("_", " ")}</b></p>}
    {node.created_at && <p className="graph-detail-time">Created {timeAgo(node.created_at)}</p>}
    {node.updated_at && <p className="graph-detail-time">Updated {timeAgo(node.updated_at)}</p>}
    <h4>Connections</h4><ul className="graph-detail-links">{[...groups.entries()].map(([relation, connected]) => <li key={relation}><strong>{relation}</strong><ul>{connected.map((other, index) => <li key={`${other.id}-${index}`}><button onClick={() => onSelect(other.id)}>{String(other.name || other.title || other.content || `Untitled ${other.type || "node"}`)}</button></li>)}</ul></li>)}{!groups.size && <li className="graph-muted">No visible connections</li>}</ul>
  </aside>;
}
