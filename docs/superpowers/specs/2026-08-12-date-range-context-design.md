# Date Range context control — Design

**Date:** 2026-08-12
**Status:** SHIPPED (main @ 409ba0b + form-landing fixes — lib, swarm sprint config, manager forms, navbar select, three consumers; live-smoked)

## Problem

The app has a WHERE lens (workspace/group selector) but no WHEN. Edwin's model: "A date range coupled with workspace/group will affect Boards, and dashboards and even sessions that should be available." The pair **[Workspace/Group] × [Date Range]** is one context window the whole app respects — and the range is the front door to phase-2 dashboards ("summary of the boards scoped by the boards and the date range").

## Decisions (Edwin rulings)

1. **Consumers — all three:** Boards, dashboards, and the available-sessions list.
2. **Ranges are calendar-anchored current periods, not rolling windows:** "Current Sprint, Current Week, Current Month, Current Quarter, Custom date range."
3. **Sprint definition is an OPT-IN workspace/group configuration** — both levels may carry one; without one, sprints simply don't exist for that context (no approximated fallback window).
4. Default is All time (unnamed in the menu list; the untouched state) — the app looks exactly as today until narrowed. My call, unvetoed.
5. View state, not persisted — same lifetime as the group lens. My call, unvetoed.
6. Activity semantics: everything reads `updatedAt`. A card born in March but touched yesterday belongs to "Current Week". My call, unvetoed.

## Design

### 1. Range model (`control-plane/src/lib/dateRange.ts`, NEW — pure, router-free)

```ts
export type DateRange =
  | { kind: "week" }        // ISO Monday–Sunday containing today
  | { kind: "sprint" }      // resolved via sprint config, see §2
  | { kind: "month" }       // calendar month containing today
  | { kind: "quarter" }     // calendar quarter containing today
  | { kind: "custom"; from: string; to: string }; // inclusive ISO dates
// null everywhere it is stored = All time (no filtering).

export interface SprintConfig { anchor: string; lengthDays: number } // anchor = ISO date any sprint started

/** Concrete bounds for a choice. `now` injected for tests. */
export function resolveDateRange(range: DateRange, now: Date, sprint?: SprintConfig): { from: Date; to: Date };
/** The one membership rule every consumer imports. `range === null` is always true. */
export function inDateRange(updatedAt: string, bounds: { from: Date; to: Date } | null): boolean;
/** The control's label. */
export function rangeLabel(range: DateRange | null): string;
```

- Sprint resolution: the window `[anchor + k·lengthDays, anchor + (k+1)·lengthDays)` containing `now`. `resolveDateRange` REQUIRES the config for `kind: "sprint"` — the control never offers Current Sprint without one (opt-in, decision 3), so no fallback exists to approximate.
- Custom bounds are inclusive of both end dates (from 00:00 to 23:59:59.999 local).

### 2. Sprint configuration (workspace AND group)

- `Workspace` (swarm/src/workspaces.ts) and `WorkspaceGroup` (swarm/src/groups.ts) each gain optional `sprint?: { anchor: string; lengthDays: number }`; round-trips through the existing CRUD routes and rides the existing frames (workspace records / session-frame `groups`) — no new endpoints.
- Edited in the workspace manager: two small fields (anchor date, length in days) on the workspace form and on the GroupsSection form.
- **Precedence at read time:** active group lens's group config → active session's workspace config. Neither configured → **Current Sprint is absent from the menu** (opt-in: un-configured contexts have no sprints). A picked sprint range whose config disappears (workspace switch) degrades to All time rather than lying.

### 3. The control (navbar)

- `DateRangeSelect` molecule immediately right of the WorkspaceSelector: a compact HeroUI Select showing the current label ("All time" default). Menu: All time | Current Week | Current Sprint | Current Month | Current Quarter | Custom range….
- "Custom range…" is a sentinel command (selector precedent) opening a small popover with two native date inputs + Apply.
- Current Sprint renders only when the active context resolves a sprint config (decision 3).
- State in `uiStore`: `dateRange: DateRange | null` (+ `setDateRange`), initial null, reset with the store. View state — never dispatch state, gone on reload like the lens.

### 4. Consumers

1. **Boards** (BoardStage/board-aggregate path): cards where `!inDateRange(card.updatedAt, bounds)` are HIDDEN; column counts reflect the window. Filtering is view-side only — the swarm store is untouched.
2. **Sessions** (SessionsPanel): rows filtered by `session.updatedAt` in bounds — "available sessions" means active within the context window. The ACTIVE session always stays listed (never hide the ground you stand on).
3. **Dashboards** (DashboardsRoute → onPresent): the scope line grows the range label — `scope: core · current sprint`. Mock compose unchanged; phase-2 board-data dashboards make it the real query dimension.

## Out of scope

- Rolling windows (7d/30d/90d presets) — calendar periods won.
- Persisting the picked range across reloads.
- Map dimming by range; per-column date fields; sprint boards/velocity.

## Testing

- **dateRange lib (vitest):** week/month/quarter bounds around edges (year wrap, quarter borders); sprint windows for k = 0, anchors in the future, exact boundary instants; custom inclusivity; `inDateRange(null)` always true; `rangeLabel` covers every kind.
- **swarm (node:test):** sprint field round-trips on workspace and group asserts/CRUD.
- **control-plane:** DateRangeSelect renders menu + custom popover + sentinel; Current Sprint absent without config, present with one; sprint pick degrades to All time when the config leaves; uiStore set/reset; BoardStage hides an out-of-window card and keeps counts honest; SessionsPanel keeps the active session; DashboardsStage scope line carries the label.
