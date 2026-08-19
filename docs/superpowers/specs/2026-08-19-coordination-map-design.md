# Coordination Map — Design

**Date:** 2026-08-19
**Status:** Approved design, ready for planning
**Part of:** spec 9 of nine — the last — in the decomposition drawn from the
Hamster / herdr / Orca teardown.
**Depends on:** spec 6 (`2026-08-19-dispatch-entity-design.md`) for `retryOf` and
`parentDispatchId`, the edges this draws. Deferred here from spec 4
(`2026-08-17-agent-visibility-design.md`), which cut it precisely because that
lineage did not exist yet.

## Goal

Nothing shows how attempts relate to each other.

Spec 4's board answers *what needs attention* — a list of work items by state,
sorted so the blocked ones come first. That is the right shape for triage and the
wrong shape for two questions it structurally cannot answer:

- **This attempt replaced that one.** A work item that succeeded on its third try
  looks identical to one that succeeded immediately. The retries exist in the
  data and nowhere in the interface.
- **This worker was spawned by that coordinator.** When a coordinating agent
  creates child dispatches, the parentage is recorded and invisible, so a crew of
  eight reads as eight peers.

Both are edges between dispatches. A list can render nodes; it cannot render the
relationships between them, which is the entire reason to spend a canvas.

The canvas itself is not new work. `MapStage` already runs `@xyflow/react` with a
`nodeTypes` registry and a documented fix for the CSS-layering conflict between
xyflow's chrome and the app's card rules. What does not transfer are the node
types, which are story-map domain — steps, activities, slices.

## Settled decisions

- **Nodes are dispatches**, not sessions and not work items.
- **Two edge kinds**, distinguishable by form rather than colour alone.
- **Its own stage**, global, with history included.
- **The default view is bounded**; history is one filter away.
- **A swarm dispatch is one node**, its members rendered as chips.
- **Filtered-empty and genuinely-empty must not look alike.**

## 1. Why dispatches are the node

Lineage is a property of the attempt. `retryOf` points from one dispatch to
another; `parentDispatchId` records which dispatch created this one. Neither is
expressible on a work item, which has many attempts, or on a session, which is a
member of one.

Choosing the node type is therefore not a rendering preference — it is the only
choice under which the edges exist at all.

| element | carries |
| --- | --- |
| node | work-item title, assignee, state, outcome, host, timestamps |
| `retryOf` edge | *this attempt replaced that one* — temporal |
| `parentDispatchId` edge | *this worker was spawned by that coordinator* — hierarchical |

Retries of one work item cluster visually. That is containment, but only where it
serves lineage; the general containment view — workspace, work item, assignee,
session — is what spec 4 already renders better as a list, and duplicating it
here was the reason the map was cut from that spec.

**The two edge kinds must differ in form**, not only in colour: line weight,
dash, arrowhead. Spec 4 sets the same rule for state, and it applies harder here
because the two relationships mean genuinely different things — one is "instead
of", the other is "underneath".

## 2. Bounded by default, complete on demand

The stage opens showing dispatches that are live (`pending` or `working`) or
settled within a recent window.

History is not excluded — it is one control away. The time filter widens through
24 hours, 7 days, 30 days, and all. Additional filters narrow by workspace,
assignee, and state, plus a toggle for edge kind.

That last filter is not decoration. Lineage edges are the densest element on the
canvas, and Orca ships exactly this control — hiding orchestration links without
removing the nodes — which is a strong signal that a graph of this shape needs it
in practice rather than in theory.

An active-filter count is shown, and clearing resets only the filters that are
on. A view that silently hides most of its data is worse than one that shows too
much, because the second is obviously wrong and the first is quietly wrong.

**Why not open on everything.** The stage is specified as global and historical,
and it is. But a first open on a busy repo after a few weeks would render a graph
nobody can read, and the reasonable response to an unreadable view is to stop
opening it. Bounding the default costs nothing — every dispatch remains one
control away — and it is the difference between a stage that is used and one that
is abandoned in its first week.

## 3. A swarm dispatch is one node

Members render as chips carrying their own states, not as separate nodes.

This is the same decision spec 4 makes for cards and spec 5 makes for the sleep
unit: the assignee is the unit, and a five-member swarm is one object. Rendering
members as nodes would multiply a crew that retried twice into fifteen nodes
describing one piece of work.

## 4. Data path

A swarm route serving dispatches, plus its named broker passthrough — the same
shape spec 4 establishes for sessions, in the same place in `broker/src/main.ts`.

**Spec 4's route-parity test covers this automatically.** It asserts that every
swarm route the UI depends on has a passthrough, so a dispatch route added
without its proxy fails a test rather than shipping as an empty canvas. That is
the test paying for itself on the very next spec that adds a route, which is the
argument for having written it as a test rather than a note.

## 5. Empty, filtered, and blind must differ

Three states that all render as "no nodes" and mean different things:

| state | cause | rendering |
| --- | --- | --- |
| genuinely empty | spec 6 unbuilt, or nothing has ever run | explain that no dispatches exist yet |
| filtered to nothing | the current filters exclude everything | say so, and offer to clear them |
| unreachable | the broker passthrough is missing or failing | a connection error, never an empty canvas |

Spec 4 draws the same distinction between an empty board and a blind one. It
recurs because the failure is structural: an interface that renders absence
identically regardless of cause teaches its reader that absence means nothing is
happening, which is true in one of these three cases.

## 6. Reuse and what does not transfer

**Reused:** the `@xyflow/react` setup, the `nodeTypes` registry pattern, and the
deliberate decision in `MapStage` to leave xyflow's stylesheet unlayered so its
chrome stays authoritative over the app's card rules. That comment exists because
someone already lost time to it.

**Not reused:** `StoryNode`, `StepNode`, `ActivityNode`, `SliceNode`. They model a
story map. This spec adds a dispatch node and two edge components.

## 7. Testing

- **Both edge kinds render**, from `retryOf` and from `parentDispatchId`, and are
  distinguishable by more than colour.
- **Default window:** a dispatch settled outside the window is absent, and
  widening the filter brings it in.
- **Three empties:** genuinely-empty, filtered-empty, and unreachable each render
  differently. Asserted separately, because the bug is that they converge.
- **Swarm dispatch is one node** with member chips, not N nodes.
- **Route parity** is inherited from spec 4 and must cover the dispatch route.

**A known trap, written down rather than rediscovered:** jsdom's `ByRole` cannot
see react-flow node children — the dashboards work already hit this. Assertions
about node *content* need a different query strategy, or they pass vacuously
while rendering nothing. A test that cannot fail is worse than no test, because
it is counted as coverage.

## Out of scope

- **Layout persistence.** Positions are computed per render; remembering a
  user's arrangement is a later change.
- **Editing from the map.** It is a reading surface. Retrying or cancelling a
  dispatch belongs to spec 6's routes and spec 4's board.
- **A timeline view.** Attempts along a time axis answers a forensic question
  well and is a different visualization, not a variant of this one.
- **Session-level nodes.** §3; members are chips.
- **Containment as the primary layout.** Spec 4's board renders it better, which
  is why this spec exists separately at all.
