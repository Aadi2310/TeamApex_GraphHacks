export const TYPE_COLORS: Record<string, string> = {
  goal: "#E69F00", task: "#56B4E9", project: "#009E73", person: "#CC79A7",
  mistake: "#D55E00", habit: "#F0E442", memory: "#8A8D91", workspace: "#FFFFFF",
  session: "#7B9EA8", message: "#858789", activity: "#C7A3D8",
};

export const NODE_RADII: Record<string, number> = {
  workspace: 14, goal: 11, project: 10, task: 8, person: 8,
  mistake: 7, habit: 7, memory: 5, session: 7, message: 5, activity: 7,
};

export const VISIBLE_TYPES = ["workspace", "goal", "project", "task", "person", "mistake", "habit", "memory", "session", "message", "activity"];
export const DEFAULT_TYPES = new Set(["workspace", "goal", "project", "task", "person", "mistake", "habit"]);
export const NOISE_TYPES = new Set(["session", "message", "activity"]);

export function radiusFor(type: string): number {
  return Math.min(16, NODE_RADII[type] ?? 7);
}
