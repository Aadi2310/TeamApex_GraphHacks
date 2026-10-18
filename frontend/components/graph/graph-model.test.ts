import { describe, expect, it } from "vitest";
import { chatRelatedNodeIds, mergeGraphPositions, normalizeGraph, relationshipLabel, statusKind, truncateLabel } from "./graph-model";
import type { GraphEdge, GraphNode, VisibleNode } from "./graph-model";

const node = (id: string, type: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, type, ...extra });

describe("graph model", () => {
  it("hides messages, sessions, activities, and memories by default", () => {
    const nodes = [node("user-1", "user", { user_id: "user-1" }), node("goal-1", "goal"), node("task-1", "task"), node("mem-1", "memory"), node("msg-1", "message"), node("session-1", "session"), node("activity-1", "activity")];
    const graph = normalizeGraph(nodes, [
      { source: "user-1", target: "goal-1" },
      { source: "session-1", target: "mem-1", label: "RELATED_TO" },
      { source: "mem-1", target: "task-1", label: "RELATED_TO" },
    ]);
    expect(graph.nodes.map((item) => item.id)).toEqual(["task-1"]);
  });

  it("keeps chat-linked entities and filters workspace-wide generalized records", () => {
    const nodes = [
      node("user-1", "user", { user_id: "user-1" }), node("session-1", "session"), node("msg-1", "message"),
      node("mem-1", "memory", { content: "Launch goal" }), node("goal-1", "goal"), node("task-1", "task"),
      node("habit-1", "habit", { pattern: "Review budgets regularly" }),
    ];
    const edges: GraphEdge[] = [
      { source: "session-1", target: "msg-1", label: "CONTAINS_MESSAGE" },
      { source: "session-1", target: "mem-1", label: "RELATED_TO" },
      { source: "mem-1", target: "goal-1", label: "RELATED_TO" },
      { source: "mem-1", target: "task-1", label: "RELATED_TO" },
      { source: "user-1", target: "habit-1", label: "HAS_HABIT" },
    ];
    expect([...chatRelatedNodeIds(nodes, edges)].sort()).toEqual(["goal-1", "mem-1", "msg-1", "session-1", "task-1"]);
    const graph = normalizeGraph(nodes, edges, { enabledTypes: new Set(["workspace", "goal", "task", "memory", "session", "message", "habit"]), showMemories: true, showNoise: true });
    expect(graph.nodes.map((item) => item.id).sort()).toEqual(["goal-1", "mem-1", "msg-1", "session-1", "task-1"]);
  });

  it("keeps task status memories out even when memory visibility is enabled", () => {
    const nodes = [node("task-1", "task"), node("mem-status", "memory", { content: "Task X is pending." }), node("mem-note", "memory", { content: "The task is important." })];
    const graph = normalizeGraph(nodes, [], { enabledTypes: new Set(["task", "memory"]), showMemories: true, chatOnly: false });
    expect(graph.nodes.map((item) => item.id)).toEqual(["task-1", "mem-note"]);
  });

  it("caps at 80 nodes and ranks by degree then recency", () => {
    const nodes = Array.from({ length: 82 }, (_, index) => node(`goal-${index}`, "goal", { updated_at: new Date(1_700_000_000_000 + index * 1000).toISOString() }));
    const edges: GraphEdge[] = Array.from({ length: 12 }, (_, index) => ({ source: "goal-0", target: `goal-${index + 1}`, label: "RELATED_TO" }));
    const graph = normalizeGraph(nodes, edges, { enabledTypes: new Set(["goal"]), chatOnly: false });
    expect(graph.nodes).toHaveLength(80);
    expect(graph.truncated).toBe(true);
    expect(graph.totalNodes).toBe(82);
    expect(graph.nodes[0].id).toBe("goal-0");
  });

  it("maps completed and pending statuses", () => {
    expect(statusKind("completed")).toBe("done");
    expect(statusKind("pending")).toBe("todo");
  });

  it("drops dangling/self-loop edges and collapses duplicates", () => {
    const nodes = [node("goal-1", "goal"), node("task-1", "task")];
    const graph = normalizeGraph(nodes, [
      { source: "goal-1", target: "task-1", label: "HAS_TASK" },
      { source: "goal-1", target: "task-1", label: "HAS_TASK" },
      { source: "goal-1", target: "goal-1", label: "RELATED_TO" },
      { source: "goal-1", target: "missing", label: "RELATED_TO" },
    ], { enabledTypes: new Set(["goal", "task"]), chatOnly: false });
    expect(graph.links).toHaveLength(1);
    expect(graph.droppedEdges).toBe(true);
  });

  it("truncates labels and maps relationship labels to plain English", () => {
    expect(truncateLabel("123456789012345678901234567890")).toBe("123456789012345678901234567…");
    expect(relationshipLabel("HAS_TASK")).toBe("includes task");
    expect(relationshipLabel("WARNS_AGAINST")).toBe("warns against");
    expect(relationshipLabel("DEPENDS_ON")).toBe("depends on");
    expect(relationshipLabel("CONTRADICTS")).toBe("contradicts");
    expect(relationshipLabel("RELATED_TO")).toBe("related to");
  });

  it("preserves positions and pinning on refresh and places new nodes near neighbors", () => {
    const old: VisibleNode[] = [{ ...node("goal-1", "goal"), type: "goal", label: "Goal", degree: 1, x: 100, y: 40, fx: 100, fy: 40 }];
    const incoming: VisibleNode[] = [old[0], { ...node("task-1", "task"), type: "task", label: "Task", degree: 1 }];
    const links = [{ source: "goal-1", target: "task-1", label: "HAS_TASK", parallelIndex: 0, parallelCount: 1 }];
    const merged = mergeGraphPositions(old, incoming, links);
    expect(merged[0]).toMatchObject({ x: 100, y: 40, fx: 100, fy: 40 });
    expect(merged[1].x).toBeGreaterThan(0);
    expect(merged[1].y).not.toBe(0);
  });
});
