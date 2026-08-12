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
  | { kind: "days"; days: number } // rolling: the last N days, today included
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
      // k from ms is approximate across DST; the WINDOW is then built with
      // CALENDAR-day arithmetic so a January anchor tiles cleanly into August
      // (raw ms drifted the boundary an hour across the DST change —
      // live-observed as "Aug 3 – Aug 17" on a 14-day sprint).
      let k = Math.floor((now.getTime() - anchor.getTime()) / (sprint.lengthDays * DAY_MS));
      const windowAt = (i: number) => {
        const from = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i * sprint.lengthDays);
        const to = new Date(
          anchor.getFullYear(),
          anchor.getMonth(),
          anchor.getDate() + (i + 1) * sprint.lengthDays,
          0,
          0,
          0,
          -1,
        );
        return { from, to };
      };
      // The ms estimate can be off by one window right at a boundary — settle it.
      let w = windowAt(k);
      if (now.getTime() > w.to.getTime()) w = windowAt(++k);
      else if (now.getTime() < w.from.getTime()) w = windowAt(--k);
      return w;
    }
    case "days":
      return {
        from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - (range.days - 1)),
        to: endOfDay(now),
      };
    case "custom":
      return { from: localDate(range.from), to: endOfDay(localDate(range.to)) };
  }
}

/**
 * The app is ALWAYS windowed (Edwin, 2026-08-12: no "All time" in the list):
 * the default is Current Sprint where a config resolves, otherwise the last
 * 14 days — and a picked sprint whose config left degrades the same way.
 */
export function effectiveRange(range: DateRange | null, sprint?: SprintConfig): DateRange {
  if (!range) return sprint ? { kind: "sprint" } : { kind: "days", days: 14 };
  if (range.kind === "sprint" && !sprint) return { kind: "days", days: 14 };
  return range;
}

/**
 * The one membership rule. `null` bounds admits everything, and so does an
 * UNPARSEABLE date — an item whose time can't be judged must never silently
 * vanish (the app is always windowed now; this guard is what keeps a bad
 * timestamp from disappearing a session or card).
 */
export function inDateRange(updatedAt: string, bounds: RangeBounds | null): boolean {
  if (!bounds) return true;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return true;
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
    case "days":
      return `Last ${range.days} days`;
    case "custom":
      return `${range.from} – ${range.to}`;
  }
}

/** Mon(1)..Sun(7), ISO order — the wizard's "sprint starts on" choices. */
export const WEEKDAYS = [
  { iso: 1, label: "Monday" },
  { iso: 2, label: "Tuesday" },
  { iso: 3, label: "Wednesday" },
  { iso: 4, label: "Thursday" },
  { iso: 5, label: "Friday" },
  { iso: 6, label: "Saturday" },
  { iso: 7, label: "Sunday" },
] as const;

/**
 * The wizard collects a WEEKDAY, the schema stores an ANCHOR date: derive one
 * from the other. The anchor is the first such weekday of 2026 — a fixed,
 * documented convention that pins multi-week sprints' phase. (A weekday alone
 * cannot say WHICH Monday a 14-day sprint starts on; this convention decides.)
 */
export function weekdayToAnchor(isoWeekday: number): string {
  const jan1 = new Date(2026, 0, 1); // a Thursday (ISO 4)
  const jan1Iso = jan1.getDay() === 0 ? 7 : jan1.getDay();
  const offset = (isoWeekday - jan1Iso + 7) % 7;
  const d = new Date(2026, 0, 1 + offset);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The stored anchor's weekday, for pre-filling the wizard when editing. */
export function anchorToWeekday(anchor: string): number {
  const [y, m, d] = anchor.split("-").map(Number);
  const day = new Date(y, (m ?? 1) - 1, d ?? 1).getDay();
  return day === 0 ? 7 : day;
}

/** Short inline dates for the picker's trigger: "Aug 10 – Aug 16" (years only when they differ from now's). */
export function formatBounds(bounds: RangeBounds, now: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    });
  return `${fmt(bounds.from)} – ${fmt(bounds.to)}`;
}

/** The dashboard scope line's WHEN suffix: "core · Current Week"; unchanged when All time. */
export function withRange(scope: string, range: DateRange | null): string {
  return range ? `${scope} · ${rangeLabel(range)}` : scope;
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
