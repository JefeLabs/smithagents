# Slice by selection — design

**Status:** approved, not yet planned
**Date:** 2026-08-09

## Goal

Make a slice by selecting its stories on the map, and let slices overlap — a
story may belong to several slices, provided every slice owns at least one story
no other slice has.

## Why

Slices are cut for delivery, and real slices share work. "login v2" and "admin
v1" both need *authenticate a user*. The current model forbids that: `CapSlice`
carries the invariant *"Disjoint across slices; a story in no slice is
backlog"*, and `patchCapability` enforces it with

```
Story ${id} is in two slices — storyIds must be disjoint
```

Disjointness also has no way to express "this slice is a real, separable piece
of work" — which is what actually matters when a slice becomes a card on the
Plan board. Ownership of at least one story does express it.

Today a slice is created from a name alone, through the `New slice name…` box
under the map, and gets its stories some other way. Nothing in the UI assigns
stories to a slice at all.

## The rule

> A slice must own **at least one** story that appears in no other slice of the
> same capability. Any number of its other stories may be shared. A story in no
> slice is backlog.

Two consequences that drive the rest of this design:

1. **A zero-story slice is invalid** — it owns nothing. Name-only creation
   cannot survive the rule, so the `New slice name…` box is removed and
   selection becomes the only way a slice is born.
2. **Validity is a property of the whole set, not of one slice.** Editing slice
   B can invalidate slice A by taking A's last exclusive story. Every check is
   therefore against the proposed set of slices, never against one slice alone.

## Architecture

One pure predicate expresses the rule:

```ts
/**
 * Slices whose every story also appears in another slice. Pure, total, and
 * evaluated over the WHOLE proposed set — a slice is invalidated by what its
 * neighbours contain, so this can never be answered one slice at a time.
 * Empty storyIds counts as owning nothing, so a storyless slice is reported
 * here rather than needing its own check.
 */
export function slicesWithoutExclusiveStory(slices: CapSlice[]): CapSlice[];
```

**It has to exist twice, and that needs stating plainly.** `control-plane` and
`swarm` are separate packages with no shared module, no tsconfig `paths` and no
project references — nothing in `control-plane/src` imports from `swarm/src`.
The wire types are already duplicated this way: `CapSliceT`
(`control-plane/src/api/types.ts:213`) mirrors `CapSlice`
(`swarm/src/capabilities.ts`), and cross-package knowledge is carried as
comments citing `file:line`. Introducing a shared package to avoid one small
function would be a build change out of proportion to this feature.

So:

- **`swarm/src/capabilities.ts` holds the authority.** `patchCapability` calls
  it and rejects the write. This is the only copy whose verdict persists.
- **`control-plane/src/organisms/map/slices.ts` holds a mirror**, used solely to
  disable the button and name the reason. It is a UX affordance, not a gate.
- Each copy carries a comment naming the other by `file:line`.
- **Both suites run the same table of cases** (below), so a divergence fails a
  test rather than silently letting the two disagree.

A rule duplicated is worse than a type duplicated — a type that drifts is caught
at the wire, a rule that drifts is caught by nobody. The shared case table is
what stands in for the missing shared module, and it is the reason the client
test must exercise the real mirror rather than a stub.

## Data flow

Every slice edit already rides one wholesale `PATCH /work/capabilities/:id`
carrying the full `slices` array (`api/work.ts:177`). Nothing new is needed on
the wire: creation, membership changes and deletion are all that one call.

```
select stories on canvas
  → panel: "+ slice from N selected"
  → name it
  → PATCH /work/capabilities/:id { slices: [...existing, newSlice] }
      → patchCapability validates the whole array
      → 400 with the offending slice named, or persisted
```

## Components

### Selection (`MapStage.tsx`, `map/nodeTypes.tsx`)

- Story nodes become selectable. Activities, steps, blanks and the slice band
  stay unselectable, so a lasso cannot pick up scenery.
- Shift-click adds to the selection; drag on empty canvas lassoes. Both are
  React Flow built-ins (`multiSelectionKeyCode`, `selectionOnDrag`) — no custom
  hit-testing, and specifically no second copy of the geometry that `cellAt`
  already owns.
- Selection lives in React Flow's node state, not in a parallel store.

### Slice panel (`map/SlicePanel.tsx`, new)

A React Flow `<Panel>` floating over the canvas, listing the current
capability's slices with story counts.

- **Hover a slice → its stories highlight on the canvas.** This is how overlap
  is read: two slices sharing a story are two highlights over the same node,
  with no edges drawn and no layout conflict.
- **Click a slice → the existing band opens beneath the map**, unchanged,
  anchor and artifact row included.
- **Footer: `+ slice from N selected`**, enabled only when the selection is
  non-empty and the result would be valid.

The panel renders from the model. It holds no slice state of its own.

### Blocking

The footer button disables when the proposed slice would leave another slice
with nothing exclusive, and says which slice and which story:

```
⚠ "book a tour" is the only story tour sched v1 owns.
```

The server refuses the same write independently, so an API caller cannot
persist what the UI declines to send.

### What is removed

- The `New slice name…` textbox (`MapStage.tsx:950`) — it creates exactly the
  state the rule forbids.
- The disjointness branch in `patchCapability` (`capabilities.ts:139`).

### What is untouched

The band, the slice anchor, `artifactRowStartX`, and the artifact row all keep
working as they are. Only one band is open at a time, so a shared story appears
in whichever band you opened, and no edge crosses another.

`applyStoryToggles` is also unchanged — see the risk below.

## Migration

The two existing zero-story slices (`slice test 3`, `slice test 4` on
`jefelabs-school-visits`) are invalid under the rule and **already have cards on
the Plan and Deliver boards**.

**Ruling: grandfather them.** Deleting slices that have live cards on a board
would destroy work, and forcing a repair before any unrelated edit would block
the map on a chore.

The check is therefore differential, and stated by slice id rather than by
count — a count can stay level while the *set* changes, which would let one
slice be repaired and another broken in the same write:

```
invalidBefore = ids(slicesWithoutExclusiveStory(cap.slices))
invalidAfter  = ids(slicesWithoutExclusiveStory(patch.slices))
reject iff invalidAfter \ invalidBefore is non-empty
```

Read plainly: **a write is rejected when it makes invalid any slice that was
valid before it.** An already-invalid slice may stay invalid; it may also be
repaired; it may not drag a healthy neighbour down with it. A slice created
invalid is rejected, since it appears in `after` and not in `before`.

The panel marks a grandfathered slice so it is visible rather than silent.
Giving it an exclusive story clears the mark; nothing else does.

*(This is my recommendation rather than an explicit ruling from Edwin — flagged
here so it can be reversed cheaply.)*

## Error handling

| Case | Behaviour |
|---|---|
| Selection empty | Button disabled, no message — nothing has been asked for yet |
| Selection would strip another slice | Button disabled, offending slice + story named |
| Server rejects a valid-looking write | 400 surfaced in the panel; the map does not optimistically reorder |
| Slice references a story that no longer exists | Existing behaviour: `sliceStories` throws, caught by the route |
| Capability already invalid (grandfathered) | Write proceeds; panel marks the slice |

## Testing

### The shared case table

Both copies of the predicate are tested against this same table, written out in
each suite. It is what stands in for the shared module the packages do not have.

| slices | invalid | why |
|---|---|---|
| `A[s1,s2,s3]` | — | nothing to share with |
| `A[s1,s2] B[s2,s3]` | — | each owns one |
| `A[s1] B[s1]` | **A, B** | both reported, not just the later one |
| `A[s1,s2] B[s1,s2]` | **A, B** | identical sets |
| `A[s1] B[s1,s2]` | **A** | A's only story is shared; B owns s2 |
| `A[]` | **A** | owns nothing |
| `[]` (no slices) | — | a capability with no slices is fine |
| `A[s1] B[s2] C[s1,s2]` | **C** | C is entirely covered by its neighbours |

The `A[s1] B[s1]` row is the one that catches the likely implementation bug:
iterating and marking the *second* occurrence reports only B, when both slices
are equally unowned.

**Server** (`swarm/src/capabilities.test.ts`) — `patchCapability` rejects a
write that newly invalidates a slice, naming it; accepts an overlapping write
where every slice still owns something; accepts a write touching an
already-invalid capability that does not newly invalidate anything; **rejects a
write that repairs one slice while breaking another** (the case a count-based
check would wave through).

**Client** (`MapStage.test.tsx`) — selecting stories enables the button;
selecting a story that is another slice's last exclusive one disables it and
names both slice and story; creating a slice sends exactly one PATCH carrying
the whole array; hovering a panel row highlights that slice's story nodes and no
others; a grandfathered slice renders its mark.

**The client test must exercise the real mirror, never a stub.** A stubbed
predicate would let the two copies drift apart in exactly the way the shared
case table exists to prevent — and drift here is silent, because the server
would simply start refusing writes the UI believes are fine.

## Out of scope

**Ideation → capability promotion.** The Ideation board (`intake → scoping →
confirm → killed`) has no path into the map today; the intended shape is that a
confirmed ideation card becomes a *capability*, while a slice remains what goes
to Plan. Independent of this work, and gets its own spec.

**Removing a story from a slice**, and **deleting a slice**, keep their current
behaviour. Both ride the same PATCH and the same predicate, so neither needs new
validation, but neither gets new UI here.
