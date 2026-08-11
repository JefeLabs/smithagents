# Shelf Everywhere + Focus View + Dashboards Dock Implementation Plan

> **CLAIMED:** in execution by Claude session d43af92a (inline, main checkout) since 2026-08-11. Do not execute concurrently.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ArtifactShelf on all five kind surfaces, a focus view (rail toggle above Settings + Esc) that CSS-collapses the shelf and docked chat, and /dashboards adopting the shared ChatDock center variant in place of its own ask box.

**Architecture:** `shelfDocsFor` extracted beside ArtifactShelf; four stages gain an inert `shelf?: ReactNode` slot rendered inside their `position: relative` `.stage` section; route components build the shelf. Focus is a `uiStore` boolean stamped as `data-focus` on `document.body` by a HomePage effect; three CSS rules do all the collapsing. `layoutForPath("/dashboards")` flips to `"center"` while DashboardAsk drops its textarea, resolving the compose-box collision the Plan-4 deferral was waiting on.

**Tech Stack:** React 19, TanStack Router (hash), TanStack Query, zustand, vitest + testing-library. Control-plane only.

**Spec:** `docs/superpowers/specs/2026-08-11-shelf-on-canvases-design.md` (v3)

## Global Constraints

- Shelf surfaces: `/` (already has it), `/dashboards`, `/doc/$docId`, `/diagram/$docId`, `/map`.
- `onOpen` uses the UNFILTERED blueprint list; family-filtered lists stay exclusive to the stages' type switches.
- Rules of hooks: new hooks in route components go ABOVE the existing early returns.
- Focus collapse is CSS only (`body[data-focus]` selectors); nothing unmounts. Home's `chat-dock--full` stays visible in focus.
- Focus never touches the URL; it does not survive reload.
- Shared checkout: stage only named files by explicit path; verify `[main <hash>]` + file count each commit. Append the Claude co-author footer to every commit.
- End state: `pnpm --dir control-plane test`, `pnpm typecheck`, `pnpm lint` all clean (zero-diagnostic baseline), exit codes measured via redirect.

---

### Task 1: Extract `shelfDocsFor` beside ArtifactShelf; HomePage adopts it

**Files:**
- Modify: `control-plane/src/molecules/ArtifactShelf.tsx`, `control-plane/src/pages/HomePage.tsx:16,157-160`
- Test: `control-plane/src/molecules/ArtifactShelf.test.tsx`

**Interfaces:**
- Produces: `shelfDocsFor(session: { artifacts?: string[] } | null | undefined, docs: DocT[]): DocT[]` exported from `ArtifactShelf.tsx`. Task 3 imports it in router.tsx.

- [ ] **Step 1: Failing tests** — append inside `describe("ArtifactShelf", ...)` (the `DOC` fixture exists at the top); extend the import to `import { ArtifactShelf, shelfDocsFor } from "./ArtifactShelf";`:

```tsx
  it("shelfDocsFor keeps the session's own artifact order and drops unknown ids", () => {
    const docs = [DOC("d1", "Login spec"), DOC("d2", "Login plan"), DOC("d3", "Old draft")];
    expect(shelfDocsFor({ artifacts: ["d2", "ghost", "d1"] }, docs).map((d) => d.id)).toEqual(["d2", "d1"]);
  });

  it("shelfDocsFor is empty for a null session or one without artifacts", () => {
    expect(shelfDocsFor(null, [DOC("d1", "x")])).toEqual([]);
    expect(shelfDocsFor({}, [DOC("d1", "x")])).toEqual([]);
  });
```

- [ ] **Step 2: Verify fail** — `pnpm --dir control-plane exec vitest run src/molecules/ArtifactShelf.test.tsx 2>&1 | tail -6` → FAIL (`shelfDocsFor` not exported).

- [ ] **Step 3: Implement** — in `ArtifactShelf.tsx` below `MAX_VISIBLE`:

```tsx
/**
 * The active session's documents in its own order — what the shelf shows.
 * Missing ids (deleted doc, frame race) drop out rather than render holes.
 */
export function shelfDocsFor(session: { artifacts?: string[] } | null | undefined, docs: DocT[]): DocT[] {
  return (session?.artifacts ?? []).map((id) => docs.find((d) => d.id === id)).filter((d): d is DocT => Boolean(d));
}
```

In `HomePage.tsx` replace the comment + inline derivation (lines 157-160) with `const shelfDocs = shelfDocsFor(session, docs);` and extend line 16 to `import { ArtifactShelf, shelfDocsFor } from "../molecules/ArtifactShelf";`.

- [ ] **Step 4: Verify pass** — `pnpm --dir control-plane exec vitest run src/molecules/ArtifactShelf.test.tsx src/pages/HomePage.test.tsx 2>&1 | tail -4` → PASS.

- [ ] **Step 5: Commit** — add exactly `control-plane/src/molecules/ArtifactShelf.tsx control-plane/src/molecules/ArtifactShelf.test.tsx control-plane/src/pages/HomePage.tsx`; message `refactor(cp): shelfDocsFor — the shelf's doc derivation, extracted beside it`. Verify 3 files.

---

### Task 2: `shelf` slot on DocumentStage, DiagramStage, MapStage, DashboardsStage

**Files:**
- Modify: `control-plane/src/organisms/DocumentStage.tsx:6-15,48`, `control-plane/src/organisms/DiagramStage.tsx:5-14,43`, `control-plane/src/organisms/MapStage.tsx:91,878`, `control-plane/src/organisms/DashboardsStage.tsx:22,59`
- Test: the four matching `.test.tsx` files

**Interfaces:**
- Produces: optional `shelf?: ReactNode` on all four stages, rendered as the FIRST child of their `<section className="stage …">`. Task 3 passes it.

- [ ] **Step 1: Failing tests** — one per stage test file, inside the existing describe, using each file's existing fixtures/props:

`DocumentStage.test.tsx`:
```tsx
  it("renders the shelf slot inside the stage when provided", () => {
    render(<DocumentStage doc={DOC} onSaveSection={vi.fn()} shelf={<aside aria-label="session documents" />} />);
    expect(screen.getByRole("complementary", { name: "session documents" })).toBeTruthy();
  });
```

`DiagramStage.test.tsx`:
```tsx
  it("renders the shelf slot inside the stage when provided", () => {
    render(
      <DiagramStage
        doc={DOC}
        blueprints={BPS}
        onSaveSection={vi.fn().mockResolvedValue({})}
        shelf={<aside aria-label="session documents" />}
      />,
    );
    expect(screen.getByRole("complementary", { name: "session documents" })).toBeTruthy();
  });
```

`MapStage.test.tsx` and `DashboardsStage.test.tsx` (both components currently take no props — mirror whatever render helper each file uses):
```tsx
  it("renders the shelf slot inside the stage when provided", () => {
    render(<MapStage shelf={<aside aria-label="session documents" />} />);
    expect(screen.getByRole("complementary", { name: "session documents" })).toBeTruthy();
  });
```
(If MapStage.test renders through a wrapper with providers, add the prop at that call site instead.)

- [ ] **Step 2: Verify fail** — `pnpm --dir control-plane exec vitest run src/organisms/DocumentStage.test.tsx src/organisms/DiagramStage.test.tsx src/organisms/MapStage.test.tsx src/organisms/DashboardsStage.test.tsx 2>&1 | tail -8` → FAIL (unknown prop / missing aside).

- [ ] **Step 3: Implement** — all four stages, identically:
  - Add to props (Document after `onRename`, Diagram after `onSaveSection`; Map/Dashboards gain a props object):
    ```tsx
    /** The session's staged-artifacts shelf, absolutely positioned over the stage's left edge. Built by the route. */
    shelf?: ReactNode;
    ```
    For MapStage/DashboardsStage: `export function MapStage({ shelf }: { shelf?: ReactNode } = {}) {` (same shape for DashboardsStage), importing `type ReactNode` from react.
  - Render `{shelf}` as the section's first child (`document-stage`:48, `diagram-stage`:43, `map-stage`:878, `dashboards-stage`:59).

- [ ] **Step 4: Verify pass** — same vitest command → PASS.

- [ ] **Step 5: Commit** — add the 8 files; message `feat(cp): every kind stage accepts a shelf slot`. Verify 8 files.

---

### Task 3: Route components build the shelf (all four canvases)

**Files:**
- Modify: `control-plane/src/router.tsx` (imports; DocRoute; DiagramRoute; MapRoute; DashboardsRoute)
- Test: `control-plane/src/router.test.tsx`

**Interfaces:**
- Consumes: Task 1's `shelfDocsFor`, Task 2's `shelf` prop, existing `openDocByFamily(navigate, blueprints, docs, docId)` from `./lib/pickKind`, `useSession()` from `./queries/pushed`.

- [ ] **Step 1: Failing test** — in `router.test.tsx` near "an artifact chip opens its document" (`within` already imported):

```tsx
  it("the /doc canvas shows the session's staged-artifacts shelf", async () => {
    await renderAt("/doc/d1", (client) => {
      client.setQueryData(qk.documents, [
        {
          id: "d1",
          title: "Login spec",
          blueprintId: "spec",
          workType: "feature",
          sections: [{ id: "overview", heading: "What this is", body: "Words." }],
          participants: [],
          status: "drafting",
          createdAt: "t",
          updatedAt: "t",
        },
        {
          id: "d2",
          title: "Login plan",
          blueprintId: "spec",
          workType: "feature",
          sections: [{ id: "overview", heading: "What this is", body: "Steps." }],
          participants: [],
          status: "drafting",
          createdAt: "t",
          updatedAt: "t",
        },
      ]);
      client.setQueryData(qk.session, {
        id: "s1",
        title: "Login spec",
        workspace: "acme",
        runtime: "local-in-process",
        artifacts: ["d1", "d2"],
      });
    });
    const shelf = await screen.findByRole("complementary", { name: "session documents" });
    expect(within(shelf).getAllByRole("button")).toHaveLength(2);
  });
```

- [ ] **Step 2: Verify fail** — `pnpm --dir control-plane exec vitest run src/router.test.tsx 2>&1 | tail -6` → FAIL (no complementary "session documents").

- [ ] **Step 3: Implement** — in `router.tsx`:

1. Imports:
```tsx
import { openDocByFamily } from "./lib/pickKind";
import { ArtifactShelf, shelfDocsFor } from "./molecules/ArtifactShelf";
```
and extend the pushed import: `import { useDocuments, useRoster, useSession } from "./queries/pushed";`.

2. A tiny local hook above the route components so four routes share one derivation (router-layer code, allowed to compose hooks):
```tsx
/** The shelf every kind canvas renders — the active session's docs, opened by family. */
function useShelf() {
  const navigate = useNavigate();
  const { data: docs = NO_DOCS } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS } = useBlueprints();
  const { data: session = null } = useSession();
  return (
    <ArtifactShelf
      docs={shelfDocsFor(session, docs)}
      onOpen={(id) => openDocByFamily(navigate, blueprints, docs, id)}
    />
  );
}
```

3. Each route calls `const shelf = useShelf();` ABOVE its early returns and passes `shelf={shelf}`:
```tsx
function MapRoute() {
  const shelf = useShelf();
  return <MapStage shelf={shelf} />;
}

function DashboardsRoute() {
  const shelf = useShelf();
  return <DashboardsStage shelf={shelf} />;
}
```
DocRoute/DiagramRoute: add `const shelf = useShelf();` as the first line, keep their own `useDocuments`/`useBlueprints` reads as-is, and add `shelf={shelf}` to the stage element.

- [ ] **Step 4: Verify pass** — `pnpm --dir control-plane exec vitest run src/router.test.tsx 2>&1 | tail -4` → PASS.

- [ ] **Step 5: Commit** — add `control-plane/src/router.tsx control-plane/src/router.test.tsx`; message `feat(cp): all four kind canvases show the staged-artifacts shelf`. Verify 2 files.

---

### Task 4: Dashboards adopts the shared ChatDock (center)

**Files:**
- Modify: `control-plane/src/lib/composerLayout.ts:10-19`, `control-plane/src/organisms/dashboards/DashboardAsk.tsx:5-12,44-64`, `control-plane/src/organisms/DashboardsStage.tsx` (the `<DashboardAsk` call)
- Test: `control-plane/src/lib/composerLayout.test.ts` (if present — else the assertions live in router.test.tsx), `control-plane/src/organisms/dashboards/DashboardAsk.test.tsx`

- [ ] **Step 1: Failing tests**

composerLayout test (extend the existing `layoutForPath` cases; create the case if the file lacks one):
```ts
  it("dashboards hosts the center dock", () => {
    expect(layoutForPath("/dashboards")).toBe("center");
  });
```

`DashboardAsk.test.tsx` — add:
```tsx
  it("owns no text input — the shared center dock is the one chat box", () => {
    render(<DashboardAsk scope="all workspaces" saved={[]} onScope={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
```
and update any existing tests that type into the textarea or pass `scopeHint` (the prop goes away; suggestion/saved-card clicks still call `onSubmit`).

- [ ] **Step 2: Verify fail** — `pnpm --dir control-plane exec vitest run src/lib/composerLayout.test.ts src/organisms/dashboards/DashboardAsk.test.tsx 2>&1 | tail -8` → FAIL.

- [ ] **Step 3: Implement**

1. `composerLayout.ts` — replace the function body + stale comment:
```ts
export function layoutForPath(pathname: string): ComposerVariant {
  if (pathname === "/") return "full";
  if (pathname.startsWith("/doc/") || pathname.startsWith("/diagram/") || pathname === "/map") return "dock";
  // The dashboards stage no longer owns a compose box (spec v3) — the shared
  // dock's center variant is the one chat box there.
  if (pathname === "/dashboards") return "center";
  return "hidden"; // /board, /work/$agent, unrouted
}
```

2. `DashboardAsk.tsx` — delete the whole `dash-ask__box` div (textarea + boxrow), the `draft` state, the `scopeHint` prop (interface + destructure), and the now-unused `ArrowRight`/`useState` imports. TRY suggestions and SAVED cards keep calling `onSubmit` — the mock composing flow stays reachable through them.

3. `DashboardsStage.tsx` — drop `scopeHint={scopeHint(scope)}` from the `<DashboardAsk` call; remove the `scopeHint` import if now unused.

- [ ] **Step 4: Verify pass** — same vitest command plus `src/router.test.tsx` (the "composer Dashboards kind navigates" test may assert dock absence — update it to expect the center dock) → PASS.

- [ ] **Step 5: Commit** — add the changed files; message `feat(cp): dashboards adopts the shared ChatDock center variant — own ask box retired`. Verify file count matches status.

---

### Task 5: Focus state + surface predicate

**Files:**
- Modify: `control-plane/src/stores/uiStore.ts`, `control-plane/src/lib/composerLayout.ts`
- Test: `control-plane/src/stores/uiStore.test.ts`, `control-plane/src/lib/composerLayout.test.ts`

**Interfaces:**
- Produces: `focusMode: boolean`, `toggleFocus(): void`, `exitFocus(): void` on `useUiStore`; `isKindSurface(pathname: string): boolean` from `composerLayout.ts`. Task 6 consumes all four.

- [ ] **Step 1: Failing tests**

uiStore.test.ts (follow the file's existing action-test style):
```ts
  it("focus toggles on/off and exits idempotently", () => {
    expect(useUiStore.getState().focusMode).toBe(false);
    useUiStore.getState().toggleFocus();
    expect(useUiStore.getState().focusMode).toBe(true);
    useUiStore.getState().exitFocus();
    useUiStore.getState().exitFocus();
    expect(useUiStore.getState().focusMode).toBe(false);
  });
```

composerLayout.test.ts:
```ts
  it("isKindSurface is exactly the non-hidden dock surfaces", () => {
    for (const p of ["/", "/dashboards", "/map", "/doc/d1", "/diagram/d2"]) expect(isKindSurface(p)).toBe(true);
    for (const p of ["/board", "/work/ignacio", "/nope"]) expect(isKindSurface(p)).toBe(false);
  });
```

- [ ] **Step 2: Verify fail** — `pnpm --dir control-plane exec vitest run src/stores/uiStore.test.ts src/lib/composerLayout.test.ts 2>&1 | tail -6` → FAIL.

- [ ] **Step 3: Implement**

uiStore.ts — interface members, `focusMode: false` in `initial`, and actions beside the other toggles:
```ts
  /** Focus view: collapses the artifact shelf and the docked chat (CSS via body[data-focus]). */
  focusMode: boolean;
  toggleFocus: () => void;
  exitFocus: () => void;
  ...
  toggleFocus: () => set((s) => ({ focusMode: !s.focusMode })),
  exitFocus: () => set({ focusMode: false }),
```

composerLayout.ts:
```ts
/** The five composer-kind surfaces — where the artifact shelf and the focus toggle exist. */
export function isKindSurface(pathname: string): boolean {
  return layoutForPath(pathname) !== "hidden";
}
```

- [ ] **Step 4: Verify pass** — same command → PASS.

- [ ] **Step 5: Commit** — add the 4 files; message `feat(cp): focusMode in uiStore + isKindSurface predicate`. Verify 4 files.

---

### Task 6: Focus UI — rail toggle, body stamp, Esc, collapse CSS

**Files:**
- Modify: `control-plane/src/organisms/ToolRail.tsx`, `control-plane/src/pages/HomePage.tsx`, `control-plane/src/styles/chatdock.css`
- Test: `control-plane/src/organisms/ToolRail.test.tsx`, `control-plane/src/pages/HomePage.test.tsx`

**Interfaces:**
- Consumes: Task 5's store fields + predicate.
- Produces: ToolRail props `showFocus?: boolean`, `focusActive?: boolean`, `onToggleFocus?: () => void`.

- [ ] **Step 1: Failing tests**

ToolRail.test.tsx (follow the file's render style):
```tsx
  it("shows the Focus toggle above Settings when enabled, hides it otherwise", () => {
    const onToggleFocus = vi.fn();
    render(<ToolRail showFocus focusActive={false} onToggleFocus={onToggleFocus} />);
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items.indexOf("Focus")).toBeLessThan(items.indexOf("Settings"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Focus" }));
    expect(onToggleFocus).toHaveBeenCalled();
    cleanup();
    render(<ToolRail />);
    expect(screen.queryByRole("menuitem", { name: "Focus" })).toBeNull();
  });
```
(If HeroUI renders MenuItems under a different role, mirror whatever role the file's existing Settings assertions use.)

HomePage.test.tsx (follow its existing render/seed helper):
```tsx
  it("focus mode stamps body[data-focus]; Esc exits", async () => {
    renderHome(); // whatever helper the file uses
    await userEvent.click(screen.getByRole("menuitem", { name: "Focus" }));
    expect(document.body.hasAttribute("data-focus")).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(document.body.hasAttribute("data-focus")).toBe(false);
  });
```

- [ ] **Step 2: Verify fail** — `pnpm --dir control-plane exec vitest run src/organisms/ToolRail.test.tsx src/pages/HomePage.test.tsx 2>&1 | tail -8` → FAIL.

- [ ] **Step 3: Implement**

1. ToolRail.tsx — props + footer item ABOVE Settings (icon `Focus` from lucide-react, added to the existing import):
```tsx
  /** Focus view toggle — shown only on the composer-kind surfaces. */
  showFocus?: boolean;
  focusActive?: boolean;
  onToggleFocus?: () => void;
  ...
        <Sidebar.Menu aria-label="Settings">
          {showFocus && (
            <Sidebar.MenuItem onAction={onToggleFocus} isCurrent={Boolean(focusActive)}>
              <Sidebar.MenuIcon>
                <Focus />
              </Sidebar.MenuIcon>
              <Sidebar.MenuItemContent>
                <Sidebar.MenuLabel>Focus</Sidebar.MenuLabel>
              </Sidebar.MenuItemContent>
            </Sidebar.MenuItem>
          )}
          <Sidebar.MenuItem onAction={onSettings}>
```

2. HomePage.tsx — read the store, stamp the body, bind Esc, pass the props:
```tsx
  const focusMode = useUiStore((s) => s.focusMode);
  const toggleFocus = useUiStore((s) => s.toggleFocus);
  const exitFocus = useUiStore((s) => s.exitFocus);

  // Focus collapses chrome via CSS alone — body-level stamp so every surface's
  // selectors see it without prop-drilling through HeroUI wrappers.
  useEffect(() => {
    document.body.toggleAttribute("data-focus", focusMode);
    return () => document.body.removeAttribute("data-focus");
  }, [focusMode]);

  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode, exitFocus]);
```
and on the `<ToolRail`: `showFocus={isKindSurface(pathname)} focusActive={focusMode} onToggleFocus={toggleFocus}` (import `isKindSurface` beside `layoutForPath`).

3. chatdock.css — append:
```css
/* ---- focus view: body[data-focus] collapses the shelf and the docked chat.
   The FULL dock (home) survives — on Chat the conversation IS the stage. ---- */
body[data-focus] .artifact-shelf {
  display: none;
}
body[data-focus] .chat-dock:not(.chat-dock--full) {
  display: none;
}
body[data-focus] .stage.document-stage,
body[data-focus] .stage.diagram-stage,
body[data-focus] .stage.map-stage {
  padding-right: 0; /* the canvas reclaims the dock's reserved width (Plan 3b note above) */
}
```

- [ ] **Step 4: Verify pass** — same vitest command → PASS.

- [ ] **Step 5: Commit** — add the 5 files; message `feat(cp): focus view — rail toggle above Settings collapses shelf + docked chat`. Verify 5 files.

---

### Task 7: Spec wording fix, full verification, live smoke, push

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-shelf-on-canvases-design.md` (one clause)

- [ ] **Step 1: Fix the spec's dashboards clause** — replace the sentence claiming `onSubmit` and the ask→composing transition "become unreachable" with:

```
  Its free-typed draft path goes away; the TRY suggestions and SAVED cards
  still call `onSubmit`, so the mock ask → composing → board flow stays
  reachable through them.
```

- [ ] **Step 2: Full verification**

Run: `pnpm --dir control-plane test 2>&1 | tail -4` → all pass.
Run: `pnpm typecheck > /tmp/tc.out 2>&1; echo "tc=$?"` → `tc=0`.
Run: `pnpm lint > /tmp/lint.out 2>&1; echo "lint=$?"` → `lint=0`.

- [ ] **Step 3: Live smoke** (cp dev server on :1420, HMR) — browser through: `/#/doc/d9` shelf tiles over the left margin; toggle Focus in the rail → shelf + right dock vanish, canvas widens; Esc → they return; `/#/dashboards` → center dock at bottom-centre, NO stage-owned textarea, shelf tiles present; `/#/map` → shelf present. Screenshot each and LOOK at them.

- [ ] **Step 4: Commit spec fix + push**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add docs/superpowers/specs/2026-08-11-shelf-on-canvases-design.md
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "docs: dashboards mock flow stays reachable via suggestions/saved cards"
gh auth switch -u ecruz165 && git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents push origin main; gh auth switch
```
Verify the push line shows `main -> main`.
