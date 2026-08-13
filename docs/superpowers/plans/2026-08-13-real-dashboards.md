# Real Dashboards (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.
>
> **CLAIMED by the main session (d43af92a), 2026-08-13 — inline execution.**

**Goal:** Dashboards compute real board summaries live (scope × current date range); stories carry map-authored point estimates that cards mirror.

**Architecture:** A pure summarizer (`boardSummary.ts`) turns boards × scope × window into stats; the dashboard doc stage renders those stats live and keeps only prose (`summary`, `texts`) from the persisted spec fence. Points enter the swarm's `CapStory`, ride the existing copy paths onto linked cards, and sum in the summarizer.

**Tech Stack:** swarm (Fastify + node:test), control-plane (React 19, TanStack Query, vitest, biome).

**Spec:** docs/superpowers/specs/2026-08-13-real-dashboards-design.md

## Global Constraints

- Undated/unset always visible and summed as 0 — never hide silently.
- Points: integer ≥ 0 or absent; reject anything else at the swarm.
- The ask-screen mock (`DashboardAsk`/fixture `DashboardBoard` with no `data`) stays byte-identical in behavior.
- Every commit: biome clean, affected tests green. Suite ceilings are the stabilized ones — a new flake is real.

---

### Task 1: Swarm story points

**Files:** Modify `swarm/src/capabilities.ts`, `swarm/src/work-items.ts`; Test `swarm/src/capabilities.test.ts`.

**Interfaces:** Produces `CapStory.points?: number`, card `stories[].points?: number`; `patchCapability` rejects invalid points with `Error("Story points must be a whole number ≥ 0")`.

- [x] `CapStory` + `WorkCard.stories[]` rows gain `points?: number` (doc comment: integer ≥ 0, absent = unestimated).
- [x] `patchCapability`: validate every incoming story's points (`Number.isInteger(p) && p >= 0` when present, else throw); include `points` in the story-diff touch comparison (points change stamps `updatedAt`, carry-forward otherwise).
- [x] `sendSliceToBoard` story copy adds `points: s.points`; `resyncLinkedCards`' story refresh does the same.
- [x] Tests: reject `points: -1` and `points: 1.5`; points change stamps a story while untouched neighbors carry forward; send + resync copy points onto the card rows.
- [x] Run `node --import tsx --test src/capabilities.test.ts`; commit `feat(swarm): map-authored story point estimates`.

### Task 2: Points authoring UI

**Files:** Modify `control-plane/src/api/types.ts`, `src/organisms/map/nodes.tsx`, `src/organisms/MapStage.tsx`, `src/organisms/CardSheet.tsx`, `src/styles/components.css`; Test `src/organisms/MapStage.test.tsx`, `src/organisms/CardSheet.test.tsx`.

**Interfaces:** Consumes Task 1's fields. Produces `StoryNodeData.onSetPoints(points: number | undefined)`; story badge `aria-label` = `` `Points for ${story.text}` ``.

- [x] `CapStoryT.points?: number`; card story rows in `WorkCardT` likewise.
- [x] `StoryNode`: points badge button on the meta row (`nodrag`, shows `points ?? "—"`); click swaps to an inline `<input type="number" min="0">` (`nodrag`, autoFocus); Enter commits `onSetPoints(parsed or undefined for blank)`, Escape reverts.
- [x] `MapStage`: `setPoints(story, points)` helper (wholesale stories patch, same shape as `removeStory`); inject `onSetPoints` in the decorate story branch.
- [x] `CardSheet`: per-row points — read-only text when `card.capabilityRef` (map owns), else an RHF-registered number input; sum badge beside the "Stories" head.
- [x] CSS: `.map-story__points` badge + input sizing; `.card-sheet__points`.
- [x] Tests: badge commits a PATCH whose story carries the typed points (fireStoryDrop-style through the patch mock); card-sheet linked rows have no spinbutton, hand-written rows save points; sum renders.
- [x] Run both test files; commit `feat(cp): story point estimates — map badge + card sheet`.

### Task 3: The summarizer

**Files:** Create `control-plane/src/lib/boardSummary.ts`; Test `src/lib/boardSummary.test.ts`.

**Interfaces:** Produces `summarizeBoards(boards: WorkBoardT[], scopeWorkspaces: string[] | null, bounds: RangeBounds | null, now: Date): BoardSummary` where `BoardSummary = { kpis: DashSpec["kpis"]; line: { labels: string[]; values: number[] }; bars: Array<{ label: string; value: number }>; table: NonNullable<DashSpec["table"]> }`.

- [x] Implement per spec §summarizer: scope filter (workspaceId ∈ scope, personal board always excluded), window by `updatedAt` via `inDateRange`, KPI five-pack, per-type bars (fixed order), per-day line buckets (calendar-day stepping; null bounds → last 14 days ending `now`), group-vs-single table.
- [x] Tests: fixture boards covering — scope excludes other workspaces + personal; window drops old cards but keeps undated; WIP counts non-terminal Deliver columns only; points done sums done stories and treats unset as 0; line buckets land on the right days across a month boundary; table pivots by workspace under multi-scope and by board under single.
- [x] Run; commit `feat(cp): boardSummary — live board stats lib`.

### Task 4: Hybrid dashboard rendering

**Files:** Modify `control-plane/src/lib/dashboardSpec.ts`, `src/organisms/dashboards/DashboardBoard.tsx`, `src/organisms/DashboardDocStage.tsx`, `src/router.tsx` (pass boards-scope context if needed); Test `src/lib/dashboardSpec.test.ts` (create if absent), `src/organisms/dashboards/DashboardBoard.test.tsx`, `src/organisms/DashboardDocStage.test.tsx` (create if absent).

**Interfaces:** Consumes Task 3's `summarizeBoards`. Produces `DashSpec.charts[].data?: { labels: string[]; series: Array<{ name: string; values: number[] }> }`; `parseScopeName(question: string): string | null` in `dashboardSpec.ts`.

- [x] `DashSpec` chart `data` field + all-or-nothing validation in `parseDashSpec` (malformed `data` fails the parse, like `texts`).
- [x] `parseScopeName`: last `/^scope:\s*(.+?)(?:\s+·.*)?$/m` match in the question body; returns the name token or null; "all workspaces" → null.
- [x] `DashboardBoard`: when a chart entry carries `data`, render it — line panel: series[0] filled + series[1] (optional) as ref, real max (min 1), hover tips and axis labels from `labels`, legend from series names; bars panel: columns from `data.labels`/`series[0].values`. No `data` → fixtures exactly as today. Meta row: show `scopeHint` only when given (drop the fixture "12 WEEKS/UPDATED" spans when spec-backed).
- [x] `DashboardDocStage`: `useBoards` + `useGroups` + `useRangeBounds`; scope = `parseScopeName(question)` resolved through groups (expansion) else `[name]` if it names a workspace board set, else null; build the RENDERED spec = `{ summary: fence.summary ?? "", texts: fence.texts, kpis: live.kpis, charts: [line w/ data, bars w/ data], table: live.table }`; fence stats ignored; boards query pending/absent → zeroed stats, never blank; scopeHint = `scope · formatBounds(bounds)`.
- [x] Tests: parse accepts/rejects `data`; `parseScopeName` (with range suffix, multiline, absent); DashboardBoard renders provided series values + keeps fixtures without `data`; doc stage shows live KPI numbers from seeded boards and fence `summary`/`texts` while ignoring fence kpis.
- [x] Run the four test files; commit `feat(cp): dashboards render live board summaries (hybrid)`.

### Task 5: Verify end-to-end and ship

- [x] Full CP suite green ×2 + swarm suite green; biome clean.
- [x] Restart swarm (points plumbing). Live smoke in the shared tab: set points on two map stories (badge edit); linked card shows mirrored read-only points + sum; open the saved dashboard doc — real KPIs/bars/line/table; switch date range → numbers move; texts/summary intact.
- [x] Push (ecruz165 flow); update memory (`dashboards-as-documents-shipped` addendum or new file), tick this plan's checkboxes.
