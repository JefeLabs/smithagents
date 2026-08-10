/**
 * Client-side fake data for the dashboards mock — the stage reads from here
 * and only here. "Make it real" later = replace this module with an
 * agent-composed payload; nothing else moves (spec: Future path).
 */

export type DashRisk = "ok" | "watch" | "high";

export interface SavedDashboard {
  id: string;
  title: string;
  meta: string;
}

export interface DashKpi {
  label: string;
  value: string;
  delta: string;
  tone: DashRisk;
  /** Meter fill, 0–1 of the tile's width. */
  bar: number;
}

export interface DashStageBar {
  label: string;
  value: number;
}

export interface DashGroupRow {
  name: string;
  cards: number;
  wip: number;
  cycle: string;
  /** 12 weekly points, arbitrary units — drawn by sparkPath. */
  trend: number[];
  risk: DashRisk;
}

export const DASH_SCOPES = [
  "all workspaces",
  "ideation",
  "plan",
  "deliver",
  "release",
  "reactive",
  "maintenance",
  "personal",
] as const;

export const DASH_SUGGESTIONS = [
  "where is delivery slipping across all workspaces this quarter?",
  "which groups have the most work stuck in scoping?",
  "how much did we kill vs. ship in the last 12 weeks?",
  "who on the crew is most loaded right now?",
] as const;

export const DASH_FOLLOWUPS = [
  "break this down by crew member",
  "compare to last quarter",
  "only show groups trending worse",
] as const;

export const DASH_STEPS = [
  "reading 24 workspaces in jefelabs",
  "resolving stage history · 12 weeks",
  "selecting KPIs, trend and breakdown",
  "composing dashboard",
] as const;

export const DASH_SAVED: SavedDashboard[] = [
  { id: "seed-0", title: "weekly delivery health", meta: "ALL · UPDATED MON" },
  { id: "seed-1", title: "intake pressure by group", meta: "IDEATION · UPDATED 3D" },
  { id: "seed-2", title: "kill-rate watch", meta: "ALL · UPDATED 1W" },
];

export const DASH_ANSWER =
  "shipped volume is up 24% over 12 weeks, but intake is growing faster — the release group is absorbing the gap and is now the only group above its WIP ceiling.";

export const DASH_KPIS: DashKpi[] = [
  { label: "ACTIVE WORKSPACES", value: "24", delta: "+3", tone: "ok", bar: 0.72 },
  { label: "CARDS IN FLIGHT", value: "186", delta: "+18%", tone: "watch", bar: 0.84 },
  { label: "MEDIAN CYCLE TIME", value: "4.2d", delta: "+0.6d", tone: "high", bar: 0.61 },
  { label: "KILLED IN SCOPING", value: "12%", delta: "−4%", tone: "ok", bar: 0.34 },
];

export const DASH_SHIPPED = [18, 22, 19, 26, 24, 31, 28, 34, 29, 36, 33, 41];
export const DASH_INTAKE = [24, 26, 25, 30, 33, 32, 36, 35, 38, 37, 40, 44];
/** One label per point; the axis renders every other one. */
export const DASH_WEEKS = ["W23", "W24", "W25", "W26", "W27", "W28", "W29", "W30", "W31", "W32", "W33", "W34"];

export const DASH_STAGE_BARS: DashStageBar[] = [
  { label: "INTAKE", value: 54 },
  { label: "SCOPING", value: 71 },
  { label: "CONFIRM", value: 38 },
  { label: "KILLED", value: 23 },
];

export const DASH_ROWS: DashGroupRow[] = [
  { name: "release", cards: 42, wip: 11, cycle: "5.8d", risk: "high", trend: [12, 14, 13, 16, 15, 18, 17, 20, 19, 22, 24, 27] },
  { name: "deliver", cards: 61, wip: 14, cycle: "4.1d", risk: "watch", trend: [22, 21, 23, 22, 24, 23, 25, 26, 25, 27, 26, 28] },
  { name: "reactive", cards: 28, wip: 9, cycle: "1.3d", risk: "ok", trend: [15, 13, 16, 12, 15, 11, 14, 12, 13, 11, 12, 10] },
  { name: "plan", cards: 33, wip: 6, cycle: "3.6d", risk: "ok", trend: [18, 17, 18, 19, 18, 17, 18, 18, 19, 18, 17, 18] },
  { name: "ideation", cards: 47, wip: 4, cycle: "8.2d", risk: "watch", trend: [9, 11, 10, 13, 12, 15, 14, 17, 16, 19, 18, 21] },
  { name: "maintenance", cards: 19, wip: 3, cycle: "2.4d", risk: "ok", trend: [8, 9, 8, 9, 8, 9, 9, 8, 9, 8, 9, 8] },
];

/** The meta line a just-saved dashboard gets; "all workspaces" folds to ALL. */
export function savedMeta(scope: string): string {
  return `${(scope === "all workspaces" ? "all" : scope).toUpperCase()} · JUST SAVED`;
}

export function scopeHint(scope: string): string {
  return `SCOPE · ${scope.toUpperCase()}`;
}
