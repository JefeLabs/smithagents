# Artifact Launcher — Plan 2: Mermaid Diagram Canvas

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Claimed by:** session 9af857dc (inline, worktree `.claude/worktrees/diagram-canvas` @ `feat/diagram-canvas`, off origin/main 6a862ac, 2026-08-11)

**Goal:** Make the `Diagrams` kind real: a diagram is a `family: "diagram"` document whose section body is Mermaid text, opened on a `DiagramStage` canvas (rendered Mermaid + a source panel + a same-family type switch) at `/diagram/$docId`, created with a starter diagram from the `er`/`sequence` blueprints.

**Architecture:** Diagrams reuse the document store/model — no new backend. A blueprint section gains an optional `starter` so a diagram opens with renderable Mermaid. A `MermaidBlock` compiles Mermaid → SVG (fallback to source+error on a parse failure). `DiagramStage` renders the diagram doc's first section body through `MermaidBlock`, with a `<textarea>` source panel saving via `onSaveSection`. The kind row + shelf route `family: "diagram"` docs to `/diagram/$docId` instead of `/doc/$docId`. Chat dock + full-screen are Plan 3.

**Tech Stack:** React 19 + TanStack Router/Query, `mermaid` (new dep), **pnpm workspace at root** (broker/control-plane/swarm/voice), vitest + node:test, biome 2.5.3.

## Global Constraints

- **Repo:** paths relative to the **smithagents** repo root; execute in the existing worktree `.claude/worktrees/diagram-canvas` (branch `feat/diagram-canvas`, off `origin/main`). `git -C`. **`develop` is deleted — main is the only branch;** merge at the end via push-fast-forward to `main` (`git push origin HEAD:main` under the `ecruz165` account), never in the shared checkout (the control-plane is live in `smith-cp-dev`).
- **Unified pnpm workspace:** install once at root: `pnpm install`. Per-package tests from the package dir: `cd control-plane && pnpm test` (vitest), `cd broker && pnpm test` (node:test glob). Typecheck `pnpm exec tsc --noEmit`. Lint `pnpm lint` (biome 2.5.3; exit 0 is clean — a non-zero exit is your own regression).
- **HeroUI compound API is verified via the heroui-pro MCP before use — LAW.** `onPress` not `onClick` for HeroUI controls.
- **Depends on Plan 1** (shipped @ main): `Blueprint.family`, `BlueprintT.family`, `lib/artifactKinds.ts` (`familyForKind`), `makePickKind` in `router.tsx`, `ArtifactShelf`.
- Spec: `docs/superpowers/specs/2026-08-11-composer-artifact-launcher-design.md` §§1–2, 5–6 and the kind table.

---

### Task 1: Blueprint `starter` + `er`/`sequence` diagram blueprints (broker)

**Files:**
- Modify: `broker/src/blueprints.ts` (`BlueprintSection` interface; `instantiateSections`; `DEFAULT_BLUEPRINTS`)
- Test: `broker/src/blueprints.test.ts` (append)

**Interfaces:**
- Produces: `BlueprintSection.starter?: string`; `instantiateSections` seeds `body: s.starter ?? ""`. Two `family: "diagram"` blueprints: `er` (name "Database design") and `sequence` (name "Sequence diagram"), each a single section (`id: "diagram"`, `heading: "Diagram"`) whose `starter` is a fenced Mermaid block.

- [ ] **Step 1: Write the failing test**
```ts
// append to broker/src/blueprints.test.ts
test('diagram blueprints carry family=diagram and a Mermaid starter that seeds the section body', () => {
  const bps = loadBlueprints(join(tmpdir(), 'no-such-dir'));
  const er = bps.find((b) => b.id === 'er');
  const seq = bps.find((b) => b.id === 'sequence');
  assert.equal(er?.family, 'diagram');
  assert.equal(seq?.family, 'diagram');
  // The starter seeds the instantiated body (not empty), so a diagram opens renderable.
  const secs = instantiateSections(er!, er!.workTypes[0]!);
  assert.ok(secs && secs[0]!.body.includes('erDiagram'));
});
```
- [ ] **Step 2: Run to verify fail** — `cd broker && node --import tsx --test src/blueprints.test.ts` → FAIL (no `er`/`sequence`; body empty).
- [ ] **Step 3: Implement.** Add `starter?: string;` to `BlueprintSection`. In `instantiateSections`, change the map to `({ id: s.id, heading: s.heading, body: s.starter ?? "" })`. Append to `DEFAULT_BLUEPRINTS`:
```ts
  {
    id: 'er',
    name: 'Database design',
    family: 'diagram',
    workTypes: ['feature', 'bugfix', 'integration'],
    sections: [
      {
        id: 'diagram',
        heading: 'Diagram',
        hint: 'A Mermaid entity-relationship diagram.',
        starter: '```mermaid\nerDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER ||--|{ LINE_ITEM : contains\n```',
      },
    ],
  },
  {
    id: 'sequence',
    name: 'Sequence diagram',
    family: 'diagram',
    workTypes: ['feature', 'bugfix', 'integration'],
    sections: [
      {
        id: 'diagram',
        heading: 'Diagram',
        hint: 'A Mermaid sequence diagram.',
        starter: '```mermaid\nsequenceDiagram\n  Client->>Server: request\n  Server-->>Client: response\n```',
      },
    ],
  },
```
- [ ] **Step 4: Run to verify pass** — the new test passes; `cd broker && pnpm test` whole suite green; `pnpm exec tsc --noEmit` clean (the existing `instantiateSections` test asserts `body: ''` for a blueprint with no starter — still true, so it stays green).
- [ ] **Step 5: Commit** — `git add broker/src/blueprints.ts broker/src/blueprints.test.ts && git commit -m "feat(broker): starter bodies + er/sequence diagram blueprints"`

---

### Task 2: `MermaidBlock` — render Mermaid text, fallback on error

**Files:**
- Modify: `control-plane/package.json` (add `mermaid`)
- Create: `control-plane/src/molecules/MermaidBlock.tsx`, `control-plane/src/molecules/MermaidBlock.test.tsx`

**Interfaces (later tasks rely on these):**
```ts
export function MermaidBlock({ code }: { code: string }): JSX.Element;
// strips a leading ```mermaid fence if present; renders the SVG; on a
// mermaid.render throw, renders <pre class="mermaid-block__error"> with the
// raw code + the error message (never blank).
export function stripMermaidFence(code: string): string; // exported for the test
```

- [ ] **Step 1: `cd control-plane && pnpm add mermaid`** — confirm it lands in dependencies.
- [ ] **Step 2: Write the failing tests** (mock mermaid — jsdom can't lay out SVG)
```tsx
// control-plane/src/molecules/MermaidBlock.test.tsx
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: (...a: unknown[]) => renderMock(...a) },
}));

import { MermaidBlock, stripMermaidFence } from "./MermaidBlock";

afterEach(() => vi.clearAllMocks());

describe("MermaidBlock", () => {
  it("strips a ```mermaid fence", () => {
    expect(stripMermaidFence("```mermaid\nerDiagram\n```")).toBe("erDiagram");
    expect(stripMermaidFence("sequenceDiagram\n A->>B: x")).toBe("sequenceDiagram\n A->>B: x");
  });
  it("renders the compiled SVG", async () => {
    renderMock.mockResolvedValue({ svg: "<svg data-testid='diagram'></svg>" });
    render(<MermaidBlock code="```mermaid\nerDiagram\n```" />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(renderMock).toHaveBeenCalledWith(expect.any(String), "erDiagram");
  });
  it("shows the source + error when Mermaid throws (never blank)", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    render(<MermaidBlock code="not a diagram" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Parse error/));
    expect(screen.getByText(/not a diagram/)).toBeInTheDocument();
  });
});
```
- [ ] **Step 3: Run to verify fail** — `pnpm exec vitest run src/molecules/MermaidBlock.test.tsx` → FAIL (module missing).
- [ ] **Step 4: Implement `MermaidBlock.tsx`.** `stripMermaidFence`: if the text starts with ```` ```mermaid ```` strip the fence lines and trailing ```` ``` ````, else return trimmed text. Component: `useEffect` on `code` → `mermaid.initialize({ startOnLoad: false })` once + `await mermaid.render(uniqueId, stripMermaidFence(code))` → on success `setSvg(svg)`, on throw `setError(String(err))`. Render: `error` → `<pre role="alert" className="mermaid-block__error">{message}\n\n{code}</pre>`; else a `<div className="mermaid-block" dangerouslySetInnerHTML={{ __html: svg }} />`. Generate the render id without `Math.random` (banned in some contexts, and stable-per-mount is fine) — use a module counter `let seq = 0; const id = useMemo(() => \`mmd-${seq++}\`, [])`.
- [ ] **Step 5: Run to verify pass** — 3 tests PASS; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 6: Commit** — `git add control-plane/src/molecules/MermaidBlock.tsx control-plane/src/molecules/MermaidBlock.test.tsx control-plane/package.json ../pnpm-lock.yaml && git commit -m "feat(cp): MermaidBlock — render mermaid, fallback to source+error"`

---

### Task 3: `DiagramStage` organism (canvas + source + type switch)

**Files:**
- Create: `control-plane/src/organisms/DiagramStage.tsx`, `control-plane/src/organisms/DiagramStage.test.tsx`
- Test uses the `matchMedia`/localStorage setup already in `src/test/setup.ts`.

**Interfaces:**
- Consumes: `MermaidBlock` (Task 2); `DocT`, `BlueprintT` (`api/types`).
- Produces:
```ts
export interface DiagramStageProps {
  doc: DocT;                                   // a family:diagram document
  blueprints?: BlueprintT[];                   // already filtered to family:diagram by the route
  onChangeBlueprint?: (blueprintId: string) => Promise<{ error?: string }>;
  onSaveSection: (sectionId: string, body: string) => Promise<{ error?: string }>;
}
export function DiagramStage(props: DiagramStageProps): JSX.Element;
```
Renders `<section className="stage diagram-stage" aria-label="Diagram">`: the diagram's first section body through `MermaidBlock` (the canvas), a `<textarea aria-label="Mermaid source">` bound to that section's body that saves on blur/debounce via `onSaveSection`, and the same type-switch markup `DocumentStage` uses (a `role="group" aria-label="diagram type"` of `blueprints` buttons re-casting via `onChangeBlueprint`, locked once the body is non-empty — mirror `DocumentStage.tsx:99-120`).

- [ ] **Step 1: Write the failing tests**
```tsx
// control-plane/src/organisms/DiagramStage.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../molecules/MermaidBlock", () => ({ MermaidBlock: ({ code }: { code: string }) => <div data-testid="mermaid">{code}</div> }));
import { DiagramStage } from "./DiagramStage";

const DOC = {
  id: "d1", title: "ER", blueprintId: "er", workType: "feature", status: "drafting" as const,
  participants: [], createdAt: "", updatedAt: "", artifacts: [],
  sections: [{ id: "diagram", heading: "Diagram", body: "erDiagram\n A ||--o{ B : has" }],
};
const BPS = [
  { id: "er", name: "Database design", family: "diagram" as const, workTypes: ["feature"] },
  { id: "sequence", name: "Sequence diagram", family: "diagram" as const, workTypes: ["feature"] },
];
afterEach(() => vi.clearAllMocks());

describe("DiagramStage", () => {
  it("renders the section body through MermaidBlock", () => {
    render(<DiagramStage doc={DOC} blueprints={BPS} onSaveSection={vi.fn().mockResolvedValue({})} />);
    expect(screen.getByTestId("mermaid")).toHaveTextContent("erDiagram");
  });
  it("editing the source saves the section body", async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render(<DiagramStage doc={DOC} blueprints={BPS} onSaveSection={onSave} />);
    const src = screen.getByRole("textbox", { name: /mermaid source/i });
    await userEvent.clear(src);
    await userEvent.type(src, "sequenceDiagram");
    await userEvent.tab(); // blur commits
    expect(onSave).toHaveBeenCalledWith("diagram", "sequenceDiagram");
  });
  it("the type switch lists only diagram blueprints", () => {
    render(<DiagramStage doc={DOC} blueprints={BPS} onChangeBlueprint={vi.fn()} onSaveSection={vi.fn()} />);
    const group = screen.getByRole("group", { name: /diagram type/i });
    expect(within(group).getByRole("button", { name: "Database design" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Sequence diagram" })).toBeInTheDocument();
  });
});
```
(add `within` to the testing-library import.)
- [ ] **Step 2: Run to verify fail** — `pnpm exec vitest run src/organisms/DiagramStage.test.tsx` → FAIL (module missing).
- [ ] **Step 3: Implement `DiagramStage.tsx`.** One `section` (the diagram doc), `locked = body.trim() !== ""`. Local `source` state seeded from `doc.sections[0]?.body ?? ""`; a `<textarea>` updates it and on blur (or a 600ms debounce) calls `onSaveSection(section.id, source)` and surfaces `r.error` inline. `<MermaidBlock code={source} />` for the canvas. The type switch: copy `DocumentStage.tsx:99-120`'s block, renaming aria-label to `diagram type` and classes to `diagram-stage__type*`.
- [ ] **Step 4: Run to verify pass** — 3 tests PASS; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Add minimal CSS** for `.diagram-stage` (full-bleed canvas + a source panel) in `src/styles/components.css` — a flex column: canvas grows, source panel fixed height at the bottom. Keep it simple; Plan 3 adds the chrome.
- [ ] **Step 6: Commit** — `git add control-plane/src/organisms/DiagramStage.tsx control-plane/src/organisms/DiagramStage.test.tsx control-plane/src/styles/components.css && git commit -m "feat(cp): DiagramStage — mermaid canvas + source panel + diagram type switch"`

---

### Task 4: `/diagram/$docId` route

**Files:**
- Modify: `control-plane/src/router.tsx` (add `DiagramRoute`, `diagramRoute`, register in `routeTree`; a lazy import like `DocumentStage`)
- Test: `control-plane/src/router.test.tsx` (append)

**Interfaces:**
- Consumes: `DiagramStage` (Task 3); the existing doc queries.
- Produces: route `/diagram/$docId`. `DiagramRoute` mirrors `DocRoute`: resolves the doc from `useDocuments()`; while the query is not `success` → `null`; unknown doc → `<Navigate to="/" replace />`; a doc whose blueprint family is NOT `diagram` → `<Navigate to="/doc/$docId" replace />` (so `/diagram` only ever shows diagrams). Renders `<DiagramStage>` with `blueprints` filtered to `family: "diagram"`.

- [ ] **Step 1: Write the failing test** (extend `router.test.tsx`; the fetch stub answers `/blueprints` with a diagram blueprint and seeds a diagram doc)
```ts
it("a diagram-family doc renders the diagram stage at /diagram/$id", async () => {
  const router = await renderAt("/diagram/d9", (client) => {
    client.setQueryData(qk.documents, [
      { id: "d9", title: "ER", blueprintId: "er", workType: "feature", status: "drafting", participants: [], createdAt: "", updatedAt: "", artifacts: [], sections: [{ id: "diagram", heading: "Diagram", body: "erDiagram" }] },
    ]);
    client.setQueryData(qk.blueprints, [{ id: "er", name: "Database design", family: "diagram", workTypes: ["feature"] }]);
  });
  expect(await screen.findByRole("region", { name: "Diagram" })).toBeTruthy();
  expect(router.state.location.pathname).toBe("/diagram/d9");
});
```
(Confirm the query key for blueprints is `qk.blueprints` — grep `queries/keys.ts`; use the real key. If DiagramStage lazy-loads like DocumentStage, wrap it in `Suspense` in the route.)
- [ ] **Step 2: Run to verify fail** — FAIL (no `/diagram` route).
- [ ] **Step 3: Implement.** Add `const DiagramStage = lazy(() => import("./organisms/DiagramStage").then((m) => ({ default: m.DiagramStage })));` (or a plain import if it stays light). `DiagramRoute` per the interface; the family filter: `const family = blueprints.find((b) => b.id === doc.blueprintId)?.family; if (family !== "diagram") return <Navigate to="/doc/$docId" params={{ docId }} replace />;` and pass `blueprints.filter((b) => b.family === "diagram")`. Register `diagramRoute` in `routeTree.addChildren([...])`.
- [ ] **Step 4: Run to verify pass** — the new test + the whole `router.test.tsx` green; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(cp): /diagram/\$docId route renders the diagram stage"`

---

### Task 5: Route diagram-family docs to `/diagram` (kind row + shelf)

**Files:**
- Modify: `control-plane/src/router.tsx` (`makePickKind`)
- Modify: `control-plane/src/molecules/ArtifactShelf.tsx` (`onOpen` routing) OR its callers in `router.tsx` (the `ArtifactShelf onOpen={...}` at the VoiceRoute) — route by family there.
- Test: `control-plane/src/router.test.tsx` (append)

**Interfaces:**
- Consumes: `familyForKind` (Plan 1). Produces: `makePickKind` sends a `family:"diagram"` create to `/diagram/$id`; the shelf's `onOpen` routes a diagram doc to `/diagram/$id`, others to `/doc/$id`.

- [ ] **Step 1: Write the failing test**
```ts
it("the Diagrams kind creates a diagram doc and opens /diagram", async () => {
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/blueprints"))
      return new Response(JSON.stringify({ blueprints: [
        { id: "spec", name: "Spec", family: "document", workTypes: ["feature"] },
        { id: "er", name: "Database design", family: "diagram", workTypes: ["feature"] },
      ] }));
    if (url.endsWith("/documents") && init?.method === "POST") {
      posts.push(String(JSON.parse(String(init.body)).blueprintId));
      return new Response(JSON.stringify({ doc: { id: "dg1", title: "ER", blueprintId: "er", workType: "feature", status: "drafting", participants: [], createdAt: "", updatedAt: "", artifacts: [], sections: [{ id: "diagram", heading: "Diagram", body: "erDiagram" }] } }));
    }
    if (url.endsWith("/agents")) return new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: false } }));
    return new Response(JSON.stringify({}));
  }));
  const router = await renderAt("/");
  await userEvent.click(screen.getByRole("button", { name: "Diagrams" }));
  await waitFor(() => expect(posts[0]).toBe("er"));            // used the diagram-family blueprint
  await waitFor(() => expect(router.state.location.pathname).toBe("/diagram/dg1"));
});
```
- [ ] **Step 2: Run to verify fail** — FAIL (makePickKind still routes diagram docs to `/doc`).
- [ ] **Step 3: Implement.** In `makePickKind`, after creating the doc, choose the destination by the created doc's blueprint family: `const created = r.doc; const fam = blueprints.find((b) => b.id === created.blueprintId)?.family; navigate({ to: fam === "diagram" ? "/diagram/$docId" : "/doc/$docId", params: { docId: created.id } });`. In the `ArtifactShelf` `onOpen` (VoiceRoute, `router.tsx`), route the same way using the doc from `docs.find`.
- [ ] **Step 4: Run to verify pass** — new test + the Plan-1 "Documents kind" test (still `/doc/d1`) both green; whole suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(cp): diagram-family docs open on the diagram canvas (kind row + shelf)"`

---

### Task 6: Type-switch family filter on the document stage

**Files:**
- Modify: `control-plane/src/router.tsx` (DocRoute passes `blueprints` filtered to the doc's family)
- Test: `control-plane/src/organisms/DocumentStage.test.tsx` (append) — a document lists only document blueprints.

**Interfaces:** none new — DocRoute already passes `blueprints`; now it passes `blueprints.filter((b) => b.family === docFamily)`.

- [ ] **Step 1: Write the failing test** — render `DocumentStage` with a mixed `blueprints` list (a `document` and a `diagram`) and assert the type switch shows only the document one. (If Task 6 filters in the ROUTE not the stage, instead assert in `router.test.tsx` that `/doc/$id`'s switch omits diagram types — pick whichever matches where you filter; filtering in the route is cleaner, so assert via router.)
```ts
// router.test.tsx
it("the document type switch omits diagram blueprints", async () => {
  await renderAt("/doc/d2", (client) => {
    client.setQueryData(qk.documents, [{ id: "d2", title: "Spec", blueprintId: "spec", workType: "feature", status: "drafting", participants: [], createdAt: "", updatedAt: "", artifacts: [], sections: [{ id: "overview", heading: "Overview", body: "" }] }]);
    client.setQueryData(qk.blueprints, [
      { id: "spec", name: "Spec", family: "document", workTypes: ["feature"] },
      { id: "implementation-plan", name: "Plan", family: "document", workTypes: ["feature"] },
      { id: "er", name: "Database design", family: "diagram", workTypes: ["feature"] },
    ]);
  });
  const group = await screen.findByRole("group", { name: /document type/i });
  expect(within(group).queryByRole("button", { name: "Database design" })).toBeNull();
  expect(within(group).getByRole("button", { name: "Plan" })).toBeInTheDocument();
});
```
- [ ] **Step 2: Run to verify fail** — FAIL (switch shows the diagram blueprint too).
- [ ] **Step 3: Implement.** In `DocRoute` (`router.tsx`), compute `const docFamily = blueprints.find((b) => b.id === doc.blueprintId)?.family ?? "document";` and pass `blueprints={blueprints.filter((b) => b.family === docFamily)}` to `DocumentStage`. (DiagramRoute already filters to `diagram` from Task 4.)
- [ ] **Step 4: Run to verify pass** — green; whole suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat(cp): the document type switch shows only same-family blueprints"`

---

### Task 7: Full suite + build + smoke

- [ ] **Step 1:** `cd control-plane && pnpm test` (whole suite green — re-run once if a known MapStage/NewWorkspaceModal parallelism flake appears; confirm it passes in isolation), `pnpm exec tsc --noEmit` clean, `pnpm lint` exit 0 (run `pnpm exec biome check --write .` if it flags formatting on new files, then re-lint). `cd broker && pnpm test && pnpm exec tsc --noEmit`. `cd control-plane && pnpm build` exit 0.
- [ ] **Step 2: Manual smoke (record evidence).** With the app running (broker + tauri): click **Diagrams** in the composer kind row → a diagram opens at `/diagram/$id` showing the `er` starter rendered as an ER diagram; edit the Mermaid in the source panel and watch it re-render; switch the diagram type to `sequence`; a parse typo shows source+error, never blank. The document stage's type switch shows only prose types; the diagram stage's only diagram types. Record what rendered (a screenshot or the observed behavior).
- [ ] **Step 3:** Commit any smoke-found fixes with their own tests.

---

## Self-review notes
- **Spec coverage (Plan 2 slice):** blueprint `family: diagram` + starters (§1, Task 1) ✓; `mermaid` dep + renderer with fallback (§2, Task 2) ✓; `DiagramStage` canvas + source + type switch (§2, §6, Tasks 3, 6) ✓; `/diagram/$docId` (§2, Task 4) ✓; kind row + shelf route diagram docs to the canvas (§5, Task 5) ✓. Deferred to Plan 3: the three-column chat-right dock + shared `CanvasStage` chrome + full-screen (§3, §8) — Plan 2's `DiagramStage` is the bare canvas; Plan 3 wraps it. Deferred to Plan 4: dashboards centered layout.
- **Chat untouched:** no change to `onSend`/composer send.
- **Type consistency:** `family: "document" | "diagram"` and `DiagramStageProps` used identically across tasks; the route family filter uses `blueprints.find(...).family`.

## Next plan
3. **Canvas chrome + full-screen** — `CanvasStage` wrapper (right chat dock, zoom-panel reposition) + `uiStore.fullscreen` + Esc, applied to `DiagramStage` and `MapStage`; then Plan 4 dashboards centered layout.
