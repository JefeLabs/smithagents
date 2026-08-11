# Artifact Launcher — Plan 1: Launcher Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Claimed by:** _(unclaimed — write your session id here before executing)_

**Goal:** Replace the left-nav stage rail with a reveal-on-engage kind row under the chat box whose buttons (`Chat · Dashboards · Documents · Diagrams · User Story Maps`) navigate immediately — wired to the *existing* stages, with a `family` tag on blueprints so Documents and Diagrams are one system split by render family.

**Architecture:** The composer's current arm-then-send document logic is replaced by an `onPickKind(kind)` dispatcher; the router maps each kind to a navigation (Documents/Diagrams create a blueprint doc of the matching family and open it; Dashboards/Map/Chat navigate to existing routes). Diagram-family docs open in the existing prose `DocumentStage` for now — Plan 2 gives them the Mermaid canvas. Blueprints gain `family: "document" | "diagram"`.

**Tech Stack:** React 19 + TanStack Router/Query + zustand, HeroUI v3 (`onPress`, compound components), **pnpm** (control-plane), **npm** (broker), vitest + node:test.

## Global Constraints

- **Repo:** paths relative to the **smithagents** repo root; execute in the existing worktree `.claude/worktrees/composer-artifact-launcher` (branch `feat/composer-artifact-launcher`, off `origin/develop`). `git -C`. **DO NOT merge/reset in the shared main checkout** — the control-plane is live in another session (`smith-cp-dev`); merge via push-fast-forward at the end.
- **Commands:** control-plane `cd control-plane && pnpm test` (`vitest run`), one file `pnpm exec vitest run src/<f>.test.tsx`, `pnpm exec tsc --noEmit`, `pnpm lint` (biome; the 2 permanent config diagnostics exit 0 — a non-zero exit is your own regression). Broker `cd broker && npm test`, `npm run typecheck`.
- **HeroUI compound API is verified via the heroui-pro MCP before use — LAW.** `onPress` not `onClick`.
- **Chat send is sacred:** the untargeted/targeted `onSend` path (and every existing composer test) must be byte-for-byte unchanged. Only the *document arm* mechanism is replaced.
- Spec: `docs/superpowers/specs/2026-08-11-composer-artifact-launcher-design.md` (§§1, 4, 5, 6, 7 and the kind table).

---

### Task 1: Blueprint `family` tag (broker)

**Files:**
- Modify: `broker/src/blueprints.ts` (`Blueprint` interface ~:20; `DEFAULT_BLUEPRINTS` entries)
- Test: `broker/src/blueprints.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `Blueprint.family: "document" | "diagram"`; the two defaults (`spec`, `implementation-plan`) carry `family: "document"`. The catalog on the wire (`getBlueprints`) now includes `family`.

- [ ] **Step 1: Write the failing test**
```ts
// broker/src/blueprints.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBlueprints } from './blueprints.js';

test('default blueprints declare a family; spec and plan are documents', () => {
  const bps = loadBlueprints('/nonexistent-dir-uses-defaults');
  const spec = bps.find((b) => b.id === 'spec');
  const plan = bps.find((b) => b.id === 'implementation-plan');
  assert.equal(spec?.family, 'document');
  assert.equal(plan?.family, 'document');
  // Every blueprint must declare a family (no undefined leaks to the UI grouping).
  assert.ok(bps.every((b) => b.family === 'document' || b.family === 'diagram'));
});
```
- [ ] **Step 2: Run to verify fail** — `cd broker && node --import tsx --test src/blueprints.test.ts` → FAIL (`family` undefined). (`loadBlueprints` tolerates a missing dir by returning the packaged defaults — confirm by reading `:56`.)
- [ ] **Step 3: Implement.** Add `family: "document" | "diagram";` to the `Blueprint` interface. Add `family: 'document',` to each `DEFAULT_BLUEPRINTS` entry. If user blueprint files omit `family`, default to `'document'` in the merge/parse path (a plain prose doc is the safe default).
- [ ] **Step 4: Run to verify pass** — same command; then `npm run typecheck` clean (the `documents.ts`/`main.ts` consumers don't read `family`, so no downstream breakage).
- [ ] **Step 5: Commit** — `git add broker/src/blueprints.ts broker/src/blueprints.test.ts && git commit -m "feat(broker): blueprint family tag (document|diagram)"`

---

### Task 2: `family` in the control-plane blueprint type

**Files:**
- Modify: `control-plane/src/api/types.ts` (the `BlueprintT` type)
- Test: covered by Task 4's composer test (no standalone test — a type-only change).

**Interfaces:**
- Produces: `BlueprintT.family: "document" | "diagram"` (mirrors the broker wire shape).

- [ ] **Step 1:** Find `BlueprintT` in `control-plane/src/api/types.ts` (grep `BlueprintT`). Add `family: "document" | "diagram";`.
- [ ] **Step 2: Verify** — `cd control-plane && pnpm exec tsc --noEmit`. Expected: it may flag any test fixture building a `BlueprintT` without `family` — fix those fixtures to include `family: "document"`. (Search `blueprintId:`/`BlueprintT` in `*.test.tsx`.)
- [ ] **Step 3: Commit** — `git add control-plane/src/api/types.ts control-plane/src/**/*.test.tsx && git commit -m "feat(cp): BlueprintT.family"`

---

### Task 3: `pickKind` navigation helper (control-plane, pure)

**Files:**
- Create: `control-plane/src/lib/artifactKinds.ts`
- Test: `control-plane/src/lib/artifactKinds.test.ts`

**Interfaces (later tasks rely on these EXACT signatures):**
```ts
export type ArtifactKind = "chat" | "dashboards" | "documents" | "diagrams" | "map";
export const ARTIFACT_KINDS: ReadonlyArray<{ kind: ArtifactKind; label: string }>;
// pure: which family a document-creating kind uses (null for non-document kinds)
export function familyForKind(kind: ArtifactKind): "document" | "diagram" | null;
```
`ARTIFACT_KINDS` order is canonical: chat, dashboards, documents, diagrams, map. Labels: `Chat`, `Dashboards`, `Documents`, `Diagrams`, `User Story Maps`. `familyForKind`: `documents`→`"document"`, `diagrams`→`"diagram"`, everything else `null`.

- [ ] **Step 1: Write the failing test**
```ts
// control-plane/src/lib/artifactKinds.test.ts
import { describe, expect, it } from "vitest";
import { ARTIFACT_KINDS, familyForKind } from "./artifactKinds";

describe("artifact kinds", () => {
  it("lists the five kinds in canonical order with labels", () => {
    expect(ARTIFACT_KINDS.map((k) => k.kind)).toEqual(["chat", "dashboards", "documents", "diagrams", "map"]);
    expect(ARTIFACT_KINDS.find((k) => k.kind === "map")?.label).toBe("User Story Maps");
  });
  it("maps only document-creating kinds to a family", () => {
    expect(familyForKind("documents")).toBe("document");
    expect(familyForKind("diagrams")).toBe("diagram");
    expect(familyForKind("chat")).toBeNull();
    expect(familyForKind("dashboards")).toBeNull();
    expect(familyForKind("map")).toBeNull();
  });
});
```
- [ ] **Step 2: Run to verify fail** — `pnpm exec vitest run src/lib/artifactKinds.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `artifactKinds.ts` per the interface.
- [ ] **Step 4: Run to verify pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git add control-plane/src/lib/artifactKinds.* && git commit -m "feat(cp): artifact-kind registry + family mapping"`

---

### Task 4: Composer kind row (reveal-on-engage, click = onPickKind)

**Files:**
- Modify: `control-plane/src/molecules/Composer.tsx` (props ~:6-36; `submit` ~:108; kind-group render ~:218-260; add reveal state)
- Test: `control-plane/src/molecules/Composer.test.tsx` (append)

**Interfaces:**
- Consumes: `ARTIFACT_KINDS`, `ArtifactKind` (Task 3).
- Produces: new prop `onPickKind?: (kind: ArtifactKind) => void`; new prop `activeKind?: ArtifactKind` (highlights the current surface's button). **Removes** `kind`, `onKindChat`, `onSendDocument`, and the internal `armed` state (the arm-then-send document mechanism). Chat's `onSend`/target path is unchanged.

- [ ] **Step 1: Write the failing tests** (reuse the file's existing render helpers)
```ts
// append to control-plane/src/molecules/Composer.test.tsx
import { ARTIFACT_KINDS } from "../lib/artifactKinds";

it("hides the kind row until engaged, reveals on focus and on draft", async () => {
  const user = userEvent.setup();
  render(<Composer onSend={() => {}} onPickKind={() => {}} />);
  // Idle: no kind row.
  expect(screen.queryByRole("group", { name: /artifact kind/i })).not.toBeInTheDocument();
  const box = screen.getByRole("textbox");
  await user.click(box); // focus
  expect(screen.getByRole("group", { name: /artifact kind/i })).toBeInTheDocument();
});

it("clicking a kind calls onPickKind and never sends", async () => {
  const user = userEvent.setup();
  const onPickKind = vi.fn();
  const onSend = vi.fn();
  render(<Composer onSend={onSend} onPickKind={onPickKind} />);
  await user.click(screen.getByRole("textbox"));
  await user.click(screen.getByRole("button", { name: "Diagrams" }));
  expect(onPickKind).toHaveBeenCalledWith("diagrams");
  expect(onSend).not.toHaveBeenCalled();
});

it("the active kind button is marked current", async () => {
  const user = userEvent.setup();
  render(<Composer onSend={() => {}} onPickKind={() => {}} activeKind="map" />);
  await user.click(screen.getByRole("textbox"));
  expect(screen.getByRole("button", { name: "User Story Maps" })).toHaveAttribute("aria-pressed", "true");
});
```
- [ ] **Step 2: Run to verify fail** — `pnpm exec vitest run src/molecules/Composer.test.tsx` → the three new tests FAIL; existing composer tests still PASS (chat send untouched).
- [ ] **Step 3: Implement.** In `Composer.tsx`:
  - Delete the `kind`, `onKindChat`, `onSendDocument` props and the `armed` state; delete the `armed && onSendDocument` branch in `submit()` (so `submit` is only the chat/target path).
  - Add props `onPickKind?`, `activeKind?`. Add reveal state: `const [focused, setFocused] = useState(false); const engaged = focused || draft.trim() !== "";` — set `focused` on the TextArea's `onFocus`/`onBlur`.
  - Replace the `composer__kind-group` block with a row rendered only when `engaged && onPickKind`: `role="group" aria-label="artifact kind"`, one `<button>` per `ARTIFACT_KINDS` entry, `aria-pressed={activeKind === k.kind}`, `onClick={() => onPickKind(k.kind)}` (plain button — a nav trigger, not a HeroUI action). Keep the existing `composer__kind` class for styling.
- [ ] **Step 4: Run to verify pass** — new tests pass; run the whole file to confirm chat/target tests unaffected; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git add control-plane/src/molecules/Composer.tsx control-plane/src/molecules/Composer.test.tsx && git commit -m "feat(cp): composer kind row — reveal-on-engage, click navigates"`

---

### Task 5: Router — `onPickKind` wiring + create-by-family

**Files:**
- Modify: `control-plane/src/router.tsx` (the VoiceRoute composer ~:76-113 and the DocRoute composer ~:171-184; remove `onSendDocument`/`kind`/`onKindChat`, add `onPickKind`/`activeKind`)
- Modify: `control-plane/src/api/broker.ts` — confirm `postDocument(blueprintId, text)` exists (used at `router.tsx:96`); no change unless it lacks a family-aware caller helper (it doesn't need one — the caller picks the blueprint id).
- Test: `control-plane/src/router.test.tsx` (append a navigation test) or `HomePage.test.tsx` depending on where the composer is exercised.

**Interfaces:**
- Consumes: `familyForKind`, `ArtifactKind` (Task 3); `onPickKind` prop (Task 4); `useBlueprints()` (already imported in router).
- Produces: a shared `onPickKind` handler wired on every composer instance:
```ts
function makePickKind(navigate, qc, blueprints) {
  return async (kind: ArtifactKind) => {
    if (kind === "chat") return void navigate({ to: "/" });
    if (kind === "dashboards") return void navigate({ to: "/dashboards" });
    if (kind === "map") return void navigate({ to: "/map" });
    const family = familyForKind(kind)!;                 // documents | diagrams
    const bp = blueprints.find((b) => b.family === family) ?? blueprints[0];
    const r = await api.postDocument(bp?.id ?? "spec", "");
    if (r.doc) {
      qc.setQueryData<DocT[]>(qk.documents, (prev = []) => [r.doc!, ...prev.filter((d) => d.id !== r.doc!.id)]);
      void navigate({ to: "/doc/$docId", params: { docId: r.doc.id } });  // Plan 2 sends diagrams to /diagram
    }
  };
}
```

- [ ] **Step 1: Write the failing test.** In the composer's host test, mock `api.postDocument` + `useBlueprints` (returning a `document` and a `diagram` blueprint) and assert: clicking `Documents` calls `postDocument` with the document-family blueprint id and navigates to `/doc/...`; clicking `Dashboards` navigates to `/dashboards` and does NOT call `postDocument`. (Mirror the existing `HomePage.test.tsx` navigation-assert pattern; use its `navigate` spy.)
```ts
it("Documents creates a document-family doc and opens it; Dashboards just navigates", async () => {
  // fixtures: useBlueprints → [{id:'spec',family:'document'}, {id:'er',family:'diagram'}]
  // api.postDocument → { doc: { id: 'd1', blueprintId: 'spec', ... } }
  // render the composer host, click into the box, click Documents
  // expect postDocument called with 'spec'; expect navigate to /doc/$docId d1
  // click Dashboards → expect navigate /dashboards, postDocument NOT called again
});
```
(Fill the fixture bodies from the existing test file's helpers — `router.test.tsx`/`HomePage.test.tsx` already stub `api` and `navigate`.)
- [ ] **Step 2: Run to verify fail** — FAIL (composer has no `onPickKind` wired in the route yet).
- [ ] **Step 3: Implement.** In `router.tsx`: build `makePickKind(navigate, qc, blueprints)` once per route that renders a composer; pass `onPickKind={pickKind}` and `activeKind={…}` (derive from the current route: `/`→`chat`, `/doc/*`→`documents`, `/dashboards`→`dashboards`, `/map`→`map`). Remove the old `onSendDocument`/`kind="document"`/`onKindChat` props from both composer instances. Keep `onSend`, `targets`, voice controls, `shelf` exactly as-is.
- [ ] **Step 4: Run to verify pass** — the nav test passes; whole suite green; `pnpm exec tsc --noEmit` clean.
- [ ] **Step 5: Commit** — `git add control-plane/src/router.tsx control-plane/src/**/*.test.tsx && git commit -m "feat(cp): router wires onPickKind — create-by-family + stage nav"`

---

### Task 6: Remove the dashboards + map nav entries

**Files:**
- Modify: `control-plane/src/organisms/ToolRail.tsx` (`/dashboards` item ~:60-67; `/map` item ~:52-59)
- Test: `control-plane/src/organisms/ToolRail.test.tsx` (or wherever ToolRail is tested — grep)

**Interfaces:** none — pure removal.

- [ ] **Step 1: Write the failing test** — assert `ToolRail` no longer renders items linking to `/dashboards` or `/map`.
```ts
it("no longer offers Dashboards or Map in the rail (they're composer-triggered)", () => {
  render(/* ToolRail with its provider harness, per the existing test */);
  expect(screen.queryByRole("link", { name: /dashboards/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: /^map$/i })).not.toBeInTheDocument();
});
```
- [ ] **Step 2: Run to verify fail** — FAIL (items still present).
- [ ] **Step 3: Implement** — delete the `/dashboards` and `/map` `Sidebar.MenuItem` blocks from `ToolRail.tsx`. Leave `Board`, `New session`, `Sessions`, `Settings`.
- [ ] **Step 4: Run to verify pass** — new test passes; update any existing ToolRail test that asserted those items were present (remove those assertions); whole suite green.
- [ ] **Step 5: Commit** — `git add control-plane/src/organisms/ToolRail.tsx control-plane/src/organisms/ToolRail.test.tsx && git commit -m "feat(cp): drop dashboards/map from the tool rail"`

---

### Task 7: Full-suite green + lint + manual smoke

- [ ] **Step 1:** `cd control-plane && pnpm test` (whole suite green), `pnpm exec tsc --noEmit` (clean), `pnpm lint` (exit 0 — run `pnpm exec biome check --write .` if it flags formatting on the new files, then re-lint). `cd broker && npm test && npm run typecheck`.
- [ ] **Step 2: Manual smoke (record evidence).** `pnpm dev` (or the project's run recipe): confirm the kind row is hidden until you focus the chat box; the five buttons appear; clicking `Documents` opens a fresh doc, `Diagrams` opens a fresh doc (prose stage for now — Plan 2 makes it a canvas), `Dashboards`/`User Story Maps` navigate to their stages, `Chat` returns home; the rail no longer shows Dashboards/Map; typing + send still chats. Note anything surprising as a plan deviation.
- [ ] **Step 3: Commit** any smoke-found fixes with their own tests.

---

## Self-review notes
- **Spec coverage (Plan 1 slice):** kind row + reveal-on-engage (§4) ✓; click=navigate `onPickKind` (§4, §5) ✓; create-by-family (§5) ✓; blueprint `family` (§1) ✓; nav cleanup (§7) ✓. Deferred to later plans: Mermaid diagram canvas + `/diagram` route (§2, Plan 2); shelf `onOpen` route-by-family (Plan 2, once `/diagram` exists); three-column chat-right layout + shared canvas chrome + full-screen (§3, §8, Plan 3); dashboards centered layout (§9, Plan 4). Diagram-family docs open in the prose `DocumentStage` until Plan 2 — an intentional, working intermediate.
- **Chat-send untouched:** Tasks 4–5 only remove the document-arm; every existing composer/router/HomePage test must stay green (called out in each task).
- **Type consistency:** `ArtifactKind` = `"chat"|"dashboards"|"documents"|"diagrams"|"map"` used identically in Tasks 3, 4, 5. `family` = `"document"|"diagram"` in Tasks 1, 2, 3, 5.

## Next plans (roadmap)
2. **Diagram canvas** — `mermaid` dep, `MermaidBlock`, `DiagramStage`, `/diagram/$docId` route, `er`/`sequence` diagram blueprints, shelf `onOpen` + `onPickKind` route diagram-family to `/diagram`.
3. **Canvas chrome + full-screen** — `CanvasStage` wrapper (right chat dock, zoom-panel reposition), `uiStore.fullscreen` + Esc, applied to `DiagramStage` + `MapStage`.
4. **Dashboards centered layout** — role-aware home: centered chat, priority slice cards, collapsed dashboards list.
