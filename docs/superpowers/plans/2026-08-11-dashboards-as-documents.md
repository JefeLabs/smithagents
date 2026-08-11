# Dashboards as Documents Implementation Plan

> **CLAIMED:** in execution by Claude session d43af92a (inline, main checkout) since 2026-08-11. Do not execute concurrently.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A composed dashboard becomes a document — dashboard blueprint family, question+spec body, `/dashboard/$docId` canvas with a Pin toggle, SAVED = pinned docs, full shelf/session/dock-edit parity.

**Architecture:** The broker only gains a blueprint (family `"dashboard"`); everything else rides the existing documents machinery. A `DashSpec` lib (parse/compose/fence) is the diagram-source analogue; `DashboardBoard` learns to render a spec; a new `DashboardDocStage` + route present spec docs; the mock's compose walk ends by creating the doc and navigating to it (its internal board view and the v4 `dashBoardShowing` machinery retire). Pin state is spec data toggled through `patchDocSection`.

**Tech Stack:** Broker blueprints (node:test), React 19 + TanStack Router/Query, vitest.

**Spec:** `docs/superpowers/specs/2026-08-11-dashboards-as-documents-design.md`

## Global Constraints

- Family value is exactly `"dashboard"`; blueprint id `"dashboard"`, name "Dashboard", workTypes `["insight"]`, sections `question` ("Question") and `spec` ("Spec"), no starters.
- Doc born ON COMPOSE only; the launcher `/dashboards` never auto-creates.
- SAVED lists exactly the dashboard-family docs whose spec parses with `pinned === true`. Pin controls listing, never access; session attachment stays additive.
- Spec parse failure on the canvas → raw fenced JSON + error line, never blank (MermaidBlock pattern).
- Shared-checkout discipline (scoped adds, verify `[main <hash>]` + counts, co-author footer); root `pnpm lint` zero-diagnostic; cascade rule: any stage padding lives unlayered in base.css.

---

### Task 1: Broker — the dashboard blueprint family

**Files:** Modify `broker/src/blueprints.ts`; Test `broker/src/blueprints.test.ts`.

**Produces:** `Blueprint.family` type includes `"dashboard"`; `blueprints` array gains the Dashboard blueprint (shape per Global Constraints).

- [ ] Failing test (extend the existing family/sections tests in blueprints.test.ts, following their style): the list contains id `"dashboard"` with `family: "dashboard"`, workTypes `["insight"]`, section ids `["question", "spec"]`, and `instantiateSections(dashboardBp, "insight")` yields two empty-bodied sections. Run `cd broker && node --import tsx --test src/blueprints.test.ts` → FAIL.
- [ ] Implement: widen the family union to `"document" | "diagram" | "dashboard"`, append the blueprint object. Run → PASS; full `pnpm test` (broker cwd) → PASS. Commit `feat(broker): dashboard blueprint family`.

### Task 2: `lib/dashboardSpec.ts` (control plane)

**Files:** Create `control-plane/src/lib/dashboardSpec.ts`, `control-plane/src/lib/dashboardSpec.test.ts`.

**Produces:**
```ts
export interface DashSpec {
  summary: string;
  kpis: Array<{ label: string; value: string; delta?: string; tone?: "ok" | "watch" | "high" }>;
  charts: Array<{ kind: "line" | "bars"; title: string; series?: string[] }>;
  table?: { title: string; columns: string[]; rows: string[][] };
  pinned?: boolean;
}
export function parseDashSpec(body: string): DashSpec | null; // first ```json fence or bare object; null unless summary is a string and kpis/charts are arrays
export function composeSpec(question: string, scope: string): DashSpec; // serializes the mock fixtures: summary=DASH_ANSWER, kpis from DASH_KPIS (label/value/delta/tone), charts [{kind:"line",title:"shipped vs intake",series:["shipped","intake"]},{kind:"bars",title:"where work is sitting"}], table from DASH_GROUP_ROWS (title "groups — sorted by risk", columns [group,cards,wip,cycle,risk])
export function specToFence(spec: DashSpec): string; // "```json\n" + JSON.stringify(spec, null, 2) + "\n```"
```
(Import the fixture names actually exported by `data/dashboards.ts` — check `DASH_GROUP_ROWS`'s real identifier and row field names at implementation and map them faithfully.)

- [ ] Failing tests: round-trip `parseDashSpec(specToFence(composeSpec("q","all workspaces")))` deep-equals the composed spec; parse of prose-with-fence extracts; malformed JSON / missing summary / non-array kpis → null; `pinned` survives the round trip. Run targeted vitest → FAIL, implement, PASS. Commit `feat(cp): DashSpec — the dashboard document's renderable source`.

### Task 3: DashboardBoard renders a spec

**Files:** Modify `control-plane/src/organisms/dashboards/DashboardBoard.tsx`; Test `control-plane/src/organisms/dashboards/DashboardBoard.test.tsx`.

**Produces:** optional prop `spec?: DashSpec`. When present: the summary line, KPI tiles, chart titles, and table render from the spec (charts keep their existing decorative visuals; the spec supplies kind/title). When absent: exactly today's fixture rendering (the compose-walk preview keeps working until Task 5 retires it).

- [ ] Failing test: render with a two-KPI spec (distinct labels/values, one `tone:"high"`), assert both tiles + summary + the spec's chart title appear and a fixture-only KPI label does NOT. Run → FAIL, implement (spec-or-fixture selection at the top: `const kpis = spec?.kpis ?? DASH_KPIS;` etc.), PASS. Commit `feat(cp): DashboardBoard renders a DashSpec`.

### Task 4: `/dashboard/$docId` — DashboardDocStage, route, family plumbing

**Files:** Create `control-plane/src/organisms/DashboardDocStage.tsx`, `control-plane/src/organisms/DashboardDocStage.test.tsx`; Modify `control-plane/src/router.tsx` (lazy stage, `DashboardDocRoute`, route table), `control-plane/src/lib/pickKind.ts` (`openDocByFamily` third family), `control-plane/src/lib/composerLayout.ts` (`/dashboard/` → dock; kindForPath → "dashboards"), `control-plane/src/lib/composerLayout.test.ts`, `control-plane/src/router.test.tsx`, `control-plane/src/styles/dashboards.css` (title bar + fallback styles).

**Produces:**
```tsx
interface DashboardDocStageProps {
  doc: DocT;                                    // family:dashboard — question + spec sections
  onRename?: (title: string) => Promise<{ error?: string }>;
  /** Rewrites the spec section with `pinned` flipped. Resolve to refusal text or null. */
  onTogglePin?: (nextFenced: string) => Promise<{ error?: string }>;
  shelf?: ReactNode;
}
export function DashboardDocStage(props): JSX.Element
```
- Renders `<section className="stage dashboards-stage" aria-label="Dashboard">`: `{shelf}`, title bar (rename input exactly like DocumentStage's), the question section body as a subheader line, then `parseDashSpec(specBody)`:
  - spec → `<DashboardBoard spec={spec} query={doc.title} scopeHint="" onFollowup={() => {}} />` plus a `Pin`/`Pinned` toggle button (`aria-pressed={Boolean(spec.pinned)}`) that calls `onTogglePin(specToFence({ ...spec, pinned: !spec.pinned }))`.
  - null → `<pre className="dashboard-doc__raw">` with the raw body and a "spec didn't parse — showing source" status line.
- Router: `DashboardDocRoute` mirrors DiagramRoute (family gate: non-dashboard docs redirect to `openDocByFamily`'s target; pending queries return null), wires `onRename`/`onTogglePin` to `api.patchDocTitle` / `api.patchDocSection(doc.id, "spec", nextFenced)`, passes `useShelf()`.
- `layoutForPath`: `pathname.startsWith("/dashboard/")` joins the dock list (NOTE: test it doesn't shadow `/dashboards` — check the prefix ordering: `/dashboards` === exact match runs first).
- `.stage.dashboards-stage` already reserves via `body[data-dock="dock"]` — no CSS boundary work.

- [ ] Failing tests: stage renders spec KPIs + Pin toggle (aria-pressed false → click → onTogglePin called with fence containing `"pinned": true`); parse-failure fallback shows raw + status; composerLayout `/dashboard/d1` → dock + kind "dashboards" (and `/dashboards` still center); router test: a dashboard-family doc at `/dashboard/d1` renders region "Dashboard", a prose doc redirects to `/doc/d1`. Run → FAIL, implement, PASS. Commit `feat(cp): /dashboard/$docId — the dashboard document canvas with Pin`.

### Task 5: Birth on compose; SAVED = pinned; retire the internal board view + v4 machinery

**Files:** Modify `control-plane/src/organisms/DashboardsStage.tsx` (drop view "board" + `dashBoardShowing` mirror; compose walk completion calls `onPresent(question, scope)`; new props `onPresent?`, `savedDocs?: Array<{ id: string; title: string; meta: string }>` passed to DashboardAsk), `control-plane/src/organisms/dashboards/DashboardAsk.tsx` (saved list renders `savedDocs` prop instead of `DASH_SAVED`; `onOpenSaved?: (docId: string) => void`), `control-plane/src/router.tsx` (DashboardsRoute: wire `onPresent` = `postDocument("dashboard", question)` → `patchDocSection(docId, "question", `${question}\n\nscope: ${scope}`)` → `patchDocSection(docId, "spec", specToFence(composeSpec(question, scope)))` → `navigate({ to: "/dashboard/$docId", params: { docId } })`; `savedDocs` = dashboard-family docs whose parsed spec is pinned, meta from `updatedAt`; `onOpenSaved` navigates), `control-plane/src/stores/uiStore.ts` + test (remove `dashBoardShowing`/`setDashBoardShowing`), `control-plane/src/pages/HomePage.tsx` + test (drop the dashboards dock override — `dockVariant = pathname === "/dashboards" && messages.length > 0 ? "dock" : layoutForPath(pathname)` keeps ONLY the v5 thread rule), affected tests (DashboardsStage board-view tests rewritten to assert `onPresent` fires with question+scope after the walk; DashboardAsk saved-list tests use the prop).

- [ ] Tests first (rewrites listed above) → FAIL, implement, PASS (full cp suite — the removed store field will surface every stale reference). Commit `feat(cp): composed dashboards become documents; SAVED lists the pinned ones`.

### Task 6: Doc-context sends cover /dashboard/

**Files:** Modify `control-plane/src/pages/HomePage.tsx` (the onSend docId regex becomes `/^\/(?:doc|diagram|dashboard)\/([^/]+)$/`); Test `control-plane/src/pages/HomePage.test.tsx` (a send from `/dashboard/d1` carries `doc: { docId: "d1" }` — seed a dashboard-family doc + blueprint, mirror the existing /doc send test).

- [ ] Test → FAIL, implement, PASS. Commit `feat(cp): dock sends edit the dashboard on screen`.

### Task 7: Verification, live smoke, restart, ship

- [ ] Root `pnpm test` / `pnpm lint` / `pnpm typecheck` all clean (exit codes via redirect).
- [ ] Restart the broker (tmux `smith-broker`, C-c + relaunch) — the new blueprint must serve.
- [ ] Live smoke: launcher → TRY suggestion → compose walk → lands on `/dashboard/$docId` with the rendered spec + shelf tile; Pin it → appears under SAVED on the launcher; dock send "make the summary one sentence" → spec updates + re-render; reopen from SAVED. Screenshot each and LOOK.
- [ ] Spec status → SHIPPED, memory file + MEMORY.md, push (ecruz165 dance).
