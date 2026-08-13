/**
 * The live half of a real dashboard (spec 2026-08-13-real-dashboards): pure
 * board → stats computation, scoped by workspaces and the context window.
 * Edwin's frame: "dashboards should be a summary of the boards which are
 * scoped by the boards and the date range." No fetching, no React — the doc
 * stage feeds it the boards query and the resolved bounds.
 */
import type { WorkBoardT } from "../organisms/BoardStage";
import type { DashSpec } from "./dashboardSpec";
import { inDateRange, type RangeBounds } from "./dateRange";

export interface BoardSummary {
  kpis: DashSpec["kpis"];
  line: { labels: string[]; values: number[] };
  bars: Array<{ label: string; value: number }>;
  table: NonNullable<DashSpec["table"]>;
}

/** Board types in presentation order — the bars' fixed x-axis. */
const TYPE_ORDER = ["ideation", "plan", "deliver", "reactive", "maintenance", "release"] as const;
const TYPE_LABELS: Record<string, string> = {
  ideation: "IDEATE",
  plan: "PLAN",
  deliver: "DELIVER",
  reactive: "REACT",
  maintenance: "MAINTAIN",
  release: "RELEASE",
};

/** Calendar-day label, "8/3" style — short enough for a dense axis. */
const dayLabel = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

/**
 * Boards in scope: named workspaces only (null = every workspace), and never
 * the personal board — a personal agenda is not a workspace summary.
 */
function scopedBoards(boards: WorkBoardT[], scopeWorkspaces: string[] | null): WorkBoardT[] {
  return boards.filter((b) => {
    const ws = b.workspaceId;
    if (!ws) return false; // personal board
    return scopeWorkspaces === null || scopeWorkspaces.includes(ws);
  });
}

/** The standing window rule: undated always counts (never hide silently). */
const inWindow = (c: { updatedAt?: string }, bounds: RangeBounds | null) =>
  !bounds || !c.updatedAt || inDateRange(c.updatedAt, bounds);

export function summarizeBoards(
  boards: WorkBoardT[],
  scopeWorkspaces: string[] | null,
  bounds: RangeBounds | null,
  now: Date,
): BoardSummary {
  const scoped = scopedBoards(boards, scopeWorkspaces);
  const windowed = scoped.map((b) => ({ board: b, cards: b.cards.filter((c) => inWindow(c, bounds)) }));

  // ---- KPIs -------------------------------------------------------------
  const touched = windowed.reduce((n, w) => n + w.cards.length, 0);
  const released = windowed.filter((w) => w.board.type === "release").reduce((n, w) => n + w.cards.length, 0);
  // WIP: Deliver cards sitting in a non-terminal column RIGHT NOW — a state,
  // not an activity, so it deliberately ignores the window.
  const wip = scoped
    .filter((b) => b.type === "deliver")
    .reduce((n, b) => {
      const terminal = b.columns[b.columns.length - 1]?.id;
      return n + b.cards.filter((c) => c.columnId !== terminal).length;
    }, 0);
  const flagged = scoped.reduce((n, b) => n + b.cards.filter((c) => c.flag).length, 0);
  const pointsDone = windowed.reduce(
    (n, w) =>
      n + w.cards.reduce((m, c) => m + (c.stories ?? []).reduce((p, s) => p + (s.done ? (s.points ?? 0) : 0), 0), 0),
    0,
  );
  const kpis: DashSpec["kpis"] = [
    { label: "touched", value: String(touched) },
    { label: "released", value: String(released), tone: "ok" },
    { label: "wip now", value: String(wip), tone: wip > 8 ? "watch" : "ok" },
    { label: "flagged", value: String(flagged), tone: flagged > 0 ? "high" : "ok" },
    { label: "points done", value: String(pointsDone) },
  ];

  // ---- Bars: where work sits -------------------------------------------
  const byType = new Map<string, number>();
  for (const w of windowed) byType.set(w.board.type, (byType.get(w.board.type) ?? 0) + w.cards.length);
  const bars = TYPE_ORDER.map((t) => ({ label: TYPE_LABELS[t], value: byType.get(t) ?? 0 }));

  // ---- Line: touched per day across the window --------------------------
  // Calendar-day stepping (never ms addition across DST — dateRange.ts's
  // lesson). No bounds → the last 14 days ending today.
  const start = bounds
    ? new Date(bounds.from.getFullYear(), bounds.from.getMonth(), bounds.from.getDate())
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13);
  const end = bounds
    ? new Date(bounds.to.getFullYear(), bounds.to.getMonth(), bounds.to.getDate())
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const labels: string[] = [];
  const values: number[] = [];
  const index = new Map<string, number>();
  for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    index.set(dayLabel(d), labels.length);
    labels.push(dayLabel(d));
    values.push(0);
    if (labels.length > 366) break; // absurd custom ranges stay bounded
  }
  for (const w of windowed) {
    for (const c of w.cards) {
      if (!c.updatedAt) continue; // undated counts in totals but has no day to land on
      const at = new Date(c.updatedAt);
      if (Number.isNaN(at.getTime())) continue;
      const i = index.get(dayLabel(at));
      if (i !== undefined) values[i] += 1;
    }
  }

  // ---- Table ------------------------------------------------------------
  // Group scope pivots by workspace; a single workspace pivots by board.
  const columns = ["scope", "open", "wip", "flagged", "released", "points done"];
  const multi = scopeWorkspaces === null || scopeWorkspaces.length !== 1;
  const rows: string[][] = [];
  if (multi) {
    const names = scopeWorkspaces ?? [...new Set(scoped.map((b) => b.workspaceId as string))];
    for (const ws of names) {
      const wsBoards = scoped.filter((b) => b.workspaceId === ws);
      rows.push(summaryRow(ws, wsBoards, bounds));
    }
  } else {
    for (const b of scoped) rows.push(summaryRow(b.name, [b], bounds));
  }

  return {
    kpis,
    line: { labels, values },
    bars,
    table: { title: multi ? "workspaces" : "boards", columns, rows },
  };
}

function summaryRow(name: string, boards: WorkBoardT[], bounds: RangeBounds | null): string[] {
  const open = boards.reduce((n, b) => n + b.cards.length, 0);
  const wip = boards
    .filter((b) => b.type === "deliver")
    .reduce((n, b) => {
      const terminal = b.columns[b.columns.length - 1]?.id;
      return n + b.cards.filter((c) => c.columnId !== terminal).length;
    }, 0);
  const flagged = boards.reduce((n, b) => n + b.cards.filter((c) => c.flag).length, 0);
  const released = boards
    .filter((b) => b.type === "release")
    .reduce((n, b) => n + b.cards.filter((c) => inWindow(c, bounds)).length, 0);
  const pointsDone = boards.reduce(
    (n, b) =>
      n +
      b.cards
        .filter((c) => inWindow(c, bounds))
        .reduce((m, c) => m + (c.stories ?? []).reduce((p, s) => p + (s.done ? (s.points ?? 0) : 0), 0), 0),
    0,
  );
  return [name, String(open), String(wip), String(flagged), String(released), String(pointsDone)];
}
