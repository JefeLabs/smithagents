# Story Map Canvas — Design

**Status:** approved, not yet implemented
**Claimed by:** unclaimed — claim this header before executing
**Date:** 2026-08-08
**Surface:** `control-plane/src/organisms/MapStage.tsx` (624 LOC today)

Replace the dnd-kit flex-grid story map with an xyflow (`@xyflow/react`) canvas that
provides pan/zoom, on-demand traceability edges, and a single coherent drag system.

---

## Goals

1. **Pan / zoom / overview.** `.map-stage__grid` is `overflow-x: auto` with 180px step
   columns. A wide map is a long horizontal scroll with no way to see the whole thing.
2. **Traceability edges.** `CapSliceT` already carries `specPath`, `planPath`,
   `capCardRef`, and `deliveryCardRef`. Make that chain visible.
3. **Modernize the drag.** One drag system, correct under zoom.

## Non-goals

- Slices do **not** become spatial rows. They stay an attribute set by the `<select>`
  on each story chip. This stays a 1-D-per-column map, not a 2-D Patton grid.
- No freeform positioning. Structure remains categorical, never derived from where a
  node happens to sit.
- No change to `CapStoryT` / `CapSliceT` / `CapActivityT` on the server.
- `BoardStage` and `AgentRoster` keep dnd-kit. Only `MapStage` migrates.

---

## Core invariant

**The model is the truth. Layout is derived. Positions are never stored.**

```
useCapabilities() ─> { activities[], stories[], slices[] }
                            │
                     layoutMap(model)              pure, no React
                            │
                   { nodes[], edges[] }
                            │
                      <ReactFlow …>
                            │
        onNodeDragStop ─> cellAt(pos, model) ─> moveStory(id, stepId, order)
                            │
                     query invalidate ─> re-layout
```

No `x`/`y` ever reaches the server. Two consequences follow, and both are load-bearing:

- The canvas cannot drift into a state the model can't explain.
- Failure recovery needs no rollback code (see *Failure handling*).

---

## Node taxonomy

| Node type  | Draggable | Persistent | Role                                     |
|------------|-----------|------------|------------------------------------------|
| `activity` | no        | yes        | Backbone header, spans its steps         |
| `step`     | no        | yes        | Column header; the drop container        |
| `story`    | **yes**   | yes        | The only thing that moves                |
| `slice`    | no        | **no**     | Read-only edge anchor; name + fraction only |
| `artifact` | no        | **no**     | spec / plan / capCard / deliveryCard     |

Activities and steps are non-draggable *nodes* rather than a background layer, so they
can serve as selection targets and edge endpoints.

Story nodes set `dragHandle: '.map-story__handle'`, which maps 1:1 onto the existing
handle at `MapStage.tsx:131`.

---

## Spatial regions

```
   x < 0              x = step columns                 x > last step
 ┌───────────┬──────────────────────────────────┬────────────────────┐
 │  SLICE    │  activity ▸ step ▸ story grid    │  ARTIFACTS         │
 │  ANCHOR   │                                  │  ephemeral         │
 │ ephemeral │  the thing you read              │  only while a      │
 │           │                                  │  slice is selected │
 └───────────┴──────────────────────────────────┴────────────────────┘

 ┌────────────────────────────────────────────────────────────────────┐
 │  .map-stage__slices — ordinary DOM, BELOW the canvas, UNCHANGED    │
 │  slice bands: name · fraction · spec · plan input · send buttons   │
 └────────────────────────────────────────────────────────────────────┘
```

**The slice bands stay in the DOM exactly where they are** (`MapStage.tsx:553-619`).
They are dense control rows — a plan-path text input, two send buttons with
disabled/title gating, a generate-spec button — not labels. Moving them onto the
canvas would mean `nodrag nopan nowheel` on every interactive child and a text input
competing with pan, paid for **zero spatial gain**: slices are an ordered list with no
meaningful position. Three existing tests query `{ selector: ".slice-band__name" }`
and survive untouched as a result.

Clicking a band sets the selection. The canvas then renders a **compact read-only
`slice` anchor node** (name + done fraction, no controls) in the left rail, purely so
edges have a source endpoint. The band remains the control surface; the anchor is a
view of the slice for graph purposes only.

Both anchor and artifact nodes are **absent from the node array at rest**. They
materialize on selection and vanish on deselect — no reserved empty space, and the map
reads clean when you are not interrogating it.

---

## Composers

Only `.map-stage__grid` becomes `<ReactFlow>`. Composers split by whether their
position carries meaning:

| Composer | Where it goes | Why |
|---|---|---|
| add story | inside `StepNode`, wrapped in `nodrag` | belongs to one step; position is meaningful |
| add step | a `+` on the activity node | belongs to one activity |
| add activity | DOM row beneath the canvas | appends to the whole map |
| add slice, new capability | DOM, unchanged | already outside the grid |

`.map-activity--composer` and `.map-step--composer` are **deleted**. They were fake
columns whose only job was to occupy the end of a flex row — a position the canvas now
derives from the model, so a column with no model entry has nowhere to be.

One control inside a node is worth the `nodrag` wrapper; the slice bands' six are not,
which is why those stay in the DOM.

## On-demand reveal

```ts
type Selection = { kind: 'slice' | 'story' | 'step'; id: string } | null
```

Selection originates from **clicking a slice band in the DOM**, not from the canvas —
the band is the control surface. Story and step selection originate from canvas clicks.

Selecting a slice:
- a read-only `slice` anchor node materializes in the left rail,
- its `storyIds` highlight across columns,
- artifact nodes materialize to the right,
- edges draw: `slice → story*`, `slice → spec → plan`, `slice → capCard`,
  `slice → deliveryCard`,
- unrelated nodes drop to ~30% opacity.

Deselect returns to a plain grid.

Edges are computed once by `buildEdges(model)` and carry `hidden: true` unless the
current selection touches them. No edge-set rebuild per click.

---

## Geometry

Constants live in `layout.ts` and are consumed by **both** `layoutMap` and `cellAt`.
That shared dependency is what makes them true inverses rather than two
implementations that drift.

**Direction of authority: `layout.ts` is the source, CSS follows.** The gap values
below are read off today's `components.css`, but the *height* values are not
measurements — they are declarations. Node CSS must be written to match them
(`height: STORY_H` etc.), never the reverse. The inverse property test guards
`layoutMap` ↔ `cellAt` agreement; it cannot detect a node whose rendered height
disagrees with the constant that positioned it. Pinning the heights in code and
forcing CSS to comply is what removes that failure mode.

```ts
STEP_W       = 180   // .map-step        flex: 0 0 180px
STEP_GAP     = 8     // .map-activity__steps  gap: 8px
ACTIVITY_GAP = 12    // .map-stage__grid      gap: 12px
STORY_GAP    = 6     // .map-step__stories    gap: 6px
COL_GAP      = 8     // .map-activity, .map-step  gap: 8px  (header → body)
STORY_H      = 32    // fixed — see below
ACTIVITY_H   = 32    // .map-activity__name  8px pad × 2 + ~16 line
STEP_HEAD_H  = 27    // .map-step__name      6px pad × 2 + ~15 line
```

`STEP_GAP` (8px, between steps *within* an activity) and `ACTIVITY_GAP` (12px, between
activities) are distinct. Conflating them puts every column past the first at the wrong
x, and the inverse property test is what will catch it.

### Decision: story nodes are fixed-height

`.map-story` has no explicit height today; it is a flex row whose text could wrap at
180px. Variable heights would break the inverse: `cellAt` cannot compute a slot
boundary from a height it would have to *measure*, and measurement forces a
render → measure → re-layout cycle that destroys the purity making `layout.ts`
testable without a DOM.

Story nodes therefore get an explicit `STORY_H = 32` with single-line text and
`text-overflow: ellipsis`. Full text remains available via `title` attribute.

This is a small visual change from today (long story text currently wraps; it will
now truncate). It is the price of an exactly invertible layout, and it is worth it.

---

## The `cellAt` contract

```ts
function cellAt(
  pos: { x: number; y: number },
  model: CapModel,
): { stepId: string; order: number } | null
```

Returns `null` to mean "reject this drop"; the node then snaps back with no mutation.

Boundary behavior — **decided by Edwin during implementation**, scaffolded with the
signature and constants in place:

| Drop location                        | Recommended     | Alternative        |
|--------------------------------------|-----------------|--------------------|
| Between two columns (inside a gap)   | nearest column  | reject → snap back |
| Past the last story in a column      | append to end   | reject             |
| Empty canvas, outside all columns    | reject          | nearest column     |

Recommendation is *forgiving inside the grid, strict outside it*. If no decision is
made, implement the Recommended column — this is a preference, not a blocker.

### What this deletes

`resolveStoryDrop` (`MapStage.tsx:71–97`) carries a forward/backward index correction
documented at L61–70: a same-step forward drag must land one slot **after** the
target's position in the sibling list with the active story excluded. That correction
exists only because dnd-kit reports a **reference sibling** (`over.id`) rather than a
location. `cellAt` computes `order` from a y-coordinate against slot boundaries, so
there is no sibling to be off-by-one against. `resolveStoryDrop` and its comment are
deleted, not ported.

---

## File structure

624 lines in one file is already past comfortable, and this change adds a layout
engine. Splitting follows the existing `src/organisms/settings/` precedent.

```
organisms/MapStage.tsx            shell — bar, composers, ReactFlow host      ~150
organisms/map/layout.ts           layoutMap + cellAt + constants              ~120   pure, no React
organisms/map/layout.test.ts      inverse property + boundary tests
organisms/map/nodes.tsx           Activity/Step/Story/Slice/Artifact nodes    ~150
organisms/map/edges.ts            buildEdges(model) + reveal filter            ~60
organisms/map/useMapSelection.ts  selection state                              ~40
```

`layout.ts` importing nothing from React is the load-bearing constraint — it is what
makes the inverse property testable without a DOM.

---

## Failure handling

Positions are never stored **on the server**, and that invariant holds. But xyflow
needs local node state for a node to follow the cursor during a drag, so recovery is
*not* free — an earlier draft of this spec claimed it was, and that was wrong.

The failure path in detail:

1. `onNodeDragStop` fires; xyflow's local `nodes` state holds the dropped position.
2. `cellAt` returns `null` (invalid drop) → re-seed `nodes` from `layoutMap(cap)`
   immediately. Snap-back.
3. `cellAt` returns a cell → `await moveStory(...)`.
   - **Success:** the query invalidates, `cap` gets a new reference, the seeding
     effect re-runs `layoutMap` and the node lands at its new computed position.
   - **Failure:** `cap` is unchanged, so the seeding effect does **not** re-run, and
     the node would keep its dropped position — showing a move that never happened.
     The handler must re-seed explicitly.

`moveStory` therefore returns `Promise<boolean>` rather than `Promise<void>`, and
`patchCap` returns whether the mutation succeeded. Today both swallow errors into
`setError` and return `void`; that is sufficient for dnd-kit, where the DOM never
moved in the first place, and insufficient here.

Also required: an error toast on mutation failure. A silent snap-back is otherwise
indistinguishable from "you dropped it somewhere invalid."

---

## Testing

1. **Inverse property test** — for every `(stepIdx, order)` in a generated model,
   `cellAt(layoutMap(model).nodes[i].position, model)` returns that exact cell.
   Permanently catches drift between the two functions, including the
   `STEP_GAP` / `ACTIVITY_GAP` confusion above.
2. **Boundary tests** on the three `cellAt` rows once decided.
3. **`fireStoryDrop` seam preserved.** `MapStage.tsx:102–106` exists because jsdom
   cannot synthesize dnd-kit pointer sequences — equally true of xyflow. The seam and
   the existing `MapStage.test.tsx` drop assertions carry over unchanged; only the
   internals behind the seam change.

---

## Dependencies

- Add `@xyflow/react` + its stylesheet to **`control-plane/package.json` via pnpm**.
  Not the untracked npm island at repo root.
- dnd-kit stays in the repo (`BoardStage`, `AgentRoster`); it leaves `MapStage` only.
- Orthogonal to the HeroUI Pro decision — this does not depend on it either way.

## Open item

xyflow's keyboard story for moving a node is unverified and must be checked during
implementation. `KeyboardSensor` count in the repo is currently 0, so this is not a
regression either way — but no a11y win should be claimed until confirmed.
