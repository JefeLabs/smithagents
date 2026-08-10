# Slice by Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a story belong to several slices, require every slice to own at least one story no other slice has, and make slices by selecting their stories on the map.

**Architecture:** One pure predicate names the slices that own nothing exclusively. It exists twice — the authority in `swarm/src/capabilities.ts`, a mirror in `control-plane/src/organisms/map/slices.ts` — because the two packages share no module. `patchCapability` rejects any write that newly invalidates a slice; the client mirror only disables a button. Selection rides React Flow's own node selection, and a floating panel lists slices, highlighting a slice's stories through the existing `decorate(base, dimmedIds)` seam.

**Tech Stack:** TypeScript, React 19, xyflow/React Flow 12.11.2, vitest (control-plane), node:test (swarm), Fastify (swarm), pnpm.

## Global Constraints

- **The rule, verbatim from the spec:** "A slice must own **at least one** story that appears in no other slice of the same capability. Any number of its other stories may be shared. A story in no slice is backlog."
- **Rejection is differential and keyed by slice id:** reject iff `invalidAfter \ invalidBefore` is non-empty. Never compare counts — a count can stay level while the set changes.
- **Grandfathering:** a capability that is already invalid may be written to, provided the write does not newly invalidate any slice that was valid.
- **Both predicate copies are tested against the identical case table** in Task 1. It stands in for the shared module the packages do not have.
- **The client mirror is never stubbed in tests.** Stubbing it lets the two copies drift silently.
- **`swarm` and `control-plane` are separate installs.** Run each package's own suite; a control-plane-only run leaves every swarm change unexercised.
- **swarm tests:** `node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts'` from `swarm/`. Imports use the `.js` extension (`./capabilities.js`).
- **control-plane tests:** `pnpm vitest run` from `control-plane/`. Read exit codes by redirect, never through a pipe.
- **Do not reintroduce edge-versus-centre comparisons** in any geometry. `cellAt` measures edge to edge; see `c8e2446`.
- **`--cap-card-w` has exactly one owner** (`layout.ts`). Do not add a second copy.

---

## File Structure

| File | Responsibility |
|---|---|
| `swarm/src/capabilities.ts` | **Modify.** Add `slicesWithoutExclusiveStory`; replace the disjointness loop in `patchCapability` with the differential check. |
| `swarm/src/capabilities.test.ts` | **Modify.** Case table + `patchCapability` acceptance/rejection. |
| `control-plane/src/organisms/map/slices.ts` | **Create.** The mirror predicate over `CapSliceT`. Pure, no React. |
| `control-plane/src/organisms/map/slices.test.ts` | **Create.** The same case table. |
| `control-plane/src/organisms/map/layout.ts` | **Modify.** `selectable` on `MapNode`; true only for real story nodes. |
| `control-plane/src/organisms/map/layout.test.ts` | **Modify.** Selectability by node type. |
| `control-plane/src/organisms/map/SlicePanel.tsx` | **Create.** The floating panel: list, hover, click, create button. |
| `control-plane/src/organisms/MapStage.tsx` | **Modify.** React Flow selection props, mount the panel, remove `addSlice` and the `New slice name…` input. |
| `control-plane/src/organisms/MapStage.test.tsx` | **Modify.** Selection → create; disabled-with-reason; hover highlight. |
| `control-plane/src/styles/components.css` | **Modify.** Panel styles. |

---

### Task 1: The rule, and differential validation in the swarm

**Files:**
- Modify: `swarm/src/capabilities.ts:126-142` (the `patchCapability` validation block)
- Test: `swarm/src/capabilities.test.ts`

**Interfaces:**
- Consumes: `CapSlice` (already exported from `swarm/src/capabilities.ts`).
- Produces: `slicesWithoutExclusiveStory(slices: CapSlice[]): CapSlice[]` — returns **every** slice owning no exclusive story, in input order. Task 2 mirrors this signature exactly over `CapSliceT`.

- [ ] **Step 1: Write the failing case-table test**

Add to `swarm/src/capabilities.test.ts`:

```ts
const sl = (id: string, storyIds: string[]): CapSlice => ({ id, name: id, order: 0, storyIds });

test('slicesWithoutExclusiveStory: the shared case table', () => {
  const cases: Array<{ name: string; slices: CapSlice[]; invalid: string[] }> = [
    { name: 'single slice owns everything', slices: [sl('A', ['s1', 's2', 's3'])], invalid: [] },
    { name: 'overlap, each owns one', slices: [sl('A', ['s1', 's2']), sl('B', ['s2', 's3'])], invalid: [] },
    { name: 'identical single story', slices: [sl('A', ['s1']), sl('B', ['s1'])], invalid: ['A', 'B'] },
    { name: 'identical sets', slices: [sl('A', ['s1', 's2']), sl('B', ['s1', 's2'])], invalid: ['A', 'B'] },
    { name: 'subset', slices: [sl('A', ['s1']), sl('B', ['s1', 's2'])], invalid: ['A'] },
    { name: 'storyless', slices: [sl('A', [])], invalid: ['A'] },
    { name: 'no slices at all', slices: [], invalid: [] },
    { name: 'covered by two neighbours', slices: [sl('A', ['s1']), sl('B', ['s2']), sl('C', ['s1', 's2'])], invalid: ['C'] },
  ];
  for (const c of cases) {
    assert.deepEqual(slicesWithoutExclusiveStory(c.slices).map((s) => s.id), c.invalid, c.name);
  }
});
```

Add `slicesWithoutExclusiveStory` to the existing import from `'./capabilities.js'`, and `CapSlice` to the type imports.

The `identical single story` row is the one that catches the likely bug: marking only the *second* occurrence reports B alone, when both slices are equally unowned.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd swarm && node --import tsx --test 'src/capabilities.test.ts'
```

Expected: FAIL — `slicesWithoutExclusiveStory is not a function`.

- [ ] **Step 3: Implement the predicate**

In `swarm/src/capabilities.ts`, above `patchCapability`:

```ts
/**
 * Slices whose every story also appears in another slice. Pure, total, and
 * evaluated over the WHOLE set — a slice is invalidated by what its neighbours
 * contain, so this can never be answered one slice at a time. Empty storyIds
 * owns nothing, so a storyless slice is reported here rather than needing its
 * own check.
 *
 * Counts each story across all slices FIRST, then asks each slice whether it
 * holds one with a count of 1. Marking duplicates while iterating would report
 * only the later of two identical slices, when both are equally unowned.
 *
 * Mirrored in control-plane/src/organisms/map/slices.ts — that copy disables a
 * button, this one decides what persists. Both are tested against the same
 * case table; keep them in step.
 */
export function slicesWithoutExclusiveStory(slices: CapSlice[]): CapSlice[] {
  const uses = new Map<string, number>();
  for (const slice of slices) {
    for (const id of new Set(slice.storyIds)) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  return slices.filter((slice) => !slice.storyIds.some((id) => uses.get(id) === 1));
}
```

`new Set(slice.storyIds)` guards a slice that lists the same story twice — without it, one slice could count itself as two users and appear to own nothing.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd swarm && node --import tsx --test 'src/capabilities.test.ts'
```

Expected: PASS.

- [ ] **Step 5: Write the failing differential-validation tests**

```ts
test('patchCapability: overlapping slices are allowed when each owns something', () => {
  const cap = createCapability('jefelabs', 'c');
  cap.activities = [{ id: 'a1', name: 'a', order: 0, steps: [{ id: 'st1', name: 's', order: 0 }] }];
  cap.stories = [
    { id: 's1', stepId: 'st1', order: 0, text: 'one', done: false },
    { id: 's2', stepId: 'st1', order: 1, text: 'two', done: false },
    { id: 's3', stepId: 'st1', order: 2, text: 'three', done: false },
  ];
  const patched = patchCapability(cap, {
    slices: [
      { id: 'A', name: 'A', order: 0, storyIds: ['s1', 's2'] },
      { id: 'B', name: 'B', order: 1, storyIds: ['s2', 's3'] },
    ],
  });
  assert.equal(patched.slices.length, 2);
});

test('patchCapability: refuses a write that newly invalidates a slice, naming it', () => {
  const cap = createCapability('jefelabs', 'c');
  cap.activities = [{ id: 'a1', name: 'a', order: 0, steps: [{ id: 'st1', name: 's', order: 0 }] }];
  cap.stories = [
    { id: 's1', stepId: 'st1', order: 0, text: 'one', done: false },
    { id: 's2', stepId: 'st1', order: 1, text: 'two', done: false },
  ];
  cap.slices = [{ id: 'A', name: 'tour sched v1', order: 0, storyIds: ['s1'] }];
  assert.throws(
    () => patchCapability(cap, {
      slices: [
        { id: 'A', name: 'tour sched v1', order: 0, storyIds: ['s1'] },
        { id: 'B', name: 'B', order: 1, storyIds: ['s1', 's2'] },
      ],
    }),
    /tour sched v1/,
  );
});

test('patchCapability: an already-invalid slice is grandfathered', () => {
  const cap = createCapability('jefelabs', 'c');
  cap.activities = [{ id: 'a1', name: 'a', order: 0, steps: [{ id: 'st1', name: 's', order: 0 }] }];
  cap.stories = [{ id: 's1', stepId: 'st1', order: 0, text: 'one', done: false }];
  cap.slices = [{ id: 'OLD', name: 'slice test 3', order: 0, storyIds: [] }];
  const patched = patchCapability(cap, { name: 'renamed' });
  assert.equal(patched.name, 'renamed');
  assert.equal(patched.slices[0].storyIds.length, 0);
});

test('patchCapability: refuses a write that repairs one slice while breaking another', () => {
  const cap = createCapability('jefelabs', 'c');
  cap.activities = [{ id: 'a1', name: 'a', order: 0, steps: [{ id: 'st1', name: 's', order: 0 }] }];
  cap.stories = [
    { id: 's1', stepId: 'st1', order: 0, text: 'one', done: false },
    { id: 's2', stepId: 'st1', order: 1, text: 'two', done: false },
  ];
  // BROKEN owns nothing; HEALTHY owns s2. The write gives BROKEN a story and
  // takes HEALTHY's only exclusive one: the invalid COUNT stays at 1, so a
  // count-based check waves it through.
  cap.slices = [
    { id: 'BROKEN', name: 'broken', order: 0, storyIds: [] },
    { id: 'HEALTHY', name: 'healthy', order: 1, storyIds: ['s2'] },
  ];
  assert.throws(
    () => patchCapability(cap, {
      slices: [
        { id: 'BROKEN', name: 'broken', order: 0, storyIds: ['s1'] },
        { id: 'HEALTHY', name: 'healthy', order: 1, storyIds: ['s1', 's2'] },
      ],
    }),
    /healthy/,
  );
});
```

That last test is the reason the check is keyed by id. Before: `{BROKEN}`. After: `{HEALTHY}`. Both size 1.

- [ ] **Step 6: Run and watch them fail**

```bash
cd swarm && node --import tsx --test 'src/capabilities.test.ts'
```

Expected: the overlap test FAILS with `storyIds must be disjoint`; the two rejection tests FAIL because nothing throws.

- [ ] **Step 7: Replace the disjointness loop**

In `patchCapability`, replace the `claimed` loop (currently `capabilities.ts:135-142`) with:

```ts
  for (const slice of slices) {
    for (const id of slice.storyIds) {
      if (!storyIds.has(id)) throw new Error(`Slice "${slice.name}" references unknown story ${id}`);
    }
  }
  // Slices MAY overlap. What they may not do is leave a neighbour owning nothing
  // of its own — and because a slice is invalidated by what its neighbours hold,
  // the comparison is between the whole set before and the whole set after.
  //
  // Keyed by id, never by count: a write that repairs one slice while breaking
  // another leaves the count level and the set changed. Already-invalid slices
  // are grandfathered because two of them are live on the Plan and Deliver
  // boards, and deleting slices with cards would destroy work.
  const invalidBefore = new Set(slicesWithoutExclusiveStory(cap.slices).map((s) => s.id));
  const newlyInvalid = slicesWithoutExclusiveStory(slices).filter((s) => !invalidBefore.has(s.id));
  if (newlyInvalid.length > 0) {
    const names = newlyInvalid.map((s) => `"${s.name}"`).join(', ');
    throw new Error(`${names} would own no story that no other slice has — every slice needs one of its own`);
  }
```

Delete the now-unused `const claimed = new Set<string>();`.

Also update the `CapSlice.storyIds` doc comment, which still asserts the old invariant:

```ts
  /** May overlap other slices, but each slice must own at least one story no other slice has. A story in no slice is backlog. */
  storyIds: string[];
```

- [ ] **Step 8: Run the whole swarm suite**

```bash
cd swarm && node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/swarm.log 2>&1; echo "exit: $?"; grep -E "^ℹ (tests|pass|fail)" /tmp/swarm.log
```

Expected: exit 0, `fail 0`. Note the runner prints `ℹ tests`, **not** `# tests` — an empty grep here means your pattern is wrong, not that the suite is clean.

- [ ] **Step 9: Typecheck and commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit
git add swarm/src/capabilities.ts swarm/src/capabilities.test.ts
git commit -m "feat: slices may overlap, provided each owns a story of its own"
```

---

### Task 2: The client mirror

**Files:**
- Create: `control-plane/src/organisms/map/slices.ts`
- Test: `control-plane/src/organisms/map/slices.test.ts`

**Interfaces:**
- Consumes: `CapSliceT` from `control-plane/src/api/types.ts:213`.
- Produces: `slicesWithoutExclusiveStory(slices: CapSliceT[]): CapSliceT[]`, and `blockedBy(current: CapSliceT[], proposed: CapSliceT[]): CapSliceT[]` — the slices a proposed write would newly invalidate, empty when the write is allowed. Task 5 calls `blockedBy`.

- [ ] **Step 1: Write the failing test with the identical case table**

Create `control-plane/src/organisms/map/slices.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CapSliceT } from "../../api/types";
import { blockedBy, slicesWithoutExclusiveStory } from "./slices";

const sl = (id: string, storyIds: string[]): CapSliceT => ({ id, name: id, order: 0, storyIds });

describe("slicesWithoutExclusiveStory", () => {
  // The SAME table as swarm/src/capabilities.test.ts. These two copies of the rule
  // have no shared module; this table is what keeps them honest.
  const cases: Array<[string, CapSliceT[], string[]]> = [
    ["single slice owns everything", [sl("A", ["s1", "s2", "s3"])], []],
    ["overlap, each owns one", [sl("A", ["s1", "s2"]), sl("B", ["s2", "s3"])], []],
    ["identical single story", [sl("A", ["s1"]), sl("B", ["s1"])], ["A", "B"]],
    ["identical sets", [sl("A", ["s1", "s2"]), sl("B", ["s1", "s2"])], ["A", "B"]],
    ["subset", [sl("A", ["s1"]), sl("B", ["s1", "s2"])], ["A"]],
    ["storyless", [sl("A", [])], ["A"]],
    ["no slices at all", [], []],
    // FIXTURE CORRECTED IN TASK 1 — copy this row as written. The first draft was
    // A[s1] B[s2] C[s1,s2] expecting ["C"], but there A's only story is in C and B's
    // only story is in C, so nothing owns anything and the true answer is
    // ["A","B","C"]. Giving A and B a story of their own keeps the property this row
    // exists for: a slice invalidated by the COMBINATION of two neighbours that are
    // each healthy, which is what stops the check being rewritten as pairwise
    // containment. Must match swarm/src/capabilities.test.ts exactly.
    ["covered by two neighbours", [sl("A", ["s1", "s3"]), sl("B", ["s2", "s4"]), sl("C", ["s1", "s2"])], ["C"]],
  ];
  for (const [name, slices, invalid] of cases) {
    it(name, () => {
      expect(slicesWithoutExclusiveStory(slices).map((s) => s.id)).toEqual(invalid);
    });
  }
});

describe("blockedBy", () => {
  it("allows an overlapping write where every slice still owns something", () => {
    const before = [sl("A", ["s1", "s2"])];
    const after = [sl("A", ["s1", "s2"]), sl("B", ["s2", "s3"])];
    expect(blockedBy(before, after)).toEqual([]);
  });

  it("names the slice a write would strip", () => {
    const before = [sl("A", ["s1"])];
    const after = [sl("A", ["s1"]), sl("B", ["s1", "s2"])];
    expect(blockedBy(before, after).map((s) => s.id)).toEqual(["A"]);
  });

  it("grandfathers a slice that was already invalid", () => {
    const before = [sl("OLD", []), sl("A", ["s1"])];
    const after = [sl("OLD", []), sl("A", ["s1"]), sl("B", ["s2"])];
    expect(blockedBy(before, after)).toEqual([]);
  });

  it("catches a write that repairs one slice while breaking another", () => {
    // FIXTURE CORRECTED IN TASK 1 — match swarm/src/capabilities.test.ts exactly.
    // BROKEN gains an exclusive story (s1) AND takes HEALTHY's only exclusive one
    // (s2): invalid COUNT stays at 1 while the invalid SET flips {BROKEN} → {HEALTHY},
    // so a length comparison waves it through. That is the single thing this test
    // exists to fail.
    //
    // Two wrong versions to avoid. BROKEN[s1], HEALTHY[s1,s2] leaves s2 exclusive to
    // HEALTHY, so nothing breaks and nothing throws. BROKEN[s2], HEALTHY[s2] does
    // break HEALTHY, but BROKEN stays invalid too, so the count goes 1 → 2 and a
    // length check catches it — the test passes while proving nothing.
    const before = [sl("BROKEN", []), sl("HEALTHY", ["s2"])];
    const after = [sl("BROKEN", ["s1", "s2"]), sl("HEALTHY", ["s2"])];
    expect(blockedBy(before, after).map((s) => s.id)).toEqual(["HEALTHY"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd control-plane && pnpm vitest run src/organisms/map/slices.test.ts
```

Expected: FAIL — cannot resolve `./slices`.

- [ ] **Step 3: Implement the mirror**

Create `control-plane/src/organisms/map/slices.ts`:

```ts
/**
 * The slice-validity rule, client side.
 *
 * MIRROR of slicesWithoutExclusiveStory in swarm/src/capabilities.ts. That copy
 * is the authority — it decides what persists. This one exists only to disable a
 * button and name the reason, because the two packages share no module: there
 * are no tsconfig paths, no project references, and nothing in control-plane/src
 * imports from swarm/src. The wire types are duplicated the same way
 * (CapSliceT ↔ CapSlice).
 *
 * A duplicated rule is worse than a duplicated type: a type that drifts is
 * caught at the wire, a rule that drifts is caught by nobody — the server would
 * simply start refusing writes this file believes are fine. The identical case
 * table in slices.test.ts and capabilities.test.ts is what stands in for the
 * module they do not have. Change one, change both.
 */
import type { CapSliceT } from "../../api/types";

/**
 * Slices whose every story also appears in another slice, in input order.
 * Counts uses across the whole set first — marking duplicates while iterating
 * would report only the later of two identical slices, when both are equally
 * unowned.
 */
export function slicesWithoutExclusiveStory(slices: CapSliceT[]): CapSliceT[] {
  const uses = new Map<string, number>();
  for (const slice of slices) {
    for (const id of new Set(slice.storyIds)) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  return slices.filter((slice) => !slice.storyIds.some((id) => uses.get(id) === 1));
}

/**
 * The slices `proposed` would newly invalidate. Empty means the write is
 * allowed. Differential and keyed by id, never by count: a write that repairs
 * one slice while breaking another leaves the count level and the set changed.
 */
export function blockedBy(current: CapSliceT[], proposed: CapSliceT[]): CapSliceT[] {
  const invalidBefore = new Set(slicesWithoutExclusiveStory(current).map((s) => s.id));
  return slicesWithoutExclusiveStory(proposed).filter((s) => !invalidBefore.has(s.id));
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd control-plane && pnpm vitest run src/organisms/map/slices.test.ts
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/organisms/map/slices.ts control-plane/src/organisms/map/slices.test.ts
git commit -m "feat: mirror the slice-validity rule client side, with the shared case table"
```

---

### Task 3: Story nodes become selectable

**Files:**
- Modify: `control-plane/src/organisms/map/layout.ts` (the `MapNode` interface at `:242`, and the story-node emission at `:552`)
- Modify: `control-plane/src/organisms/MapStage.tsx` (the `<ReactFlow>` element, around `:750`)
- Test: `control-plane/src/organisms/map/layout.test.ts`

**Interfaces:**
- Consumes: the existing `MapNode` interface in `layout.ts` and the existing `<ReactFlow>` element in `MapStage.tsx`. Nothing from Tasks 1–2.
- Produces: `MapNode.selectable: boolean` — `true` only on real story nodes. Task 4 and Task 5 rely on React Flow reporting selected story ids.

- [ ] **Step 1: Write the failing test**

Add to `control-plane/src/organisms/map/layout.test.ts`:

```ts
describe("selectability", () => {
  it("only real story nodes are selectable", () => {
    const nodes = layoutMap(MODEL);
    const selectable = nodes.filter((n) => n.selectable).map((n) => n.id);
    const stories = nodes.filter((n) => n.type === "story" && !n.data.blank).map((n) => n.id);
    expect(selectable.sort()).toEqual(stories.sort());
  });

  it("a blank story card is NOT selectable — it is the composer, not an item", () => {
    const blanks = layoutMap(MODEL).filter((n) => n.type === "story" && n.data.blank);
    expect(blanks.length).toBeGreaterThan(0);
    expect(blanks.every((n) => n.selectable === false)).toBe(true);
  });

  it("activities and steps are not selectable — a lasso must not pick up scenery", () => {
    const scenery = layoutMap(MODEL).filter((n) => n.type === "activity" || n.type === "step");
    expect(scenery.every((n) => n.selectable === false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd control-plane && pnpm vitest run src/organisms/map/layout.test.ts
```

Expected: FAIL — `selectable` is `undefined` everywhere.

- [ ] **Step 3: Add the field and set it**

In `layout.ts`, add to the `MapNode` interface, below `draggable`:

```ts
  /**
   * Selection is how a slice is made, so only REAL story nodes carry it —
   * a lasso across the canvas must not pick up activities, steps, or the blank
   * composers, and a blank has no story id to put in a slice.
   */
  selectable: boolean;
```

Then set `selectable` on every node `layoutMap` emits: `false` for activities, steps, blanks and artifacts, and for real stories:

```ts
          selectable: true,
```

The compiler will name every omission once the field is non-optional — work through them until `tsc` is clean.

- [ ] **Step 4: Run it and watch it pass**

```bash
cd control-plane && pnpm vitest run src/organisms/map/layout.test.ts && ./node_modules/.bin/tsc --noEmit
```

Expected: PASS, typecheck clean.

- [ ] **Step 5: Turn on selection in React Flow**

On the `<ReactFlow>` element in `MapStage.tsx`, add:

```tsx
        nodesSelectable
        selectionOnDrag
        multiSelectionKeyCode="Shift"
        selectionKeyCode={null}
        panOnDrag={[1, 2]}
```

`selectionOnDrag` with `panOnDrag={[1, 2]}` gives left-drag-to-lasso and middle/right-drag-to-pan. `selectionKeyCode={null}` means the lasso needs no modifier. React Flow only honours these on nodes whose `selectable` is true, which Step 3 restricted to real stories.

- [ ] **Step 6: Verify in a real browser**

```bash
open http://127.0.0.1:1420/#/map
```

Drag across two story cards: both show React Flow's selected outline. Drag across an activity: nothing selects. Middle-drag: the canvas pans. Confirm dragging a story by its title still reorders — selection must not have eaten the drag.

- [ ] **Step 7: Full suite and commit**

```bash
cd control-plane && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/biome check . && pnpm vitest run > /tmp/cp.log 2>&1; echo "exit: $?"; grep -E "Test Files|Tests " /tmp/cp.log
git add control-plane/src/organisms/map/layout.ts control-plane/src/organisms/map/layout.test.ts control-plane/src/organisms/MapStage.tsx
git commit -m "feat: story nodes are selectable, scenery is not"
```

---

### Task 4: The slice panel, listing and highlighting

**Files:**
- Create: `control-plane/src/organisms/map/SlicePanel.tsx`
- Modify: `control-plane/src/organisms/MapStage.tsx` (mount the panel inside `<ReactFlow>`)
- Modify: `control-plane/src/styles/components.css`
- Test: `control-plane/src/organisms/MapStage.test.tsx`

**Interfaces:**
- Consumes: `CapSliceT`; `slicesWithoutExclusiveStory` from Task 2; the existing `decorate(base: MapNode[], dimmedIds: Set<string>): Node[]` in `MapStage.tsx:463`; `storyNodeId` from `layout.ts`.
- Produces: `<SlicePanel>` with props `{ slices, invalidIds, activeSliceId, onHover, onOpen, footer }`. Task 5 supplies `footer`.

**The panel collapses.** It floats over the canvas, so it must be able to get out of the way — collapsed it is a single header row carrying the slice count, and it holds no hover state while collapsed.

- [ ] **Step 1: Write the failing test**

Add to `control-plane/src/organisms/MapStage.test.tsx`:

```ts
it("lists every slice with its story count", async () => {
  renderMap();
  const panel = await screen.findByRole("region", { name: "Slices" });
  expect(within(panel).getByText("tour scheduling v1")).toBeDefined();
  expect(within(panel).getByText("2")).toBeDefined();
});

it("hovering a slice dims every story it does not own", async () => {
  renderMap();
  const panel = await screen.findByRole("region", { name: "Slices" });
  await userEvent.hover(within(panel).getByText("tour scheduling v1"));
  await waitFor(() => {
    expect(document.querySelector('[data-id="s3"]')?.className).toMatch(/dimmed/);
  });
  expect(document.querySelector('[data-id="s1"]')?.className).not.toMatch(/dimmed/);
});

it("marks a grandfathered slice that owns nothing", async () => {
  renderMap();
  const panel = await screen.findByRole("region", { name: "Slices" });
  const row = within(panel).getByText("empty legacy").closest("li");
  expect(row?.getAttribute("data-invalid")).toBe("true");
});

it("collapses to a header carrying the count, and hides the list", async () => {
  renderMap();
  const panel = await screen.findByRole("region", { name: "Slices" });
  const toggle = within(panel).getByRole("button", { name: /collapse slices/i });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(toggle);
  expect(within(panel).queryByText("tour scheduling v1")).toBeNull();
  expect(within(panel).getByText("3")).toBeDefined();
  expect(within(panel).getByRole("button", { name: /expand slices/i })).toBeDefined();
});

it("collapsing clears any hover highlight rather than stranding it", async () => {
  renderMap();
  const panel = await screen.findByRole("region", { name: "Slices" });
  await userEvent.hover(within(panel).getByText("tour scheduling v1"));
  await waitFor(() => expect(document.querySelector('[data-id="s3"]')?.className).toMatch(/dimmed/));
  await userEvent.click(within(panel).getByRole("button", { name: /collapse slices/i }));
  await waitFor(() => expect(document.querySelector('[data-id="s3"]')?.className).not.toMatch(/dimmed/));
});
```

Extend the test fixture with a third slice `{ id: "sl3", name: "empty legacy", order: 2, storyIds: [] }` so the grandfathered case has something to render.

The second collapse test is the one that matters. Hover state lives in `MapStage`, the list lives in the panel — unmounting the list does **not** fire `onMouseLeave`, so without an explicit clear the map stays dimmed against a slice the user can no longer see or un-hover.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd control-plane && pnpm vitest run src/organisms/MapStage.test.tsx
```

Expected: FAIL — no region named `Slices`.

- [ ] **Step 3: Build the panel**

Create `control-plane/src/organisms/map/SlicePanel.tsx`:

```tsx
import { Panel } from "@xyflow/react";
import type { ReactNode } from "react";
import type { CapSliceT } from "../../api/types";

interface Props {
  slices: CapSliceT[];
  /** Ids of slices owning no exclusive story — grandfathered, marked, not hidden. */
  invalidIds: Set<string>;
  activeSliceId: string | null;
  /** Null on mouse-out. Drives dimming through MapStage's existing decorate seam. */
  onHover: (sliceId: string | null) => void;
  onOpen: (sliceId: string) => void;
  /** Task 5's create control. Rendered below the list, inside the same panel. */
  footer?: ReactNode;
}

/**
 * Slices, floating over the canvas rather than laid out on it.
 *
 * Slices OVERLAP now, so there is no geometry that can show membership: a story
 * in two slices belongs to no single band, and edges from several slices into one
 * node draw a hairball. Hover highlighting sidesteps that — two slices sharing a
 * story are two highlights over the same node, one at a time, no layout conflict.
 *
 * Clicking still opens the band beneath the map. Only one band is open at a time,
 * so a shared story simply appears in whichever slice you opened.
 */
export function SlicePanel({ slices, invalidIds, activeSliceId, onHover, onOpen, footer }: Props) {
  const [open, setOpen] = useState(true);

  // Collapsing UNMOUNTS the list, and an unmounted element fires no onMouseLeave.
  // Without this the map stays dimmed against a slice the user can no longer see,
  // with no way to clear it short of re-expanding and hovering something else.
  const toggle = () => {
    setOpen((wasOpen) => {
      if (wasOpen) onHover(null);
      return !wasOpen;
    });
  };

  return (
    <Panel position="top-right" className="slice-panel">
      <section aria-label="Slices" data-open={open ? "true" : "false"}>
        <header className="slice-panel__head">
          <button
            type="button"
            className="slice-panel__toggle"
            aria-expanded={open}
            aria-label={open ? "Collapse slices" : "Expand slices"}
            onClick={toggle}
          >
            <span className="slice-panel__title">Slices</span>
            <span className="slice-panel__total">{slices.length}</span>
            <span className="slice-panel__chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
        </header>
        {!open ? null : (
        <>
        <ul className="slice-panel__list" onMouseLeave={() => onHover(null)}>
          {slices.map((slice) => (
            <li
              key={slice.id}
              data-invalid={invalidIds.has(slice.id) ? "true" : undefined}
              className={slice.id === activeSliceId ? "is-open" : undefined}
            >
              <button
                type="button"
                onMouseEnter={() => onHover(slice.id)}
                onFocus={() => onHover(slice.id)}
                onClick={() => onOpen(slice.id)}
              >
                <span className="slice-panel__name">{slice.name}</span>
                <span className="slice-panel__count">{slice.storyIds.length}</span>
                {invalidIds.has(slice.id) && (
                  <span
                    className="slice-panel__warn"
                    title="Every story here belongs to another slice too. Give it one of its own."
                  >
                    ⚠
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {footer}
        </>
        )}
      </section>
    </Panel>
  );
}
```

Import `useState` from `react` alongside the existing `ReactNode` type import.

- [ ] **Step 4: Mount it and wire hover to the existing dim seam**

In `MapStage.tsx`, add state and derive the dim set. **Extend `dimmedIds`; do not add a second path** — the comment at `MapStage.tsx:450` is explicit that dimming arrives as an argument rather than a closure, and that this is what keeps `decorate` a function of `cap` alone.

```tsx
  const [hoveredSliceId, setHoveredSliceId] = useState<string | null>(null);

  // Hovering a slice dims every story it does NOT own. Same argument-passed dim
  // set the slice reveal already uses, so there is one dimming mechanism.
  const hoverDimmed = useMemo(() => {
    if (!hoveredSliceId || !cap) return new Set<string>();
    const owned = new Set(cap.slices.find((s) => s.id === hoveredSliceId)?.storyIds ?? []);
    return new Set(cap.stories.filter((s) => !owned.has(s.id)).map((s) => storyNodeId(s.id)));
  }, [hoveredSliceId, cap]);
```

Union `hoverDimmed` into the set already passed to `decorate`, and render inside `<ReactFlow>`:

```tsx
          <SlicePanel
            slices={cap.slices}
            invalidIds={new Set(slicesWithoutExclusiveStory(cap.slices).map((s) => s.id))}
            activeSliceId={activeSliceId}
            onHover={setHoveredSliceId}
            onOpen={setActiveSliceId}
          />
```

- [ ] **Step 5: Style it**

In `components.css`, in the same layer as the other map rules:

```css
.slice-panel {
  background: var(--pill);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px;
  min-width: 200px;
  max-height: 60%;
  overflow-y: auto;
}
/* Collapsed, the panel is one header row — min-width drops so it stops covering
   the canvas it floats over. */
.slice-panel:has([data-open="false"]) { min-width: 0; }
.slice-panel__head { margin-bottom: 6px; }
.slice-panel:has([data-open="false"]) .slice-panel__head { margin-bottom: 0; }
.slice-panel__toggle {
  display: flex; align-items: center; gap: 6px; width: 100%;
  background: none; border: none; padding: 2px 4px; cursor: pointer;
}
.slice-panel__title { font-size: 11px; color: var(--text-2); margin: 0; flex: 1 1 auto; text-align: left; }
.slice-panel__total { font-size: 11px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.slice-panel__chevron { font-size: 9px; color: var(--text-2); }
.slice-panel__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.slice-panel__list button {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 4px 6px; border-radius: 6px; background: none; border: none;
  color: var(--text); cursor: pointer; text-align: left;
}
.slice-panel__list button:hover { background: var(--surface); }
.slice-panel__list .is-open button { background: var(--surface); box-shadow: inset 2px 0 0 var(--accent); }
.slice-panel__name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slice-panel__count { flex: 0 0 auto; color: var(--text-2); font-variant-numeric: tabular-nums; }
.slice-panel__warn { flex: 0 0 auto; color: var(--warn, #d9a441); }
```

- [ ] **Step 6: Run and watch them pass**

```bash
cd control-plane && pnpm vitest run src/organisms/MapStage.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Verify in a real browser**

```bash
open http://127.0.0.1:1420/#/map
```

Hover a slice: its stories stay lit, everything else dims. Move away: dimming clears. Click: the band opens beneath the map as before. Confirm the panel does not block canvas panning at its edges.

- [ ] **Step 8: Full suite and commit**

```bash
cd control-plane && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/biome check . && pnpm vitest run > /tmp/cp.log 2>&1; echo "exit: $?"; grep -E "Test Files|Tests " /tmp/cp.log
git add control-plane/src/organisms/map/SlicePanel.tsx control-plane/src/organisms/MapStage.tsx control-plane/src/organisms/MapStage.test.tsx control-plane/src/styles/components.css
git commit -m "feat: a floating slice panel, hover to see what a slice owns"
```

---

### Task 5: Make a slice from the selection, and retire the name box

**Files:**
- Modify: `control-plane/src/organisms/map/SlicePanel.tsx` (footer)
- Modify: `control-plane/src/organisms/MapStage.tsx` (`addSlice` at `:426`, the `New slice name…` input at `:948-955`)
- Test: `control-plane/src/organisms/MapStage.test.tsx`

**Interfaces:**
- Consumes: `blockedBy` from Task 2; `<SlicePanel footer>` from Task 4; React Flow's `useOnSelectionChange`.
- Produces: nothing downstream — this task closes the feature.

- [ ] **Step 1: Write the failing tests**

```ts
it("creating a slice from the selection sends one PATCH with the whole array", async () => {
  const patch = vi.fn().mockResolvedValue({ ok: true });
  renderMap({ patchCapability: patch });
  await selectStories(["s1", "s2"]);
  const panel = await screen.findByRole("region", { name: "Slices" });
  await userEvent.click(within(panel).getByRole("button", { name: /slice from 2 selected/i }));
  await userEvent.type(screen.getByPlaceholderText("Name this slice…"), "analytics v2{Enter}");
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  const body = patch.mock.calls[0][1];
  expect(body.slices).toHaveLength(4);
  expect(body.slices.at(-1)).toMatchObject({ name: "analytics v2", storyIds: ["s1", "s2"] });
});

it("disables the button and names the slice a selection would strip", async () => {
  renderMap();
  // s1 is tour scheduling v1's only exclusive story.
  await selectStories(["s1"]);
  const panel = await screen.findByRole("region", { name: "Slices" });
  expect(within(panel).getByRole("button", { name: /slice from 1 selected/i })).toHaveProperty("disabled", true);
  expect(within(panel).getByText(/tour scheduling v1/)).toBeDefined();
});

it("blames the selection, not a neighbour, when only the NEW slice would be invalid", async () => {
  renderMap();
  // Every selected story is already in some slice, but each of those slices keeps
  // an exclusive story of its own — so nothing is taken and no neighbour is named.
  await selectStories(["s1", "s2"]);
  const panel = await screen.findByRole("region", { name: "Slices" });
  expect(within(panel).getByRole("button", { name: /slice from 2 selected/i })).toHaveProperty("disabled", true);
  expect(within(panel).getByText(/already belongs to another slice/i)).toBeDefined();
  expect(within(panel).queryByText(/is the only story/i)).toBeNull();
});

it("offers nothing when nothing is selected", async () => {
  renderMap();
  const panel = await screen.findByRole("region", { name: "Slices" });
  expect(within(panel).queryByRole("button", { name: /slice from/i })).toBeNull();
});

it("the New slice name box is gone — selection is the only way a slice is born", async () => {
  renderMap();
  await screen.findByRole("region", { name: "Slices" });
  expect(screen.queryByPlaceholderText("New slice name…")).toBeNull();
});
```

Add a `selectStories` helper to the test file that dispatches React Flow selection by setting `selected: true` on the named nodes.

- [ ] **Step 2: Run and watch them fail**

```bash
cd control-plane && pnpm vitest run src/organisms/MapStage.test.tsx
```

Expected: FAIL — no create button; the `New slice name…` box still exists.

- [ ] **Step 3: Track the selection**

In `MapStage.tsx`:

```tsx
  const [selectedStoryIds, setSelectedStoryIds] = useState<string[]>([]);

  // Only real story nodes are selectable (Task 3), so anything React Flow reports
  // here is already a story — no filtering by type, and no second source of truth.
  useOnSelectionChange({
    onChange: ({ nodes: sel }) => setSelectedStoryIds(sel.map((n) => n.id)),
  });
```

- [ ] **Step 3b: Add `storiesLost` to `slices.ts` — the message needs a second differential**

The designed copy names a slice **and a story**: `⚠ "book a tour" is the only story tour sched v1 owns.` `blockedBy` cannot answer the story half. A blocked slice has no exclusive story in `proposed` **by definition**, so asking `proposed` alone always returns the empty set. The answer is differential the same way validity is: which stories did this slice hold exclusively *before*, and no longer hold exclusively *after*.

It lives in `slices.ts` beside `blockedBy` so the counting logic has one home rather than three.

Test first, in `control-plane/src/organisms/map/slices.test.ts`:

```ts
describe("storiesLost", () => {
  it("names the story a neighbour took, not merely one they share", () => {
    // X owned s1 alone and also shared s2 with Y. The new slice takes BOTH.
    // Only s1 was ever exclusive, so only s1 was lost — a `find` over the
    // selection names whichever comes first and is wrong half the time.
    const current = [sl("X", ["s1", "s2"]), sl("Y", ["s2", "s3"])];
    const proposed = [...current, sl("NEW", ["s1", "s2"])];
    expect(storiesLost(current, proposed, current[0])).toEqual(["s1"]);
  });

  it("returns every exclusive story lost, not just the first", () => {
    const current = [sl("X", ["s1", "s2"])];
    const proposed = [...current, sl("NEW", ["s1", "s2"])];
    expect(storiesLost(current, proposed, current[0])).toEqual(["s1", "s2"]);
  });

  it("names the story even when the slice was emptied rather than raided", () => {
    // X is emptied outright. It still LOST s1 as an exclusive story — it no
    // longer holds it at all — so the story is nameable here too.
    const current = [sl("X", ["s1"]), sl("Y", ["s2"])];
    const proposed = [sl("X", []), sl("Y", ["s2"])];
    expect(storiesLost(current, proposed, current[0])).toEqual(["s1"]);
  });

  it("is never empty for a blocked slice that EXISTED before the write", () => {
    // Asserted rather than assumed. Note the quantifier: pre-existing slices
    // only. The first version of this search permuted just X and Y — slices
    // present in both states — so it could not reach a CREATED slice, and
    // "never empty" looked universal when it is not. See the next test.
    const sets = ["s1", "s2", "s3"].reduce<string[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
    let examined = 0;
    for (const a of sets) for (const b of sets) for (const c of sets) for (const d of sets) {
      const current = [sl("X", a), sl("Y", b)];
      const proposed = [sl("X", c), sl("Y", d)];
      for (const slice of blockedBy(current, proposed)) {
        examined++;
        expect(storiesLost(current, proposed, slice).length).toBeGreaterThan(0);
      }
    }
    expect(examined).toBeGreaterThan(0);
  });

  it("IS empty for a newly created blocked slice — the feature's main flow", () => {
    // The case table's own last row, turned into a creation. A and B stay
    // healthy; C is blocked because every story selected for it is already
    // spoken for. C lost nothing — it never had anything — so no story can be
    // named and nothing was taken from anyone. This is why the panel copy
    // branches on whether the blocked slice is new.
    const current = [sl("A", ["s1", "s3"]), sl("B", ["s2", "s4"])];
    const proposed = [...current, sl("C", ["s1", "s2"])];
    expect(blockedBy(current, proposed).map((s) => s.id)).toEqual(["C"]);
    expect(storiesLost(current, proposed, proposed[2])).toEqual([]);
    // and the neighbours are untouched, so there is no victim to name either
    expect(slicesWithoutExclusiveStory(proposed).map((s) => s.id)).toEqual(["C"]);
  });
});
```

Then implement:

```ts
/**
 * Stories `slice` held exclusively in `current` and no longer holds exclusively
 * in `proposed` — the "what was taken" behind a blockedBy verdict.
 *
 * Differential for the same reason blockedBy is: in `proposed` a blocked slice
 * has NO exclusive story, so `proposed` alone can never name what it lost.
 *
 * NON-EMPTY for a blocked slice THAT EXISTED IN `current`: it was valid before,
 * so it held an exclusive story, and is invalid after, so it holds none.
 *
 * EMPTY for a blocked slice the write CREATES — and that is this feature's main
 * flow, not an edge case. A new slice held nothing before, so the premise above
 * is unavailable: it lost nothing, and its neighbours may all still be healthy.
 * Creating C[s1,s2] over A[s1,s3] B[s2,s4] blocks C while A and B stay valid, so
 * there is no "you took X from Y" to report. Callers MUST branch on whether the
 * blocked slice is new; see the panel copy in Task 5.
 *
 * Both halves are pinned by tests rather than left as reasoning.
 */
export function storiesLost(current: CapSliceT[], proposed: CapSliceT[], slice: CapSliceT): string[] {
  const exclusiveIn = (slices: CapSliceT[], id: string): Set<string> => {
    const uses = new Map<string, number>();
    for (const s of slices) for (const sid of new Set(s.storyIds)) uses.set(sid, (uses.get(sid) ?? 0) + 1);
    const self = slices.find((s) => s.id === id);
    return new Set((self?.storyIds ?? []).filter((sid) => uses.get(sid) === 1));
  };
  const after = exclusiveIn(proposed, slice.id);
  return [...exclusiveIn(current, slice.id)].filter((sid) => !after.has(sid));
}
```

Run: `pnpm vitest run src/organisms/map/slices.test.ts` — red on the missing export first, then green.

- [ ] **Step 4: Build the composer**

`SliceComposer` is a **second export from `SlicePanel.tsx`**, not a change to `SlicePanel`'s own markup. `MapStage` renders it and passes the element as the `footer` prop Task 4 already added — so the panel keeps knowing nothing about selection, and the composer disappears with the list when the panel is collapsed.

Add to `SlicePanel.tsx`:

```tsx
interface FooterProps {
  count: number;
  /** Slices this selection would strip. Non-empty disables the button. */
  blocked: CapSliceT[];
  blockingStory: string | null;
  naming: boolean;
  onStart: () => void;
  onName: (name: string) => void;
}

export function SliceComposer({ count, blocked, blockingStory, naming, onStart, onName }: FooterProps) {
  if (count === 0) return null;
  if (naming) {
    return (
      <input
        className="slice-panel__name-input"
        placeholder="Name this slice…"
        // biome-ignore lint/a11y/noAutofocus: the button that revealed this input is gone from the DOM,
        // so focus would otherwise land on <body> and the gesture would stall mid-flow.
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") onName((e.target as HTMLInputElement).value.trim());
        }}
      />
    );
  }
  return (
    <div className="slice-panel__composer">
      <button type="button" disabled={blocked.length > 0} onClick={onStart}>
        + slice from {count} selected
      </button>
      {blocked.length > 0 && (
        <p className="slice-panel__blocked">
          {/* TWO FORMS, split by whether the blocked slice is the one being created.
              Creating a slice whose every story is already spoken for takes nothing
              from anyone — the neighbours stay healthy and there is no victim to
              name, so the honest sentence is about the selection. That is also the
              more actionable one: the fix is to change what you selected. */}
          {blockingStory
            ? `"${blockingStory}" is the only story ${blocked.map((s) => s.name).join(", ")} owns.`
            : "Every story you selected already belongs to another slice — add one that does not."}
        </p>
      )}
    </div>
  );
}
```

In `MapStage.tsx`, declare the naming state, compute the block, and pass the composer in as `footer`:

```tsx
  const [naming, setNaming] = useState(false);
```

```tsx
          <SlicePanel
            /* …props from Task 4… */
            footer={
              <SliceComposer
                count={selectedStoryIds.length}
                blocked={blocked}
                blockingStory={blockingStory}
                naming={naming}
                onStart={() => setNaming(true)}
                onName={createSliceFromSelection}
              />
            }
          />
```


```tsx
  const proposed = useMemo(
    () =>
      cap
        ? [...cap.slices, { id: "__proposed__", name: "", order: cap.slices.length, storyIds: selectedStoryIds }]
        : [],
    [cap, selectedStoryIds],
  );
  const blocked = cap ? blockedBy(cap.slices, proposed) : [];
  // The stories the blocked slice is LOSING — a second differential, this time over
  // stories. See Step 3b; do not reach for a `find` over the selection, which names
  // whichever story happens to come first and is wrong whenever the selection also
  // takes a story that was already shared.
  const lost = blocked.length > 0 && cap ? storiesLost(cap.slices, proposed, blocked[0]) : [];
  const blockingStory = lost.length > 0 ? (cap?.stories.find((s) => s.id === lost[0])?.text ?? null) : null;
```

Create on naming:

```tsx
  const createSliceFromSelection = (name: string) => {
    if (!cap || !name || selectedStoryIds.length === 0) return;
    void patchCap({
      slices: [...cap.slices, { id: crypto.randomUUID(), name, order: cap.slices.length, storyIds: selectedStoryIds }],
    });
    setNaming(false);
  };
```

- [ ] **Step 5: Delete the old path**

Remove `addSlice` (`MapStage.tsx:426-433`) and the `slice-band--composer` block containing `placeholder="New slice name…"` (`:947-955`). Remove `sliceName` from the form's `register`/`getValues`/`setValue` usage and from its type if it is now unused.

Name the reason in the commit rather than only the diff: a name-only slice has no stories, owns nothing, and is invalid the moment it is created. Keeping the box means the app's most-used path produces exactly the state the rule forbids.

- [ ] **Step 6: Run and watch them pass**

```bash
cd control-plane && pnpm vitest run src/organisms/MapStage.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Verify the whole gesture in a real browser**

```bash
open http://127.0.0.1:1420/#/map
```

1. Lasso two stories → panel shows `+ slice from 2 selected`.
2. Click it, type a name, Enter → the slice appears in the panel with count 2.
3. Hover it → exactly those two stay lit.
4. Select a story that is another slice's only exclusive one → button disabled, message names that slice and story.
5. Confirm no `New slice name…` box exists anywhere.
6. Confirm dragging a story still reorders, and dragging an activity still reorders — selection must not have eaten either gesture.

- [ ] **Step 8: Both suites, then commit**

```bash
cd control-plane && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/biome check . && pnpm vitest run > /tmp/cp.log 2>&1; echo "cp exit: $?"; grep -E "Test Files|Tests " /tmp/cp.log
cd ../swarm && node --import tsx --test --test-timeout 60000 'src/*.test.ts' 'src/**/*.test.ts' > /tmp/sw.log 2>&1; echo "swarm exit: $?"; grep -E "^ℹ (tests|pass|fail)" /tmp/sw.log
git add control-plane/src/organisms/map/SlicePanel.tsx control-plane/src/organisms/MapStage.tsx control-plane/src/organisms/MapStage.test.tsx control-plane/src/styles/components.css
git commit -m "feat: slices are made by selecting their stories; the name box is gone"
```

---

## Deferred

**Ideation → capability promotion.** A confirmed card on the Ideation board becomes a capability on the map, while a slice remains what goes to Plan. Named as out of scope in the spec; needs its own spec and plan.

**Removing a story from a slice, and deleting a slice.** Both already ride the same PATCH and the same predicate, so neither needs new validation — but neither gets new UI here.
