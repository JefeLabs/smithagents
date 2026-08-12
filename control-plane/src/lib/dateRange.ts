/**
 * The WHEN half of the context window (spec 2026-08-12-date-range-context):
 * calendar-anchored current periods plus an opt-in sprint. One membership rule
 * (`inDateRange`) that Boards, the sessions panel and dashboards all import —
 * the case table lives here and nowhere else. Pure: every resolver takes `now`.
 */

export type DateRange =
  | { kind: "week" }
  | { kind: "sprint" }
  | { kind: "month" }
  | { kind: "quarter" }
  | { kind: "custom"; from: string; to: string };

export interface SprintConfig {
  /** ISO date any sprint started — the window grid is anchored here. */
  anchor: string;
  lengthDays: number;
}

export interface RangeBounds {
  from: Date;
  to: Date;
}

const DAY_MS = 86_400_000;

/** Local midnight of an ISO `YYYY-MM-DD` (Date.parse would give UTC and shift the day). */
function localDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/**
 * Concrete bounds for a choice. Returns null ONLY for a sprint without config —
 * sprints are opt-in (decision 3), so an unconfigured context degrades to
 * All time rather than approximating a window.
 */
export function resolveDateRange(range: DateRange, now: Date, sprint?: SprintConfig): RangeBounds | null {
  switch (range.kind) {
    case "week": {
      // ISO week: Monday is day 1; JS Sunday is 0 → treat as 7.
      const day = now.getDay() === 0 ? 7 : now.getDay();
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day - 1));
      return { from: monday, to: endOfDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)) };
    }
    case "month": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to: endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
    }
    case "quarter": {
      const q = Math.floor(now.getMonth() / 3);
      const from = new Date(now.getFullYear(), q * 3, 1);
      return { from, to: endOfDay(new Date(now.getFullYear(), q * 3 + 3, 0)) };
    }
    case "sprint": {
      if (!sprint) return null;
      const anchor = localDate(sprint.anchor);
      const length = sprint.lengthDays * DAY_MS;
      // floor() handles a future anchor too (negative k) — the grid extends both ways.
      const k = Math.floor((now.getTime() - anchor.getTime()) / length);
      const from = new Date(anchor.getTime() + k * length);
      return { from, to: new Date(from.getTime() + length - 1) };
    }
    case "custom":
      return { from: localDate(range.from), to: endOfDay(localDate(range.to)) };
  }
}

/** The one membership rule. `null` bounds = All time — everything belongs. */
export function inDateRange(updatedAt: string, bounds: RangeBounds | null): boolean {
  if (!bounds) return true;
  const t = new Date(updatedAt).getTime();
  return t >= bounds.from.getTime() && t <= bounds.to.getTime();
}

export function rangeLabel(range: DateRange | null): string {
  if (!range) return "All time";
  switch (range.kind) {
    case "week":
      return "Current Week";
    case "sprint":
      return "Current Sprint";
    case "month":
      return "Current Month";
    case "quarter":
      return "Current Quarter";
    case "custom":
      return `${range.from} – ${range.to}`;
  }
}

/**
 * Which sprint config governs the current context: the group lens's group
 * first, then the active session's workspace — "look at many, act in one".
 */
export function sprintConfigFor(
  lensGroup: { sprint?: SprintConfig } | undefined,
  workspace: { sprint?: SprintConfig } | undefined,
): SprintConfig | undefined {
  return lensGroup?.sprint ?? workspace?.sprint;
}
