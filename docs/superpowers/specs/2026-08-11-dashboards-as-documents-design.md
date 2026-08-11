# Dashboards as documents — Design

**Date:** 2026-08-11
**Status:** Approved by Edwin (question+spec body; doc born on compose; full documents parity)

## Problem

A presented dashboard is a work product, but today it is client-side mock
state: no identity, no persistence, no shelf tile, no session attachment,
no chat-driven editing. Edwin's direction: "Dashboard presented should be
treated like a document like diagrams and documents."

## Decisions (Edwin, 2026-08-11)

1. **Body = question + spec**: section `question` records the ask and
   scope (recomposable intent); section `spec` holds fenced JSON the
   canvas renders — the diagram pattern (source of truth in a section).
2. **Born on compose**: `/dashboards` stays the launcher; the moment a
   dashboard is composed/presented it becomes a doc and the URL moves to
   its route. Asks that never compose leave nothing behind.

## Design

### Broker

- `blueprints.ts`: family value `"dashboard"` joins `document | diagram`;
  one blueprint `{ id: "dashboard", name: "Dashboard", family:
  "dashboard", workTypes: ["insight"], sections: [ { id: "question",
  heading: "Question" }, { id: "spec", heading: "Spec" } ] }`. No
  starters — the compose flow writes both sections.
- Nothing else broker-side changes: documents.create/patchSection, the
  documents frame, proposals, and the edit turn already treat it as a doc.

### Spec schema v1 (control plane, `lib/dashboardSpec.ts`)

```ts
interface DashSpec {
  summary: string;
  kpis: Array<{ label: string; value: string; delta?: string; tone?: "ok" | "watch" | "high" }>;
  charts: Array<{ kind: "line" | "bars"; title: string; series?: string[] }>;
  table?: { title: string; columns: string[]; rows: string[][] };
}
```

- `parseDashSpec(body: string): DashSpec | null` — first fenced ```json
  block (or bare object), null on parse/shape failure.
- `composeSpec(question: string, scope: string): DashSpec` — serializes
  the mock's current fixtures (`data/dashboards.ts`) into the schema; the
  real composition backend later writes better specs into the same shape.
- `specToFence(spec: DashSpec): string`.

### Compose → doc (the birth)

- `DashboardsStage` gains `onPresent?: (question: string, scope: string)
  => void`; when the mock compose walk completes, it calls `onPresent`
  INSTEAD of switching to its internal board view (board view + "save
  dashboard" retire; `dashBoardShowing` mirror and its uiStore flag are
  removed — the launcher is always center, presented dashboards are doc
  canvases).
- `DashboardsRoute` wires `onPresent`: `postDocument("dashboard",
  question)` (title from the question; the send-is-the-commit path
  already broadcasts the ask into the room) → `patchDocSection(docId,
  "spec", specToFence(composeSpec(question, scope)))` → `patchDocSection(
  docId, "question", `${question}\n\nscope: ${scope}`)` → navigate
  `/dashboard/$docId`.

### The dashboard doc canvas

- New route `/dashboard/$docId` (+ lazy `DashboardDocStage`): family
  gate like DiagramRoute (non-dashboard docs redirect to their own
  canvas). Renders: doc title bar (rename like DocumentStage), the
  question section as the subheader, and the parsed spec through the
  existing presentation components (`DashboardBoard`'s KPI/chart/table
  pieces refactored to accept a `DashSpec` instead of reading fixtures).
  Parse failure → raw fenced JSON + error line (MermaidBlock pattern).
- `layoutForPath`: `/dashboard/` prefix → `"dock"`. `kindForPath` →
  `"dashboards"`. `isKindSurface` unchanged (non-hidden).
- `openDocByFamily`: family `"dashboard"` → `/dashboard/$docId`.
- Doc-context sends: HomePage's docId regex gains the `/dashboard/`
  prefix — the edit turn rewrites the spec JSON (host direct-apply, live
  re-render via the documents frame). Aim UI: none (spec is effectively
  the one target).
- Shelf: automatic (docs are docs); tile tag shows `dashboard`.
- SAVED on the launcher: `DashboardAsk`'s saved list switches from
  `DASH_SAVED` fixtures to dashboard-family docs (wired by the route from
  `useDocuments` + blueprints); clicking one opens its doc route.

### Dock variant cleanup

- The v4 `dashBoardShowing` store flag, its DashboardsStage mirror, the
  `dashboards-stage--docked` modifier, and HomePage's dashboards override
  are removed. `/dashboards` = center (launcher); `/dashboard/$docId` =
  dock like every canvas. The v5 thread rule ("center only in the fresh
  state") stays for the launcher. The `body[data-dock]` stamp stays (the
  launcher's ask view still reserves when thread-docked).

### Testing

- lib: parse/compose/fence round-trip, malformed spec → null.
- Broker: blueprint family test extends (three families; dashboard
  sections listed).
- Stage: DashboardDocStage renders KPIs/charts/table from a spec doc,
  raw-JSON fallback on parse failure; DashboardsStage compose completion
  calls onPresent (board view gone).
- Route: /dashboard family gate + redirect, openDocByFamily third family,
  layoutForPath/kindForPath additions, saved-list wiring.
- HomePage: doc-context regex covers /dashboard/; the removed dashboards
  variant override's tests replaced by launcher-center + doc-dock cases.
- Live smoke: compose from the launcher → doc route + shelf tile; dock
  send "change the summary" → spec updates + canvas re-renders; reopen
  from SAVED.

## Out of scope

- Sticky-note proposals rendered on the dashboard canvas (machinery
  works; the surface joins later).
- Real data composition (the mock's fixtures remain the "agent").
- Spec-section aiming, chart-level targeting.
- Migrating the mock's DASH_SAVED fixtures (they simply stop rendering).
