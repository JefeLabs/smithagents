# Story Map Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Claimed by:** unclaimed — claim this header before executing

**Goal:** Replace `MapStage`'s dnd-kit flex grid with an `@xyflow/react` canvas giving
pan/zoom, on-demand traceability edges, and one drag system that is correct at any zoom.

**Architecture:** The capability model is the source of truth. `layoutMap(model)`
derives node positions; `cellAt(pos, model)` is its exact inverse and resolves a drop
back to `{ stepId, order }`. Positions never reach the server. Slice bands stay in the
DOM; selecting one materializes a read-only anchor node plus artifact nodes and draws
edges, which vanish on deselect.

**Tech Stack:** React 19, Vite 6, TypeScript, Vitest 4 + jsdom, Testing Library,
Biome, pnpm, TanStack Query. Adding: `@xyflow/react`.

**Spec:** `docs/superpowers/specs/2026-08-08-story-map-canvas-design.md`

## Global Constraints

- Package manager is **pnpm**, run from `control-plane/`. Never `npm`.
- `layout.ts` must import **nothing** from React or `@xyflow/react`. That is what makes
  the inverse property testable without a DOM, and it is not negotiable.
- Positions are **never** persisted. `CapStoryT` gains no `x`/`y`. The server model
  shape is unchanged.
- Slice bands (`MapStage.tsx:553-619`) stay in the DOM, unchanged. Three existing tests
  query `{ selector: ".slice-band__name" }` and must keep passing untouched.
- `fireStoryDrop` (`MapStage.tsx:102-106`) is preserved as the test seam. jsdom cannot
  synthesize xyflow pointer drags any more than dnd-kit ones.
- dnd-kit stays in the repo for `BoardStage` and `AgentRoster`. It leaves `MapStage` only.
- Geometry constants live only in `layout.ts`. Node CSS is written to match them, never
  the reverse.
- Verification from `control-plane/`: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
  All three pass before any task is done.
- Commit after every task with `git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents`,
  verifying the reported `[branch hash]` and file count.

---

## File Structure

**Created:**
- `control-plane/src/organisms/map/layout.ts` — geometry constants, `stepColumns`,
  `layoutMap`, `cellAt`. Pure. No React, no xyflow.
- `control-plane/src/organisms/map/layout.test.ts`
- `control-plane/src/organisms/map/nodes.tsx` — the five node components + `nodeTypes`.
- `control-plane/src/organisms/map/nodes.test.tsx`
- `control-plane/src/organisms/map/edges.ts` — `buildEdges`, `visibleEdgeIds`.
- `control-plane/src/organisms/map/edges.test.ts`
- `control-plane/src/organisms/map/useMapSelection.ts` — selection state.

**Modified:**
- `control-plane/src/api/types.ts` — receives the `Cap*T` types
- `control-plane/src/organisms/MapStage.tsx` — grid → canvas; dnd-kit removed
- `control-plane/src/queries/work.ts:15`, `control-plane/src/api/work.ts:17` — import fix
- `control-plane/src/styles/components.css` — `.map-story` fixed height
- `control-plane/package.json`

---

### Task 1: Pure layout module

**Files:**
- Modify: `control-plane/src/api/types.ts`
- Modify: `control-plane/src/organisms/MapStage.tsx` (type definitions out, import in)
- Modify: `control-plane/src/queries/work.ts:15`, `control-plane/src/api/work.ts:17`
- Create: `control-plane/src/organisms/map/layout.ts`
- Create: `control-plane/src/organisms/map/layout.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `api/types.ts` exports `CapStoryT`, `CapActivityT`, `CapSliceT`, `CapabilityT`.
  - `layout.ts` exports `STEP_W`, `STEP_GAP`, `ACTIVITY_GAP`, `STORY_H`, `STORY_GAP`,
    `COL_GAP`, `ACTIVITY_H`, `STEP_HEAD_H`, `STORIES_Y`, `SLOT_H`, `SLICE_RAIL_X`,
    `ARTIFACT_GAP`, plus:
    - `stepColumns(activities: CapActivityT[]): Array<{ stepId: string; x: number }>`
    - `layoutMap(model: MapModel): { nodes: MapNode[] }`
    - `cellAt(pos: { x: number; y: number }, model: MapModel): { stepId: string; order: number } | null`
    - `interface MapModel { activities: CapActivityT[]; stories: CapStoryT[]; slices: CapSliceT[] }`
    - `type MapNode = { id: string; type: "activity" | "step" | "story"; position: { x: number; y: number }; data: Record<string, unknown>; draggable: boolean; dragHandle?: string }`

**TASK 1 IS NOT EXECUTABLE AS WRITTEN — three gaps, found in a coherence scan on
2026-08-09 after Edwin's blank-card and visual-target rulings. Fix these before dispatching
it; an implementer following the signatures above will build something the later tasks
cannot use.**

**Gap A — `MapNode` cannot express a spanning activity.** The visual target requires each
activity card to span the group of steps beneath it, but `MapNode` carries only
`position`. Width is not derivable by the node component: it depends on the activity's step
count and on `STEP_W`/`STEP_GAP`, which are `layout.ts`'s constants and must not be
duplicated in CSS (see Global Constraints — "Geometry constants live only in `layout.ts`").
So `MapNode` gains a width:

```ts
type MapNode = {
  id: string;
  type: "activity" | "step" | "story";
  position: { x: number; y: number };
  /** Set for activities, which span their step group; steps and stories use STEP_W. */
  width?: number;
  data: Record<string, unknown>;
  draggable: boolean;
  dragHandle?: string;
};
```

`layoutMap` computes it as `steps.length * STEP_W + (steps.length - 1) * STEP_GAP`. An
activity with one step is exactly `STEP_W` wide — assert that case, it is the boundary
where a wrong `- 1` disappears.

**Gap B — blank cards have no representation.** Every level ends with an empty card, and
the amendment above forbids an `isDraft` field on the model. So blankness is a LAYOUT
concern and `layoutMap` must emit these cells itself. Requirements, all three testable:

1. **Synthetic ids, never colliding with real ones.** Use a reserved prefix — `new:activity`,
   `new:step:<activityId>`, `new:story:<stepId>`. A real id must never begin `new:`.
2. **`data.blank: true` and `draggable: false`.** The node component branches on `blank` to
   render an input instead of text; `draggable: false` is what keeps it out of drag.
3. **`cellAt` must never resolve to a blank COLUMN.** *(Corrected 2026-08-09 — the first
   wording of this item said "must not return a blank cell", which was wrong. It conflated
   two different blanks that deserve opposite answers.)*

   - A blank **story slot** at index `count` is NOT a nonexistent cell. The step exists and
     `order = count` is an ordinary append. Rejecting it would delete drag-to-end-of-column
     outright; rejecting only `slot == count` while `slot >= count + 1` still appends would
     carve a **non-monotonic dead zone** into the middle of a drag — a control that stops
     working in a band and resumes past it. Worse than the bug being guarded against.
   - A blank **column** (`new:step:*`, `new:activity`) IS the hazard: it means "file this
     story under a step that does not exist," which cannot be persisted.

   So: `cellAt` finds the nearest column over the full list **including** blanks, and
   returns `null` when the nearest is blank. Real story nodes keep an exact inverse, append
   keeps working, and the rule is monotonic across the whole gesture.

   **The guard test:** drop at the blank step column's CENTRE (`blankX + STEP_W / 2`) and
   assert `null`. The centre matters — at the edge, the `±STEP_W` nearest-column margin
   could produce the `null` on its own and the test would prove nothing.

4. **Zero-step activities must render.** `Math.max(steps.length, 1)` in both terms of the
   width. The raw formula gives `-8` at zero steps, and typing into the blank activity card
   produces exactly a zero-step activity — so the headline creation flow rendered nothing.
   One step must still be exactly `STEP_W`. Pin 0, 1 and 2 steps.

5. **Blank cells need reserved space.** `stepColumns`' cursor must advance a full slot per
   activity for its trailing blank (`STEP_W + STEP_GAP`, then `ACTIVITY_GAP - STEP_GAP`),
   or blank columns overlap the next activity's real ones by 176px. `stepColumns` keeps its
   public signature returning REAL columns only; an internal `columns()` returns
   `{stepId, x, blank}` that BOTH `layoutMap` and `cellAt` consume, so the two cannot drift.

**Gap C — the capability level is deliberately NOT in `layoutMap`.** Edwin's rule covers
capability too, but the capability row lives in the stage header, not on the canvas (the
OPEN item above; recommended (b)). So `MapModel` is unchanged and Task 1 owns none of it.
Stated explicitly because "the rule is universal" otherwise reads as "add a fourth node
type", which would be wrong. **If Edwin picks (a) instead, Task 1 changes and this note is
void.**

**Why the type move:** `queries/work.ts` and `api/work.ts` import `CapabilityT` from an
**organism**, inverting the dependency direction. `layout.ts` needs those types and must
not import a React component to get them. Moving them to `api/types.ts`, where
`WorkspaceRecord` and `ConnectorInstanceRecord` already live, fixes both at once.

- [ ] **Step 1: Move the capability types to `api/types.ts`**

Cut these four interfaces from `control-plane/src/organisms/MapStage.tsx` (they begin
around line 29) and paste them into `control-plane/src/api/types.ts`, adding `export`
to each: `CapStoryT`, `CapActivityT`, `CapSliceT`, `CapabilityT`.

In `MapStage.tsx`, replace them with an import:

```ts
import type { CapabilityT, CapActivityT, CapSliceT, CapStoryT } from "../api/types";
```

In `control-plane/src/queries/work.ts` line 15 and `control-plane/src/api/work.ts`
line 17, change:

```ts
import type { CapabilityT } from "../organisms/MapStage";
```

to:

```ts
import type { CapabilityT } from "../api/types";
```

- [ ] **Step 2: Verify the move changed nothing**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane
pnpm typecheck && pnpm test
```

Expected: all pass, same test count as before. This is a pure move.

- [ ] **Step 3: Write the failing layout test**

Create `control-plane/src/organisms/map/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MapModel } from "./layout";
import { cellAt, layoutMap, SLOT_H, STEP_W, STORIES_Y, stepColumns } from "./layout";

/** Two activities: the first has two steps, the second has one. Exercises ACTIVITY_GAP. */
const MODEL: MapModel = {
  activities: [
    {
      id: "act1",
      name: "Manage Tours",
      order: 0,
      steps: [
        { id: "st1", name: "Define", order: 0 },
        { id: "st2", name: "Analyze", order: 1 },
      ],
    },
    { id: "act2", name: "Report", order: 1, steps: [{ id: "st3", name: "Export", order: 0 }] },
  ],
  stories: [
    { id: "s1", stepId: "st1", order: 0, text: "create slots", done: true },
    { id: "s2", stepId: "st1", order: 1, text: "edit slots", done: false },
    { id: "s3", stepId: "st2", order: 0, text: "view analytics", done: false },
  ],
  slices: [],
};

describe("stepColumns", () => {
  it("lays steps left to right, using ACTIVITY_GAP between activities", () => {
    const cols = stepColumns(MODEL.activities);
    expect(cols.map((c) => c.stepId)).toEqual(["st1", "st2", "st3"]);
    // st1 at 0; st2 one step-width + STEP_GAP later; st3 additionally an ACTIVITY_GAP.
    expect(cols[0].x).toBe(0);
    expect(cols[1].x).toBe(STEP_W + 8);
    expect(cols[2].x).toBe((STEP_W + 8) * 2 + (12 - 8));
  });
});

describe("cellAt is the exact inverse of layoutMap", () => {
  it("round-trips every story back to its own cell", () => {
    const { nodes } = layoutMap(MODEL);
    const storyNodes = nodes.filter((n) => n.type === "story");
    expect(storyNodes).toHaveLength(3);
    for (const node of storyNodes) {
      const story = MODEL.stories.find((s) => s.id === node.id);
      if (!story) throw new Error(`no story for node ${node.id}`);
      expect(cellAt(node.position, MODEL)).toEqual({ stepId: story.stepId, order: story.order });
    }
  });
});

describe("cellAt boundaries", () => {
  const cols = stepColumns(MODEL.activities);

  it("snaps a drop in the gap between columns to the nearest column", () => {
    // Just past st1's right edge — still nearer st1's centre than st2's.
    const x = cols[0].x + STEP_W + 2;
    expect(cellAt({ x, y: STORIES_Y }, MODEL)?.stepId).toBe("st1");
  });

  it("appends when dropped past the last story in a column", () => {
    expect(cellAt({ x: cols[0].x, y: STORIES_Y + SLOT_H * 9 }, MODEL)).toEqual({
      stepId: "st1",
      order: 2,
    });
  });

  it("rejects a drop far outside the grid", () => {
    expect(cellAt({ x: -5000, y: STORIES_Y }, MODEL)).toBeNull();
    expect(cellAt({ x: 5000, y: STORIES_Y }, MODEL)).toBeNull();
  });

  it("rejects a drop above the story area", () => {
    expect(cellAt({ x: cols[0].x, y: -500 }, MODEL)).toBeNull();
  });

  it("returns null when there are no steps at all", () => {
    expect(cellAt({ x: 0, y: STORIES_Y }, { ...MODEL, activities: [] })).toBeNull();
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

```bash
pnpm vitest run src/organisms/map/layout.test.ts
```

Expected: FAIL — `Cannot find module './layout'`.

- [ ] **Step 5: Write `layout.ts`**

Create `control-plane/src/organisms/map/layout.ts`:

```ts
import type { CapActivityT, CapSliceT, CapStoryT } from "../../api/types";

/**
 * Geometry for the story-map canvas.
 *
 * These constants are the SOURCE, not measurements — node CSS is written to match
 * them. `layoutMap` and `cellAt` both consume them, which is what makes the two
 * functions exact inverses rather than two implementations that drift.
 *
 * Gap values are read from components.css. Note STEP_GAP and ACTIVITY_GAP are
 * different: 8px separates steps inside one activity (.map-activity__steps), 12px
 * separates activities (.map-stage__grid). Conflating them misplaces every column
 * past the first.
 */
export const STEP_W = 180;
export const STEP_GAP = 8;
export const ACTIVITY_GAP = 12;
export const STORY_H = 32;
export const STORY_GAP = 6;
export const COL_GAP = 8;
export const ACTIVITY_H = 32;
export const STEP_HEAD_H = 27;

/** Vertical offset where a step's story stack begins. */
export const STORIES_Y = ACTIVITY_H + COL_GAP + STEP_HEAD_H + COL_GAP;
/** Vertical pitch of one story slot. */
export const SLOT_H = STORY_H + STORY_GAP;
/** Slice anchor nodes sit left of the grid. */
export const SLICE_RAIL_X = -(STEP_W + ACTIVITY_GAP * 2);
/** Artifact nodes sit right of the last column. */
export const ARTIFACT_GAP = ACTIVITY_GAP * 2;

/** How far outside the grid's horizontal span still counts as a valid drop. */
const REJECT_MARGIN = STEP_W;

export interface MapModel {
  activities: CapActivityT[];
  stories: CapStoryT[];
  slices: CapSliceT[];
}

export interface MapNode {
  id: string;
  type: "activity" | "step" | "story";
  position: { x: number; y: number };
  data: Record<string, unknown>;
  draggable: boolean;
  dragHandle?: string;
}

/**
 * Every step column's x, left to right in render order. The single place column
 * geometry is computed — both layoutMap and cellAt call it, so neither can disagree
 * with the other about where a column is.
 */
export function stepColumns(activities: CapActivityT[]): Array<{ stepId: string; x: number }> {
  const cols: Array<{ stepId: string; x: number }> = [];
  let x = 0;
  for (const act of [...activities].sort((a, b) => a.order - b.order)) {
    const steps = [...act.steps].sort((a, b) => a.order - b.order);
    for (const step of steps) {
      cols.push({ stepId: step.id, x });
      x += STEP_W + STEP_GAP;
    }
    // The loop already added a STEP_GAP after the activity's last step; the space
    // before the next activity should be ACTIVITY_GAP instead.
    if (steps.length > 0) x += ACTIVITY_GAP - STEP_GAP;
  }
  return cols;
}

/** Derives every persistent node's position from the model. Layout is never stored. */
export function layoutMap(model: MapModel): { nodes: MapNode[] } {
  const nodes: MapNode[] = [];
  const cols = stepColumns(model.activities);
  const xOf = new Map(cols.map((c) => [c.stepId, c.x]));

  for (const act of [...model.activities].sort((a, b) => a.order - b.order)) {
    const steps = [...act.steps].sort((a, b) => a.order - b.order);
    const first = steps[0] ? xOf.get(steps[0].id) : undefined;
    if (first !== undefined) {
      nodes.push({
        id: `activity:${act.id}`,
        type: "activity",
        position: { x: first, y: 0 },
        data: { activity: act },
        draggable: false,
      });
    }
    for (const step of steps) {
      const x = xOf.get(step.id);
      if (x === undefined) continue;
      nodes.push({
        id: `step:${step.id}`,
        type: "step",
        position: { x, y: ACTIVITY_H + COL_GAP },
        data: { step, activity: act },
        draggable: false,
      });
      const stories = model.stories
        .filter((s) => s.stepId === step.id)
        .sort((a, b) => a.order - b.order);
      stories.forEach((story, i) => {
        nodes.push({
          id: story.id,
          type: "story",
          position: { x, y: STORIES_Y + i * SLOT_H },
          data: { story },
          draggable: true,
          dragHandle: ".map-story__handle",
        });
      });
    }
  }
  return { nodes };
}

/**
 * The exact inverse of layoutMap for story nodes: resolves a dropped position back to
 * the cell it landed in.
 *
 * Because order comes from a y-coordinate against slot boundaries rather than from a
 * reference sibling, there is no forward/backward off-by-one to correct — the
 * adjustment the old dnd-kit resolveStoryDrop needed simply has no analogue here.
 *
 * Boundary behaviour (spec §cellAt contract): forgiving inside the grid, strict
 * outside it. Gaps snap to the nearest column; drops past the last story append;
 * drops outside the grid are rejected with null so the caller snaps back.
 */
export function cellAt(
  pos: { x: number; y: number },
  model: MapModel,
): { stepId: string; order: number } | null {
  const cols = stepColumns(model.activities);
  if (cols.length === 0) return null;

  const left = cols[0].x;
  const right = cols[cols.length - 1].x + STEP_W;
  if (pos.x < left - REJECT_MARGIN || pos.x > right + REJECT_MARGIN) return null;
  if (pos.y < STORIES_Y - SLOT_H) return null;

  let best = cols[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const col of cols) {
    const distance = Math.abs(pos.x - (col.x + STEP_W / 2));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = col;
    }
  }

  const count = model.stories.filter((s) => s.stepId === best.stepId).length;
  const raw = Math.round((pos.y - STORIES_Y) / SLOT_H);
  return { stepId: best.stepId, order: Math.max(0, Math.min(raw, count)) };
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
pnpm vitest run src/organisms/map/layout.test.ts
```

Expected: PASS — 7 cases.

- [ ] **Step 7: Full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass; test count up by 7.

- [ ] **Step 8: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/src/api/types.ts control-plane/src/api/work.ts \
  control-plane/src/queries/work.ts control-plane/src/organisms/MapStage.tsx \
  control-plane/src/organisms/map/
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: derive story-map geometry in a pure layout module

cellAt is the exact inverse of layoutMap, so order comes from a slot
boundary rather than a reference sibling — the forward/backward
correction dnd-kit's resolveStoryDrop needed has no analogue here.

Cap*T move to api/types.ts: queries/work.ts and api/work.ts were
importing them from an organism, and layout.ts must not import React to
get a type."
```

Verify **5 files changed** (3 modified + 2 created under `map/`), plus `api/types.ts`.

---

### Task 2: Node components

**Files:**
- Create: `control-plane/src/organisms/map/nodes.tsx`
- Create: `control-plane/src/organisms/map/nodes.test.tsx`
- Modify: `control-plane/src/styles/components.css` (`.map-story` fixed height)

**Interfaces:**
- Consumes: `layout.ts` constants; `api/types.ts` types.
- Produces: `nodeTypes` — a frozen object mapping `"activity" | "step" | "story" |
  "slice" | "artifact"` to components. Exported as a module-level const so its identity
  is stable across renders. Task 4 passes it to `<ReactFlow nodeTypes={nodeTypes} />`.

**Critical:** `nodeTypes` must be defined at module scope, never inside a component.
A new object identity each render makes xyflow remount every node on every render.

**TASK 2 HAS THREE GAPS, same cause as Task 1's — it was written before the blank-card and
visual-target rulings. Fix these before dispatching it.**

**Gap A — blank cards are not mentioned at all, and they are half of what these components
do.** Task 1 emits trailing cells carrying `data.blank === true` at every level. The node
components must branch on it: a blank card renders **an input, not text** — the card *is*
the composer, which is the entire point of Edwin's ruling. Requirements:

- Blank activity, step and story nodes render an `<input>` with the placeholder text the
  old composers used (`Add an activity…`, `Add a step…`, `Add a story…`), so nothing about
  the affordance is lost in the move.
- **Committing empty is a no-op.** Enter or blur with no text leaves the card as it was and
  creates no record.
- The input must be wrapped `nodrag` — the same class the existing story input already
  uses — or xyflow swallows the click and the field can never be focused. This is the single
  most likely way to ship a blank card that looks right and cannot be typed into.
- A blank card is **not draggable and not a drop target.** `layoutMap` already sets
  `draggable: false`; do not re-derive it here.

**Gap B — only ONE of three heights is pinned, and the other two silently break `cellAt`.**
Step 5 pins `.map-story` to `STORY_H`. But `STEP_HEAD_H = 27` and `ACTIVITY_H = 32` are
equally load-bearing and `components.css`'s current padding implies roughly 30 and 31 — so
they are already wrong. `cellAt` divides `y` by a pitch it cannot measure; if CSS lets
content size these cards, drops resolve one row off from what the user sees, **with every
test passing, because no test consults CSS.** Pin all three explicitly, each with the same
comment style as `.map-story`, naming the constant it must equal.

**Gap C — the activity node must consume `MapNode.width`.** Task 1 computes it
(`Math.max(steps.length, 1)` in both terms) precisely so an activity spans its step group,
which is the reference layout's defining feature. The node component must apply it rather
than assuming `STEP_W`. Do not recompute the width here — read it from the node.

**Note on `nodeTypes`' five keys:** `slice` and `artifact` have no counterpart in Task 1's
`MapNode["type"]` union, which is `"activity" | "step" | "story"`. That is expected — Task 5
introduces artifacts. Build all five components now; only three are reachable until then.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/organisms/map/nodes.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ArtifactNode, SliceNode, StoryNode, nodeTypes } from "./nodes";

const STORY = { id: "s1", stepId: "st1", order: 0, text: "create slots", done: false };

describe("nodeTypes", () => {
  it("registers all five node types", () => {
    expect(Object.keys(nodeTypes).sort()).toEqual([
      "activity",
      "artifact",
      "slice",
      "step",
      "story",
    ]);
  });
});

describe("StoryNode", () => {
  const data = {
    story: STORY,
    sliceOptions: [{ id: "sl1", name: "v1", order: 0, storyIds: [] }],
    sliceValue: "backlog",
    onSliceChange: vi.fn(),
    onRemove: vi.fn(),
    dimmed: false,
  };

  it("renders the drag handle carrying the story text", () => {
    const { container } = render(<StoryNode data={data} />);
    const handle = container.querySelector(".map-story__handle");
    expect(handle?.textContent).toBe("create slots");
  });

  it("marks the interactive controls nodrag so xyflow does not steal their pointer", () => {
    const { container } = render(<StoryNode data={data} />);
    expect(container.querySelector("select")?.classList.contains("nodrag")).toBe(true);
    expect(container.querySelector("button")?.classList.contains("nodrag")).toBe(true);
  });

  it("calls onSliceChange when the slice select changes", async () => {
    const onSliceChange = vi.fn();
    render(<StoryNode data={{ ...data, onSliceChange }} />);
    await userEvent.selectOptions(screen.getByLabelText("Slice for create slots"), "sl1");
    expect(onSliceChange).toHaveBeenCalledWith("sl1");
  });
});

describe("SliceNode", () => {
  it("is read-only: name and fraction, no controls", () => {
    const { container } = render(
      <SliceNode data={{ name: "tour scheduling v1", fraction: "1/2" }} />,
    );
    expect(screen.getByText("tour scheduling v1")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });
});

describe("ArtifactNode", () => {
  it("renders its label and kind", () => {
    render(<ArtifactNode data={{ kind: "spec", label: "x.md" }} />);
    expect(screen.getByText("x.md")).toBeTruthy();
    expect(screen.getByText("spec")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm vitest run src/organisms/map/nodes.test.tsx
```

Expected: FAIL — `Cannot find module './nodes'`.

- [ ] **Step 3: Write `nodes.tsx`**

Create `control-plane/src/organisms/map/nodes.tsx`:

```tsx
import { X } from "lucide-react";
import type { CapActivityT, CapSliceT, CapStoryT } from "../../api/types";

interface StoryNodeData {
  story: CapStoryT;
  sliceOptions: CapSliceT[];
  sliceValue: string;
  onSliceChange: (sliceId: string) => void;
  onRemove: () => void;
  dimmed: boolean;
}

/**
 * One story. The handle is the drag target (nodes set dragHandle:
 * ".map-story__handle"); the select and remove button carry `nodrag` so xyflow
 * leaves their pointer events alone.
 */
export function StoryNode({ data }: { data: StoryNodeData }) {
  const { story, sliceOptions, sliceValue, onSliceChange, onRemove, dimmed } = data;
  return (
    <div
      className={`map-story${story.done ? " is-done" : ""}${dimmed ? " is-dimmed" : ""}`}
      title={story.verifiedBy}
    >
      <span className="map-story__handle">{story.text}</span>
      <select
        className="nodrag"
        aria-label={`Slice for ${story.text}`}
        value={sliceValue}
        onChange={(e) => onSliceChange(e.target.value)}
      >
        <option value="backlog">backlog</option>
        {sliceOptions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button className="nodrag" type="button" aria-label={`Remove story: ${story.text}`} onClick={onRemove}>
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}

interface StepNodeData {
  step: { id: string; name: string; order: number };
  activity: CapActivityT;
  storyCount: number;
  onRemove: () => void;
  addStoryInput: React.ReactNode;
  dimmed: boolean;
}

export function StepNode({ data }: { data: StepNodeData }) {
  const { step, storyCount, onRemove, addStoryInput, dimmed } = data;
  return (
    <div className={`map-step${dimmed ? " is-dimmed" : ""}`}>
      <div className="map-step__name">
        {step.name}
        <button
          className="nodrag"
          type="button"
          aria-label={`Remove step: ${step.name}`}
          disabled={storyCount > 0}
          title={storyCount > 0 ? "Remove its stories first" : undefined}
          onClick={onRemove}
        >
          <X size={10} strokeWidth={2} />
        </button>
      </div>
      <div className="nodrag">{addStoryInput}</div>
    </div>
  );
}

interface ActivityNodeData {
  activity: CapActivityT;
  onRemove: () => void;
  dimmed: boolean;
}

export function ActivityNode({ data }: { data: ActivityNodeData }) {
  const { activity, onRemove, dimmed } = data;
  return (
    <div className={`map-activity__name${dimmed ? " is-dimmed" : ""}`}>
      {activity.name}
      <button
        className="nodrag"
        type="button"
        aria-label={`Remove activity: ${activity.name}`}
        disabled={activity.steps.length > 0}
        title={activity.steps.length > 0 ? "Remove its stories first" : undefined}
        onClick={onRemove}
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}

/**
 * Read-only anchor for a selected slice. The interactive slice band stays in the DOM
 * below the canvas — this exists only so edges have a source endpoint.
 */
export function SliceNode({ data }: { data: { name: string; fraction: string } }) {
  return (
    <div className="map-slice-anchor">
      <span className="map-slice-anchor__name">{data.name}</span>
      <span className="map-slice-anchor__fraction">{data.fraction}</span>
    </div>
  );
}

export function ArtifactNode({ data }: { data: { kind: string; label: string } }) {
  return (
    <div className={`map-artifact map-artifact--${data.kind}`}>
      <span className="map-artifact__kind">{data.kind}</span>
      <span className="map-artifact__label">{data.label}</span>
    </div>
  );
}

/**
 * Module scope on purpose. A fresh object identity each render makes xyflow remount
 * every node on every render.
 */
export const nodeTypes = {
  activity: ActivityNode,
  step: StepNode,
  story: StoryNode,
  slice: SliceNode,
  artifact: ArtifactNode,
} as const;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm vitest run src/organisms/map/nodes.test.tsx
```

Expected: PASS — 6 cases.

- [ ] **Step 5: Pin `.map-story` to STORY_H**

In `control-plane/src/styles/components.css`, the `.map-story` rule currently has no
height. Add the height and single-line truncation, and add the dim state:

```css
.map-story {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid var(--pill-br);
  background: rgba(255, 255, 255, 0.04);
  font-size: 12px;
  /* Must equal STORY_H in organisms/map/layout.ts — cellAt resolves a drop by
     dividing y by this pitch, and cannot measure a height it did not declare. */
  height: 32px;
  box-sizing: border-box;
}
.map-story__handle {
  flex: 1;
  cursor: grab;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.is-dimmed {
  opacity: 0.3;
}
```

Keep the existing `.map-story.is-done .map-story__handle` rule as-is.

- [ ] **Step 6: Full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass; test count up by 6.

- [ ] **Step 7: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/src/organisms/map/nodes.tsx control-plane/src/organisms/map/nodes.test.tsx \
  control-plane/src/styles/components.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: story-map node components

nodeTypes is module scope: a fresh identity each render remounts every
node. Interactive children carry nodrag so xyflow leaves their pointer
events alone; the handle does not, since it is the drag target.

.map-story is pinned to STORY_H with ellipsis. cellAt divides y by that
pitch and cannot measure a height it did not declare, so the constant is
the source and the CSS follows."
```

Verify **3 files changed**.

---

### Task 3: Edges and selection

**Files:**
- Create: `control-plane/src/organisms/map/edges.ts`
- Create: `control-plane/src/organisms/map/edges.test.ts`
- Create: `control-plane/src/organisms/map/useMapSelection.ts`

**Interfaces:**
- Consumes: `api/types.ts` types.
- Produces:
  - `buildEdges(model: MapModel): MapEdge[]` — every possible edge, computed once.
  - `type MapEdge = { id: string; source: string; target: string; sliceId: string }`
  - `artifactNodesFor(slice: CapSliceT): Array<{ id: string; kind: string; label: string }>`
  - `useMapSelection(): { selection: Selection; select: (s: Selection) => void; clear: () => void }`
  - `type Selection = { kind: "slice" | "story" | "step"; id: string } | null`

Edges carry `sliceId` so Task 5 can filter by selection without rebuilding the set.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/organisms/map/edges.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CapSliceT } from "../../api/types";
import { artifactNodesFor, buildEdges } from "./edges";
import type { MapModel } from "./layout";

const SLICE: CapSliceT = {
  id: "sl1",
  name: "tour scheduling v1",
  order: 0,
  storyIds: ["s1", "s2"],
  specPath: "docs/specs/x.md",
  deliveryCardRef: { boardId: "b1", cardId: "c1" },
};

const MODEL: MapModel = {
  activities: [],
  stories: [
    { id: "s1", stepId: "st1", order: 0, text: "a", done: false },
    { id: "s2", stepId: "st1", order: 1, text: "b", done: false },
  ],
  slices: [SLICE, { id: "sl2", name: "empty", order: 1, storyIds: [] }],
};

describe("buildEdges", () => {
  it("fans a slice out to each of its stories", () => {
    const edges = buildEdges(MODEL);
    const fan = edges.filter((e) => e.source === "slice:sl1" && e.target.startsWith("s"));
    expect(fan.map((e) => e.target).sort()).toEqual(["s1", "s2"]);
  });

  it("chains the slice to its artifacts, skipping absent ones", () => {
    const edges = buildEdges(MODEL);
    const targets = edges.filter((e) => e.sliceId === "sl1").map((e) => e.target);
    expect(targets).toContain("artifact:sl1:spec");
    expect(targets).toContain("artifact:sl1:deliveryCard");
    // No planPath and no capCardRef on this slice.
    expect(targets).not.toContain("artifact:sl1:plan");
    expect(targets).not.toContain("artifact:sl1:capCard");
  });

  it("produces no edges for a slice with no stories and no artifacts", () => {
    expect(buildEdges(MODEL).filter((e) => e.sliceId === "sl2")).toHaveLength(0);
  });

  it("gives every edge a unique id", () => {
    const ids = buildEdges(MODEL).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("artifactNodesFor", () => {
  it("returns only the artifacts the slice actually has", () => {
    expect(artifactNodesFor(SLICE).map((a) => a.kind)).toEqual(["spec", "deliveryCard"]);
  });

  it("returns nothing for a bare slice", () => {
    expect(artifactNodesFor({ id: "sl2", name: "empty", order: 1, storyIds: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm vitest run src/organisms/map/edges.test.ts
```

Expected: FAIL — `Cannot find module './edges'`.

- [ ] **Step 3: Write `edges.ts`**

Create `control-plane/src/organisms/map/edges.ts`:

```ts
import type { CapSliceT } from "../../api/types";
import type { MapModel } from "./layout";

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  /** Which slice's chain this edge belongs to — lets Task 5 filter without rebuilding. */
  sliceId: string;
}

export interface ArtifactSpec {
  id: string;
  kind: "spec" | "plan" | "capCard" | "deliveryCard";
  label: string;
}

/** The artifacts a slice actually has. Absent ones produce no node and no edge. */
export function artifactNodesFor(slice: CapSliceT): ArtifactSpec[] {
  const out: ArtifactSpec[] = [];
  if (slice.specPath) {
    out.push({ id: `artifact:${slice.id}:spec`, kind: "spec", label: slice.specPath });
  }
  if (slice.planPath) {
    out.push({ id: `artifact:${slice.id}:plan`, kind: "plan", label: slice.planPath });
  }
  if (slice.capCardRef) {
    out.push({
      id: `artifact:${slice.id}:capCard`,
      kind: "capCard",
      label: slice.capCardRef.cardId,
    });
  }
  if (slice.deliveryCardRef) {
    out.push({
      id: `artifact:${slice.id}:deliveryCard`,
      kind: "deliveryCard",
      label: slice.deliveryCardRef.cardId,
    });
  }
  return out;
}

/**
 * Every edge the map could draw, computed once from the model. Nothing here knows
 * about selection — Task 5 filters this set rather than rebuilding it, so clicking a
 * band does not recompute the graph.
 */
export function buildEdges(model: MapModel): MapEdge[] {
  const edges: MapEdge[] = [];
  const known = new Set(model.stories.map((s) => s.id));

  for (const slice of model.slices) {
    const source = `slice:${slice.id}`;
    for (const storyId of slice.storyIds) {
      // A slice can reference a story that has since been removed.
      if (!known.has(storyId)) continue;
      edges.push({
        id: `${source}->${storyId}`,
        source,
        target: storyId,
        sliceId: slice.id,
      });
    }
    for (const artifact of artifactNodesFor(slice)) {
      edges.push({
        id: `${source}->${artifact.id}`,
        source,
        target: artifact.id,
        sliceId: slice.id,
      });
    }
  }
  return edges;
}
```

- [ ] **Step 4: Write `useMapSelection.ts`**

Create `control-plane/src/organisms/map/useMapSelection.ts`:

```ts
import { useCallback, useState } from "react";

export type Selection = { kind: "slice" | "story" | "step"; id: string } | null;

/**
 * Which slice/story/step the map is currently interrogating. Selecting the same
 * thing twice clears it, so clicking a slice band toggles its chain.
 */
export function useMapSelection() {
  const [selection, setSelection] = useState<Selection>(null);

  const select = useCallback((next: Selection) => {
    setSelection((current) => {
      if (!next) return null;
      if (current && current.kind === next.kind && current.id === next.id) return null;
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelection(null), []);

  return { selection, select, clear };
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm vitest run src/organisms/map/edges.test.ts
```

Expected: PASS — 6 cases.

- [ ] **Step 6: Full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass; test count up by 6.

- [ ] **Step 7: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/map/
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: story-map edge model and selection state

Edges are built once and carry sliceId, so revealing a chain filters the
set rather than rebuilding the graph on every click. Slices referencing
a deleted story are skipped rather than producing a dangling edge."
```

Verify **3 files changed**.

---

### Task 4: Canvas integration

**AMENDED 2026-08-09, after Task 2's interface decisions. Two things below are now wrong.**

**1. `decorate` must NOT build an add-story input.** Task 2 dropped `addStoryInput` from
`StepNodeData`: the blank story card *is* that input, so building both renders the same
affordance twice per column, which is exactly what Edwin's ruling removes. Any sketch below
that constructs an input for `StepNode` is superseded — `StepNode` is name plus remove
button, parallel to `ActivityNode`.

**2. `decorate` supplies `onCommit` to every blank node.** Blank cards own their own input
state and call `data.onCommit(text: string)` on Enter, or on blur with non-empty text; they
trim, no-op on empty, and clear themselves. `layoutMap` already puts `activityId`/`stepId`
in blank data, so `decorate` closes over the parent and the component never learns it.
Wire `onCommit` to the existing create mutations — this is where the three deleted
composers' behaviour now lives.

**3. Expect a cast at the `nodeTypes={...}` site, and do NOT "fix" it upward.** The node
components' props are deliberately narrower than xyflow's `NodeProps` (whose `data` is
`Record<string, unknown>`). That narrowing is what lets them be rendered and asserted
without xyflow present. Cast at the mount site; do not loosen the component types to make
the cast go away — that trades a one-line cast for untypable components.

**Files:**
- Modify: `control-plane/package.json`
- Modify: `control-plane/src/organisms/MapStage.tsx`
- Modify: `control-plane/src/organisms/MapStage.test.tsx`
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Consumes: `layoutMap`, `cellAt`, `MapNode` (Task 1); `nodeTypes` (Task 2).
- Produces: `MapStage` rendering `<ReactFlow>` in place of `.map-stage__grid`, with drag
  resolving through `cellAt`. `moveStory` changes signature to
  `(storyId: string, stepId: string, order: number) => Promise<boolean>`, and `patchCap`
  to `Promise<boolean>`. `fireStoryDrop` keeps its existing signature.

**Behaviour note:** this task removes dnd-kit from `MapStage` only. `BoardStage` and
`AgentRoster` keep it; do not touch them.

- [ ] **Step 1: Install xyflow**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane
pnpm add @xyflow/react
```

- [ ] **Step 2: Write the failing test**

Append to `control-plane/src/organisms/MapStage.test.tsx`, inside the
`describe("MapStage editing")` block:

```tsx
  it("a failed move snaps the story back instead of showing a move that did not happen", async () => {
    const { calls } = stubFetch();
    // Make the PATCH fail: the model never changes, so the seeding effect never
    // re-runs, and without an explicit re-seed the node would keep its dropped
    // position — showing a move the server rejected.
    const original = globalThis.fetch as typeof fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      return original(input, init);
    });
    renderWithProviders(<MapStage />);
    await screen.findByText("Define Tour Schedule");
    const { fireStoryDrop } = await import("./MapStage");
    const moved = await fireStoryDrop("s2", "st2", 0);
    expect(moved).toBe(false);
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });
```

- [ ] **Step 3: Run it to confirm it fails**

```bash
pnpm vitest run src/organisms/MapStage.test.tsx -t "snaps the story back"
```

Expected: FAIL — `fireStoryDrop` resolves `undefined`, not `false`.

- [ ] **Step 4: Make `patchCap` and `moveStory` report success**

In `control-plane/src/organisms/MapStage.tsx`, change `patchCap` (line ~257) to return
a boolean:

```ts
  const patchCap = useCallback(
    async (body: Partial<Pick<CapabilityT, "name" | "activities" | "stories" | "slices">>) => {
      if (!cap) return false;
      try {
        await patchCapMutation.mutateAsync({ id: cap.id, body });
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Update failed");
        return false;
      }
    },
    [cap, patchCapMutation],
  );
```

Then `moveStory` (line ~270): change its two early `return;` statements to
`return false;`, and its final line from `await patchCap({ stories });` to
`return patchCap({ stories });`.

Update the seam's type at line ~102:

```ts
let storyDropHandler: ((storyId: string, stepId: string, order: number) => Promise<boolean>) | null = null;
export async function fireStoryDrop(storyId: string, stepId: string, order: number): Promise<boolean> {
  if (!storyDropHandler) throw new Error("MapStage is not mounted");
  return storyDropHandler(storyId, stepId, order);
}
```

Every other `patchCap` caller ignores the return value, so no other call site changes.

- [ ] **Step 5: Replace the grid with the canvas**

In `MapStage.tsx`, remove these imports entirely:

```ts
import { DndContext, type DragEndEvent, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
```

and add:

```ts
import { ReactFlow, Background, Controls, MiniMap, useNodesState, type OnNodeDrag } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cellAt, layoutMap } from "./map/layout";
import { nodeTypes } from "./map/nodes";
```

Delete `resolveStoryDrop` (lines 61-97 including its doc comment), `SortableStory`
(108-147), `MapStepStories` (149-184), `handleDragEnd` (421-428), and the `sensors`
line (304). Their jobs move to `cellAt` and the canvas.

Inside the component, replace the `sensors` line with node state, a decorator, and the
drag handler.

**`layoutMap` is pure — it emits `data: { story }` and `data: { step, activity }` and
knows nothing about callbacks.** The node components need handlers and a `dimmed` flag
in that same `data`. `decorate` is the single bridge between them, and Task 5 extends
its `dimmedIds` argument rather than adding a second path:

```ts
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);

  /**
   * Injects handlers and dim state into the pure layout's node data. layoutMap cannot
   * do this itself without importing React, which would cost the DOM-free property
   * test that makes cellAt trustworthy.
   */
  const decorate = useCallback(
    (base: MapNode[], dimmedIds: Set<string>): Node[] =>
      base.map((n) => {
        const dimmed = dimmedIds.has(n.id);
        if (n.type === "story") {
          const story = n.data.story as CapStoryT;
          return {
            ...n,
            data: {
              story,
              dimmed,
              sliceOptions: [...(cap?.slices ?? [])].sort((a, b) => a.order - b.order),
              sliceValue: sliceFor(story.id),
              onSliceChange: (sliceId: string) => assignSlice(story.id, sliceId),
              onRemove: () => removeStory(story),
            },
          } as Node;
        }
        if (n.type === "step") {
          const step = n.data.step as { id: string; name: string; order: number };
          const activity = n.data.activity as CapActivityT;
          return {
            ...n,
            data: {
              step,
              activity,
              dimmed,
              storyCount: storiesFor(step.id).length,
              onRemove: () => removeStep(activity, step.id),
              addStoryInput: (
                <input
                  placeholder="Add a story…"
                  {...register(`storyTexts.${step.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addStory(step.id);
                  }}
                />
              ),
            },
          } as Node;
        }
        const activity = n.data.activity as CapActivityT;
        return {
          ...n,
          data: { activity, dimmed, onRemove: () => removeActivity(activity) },
        } as Node;
      }),
    [cap, sliceFor, assignSlice, removeStory, storiesFor, removeStep, removeActivity, register, addStory],
  );

  // Positions are derived, never stored. xyflow needs local node state for a node to
  // follow the cursor mid-drag, so the model re-seeds it on every change.
  useEffect(() => {
    setNodes(cap ? decorate(layoutMap(cap).nodes, new Set()) : []);
  }, [cap, decorate, setNodes]);

  const onNodeDragStop: OnNodeDrag = useCallback(
    async (_event, node) => {
      if (!cap) return;
      const cell = cellAt(node.position, cap);
      // Invalid drop, or a rejected mutation: re-seed from the model. Without this the
      // node keeps its dropped position and shows a move that never happened.
      if (!cell) {
        setNodes(decorate(layoutMap(cap).nodes, new Set()));
        return;
      }
      const ok = await moveStory(node.id, cell.stepId, cell.order);
      if (!ok) setNodes(decorate(layoutMap(cap).nodes, new Set()));
    },
    [cap, moveStory, decorate, setNodes],
  );
```

Add to the import line: `type Node` from `@xyflow/react`, and `type MapNode` from
`./map/layout`.

Replace the whole `<DndContext>…</DndContext>` block (lines 478-552) with:

```tsx
          <div className="map-stage__canvas">
            <ReactFlow
              nodes={nodes}
              edges={[]}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={onNodeDragStop}
              nodesConnectable={false}
              fitView
            >
              <Background />
              <Controls />
              <MiniMap pannable zoomable />
            </ReactFlow>
          </div>
          <div className="map-stage__composer">
            <input
              placeholder="Add an activity…"
              {...register("activityName")}
              onKeyDown={(e) => {
                if (e.key === "Enter") addActivity();
              }}
            />
          </div>
```

**SUPERSEDED — the composers become blank cards, not separate controls.** Edwin,
2026-08-09: *"I expect the next card expected to be filled to already exist and allow the
user to fill it in."*

The original approach here was to move add-activity below the canvas and turn add-step
into a `+` button. Do neither. Instead, **every level always renders one empty card in
place**, at the position the next real card would occupy:

- the capability set ends with an empty capability card
- each activity row ends with an empty activity card
- each activity's step row ends with an empty step card
- each step's story stack ends with an empty story card

Typing into an empty card and committing (Enter, or blur with non-empty text) creates the
real record and a fresh empty card appears after it. The three `placeholder="Add a …"`
inputs are deleted — the card *is* the input.

Why this is better than a composer, and why it suits the canvas specifically:

- **The layout module already knows where it goes.** `layoutMap(model)` derives every
  position; an empty card is just the next cell in the sequence, so it needs no fake
  column and no special case below the canvas. The original plan had to relocate
  add-activity precisely *because* a pseudo-column had nowhere to live — a real cell does.
- **`cellAt(pos, model)` stays the exact inverse.** A trailing empty cell is a position the
  model can already name; a floating composer beneath the canvas is not.
- One interaction for reading and writing, at every level, instead of cards for reading
  and three differently-shaped controls for writing.

**EXTENDED TO THE CAPABILITY LEVEL.** Edwin, 2026-08-09: *"adding a new card, whether it
is capability, activity or step, should be a card waiting to be filled out."* The rule is
universal — there is no "add" control anywhere in the map, at any level.

Capability is the one level where this is not just deleting a composer, because a
capability is not a card today. It is a `<select aria-label="Capability">` plus a
`+ new capability` button toggling a `creating` composer (`MapStage.tsx:450-470`). Both go.
**Capabilities become a row of cards: selecting one is clicking it, and the row ends with
an empty card that creates the next one.** `creating`, `capName`, and the toggle button are
deleted along with the other three composers.

Two consequences worth stating before anyone implements it:

- **The dropdown was also the workspace filter's output surface.** `activeId` is reset on
  workspace change (`MapStage.tsx:440`). A card row must keep that behaviour or a stale
  capability from another workspace stays selected — the same bug the comment at that line
  already names.
- **Selection and editing now share one control.** A capability card must distinguish a
  click (select) from a click-into-text (rename), the way the story cards already
  distinguish drag from edit. Reuse whatever the story card settles on; do not invent a
  second gesture vocabulary.

**OPEN — where the capability row lives.** Two readings, and the plan should not guess:
**(a)** a band on the canvas above the activities, so all four levels are one surface; or
**(b)** a row in the stage header, above the canvas, leaving the canvas to the three
levels the reference image shows. **Recommend (b).** The reference has no capability band,
capabilities are the map's identity rather than part of its content, and a capability
band on the canvas would scroll away from the map it names. (a) is defensible if
capabilities are few and switching between them is frequent. Edwin decides.

**Three things to get right:**

1. **The empty card is not a record.** It has no id and never reaches the server until
   committed. `CapStoryT`/`CapActivityT` gain no "draft" field, and `patchCap` sees a
   normal create. If you find yourself adding an `isDraft` flag to the model, stop — the
   emptiness is a render concern, not data.
2. **Committing empty is a no-op**, not an empty record. Blur with no text leaves the card
   as it was.
3. **The empty card is not draggable and not a drop target.** Wrap it `nodrag` like the
   existing story input, and exclude it from `cellAt`'s hit-testing, or a drop can land on
   a cell that does not exist yet.

**Error surfacing needs no new work:** `patchCap` already calls `setError`, and
`MapStage` already renders `{displayError && <p className="wizard__error">…}` at line
472. A failed move therefore shows a message alongside the snap-back, satisfying the
spec's toast requirement.

- [ ] **Step 6: Give the canvas a height**

In `components.css`, add:

```css
.map-stage__canvas {
  flex: 1;
  min-height: 0;
  /* ReactFlow measures its parent; a percentage height on an unsized parent collapses
     it to zero and the canvas renders blank. */
  height: 100%;
}
```

- [ ] **Step 7: Run the failing test, then the whole file**

```bash
pnpm vitest run src/organisms/MapStage.test.tsx
```

Expected: PASS, including the new snap-back case. If `renders the backbone` fails
because jsdom reports zero canvas dimensions, xyflow has not measured the container —
that is expected in jsdom and the node components still render; assert on text, not
on layout.

- [ ] **Step 8: Full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass; test count up by 1.

- [ ] **Step 9: Visual smoke**

```bash
pnpm dev
```

Confirm on the story map stage: the grid renders as a canvas; scroll wheel zooms;
drag on empty space pans; the minimap reflects the map; dragging a story by its text
handle moves it and it lands in the target column; the slice select and remove button
inside a story still work and do **not** start a drag.

Check all four themes (`data-theme` unset / `light` / `midnight` / `sand`).

- [ ] **Step 10: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/package.json control-plane/pnpm-lock.yaml \
  control-plane/src/organisms/MapStage.tsx control-plane/src/organisms/MapStage.test.tsx \
  control-plane/src/styles/components.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: story map renders on an xyflow canvas

Drag resolves through cellAt, so it is correct at any zoom — dnd-kit
measures DOM rects and would have drifted against xyflow's viewport
transform.

patchCap and moveStory now return booleans. Positions are derived, but
xyflow needs local node state to follow the cursor, so a rejected
mutation must re-seed explicitly or the node keeps a position the server
refused."
```

Verify **5 files changed**.

---

### Task 5: On-demand reveal

**Files:**
- Modify: `control-plane/src/organisms/MapStage.tsx`
- Modify: `control-plane/src/organisms/MapStage.test.tsx`
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Consumes: `buildEdges`, `artifactNodesFor`, `useMapSelection` (Task 3); `SLICE_RAIL_X`,
  `ARTIFACT_GAP`, `STEP_W`, `SLOT_H`, `STORIES_Y`, `stepColumns` (Task 1).
- Produces: nothing further; this is the last task.

- [ ] **Step 1: Write the failing test**

Append to `describe("MapStage editing")` in `MapStage.test.tsx`:

```tsx
  it("clicking a slice band reveals its chain and dims the rest", async () => {
    stubFetch();
    renderWithProviders(<MapStage />);
    await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });

    // At rest there is no anchor and no artifact node.
    expect(document.querySelector(".map-slice-anchor")).toBeNull();
    expect(document.querySelector(".map-artifact")).toBeNull();

    await userEvent.click(screen.getByText("tour scheduling v1", { selector: ".slice-band__name" }));

    // sl1 has a specPath, so a spec artifact materializes; sl1 owns s1 and s2.
    await waitFor(() => expect(document.querySelector(".map-slice-anchor")).not.toBeNull());
    expect(document.querySelector(".map-artifact--spec")).not.toBeNull();
    // s3 belongs to no slice, so it dims.
    await waitFor(() => {
      const s3 = screen.getByText("view tour analytics").closest(".map-story");
      expect(s3?.classList.contains("is-dimmed")).toBe(true);
    });
  });

  it("clicking the same slice band again clears the reveal", async () => {
    stubFetch();
    renderWithProviders(<MapStage />);
    const band = await screen.findByText("tour scheduling v1", { selector: ".slice-band__name" });
    await userEvent.click(band);
    await waitFor(() => expect(document.querySelector(".map-slice-anchor")).not.toBeNull());
    await userEvent.click(band);
    await waitFor(() => expect(document.querySelector(".map-slice-anchor")).toBeNull());
  });
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
pnpm vitest run src/organisms/MapStage.test.tsx -t "reveals its chain"
```

Expected: FAIL — no `.map-slice-anchor` after the click.

- [ ] **Step 3: Wire selection into MapStage**

Add imports:

```ts
import { artifactNodesFor, buildEdges } from "./map/edges";
import { useMapSelection } from "./map/useMapSelection";
import { ARTIFACT_GAP, SLICE_RAIL_X, STEP_W, STORIES_Y, stepColumns } from "./map/layout";
```

Inside the component:

```ts
  const { selection, select } = useMapSelection();

  const allEdges = useMemo(() => (cap ? buildEdges(cap) : []), [cap]);

  const revealed = selection?.kind === "slice" ? selection.id : null;
  const revealedSlice = cap?.slices.find((s) => s.id === revealed) ?? null;

  const edges = useMemo(
    () => allEdges.filter((e) => e.sliceId === revealed),
    [allEdges, revealed],
  );
```

Make the slice band clickable — wrap its name span (`MapStage.tsx:558`):

```tsx
                  <button
                    type="button"
                    className="slice-band__select"
                    onClick={() => select({ kind: "slice", id: slice.id })}
                  >
                    <span className="slice-band__name">{slice.name}</span>
                  </button>
```

The `.slice-band__name` class stays on the inner span, so the three existing tests that
query `{ selector: ".slice-band__name" }` keep passing.

- [ ] **Step 4: Add the ephemeral nodes to the seeding effect**

Replace the seeding effect from Task 4 with one that appends anchor and artifact nodes
when a slice is revealed. Add `revealedSlice` and `decorate` to its dependency array;
`decorate` itself is unchanged from Task 4:

```ts
  useEffect(() => {
    if (!cap) {
      setNodes([]);
      return;
    }
    const base = layoutMap(cap).nodes;
    if (!revealedSlice) {
      setNodes(decorate(base, new Set()));
      return;
    }

    // Dim every story the revealed slice does not own. decorate is the same bridge
    // Task 4 uses — reveal only changes which ids land in the dimmed set.
    const inSlice = new Set(revealedSlice.storyIds);
    const dimmedIds = new Set(
      base.filter((n) => n.type === "story" && !inSlice.has(n.id)).map((n) => n.id),
    );
    const decorated = decorate(base, dimmedIds);

    const cols = stepColumns(cap.activities);
    const rightEdge = cols.length > 0 ? cols[cols.length - 1].x + STEP_W : 0;
    const done = revealedSlice.storyIds.filter(
      (id) => cap.stories.find((s) => s.id === id)?.done,
    ).length;

    setNodes([
      ...decorated,
      {
        id: `slice:${revealedSlice.id}`,
        type: "slice",
        position: { x: SLICE_RAIL_X, y: STORIES_Y },
        data: { name: revealedSlice.name, fraction: `${done}/${revealedSlice.storyIds.length}` },
        draggable: false,
      },
      ...artifactNodesFor(revealedSlice).map((a, i) => ({
        id: a.id,
        type: "artifact" as const,
        position: { x: rightEdge + ARTIFACT_GAP, y: STORIES_Y + i * 64 },
        data: { kind: a.kind, label: a.label },
        draggable: false,
      })),
    ]);
  }, [cap, revealedSlice, setNodes]);
```

Pass `edges` to `<ReactFlow edges={edges} …>` in place of the empty array from Task 4.

- [ ] **Step 5: Style the ephemeral nodes**

In `components.css`:

```css
.map-slice-anchor,
.map-artifact {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid var(--pill-br);
  background: var(--pill);
  font-size: 11.5px;
  width: 160px;
}
.map-slice-anchor__fraction,
.map-artifact__kind {
  color: var(--text-2);
  font-size: 10.5px;
}
.map-artifact__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slice-band__select {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
```

- [ ] **Step 6: Run the tests**

```bash
pnpm vitest run src/organisms/MapStage.test.tsx
```

Expected: PASS — all cases including the two new ones, and the three pre-existing
`.slice-band__name` queries.

- [ ] **Step 7: Full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass; test count up by 2.

- [ ] **Step 8: Visual smoke**

Run `pnpm dev`. Click a slice band: its stories stay lit, unrelated stories dim, an
anchor appears left of the grid, artifacts appear right, and edges connect them. Click
the same band again: everything returns to a plain grid with no leftover nodes.

Confirm in all four themes.

- [ ] **Step 9: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/src/organisms/MapStage.tsx control-plane/src/organisms/MapStage.test.tsx \
  control-plane/src/styles/components.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat: on-demand traceability reveal on the story map

Anchor and artifact nodes are absent at rest and materialize only while
a slice is selected, so the map stays readable when you are not
interrogating it.

The band keeps .slice-band__name on an inner span — the click target
wraps it, so the three existing selector-based tests are untouched."
```

Verify **3 files changed**.

---

## The visual target

Edwin supplied a reference story map (2026-08-09) and confirmed it belongs **on a canvas**,
which is this plan's premise. The information design to match:

- **Activities** across the top as wide cards, each spanning the group of steps beneath it.
- **Steps** in a row under their activity, colour-distinct from activities.
- A labelled **"Story cards"** band separating the map's skeleton from its stories.
- **Stories** in vertical columns under their step, so a column reads as "everything to
  build for this step".

`MapStage` already has this skeleton — `.map-activity` → `.map-activity__steps` →
`.map-step` → `.map-step__stories`. So this is a **restyle plus the blank-card change**,
not a restructure. Three things the reference has that the current UI does not:

1. the level-distinguishing colour treatment,
2. the explicit "Story cards" band label,
3. activities sized to span their step group rather than sitting as one more equal column.

Only 3 has layout consequences: `.map-step` is `flex: 0 0 180px` today, so an activity
spanning its steps needs a width derived from its step count. On the canvas that falls out
of `layoutMap` for free — it already computes every position — which is another reason to
do the restyle *with* the migration rather than before it.

**The reference is information design, not pixel spec.** It is a different product with
its own chrome. Edwin's standing ruling applies: *"the function is more important than the
fidelity to the original."*

## Done Criteria

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` pass from `control-plane/`.
- [ ] `grep -rn "dnd-kit" src/organisms/MapStage.tsx` → no output.
- [ ] `grep -rn "dnd-kit" src/organisms/BoardStage.tsx src/organisms/AgentRoster.tsx` →
      still present. This migration does not touch them.
- [ ] The inverse property test passes: every story round-trips through
      `layoutMap` → `cellAt` back to its own cell.
- [ ] Pan, zoom, and minimap work; dragging a story by its handle moves it; the slice
      select and remove button inside a story do not start a drag.
- [ ] A rejected PATCH snaps the story back rather than leaving it at the drop point.
- [ ] Selecting a slice band reveals its chain; selecting again clears it.
- [ ] All four themes render correctly.

## Open item, carried from the spec

xyflow's keyboard story for moving a node is **unverified**. `KeyboardSensor` count in
the repo is 0, so this is not a regression either way — but claim no accessibility win
until it is confirmed. Check during Task 4's visual smoke: focus a story node and try
arrow keys. If it works, add a test; if not, record it as a known gap.

## Coordination

If HeroUI Phase 0 (`docs/superpowers/plans/2026-08-08-heroui-phase-0-foundation.md`)
has already merged when this work starts, write `organisms/map/*` styling as Tailwind
utilities rather than `components.css` rules — otherwise Phase 2 of that migration
rewrites everything this plan just added.
