# Dashboards stage (client-side mock)

**Date:** 2026-08-10
**Status:** Approved design, ready for planning
**Source design:** claude.ai/design project "Agentic dashboard left rail", file `Dashboards Rail.dc.html` (project `55dce35a-8656-41ef-bbe0-a16d64af5121`)

## What this is

A fully client-side mock of the "agent-composed dashboards" concept, added as a
real stage in the control-plane shell. The user asks a question in plain
language, watches a fake agent compose for ~2.5s, and lands on a composed
dashboard (KPIs, charts, a risk table). Every number is hardcoded. No broker,
no queries, no persistence.

The point of building it on real rails (route + organism + data seam) is that
"make it real" later means replacing one data module with an agent-composed
payload — the shell wiring, views, and interaction all survive.

## Non-goals

- No backend, WebSocket frames, or broker endpoints of any kind.
- No persistence: "save dashboard" is in-memory only, gone on refresh.
- No new dependencies — charts are hand-rolled inline SVG, as in the design.
- No porting of the design's window-chrome, navbar, or rail mocks — the real
  shell already provides those.

## Structure & routing

New hash route `/dashboards` in `src/router.tsx` with a thin route component
(same shape as `MapRoute`). One new `Sidebar.MenuItem` in
`src/organisms/ToolRail.tsx`, placed after Map: lucide `ChartLine` icon, label
"Dashboards", `href="/dashboards"` + `isCurrent` highlight like Board/Map.

Files (option B — split organisms per view):

| File | Role |
|---|---|
| `src/organisms/DashboardsStage.tsx` | Thin stage: state machine + header row (title, `AGENT COMPOSED` badge, board-only "new question" / "save dashboard" actions). Delegates each view. |
| `src/organisms/dashboards/DashboardAsk.tsx` | Heading, scope chips, question textarea, suggestion rows, saved-dashboards grid. Stateless: data + callbacks in props. |
| `src/organisms/dashboards/DashboardComposing.tsx` | Four fake agent steps, pulsing current-step dot, progress sweep. Stateless. |
| `src/organisms/dashboards/DashboardBoard.tsx` | Answer banner, 4 KPI tiles, throughput-vs-intake area chart, cards-by-stage bars, workspace-groups table (sparklines, risk pills), follow-up chips. Stateless. |
| `src/data/dashboards.ts` | All fake constants: scopes, suggestions, saved cards, step labels, KPI tiles, week series (shipped/intake), stage bars, group rows, answer text. |
| `src/lib/dashboard-paths.ts` | Pure SVG-path helpers ported from the design: `seriesPath` (line/area over a fixed max) and `sparkPath` (normalized 100×22 sparkline). |

## State machine (DashboardsStage)

```
{ view: "ask" | "composing" | "board", query: string, scope: string, step: number }
```

- **Submit** — from the compose button, Enter in the textarea (Shift+Enter
  inserts a newline), a suggestion row, a saved card, or a follow-up chip.
  Sets `view: "composing"`, `step: 0`, and starts a 620ms interval advancing
  `step`; after the fourth step, `view: "board"`. An empty manual query falls
  back to the first suggestion (design behavior).
- **Reset** — "new question" returns to `ask` with an empty query. Scope is
  kept.
- **Save** — "save dashboard" appends `{ title: query, meta: "<SCOPE> · JUST
  SAVED" }` (scope uppercased, "all workspaces" → "ALL") to the in-memory
  saved list, so the ask screen shows it this session. No persistence, no
  dedup — saving twice lists it twice.
- **Scope chips** — single-select; the selected scope renders in the
  `SCOPE · <NAME>` hint on the ask box, the composing screen, and the board
  banner. It does not change the fake data.
- **Timer hygiene** — the interval is cleared on unmount and on re-submit
  (re-submit while composing restarts cleanly, never double-fires).

Scope list mirrors the six-board vocabulary plus the two specials:
`all workspaces, ideation, plan, deliver, release, reactive, maintenance,
personal`.

## Styling

- Classes live in `src/styles/components.css` under the existing cascade-layer
  conventions; app fonts and theme tokens only. Renders native in both light
  and dark themes.
- The design's layout, spacing rhythm, type hierarchy, and chart shapes are
  kept. Its oklch accent/risk hues become stage-local CSS variables derived
  from theme tokens; final chart colors chosen per the dataviz skill at
  implementation time.
- Not ported: Google-font imports (Space Grotesk / IBM Plex Mono), the window
  chrome, the mocked navbar and left rail.

## Data & error handling

Zero IO, so no loading/error states exist. The only lifecycle concern is
interval cleanup (above). The stage reads nothing from stores or the query
cache and registers nothing app-wide.

## Testing

- `DashboardsStage.test.tsx` (fake timers): submit → composing → board after
  four ticks; "new question" resets; re-submit mid-compose doesn't
  double-advance; save appends to the saved list and it renders back on ask.
- Subview tests: scope chip selection calls back with the picked scope;
  suggestion / saved-card / follow-up clicks call submit with their text;
  Enter submits vs Shift+Enter doesn't.
- `dashboard-paths.test.ts`: deterministic path strings for known inputs;
  sparkline normalization handles a flat series (max === min) without NaN.

## Future path (context, not scope)

When the real feature lands, `data/dashboards.ts` is replaced by an
agent-composed payload (query → broker → composed spec), `DashboardBoard`
renders from that payload unchanged, and the state machine's fake interval
becomes real progress frames. Nothing in this mock should need moving —
only replacing.
