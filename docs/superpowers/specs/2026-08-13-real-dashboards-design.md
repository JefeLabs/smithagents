# Phase-2 Real Dashboards — Design

**Date:** 2026-08-13 · **Approved:** Edwin (chat) · **Prior art:** 2026-08-11 dashboards-as-documents, 2026-08-12 date-range-context

Edwin's frame: "dashboards should be a summary of the boards which are scoped by the boards and the date range." Both scoping dimensions (group lens, date-range window) exist and are live on every surface. This phase replaces the mock's canned numbers with real ones.

## Decisions (Edwin, 2026-08-13)

1. **Hybrid compute.** Stats widgets (KPIs, charts, table) compute **live, client-side** from the boards data already in the app, scoped by the dashboard's scope × the *current* date range, on every render. The `summary` line and `texts` cards stay **persisted prose** in the doc's spec fence — chat/agent-written, editable by dock-sends when API credits exist.
2. **Widgets v1:** KPI row, bars (where work sits), line (activity over the window), table (per-workspace under a group scope, per-board for a single workspace) — **plus story point estimates**.
3. **Story points:** map-authored (`CapStory.points`), cards mirror read-only; hand-written card stories editable in the card sheet. Scale: free small integer ≥ 0; unset = unestimated (rendered as "—", summed as 0).
4. **Existing mock docs re-render live.** Question/scope/texts survive; fixture numbers stop existing. No migration.

## Data model

- Swarm `CapStory` gains `points?: number` (integer ≥ 0). `patchCapability` validates it and treats a points change as a touch (stamps the story's `updatedAt` — consistent with date-range windowing). `sendSliceToBoard` and `resyncLinkedCards` copy `points` onto linked-card story rows alongside `text`. `applyStoryToggles` never reads points from cards (toggle-only stays toggle-only).
- Swarm `WorkCard.stories[]` rows gain `points?: number` (typed; the existing wholesale stories PATCH already round-trips unknown fields for hand-written rows).
- CP `CapStoryT` / card-story rows mirror the field.

## Authoring UI

- **Map story node:** a points badge on the meta row ("—" when unset, `nodrag`). Clicking opens an inline number input on the node; Enter commits via the normal wholesale stories patch, Escape cancels.
- **Card sheet:** each checklist row shows its points; the header shows the sum (unset rows count 0 and display "—"). Rows on a capability-linked card are read-only (the map owns them); hand-written rows get a small number input saved with the existing form.

## The summarizer — `control-plane/src/lib/boardSummary.ts`

Pure: `summarizeBoards(boards, scopeWorkspaces, bounds, now)` → `{ kpis, line, bars, table }`.

- **Scope:** `scopeWorkspaces: string[] | null` — null means all workspaces (the personal board is always excluded). Boards resolve by their `workspaceId`.
- **Window:** cards count as "in window" by `updatedAt` (`inDateRange`; undated always in — the standing rule). `bounds: RangeBounds | null`, null = no window.
- **KPIs:** touched (cards in window), released (cards on the Release board in window), WIP now (Deliver board cards in non-terminal columns — terminal = last column), flagged now (blocked/at-risk/waiting), points done (sum of `points` over `done` stories on in-scope, in-window cards).
- **Bars:** in-window card counts per board type, fixed order Ideate/Plan/Deliver/React/Maintain/Release.
- **Line:** cards touched per day across the window (calendar-day buckets, DST-safe day arithmetic like `dateRange.ts`); no window → last 14 days ending `now`.
- **Table:** group scope → one row per member workspace (`workspace, open, wip, flagged, released, points done`); single workspace → same columns per board.

## Rendering (hybrid)

- `DashSpec.charts[]` gains optional `data?: { labels: string[]; series: Array<{ name: string; values: number[] }> }`. `parseDashSpec` validates it when present (all-or-nothing, like `texts`).
- `DashboardBoard` renders real series when `data` is present — line panel: first series filled + second as reference line, axis labels from `labels`, hover tooltip from real values, shared max from the data; bars panel: label/value columns. Without `data` it keeps the decorative fixtures (the ask-screen mock is unchanged).
- `DashboardDocStage` becomes the hybrid: it reads boards (`useBoards`), groups, and `useRangeBounds`, resolves the doc's scope, computes `summarizeBoards`, and renders a spec whose **stats fields are the live computation** and whose `summary`/`texts` come from the persisted fence. The fence's kpis/charts/table are ignored on doc canvases. The stage passes a real "as of" scope hint (`scope · resolved window`) instead of the fixture "12 WEEKS / UPDATED 2 MIN AGO" copy.
- **Scope resolution:** the composer writes `scope: <name> · <range>` into the question section. The stage parses the LAST `scope:` line's name token: a group name resolves to its expansion (live, so membership edits follow), "all workspaces" or no match → null (all). Parser lives in `dashboardSpec.ts` (`parseScopeName`).

## Error handling

- Boards query unavailable → stats render zeroed with the summary line intact (never blank, never crash).
- Unparseable spec fence still shows the raw-source fallback, but stats render regardless — the fence only carries prose now.

## Testing

- `boardSummary` pure tests: window edges, scope filtering, group vs single table, points sums with unset points, day buckets.
- Swarm: points validation (reject non-integer/negative), points change stamps `updatedAt`, send/resync copy points, toggles preserve canonical points.
- UI: story-node badge edit commits a wholesale patch; card-sheet read-only vs editable rows and sum; doc stage renders live numbers over fence numbers; `parseDashSpec` accepts/rejects `data` shapes; `parseScopeName` cases.

## Out of scope

Agent-composed prose stays as-is (dock-edit path already exists; dead until credits). Sprint-velocity-per-sprint charts, intake-vs-shipped split via `routedFrom`, and follow-up chips wiring are later phases.
