# Shelf on the /doc and /diagram Canvases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the staged-artifacts shelf (ArtifactShelf) on the `/doc/$docId` and `/diagram/$docId` canvases, wired as a stage slot prop built by the route components.

**Architecture:** `ArtifactShelf` and its CSS are untouched; a `shelfDocsFor` derivation is extracted next to it and reused by HomePage. `DocumentStage`/`DiagramStage` gain an inert `shelf?: ReactNode` slot rendered inside their `position: relative` `.stage` section (so the existing absolute-positioning CSS anchors correctly). `DocRoute`/`DiagramRoute` build the shelf from `useSession()` + `useDocuments()` + `useBlueprints()` and `openDocByFamily`. Organisms stay router-free.

**Tech Stack:** React 19, TanStack Router (hash history), TanStack Query, vitest + testing-library. Control-plane only — no broker changes.

**Spec:** `docs/superpowers/specs/2026-08-11-shelf-on-canvases-design.md`

## Global Constraints

- Both canvases get the shelf: `/doc/$docId` AND `/diagram/$docId`.
- `onOpen` uses the UNFILTERED blueprint list (`openDocByFamily` resolves family itself); the family-filtered list stays exclusive to the stages' type switch.
- Rules of hooks: the new `useSession()`/`useNavigate()` calls in the route components go ABOVE the existing early returns.
- Shared checkout: `git status` + stage only named files by explicit path; verify `[main <hash>]` + file count on every commit.
- After the last task: `pnpm --dir control-plane test`, `pnpm typecheck`, `pnpm lint` (zero-diagnostic baseline), measured by exit code via redirect.

---

### Task 1: Extract `shelfDocsFor` beside ArtifactShelf; HomePage adopts it

**Files:**
- Modify: `control-plane/src/molecules/ArtifactShelf.tsx`, `control-plane/src/pages/HomePage.tsx:16,158-160`
- Test: `control-plane/src/molecules/ArtifactShelf.test.tsx`

**Interfaces:**
- Produces: `shelfDocsFor(session: { artifacts?: string[] } | null | undefined, docs: DocT[]): DocT[]` exported from `ArtifactShelf.tsx`. Task 3 imports it in router.tsx.

- [ ] **Step 1: Write the failing tests** — append inside the existing `describe("ArtifactShelf", ...)` in `ArtifactShelf.test.tsx` (the `DOC` fixture already exists at the top):

```tsx
  it("shelfDocsFor keeps the session's own artifact order and drops unknown ids", () => {
    const docs = [DOC("d1", "Login spec"), DOC("d2", "Login plan"), DOC("d3", "Old draft")];
    const session = { artifacts: ["d2", "ghost", "d1"] };
    expect(shelfDocsFor(session, docs).map((d) => d.id)).toEqual(["d2", "d1"]);
  });

  it("shelfDocsFor is empty for a null session or one without artifacts", () => {
    expect(shelfDocsFor(null, [DOC("d1", "x")])).toEqual([]);
    expect(shelfDocsFor({}, [DOC("d1", "x")])).toEqual([]);
  });
```

Add `shelfDocsFor` to the import: `import { ArtifactShelf, shelfDocsFor } from "./ArtifactShelf";`

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --dir control-plane exec vitest run src/molecules/ArtifactShelf.test.tsx 2>&1 | tail -8`
Expected: FAIL — `shelfDocsFor` is not exported.

- [ ] **Step 3: Implement** — in `ArtifactShelf.tsx`, below `MAX_VISIBLE`:

```tsx
/**
 * The active session's documents in its own order — what the shelf shows.
 * Missing ids (deleted doc, frame race) drop out rather than render holes.
 */
export function shelfDocsFor(session: { artifacts?: string[] } | null | undefined, docs: DocT[]): DocT[] {
  return (session?.artifacts ?? []).map((id) => docs.find((d) => d.id === id)).filter((d): d is DocT => Boolean(d));
}
```

In `HomePage.tsx` replace lines 157-160 (the comment + inline derivation):

```tsx
  const shelfDocs = shelfDocsFor(session, docs);
```

and extend its import at line 16:

```tsx
import { ArtifactShelf, shelfDocsFor } from "../molecules/ArtifactShelf";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --dir control-plane exec vitest run src/molecules/ArtifactShelf.test.tsx src/pages/HomePage.test.tsx 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/molecules/ArtifactShelf.tsx control-plane/src/molecules/ArtifactShelf.test.tsx control-plane/src/pages/HomePage.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "refactor(cp): shelfDocsFor — the shelf's doc derivation, extracted beside it"
```
Verify `[main <hash>]`, 3 files.

---

### Task 2: `shelf` slot on DocumentStage and DiagramStage

**Files:**
- Modify: `control-plane/src/organisms/DocumentStage.tsx:6-15,47-49`, `control-plane/src/organisms/DiagramStage.tsx:5-14,43`
- Test: `control-plane/src/organisms/DocumentStage.test.tsx`, `control-plane/src/organisms/DiagramStage.test.tsx`

**Interfaces:**
- Produces: optional prop `shelf?: ReactNode` on both stages, rendered as the FIRST child of `<section className="stage document-stage">` / `<section className="stage diagram-stage">`. Task 3 passes it.

- [ ] **Step 1: Write the failing tests** — in `DocumentStage.test.tsx`, inside the existing describe (fixtures `DOC` exist):

```tsx
  it("renders the shelf slot inside the stage when provided", () => {
    render(<DocumentStage doc={DOC} onSaveSection={vi.fn()} shelf={<aside aria-label="session documents" />} />);
    expect(screen.getByRole("complementary", { name: "session documents" })).toBeTruthy();
  });
```

In `DiagramStage.test.tsx` (fixtures `DOC`, `BPS` exist):

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

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --dir control-plane exec vitest run src/organisms/DocumentStage.test.tsx src/organisms/DiagramStage.test.tsx 2>&1 | tail -8`
Expected: FAIL — TS rejects the unknown `shelf` prop (or the aside is absent).

- [ ] **Step 3: Implement** — in `DocumentStage.tsx` add to the props interface (after `onRename`):

```tsx
  /** The session's staged-artifacts shelf, absolutely positioned over the stage's left edge. Built by the route. */
  shelf?: ReactNode;
```

destructure it in the component signature, and render it as the section's first child:

```tsx
    <section className="stage document-stage" aria-label="Document">
      {shelf}
```

Add `ReactNode` to the react import (`import type { ReactNode } from "react";` or extend an existing `react` type import). Repeat identically in `DiagramStage.tsx` (props after `onSaveSection`; first child of `<section className="stage diagram-stage" aria-label="Diagram">`).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --dir control-plane exec vitest run src/organisms/DocumentStage.test.tsx src/organisms/DiagramStage.test.tsx 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/DocumentStage.tsx control-plane/src/organisms/DocumentStage.test.tsx control-plane/src/organisms/DiagramStage.tsx control-plane/src/organisms/DiagramStage.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(cp): DocumentStage/DiagramStage accept a shelf slot"
```
Verify `[main <hash>]`, 4 files.

---

### Task 3: Route components build the shelf

**Files:**
- Modify: `control-plane/src/router.tsx` (imports; `DocRoute`; `DiagramRoute`)
- Test: `control-plane/src/router.test.tsx`

**Interfaces:**
- Consumes: Task 1's `shelfDocsFor`, Task 2's `shelf` prop, existing `openDocByFamily(navigate, blueprints, docs, docId)` from `lib/pickKind`, `useSession()` from `queries/pushed`.

- [ ] **Step 1: Write the failing test** — in `router.test.tsx` (inside the main describe, near "an artifact chip opens its document"; `within` is already imported there):

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

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --dir control-plane exec vitest run src/router.test.tsx 2>&1 | tail -8`
Expected: FAIL — no element with role complementary named "session documents" on /doc.

- [ ] **Step 3: Implement** — in `router.tsx`:

1. Imports: add `openDocByFamily` (`import { makePickKind, openDocByFamily } from "./lib/pickKind";` — check whether `makePickKind` is already imported there; if not, import only `openDocByFamily`), add `ArtifactShelf, shelfDocsFor`:

```tsx
import { ArtifactShelf, shelfDocsFor } from "./molecules/ArtifactShelf";
```

and extend the pushed-queries import: `import { useDocuments, useRoster, useSession } from "./queries/pushed";`

2. `DocRoute` — add the two hooks ABOVE the early returns, and pass the shelf:

```tsx
function DocRoute() {
  const navigate = useNavigate();
  const { docId } = docRoute.useParams();
  const { data: docs = NO_DOCS, status } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS } = useBlueprints();
  const { data: session = null } = useSession();
  ...
      <DocumentStage
        doc={doc}
        blueprints={blueprints.filter((b) => b.family === docFamily)}
        shelf={
          <ArtifactShelf
            docs={shelfDocsFor(session, docs)}
            onOpen={(id) => openDocByFamily(navigate, blueprints, docs, id)}
          />
        }
        ...
```

3. `DiagramRoute` — identically: `useNavigate()` + `useSession()` above the early returns, same `shelf={...}` on `DiagramStage` (the `blueprints` passed to `openDocByFamily` is the UNFILTERED list in both).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --dir control-plane exec vitest run src/router.test.tsx 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/router.tsx control-plane/src/router.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(cp): /doc and /diagram canvases show the staged-artifacts shelf"
```
Verify `[main <hash>]`, 2 files.

---

### Task 4: Spec wording fix, full verification, live smoke, push

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-shelf-on-canvases-design.md` (one line)

- [ ] **Step 1: Fix the spec's empty-state line** — replace

```
- No active session or no artifacts → empty aside, exactly as home today.
```

with

```
- No active session or no artifacts → the shelf renders nothing at all
  (ArtifactShelf returns null on an empty list), exactly as home today.
```

- [ ] **Step 2: Full verification**

Run: `pnpm --dir control-plane test 2>&1 | tail -4` — expected: all pass.
Run: `pnpm typecheck > /tmp/tc.out 2>&1; echo "tc=$?"` — expected `tc=0`.
Run: `pnpm lint > /tmp/lint.out 2>&1; echo "lint=$?"` — expected `lint=0`.

- [ ] **Step 3: Live smoke** — with the cp dev server on :1420 (tmux `smith-cp-dev`, HMR picks the change up automatically): browser to `http://localhost:1420/#/doc/d9` → the shelf tiles render over the document stage's left margin; click the other tile → navigates to its doc. Screenshot and LOOK at it.

- [ ] **Step 4: Commit the spec fix and push everything**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add docs/superpowers/specs/2026-08-11-shelf-on-canvases-design.md
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "docs: shelf empty-state wording matches ArtifactShelf's null return"
# push under ecruz165 (default account 403s), then switch back
gh auth switch -u ecruz165 && git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents push origin main; gh auth switch
```
Verify the push line shows `main -> main`.
