# Dashboards as Documents Implementation Plan

> **EXECUTED:** shipped to main @ 39ea7af on 2026-08-11 (session d43af92a). All nine tasks landed; see the spec's Status line.

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

### Task 4: Broker — doc pins + session-context seeding (pin model v2)

**Files:** Modify `broker/src/documents.ts` (Doc.pins?: string[]; idempotent `pin(docId, target): Doc | null` / `unpin(docId, target): Doc | null`), `broker/src/text-channel.ts` (documents seam gains `pin(docId, target): string | null` / `unpin(docId, target): string | null`; routes `POST /documents/:id/pins` `{target}` and `DELETE /documents/:id/pins/:target`, originBlocked, null→200/string→404 like proposals), `broker/src/main.ts` (adapter entries broadcasting documentsFrame; POST /sessions path: after create in workspace W, attach every doc whose pins include W via the same addArtifact path and broadcast session+documents frames); Tests `broker/src/documents.test.ts`, `broker/src/text-channel.test.ts`.

- [ ] Failing tests: pin/unpin round-trip + idempotence + unknown doc → null (documents.test); pin routes 200/404 + seam args (text-channel.test, stubbed seam). Session seeding is main.ts wiring — covered by the live smoke (repo convention). Run → FAIL, implement, PASS. Commit `feat(broker): doc pins target a workspace; new sessions inherit pinned docs`.

### Task 5: CP pin plumbing — PinButton, shelf marker, api helpers

**Files:** Modify `control-plane/src/api/types.ts` (DocT.pins?: string[]), `control-plane/src/api/broker.ts` (`pinDoc(docId, target)` / `unpinDoc(docId, target)` → error-string-or-null, POST/DELETE per Task 4 routes), Create `control-plane/src/molecules/PinButton.tsx` (+test) — `{ pins?: string[]; workspace?: string; onPin: (target: string) => Promise<string | null>; onUnpin: (target: string) => Promise<string | null> }`, renders nothing without `workspace`, else aria-pressed toggle "Pin to <workspace>"/"Pinned to <workspace>"; Modify `control-plane/src/molecules/ArtifactShelf.tsx` (+test) — tiles with `doc.pins?.length` get `artifact-shelf__card--pinned` + a pin dot span, `control-plane/src/styles/documents.css` (dot + tinted edge), `control-plane/src/organisms/DocumentStage.tsx` + `DiagramStage.tsx` (+tests) — optional `pinControl?: ReactNode` slot in the title bar, `control-plane/src/router.tsx` — DocRoute/DiagramRoute build `<PinButton pins={doc.pins} workspace={session?.workspace} onPin/onUnpin={api helpers}>`.

- [ ] Failing tests per file (PinButton toggle callbacks + hidden-without-workspace; shelf marker class; stages render the pinControl slot). Run → FAIL, implement, PASS. Commit `feat(cp): pin any doc to a workspace — PinButton on the canvases, marked shelf tiles`.

### Task 6: `/dashboard/$docId` — DashboardDocStage, route, family plumbing

**Files:** Create `control-plane/src/organisms/DashboardDocStage.tsx`, `control-plane/src/organisms/DashboardDocStage.test.tsx`; Modify `control-plane/src/router.tsx` (lazy stage, `DashboardDocRoute`, route table), `control-plane/src/lib/pickKind.ts` (`openDocByFamily` third family), `control-plane/src/lib/composerLayout.ts` (`/dashboard/` → dock; kindForPath → "dashboards"), `control-plane/src/lib/composerLayout.test.ts`, `control-plane/src/router.test.tsx`, `control-plane/src/styles/dashboards.css` (title bar + fallback styles).

**Produces:**
```tsx
interface DashboardDocStageProps {
  doc: DocT;                                    // family:dashboard — question + spec sections
  onRename?: (title: string) => Promise<{ error?: string }>;
  pinControl?: ReactNode;
  shelf?: ReactNode;
}
export function DashboardDocStage(props): JSX.Element
```
- Renders `<section className="stage dashboards-stage" aria-label="Dashboard">`: `{shelf}`, title bar (rename input exactly like DocumentStage's), the question section body as a subheader line, then `parseDashSpec(specBody)`:
  - spec → `<DashboardBoard spec={spec} query={doc.title} scopeHint="" onFollowup={() => {}} />`; the title bar hosts the shared `pinControl` slot (PinButton from Task 5 — pins are doc-level, not spec data).
  - null → `<pre className="dashboard-doc__raw">` with the raw body and a "spec didn't parse — showing source" status line.
- Router: `DashboardDocRoute` mirrors DiagramRoute (family gate: non-dashboard docs redirect; pending queries return null), wires `onRename` → `api.patchDocTitle`, `pinControl` → PinButton, passes `useShelf()`.
- `layoutForPath`: `pathname.startsWith("/dashboard/")` joins the dock list (NOTE: test it doesn't shadow `/dashboards` — check the prefix ordering: `/dashboards` === exact match runs first).
- `.stage.dashboards-stage` already reserves via `body[data-dock="dock"]` — no CSS boundary work.

- [ ] Failing tests: stage renders spec KPIs + the pinControl slot; parse-failure fallback shows raw + status; composerLayout `/dashboard/d1` → dock + kind "dashboards" (and `/dashboards` still center); router test: a dashboard-family doc at `/dashboard/d1` renders region "Dashboard", a prose doc redirects to `/doc/d1`. Run → FAIL, implement, PASS. Commit `feat(cp): /dashboard/$docId — the dashboard document canvas with Pin`.

### Task 7: Birth on compose; SAVED = pinned docs; retire the internal board view + v4 machinery

**Files:** Modify `control-plane/src/organisms/DashboardsStage.tsx` (drop view "board" + `dashBoardShowing` mirror; compose walk completion calls `onPresent(question, scope)`; new props `onPresent?`, `savedDocs?: Array<{ id: string; title: string; meta: string }>` passed to DashboardAsk), `control-plane/src/organisms/dashboards/DashboardAsk.tsx` (saved list renders `savedDocs` prop instead of `DASH_SAVED`; `onOpenSaved?: (docId: string) => void`), `control-plane/src/router.tsx` (DashboardsRoute: wire `onPresent` = `postDocument("dashboard", question)` → `patchDocSection(docId, "question", `${question}\n\nscope: ${scope}`)` → `patchDocSection(docId, "spec", specToFence(composeSpec(question, scope)))` → `navigate({ to: "/dashboard/$docId", params: { docId } })`; `savedDocs` = dashboard-family docs with `pins?.length` (meta from `updatedAt` + pin targets); `onOpenSaved` navigates), `control-plane/src/stores/uiStore.ts` + test (remove `dashBoardShowing`/`setDashBoardShowing`), `control-plane/src/pages/HomePage.tsx` + test (drop the dashboards dock override — `dockVariant = pathname === "/dashboards" && messages.length > 0 ? "dock" : layoutForPath(pathname)` keeps ONLY the v5 thread rule), affected tests (DashboardsStage board-view tests rewritten to assert `onPresent` fires with question+scope after the walk; DashboardAsk saved-list tests use the prop).

- [ ] Tests first (rewrites listed above) → FAIL, implement, PASS (full cp suite — the removed store field will surface every stale reference). Commit `feat(cp): composed dashboards become documents; SAVED lists the pinned ones`.

### Task 8: Doc-context sends cover /dashboard/

**Files:** Modify `control-plane/src/pages/HomePage.tsx` (the onSend docId regex becomes `/^\/(?:doc|diagram|dashboard)\/([^/]+)$/`); Test `control-plane/src/pages/HomePage.test.tsx` (a send from `/dashboard/d1` carries `doc: { docId: "d1" }` — seed a dashboard-family doc + blueprint, mirror the existing /doc send test).

- [ ] Test → FAIL, implement, PASS. Commit `feat(cp): dock sends edit the dashboard on screen`.

### Task 9: Verification, live smoke, restart, ship

- [ ] Root `pnpm test` / `pnpm lint` / `pnpm typecheck` all clean (exit codes via redirect).
- [ ] Restart the broker (tmux `smith-broker`, C-c + relaunch) — the new blueprint must serve.
- [ ] Live smoke: launcher → TRY → compose → `/dashboard/$docId` renders + shelf tile; Pin to the active workspace → SAVED lists it; NEW session in that workspace opens with the doc attached (seeding); dock send "make the summary one sentence" → spec updates; reopen from SAVED. Screenshot and LOOK.
- [ ] Spec status → SHIPPED, memory file + MEMORY.md, push (ecruz165 dance).
