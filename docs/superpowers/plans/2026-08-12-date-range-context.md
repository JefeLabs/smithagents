# Date Range Context Implementation Plan

> **EXECUTED:** shipped to main on 2026-08-12 (session d43af92a). All seven tasks landed; includes the New-group form landing.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Date Range select beside the workspace/group selector — All time | Current Week | Current Sprint (opt-in config) | Current Month | Current Quarter | Custom — filtering Boards and the sessions list and riding dashboard scope. Plus: "New group…" opens straight into the group-creation form.

**Architecture:** One pure lib (`dateRange.ts`) owns period resolution and membership; sprint config is an optional `{anchor, lengthDays}` on Workspace AND WorkspaceGroup (swarm-owned, rides existing CRUD + frames); the picked range is uiStore view state like the group lens; three consumers filter view-side via the one `inDateRange` helper.

**Tech Stack:** vitest (cp lib/components), node:test (swarm), HeroUI Select, zustand.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-date-range-context-design.md` (opt-in sprint: NO fallback window; active session always listed in sessions panel; view-side filtering only).
- pnpm; zero-diagnostic biome; swarm tests from swarm cwd; exit codes by redirect; commit explicit paths; verify `[main <hash>]`.
- Organisms may read uiStore (BoardStage precedent) but stay router-free.
- `Date.now()` free lib: every resolver takes `now: Date`.

---

### Task 1: `dateRange` lib

**Files:** Create `control-plane/src/lib/dateRange.ts`; Test `control-plane/src/lib/dateRange.test.ts`.

**Produces:**
```ts
export type DateRange =
  | { kind: "week" } | { kind: "sprint" } | { kind: "month" } | { kind: "quarter" }
  | { kind: "custom"; from: string; to: string };
export interface SprintConfig { anchor: string; lengthDays: number }
export interface RangeBounds { from: Date; to: Date }
export function resolveDateRange(range: DateRange, now: Date, sprint?: SprintConfig): RangeBounds | null; // null ONLY for sprint-without-config (degrade to All time)
export function inDateRange(updatedAt: string, bounds: RangeBounds | null): boolean; // null bounds → true
export function rangeLabel(range: DateRange | null): string; // "All time" | "Current Week" | ... | "Aug 1 – Aug 12"
export function sprintConfigFor(
  lensGroup: { sprint?: SprintConfig } | undefined,
  workspace: { sprint?: SprintConfig } | undefined,
): SprintConfig | undefined; // group lens wins, then workspace (spec §2 precedence)
```

- [ ] Tests first: ISO week Mon–Sun incl. year wrap (Wed 2025-12-31); month/quarter borders (Mar 31 → Q1, Apr 1 → Q2); sprint windows k=0 and k>0, `now` exactly on a boundary starts the NEXT window, future anchor resolves the containing window (negative k); sprint without config → null; custom inclusive both ends (from 00:00:00.000 local to 23:59:59.999); `inDateRange(anything, null)` true; labels for every kind. FAIL → implement → PASS. Commit `feat(cp): dateRange lib — calendar periods, opt-in sprints, one membership rule`.

### Task 2: sprint config on Workspace and WorkspaceGroup (swarm)

**Files:** Modify `swarm/src/workspaces.ts` (Workspace interface + assert accepts optional `sprint`), `swarm/src/groups.ts` (same on WorkspaceGroup + assertGroup), `swarm/src/server.ts` (workspace POST object-build + PUT field-merge + GET /workspaces mapping carry `sprint`; group POST object-build + PUT merge carry `sprint`); Test `swarm/src/groups.test.ts` (+ the existing workspace assert test file if one covers optional fields).

**Contract:** `sprint?: { anchor: string; lengthDays: number }` — validated when present: anchor parses as a date, lengthDays a positive integer; invalid → the existing 400 path.

- [ ] Test first (groups.test.ts): assertGroup accepts a valid sprint, rejects `lengthDays: 0` and `anchor: "not-a-date"`. FAIL → implement asserts + route plumbing (all THREE workspace spots: POST build, PUT merge, GET map — the routes copy fields explicitly and silently drop unknown ones) → PASS `cd swarm && pnpm test`. Commit `feat(swarm): opt-in sprint config on workspaces and groups`.

### Task 3: control-plane plumbing — types, manager forms

**Files:** Modify `control-plane/src/api/types.ts` (WorkspaceRecord + GroupT gain `sprint?`), `control-plane/src/api/broker.ts` (saveGroup body type gains `sprint?`), `control-plane/src/organisms/GroupsSection.tsx` (+test: anchor date + length inputs, ride onSave body), `control-plane/src/organisms/WorkspaceManagerModal.tsx` (WorkspaceFormValues/toForm/toRecord/padKeys + two fields on the form — half-filled sprint (anchor XOR length) saves as ABSENT, the "half-filled block is not a block" rule already in toRecord).

- [ ] GroupsSection test first: editing a group with sprint shows the values; create with anchor+length calls onSave with `sprint: { anchor, lengthDays }`; length blank → no sprint key. FAIL → implement both forms → PASS full cp suite. Commit `feat(cp): sprint config edits in the workspace manager`.

### Task 4: "New group…" opens the group form (Edwin, 2026-08-12)

**Files:** Modify `control-plane/src/stores/uiStore.ts` (+test) — `groupFormIntent: boolean`, set by `openGroupForm()` (also sets `workspacesOpen: true`), cleared by `clearGroupFormIntent()`; `control-plane/src/molecules/WorkspaceSelector.tsx` (+test — NEW_GROUP calls `openGroupForm()` instead of bare `setWorkspacesOpen(true)`); `control-plane/src/organisms/GroupsSection.tsx` (+test — new prop `autoStart?: boolean`; on mount with autoStart, run `startNew()` and call `onAutoStarted?()`); `control-plane/src/organisms/WorkspaceManagerModal.tsx` (pass `autoStart={groupFormIntent}` + clear via uiStore on consume).

- [ ] Tests first (store toggle; selector calls openGroupForm; GroupsSection auto-opens create form with the member checkboxes rendered). FAIL → implement → PASS. Commit `fix(cp): New group… lands in the group form, member pickers in view`.

### Task 5: uiStore range + DateRangeSelect in the navbar

**Files:** Modify `control-plane/src/stores/uiStore.ts` (+test): `dateRange: DateRange | null`, `setDateRange`; Create `control-plane/src/molecules/DateRangeSelect.tsx` (+test); Modify `control-plane/src/pages/HomePage.tsx` (workspaceSlot becomes `<><WorkspaceSelector /><DateRangeSelect /></>`), `control-plane/src/styles/components.css` (compact trigger beside the selector, same treatment as the kind picker's bordered trigger).

**DateRangeSelect contract:** reads `useGroups()` + `useWorkspaceRecords()` + `useSession()` + `activeLens` to resolve `sprintConfigFor`; HeroUI Select — All time | Current Week | (Current Sprint only when config resolves) | Current Month | Current Quarter | Custom range… (sentinel opens a popover: two `<input type="date">` + Apply → `{kind:"custom",from,to}`). An active `{kind:"sprint"}` whose config disappears renders as All time (`rangeLabel` of a degraded range) without writing the store.

- [ ] Tests first: menu contents ± sprint config; picking week sets the store; custom popover applies from/to; sprint pick with config present sets `{kind:"sprint"}`. FAIL → implement → PASS. Commit `feat(cp): Date Range select beside the workspace selector`.

### Task 6: the three consumers

**Files:** Modify `control-plane/src/organisms/BoardStage.tsx` (+test — before `clusterByWorkspace(collectCards(...))` at `:395`, cards filter through `inDateRange(card.updatedAt, bounds)`; bounds computed once per render from uiStore dateRange + sprintConfigFor), `control-plane/src/organisms/SessionsPanel.tsx` (+test — `visible` chain at `:52` also filters `inDateRange(s.updatedAt, bounds)` EXCEPT the active session), `control-plane/src/router.tsx` (DashboardsRoute onPresent: scope string becomes `` `${scope} · ${rangeLabel(dateRange)}` `` when a range is set), `control-plane/src/organisms/DashboardsStage.test.tsx` or HomePage test only if the scope change surfaces there.

- [ ] Tests first: BoardStage hides a card with stale updatedAt when a range is set, shows it on All time; SessionsPanel hides an out-of-window session but never the active one; dashboards scope line carries the label. FAIL → implement → PASS full cp suite. Commit `feat(cp): the context window filters boards and sessions and rides dashboard scope`.

### Task 7: verify, restart, smoke, ship

- [ ] Root test/lint/typecheck by redirect. Restart swarm + broker (tmux), reload the cp tab (stale-cache lesson).
- [ ] Live smoke: navbar shows the range select; Current Sprint absent → add sprint config to workspace jefelabs in the manager → present; pick Current Week → Boards hide stale cards, sessions panel narrows (active stays); compose a dashboard → question shows `scope: … · current week`; New group… lands in the open group form with pickers. Screenshot and LOOK.
- [ ] Spec → SHIPPED, memory + MEMORY.md, push via ecruz165.
