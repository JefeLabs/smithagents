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
 *
 * This module imports no React and no @xyflow/react, deliberately: the inverse
 * property below is a property of the numbers, and it must be testable without a
 * DOM.
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

/**
 * Node ids, for every level of the map.
 *
 * These are exported rather than written inline at the emission sites because
 * `layoutMap` is not the only module that names a node: edges carry node ids as
 * `source`/`target`, and an edge naming a node that does not exist is not an
 * error anywhere — xyflow simply draws nothing. Two modules agreeing about a
 * template literal is not the same as there being one format, so there is one
 * function per level and both callers go through it.
 *
 * MIND THE ASYMMETRY: activities and steps are prefixed, stories are NOT. A
 * story node's id IS the story's id, because a story is the only level the user
 * drags — `cellAt` resolves a drop by matching node id to `CapStoryT.id`, and a
 * prefix would have to be stripped at every one of those seams. So "the obvious
 * thing" is right twice and wrong once, which is exactly the shape of mistake
 * that survives review.
 *
 * `slice` and `artifact` have no nodes yet; the levels are laid out later. They
 * live here anyway so that whoever adds them imports a format instead of
 * re-deriving one that has to match edges already in flight.
 */
export const activityNodeId = (activityId: string) => `activity:${activityId}`;
export const stepNodeId = (stepId: string) => `step:${stepId}`;
export const storyNodeId = (storyId: string) => storyId;
export const sliceNodeId = (sliceId: string) => `slice:${sliceId}`;
/** The four artifacts a slice can hang off itself; absent ones get no node. */
export type ArtifactKind = "spec" | "plan" | "capCard" | "deliveryCard";
export const artifactNodeId = (sliceId: string, kind: ArtifactKind) => `artifact:${sliceId}:${kind}`;

/**
 * Reserved id prefix for the trailing blank card at each level. Blankness is a
 * LAYOUT concern — the model has no `isDraft` field — so these ids exist only
 * between `layoutMap` and the node components. A real id (a uuid) never begins
 * with it, which is what keeps `data.blank` and the id in agreement.
 */
const BLANK_PREFIX = "new:";
/** The trailing blank activity — one per map, not one per parent. */
export const BLANK_ACTIVITY_ID = `${BLANK_PREFIX}activity`;
export const blankStepId = (activityId: string) => `${BLANK_PREFIX}step:${activityId}`;
export const blankStoryId = (stepId: string) => `${BLANK_PREFIX}story:${stepId}`;

/**
 * The model layout reads. Positions are derived from it and never stored back.
 *
 * INVARIANT — story `order` within a step is DENSE and 0-based (0, 1, 2, …).
 * `layoutMap` places stories by ARRAY INDEX after sorting, while `cellAt` returns
 * a SLOT INDEX; both coincide with `order` only while that holds. Given sparse
 * orders (say 0 and 5) the second story renders in slot 1 and `cellAt` reports
 * `order: 1`, not 5 — pinned by the sparse-order test, which asserts the current
 * behaviour rather than a preferred one.
 *
 * Nothing here normalises, deliberately: whether the broker can emit sparse
 * orders is not knowable from this module, and guessing a normalisation would
 * invent a contract rather than honour one. If it turns out it can, the fix
 * belongs where the model is written, not in geometry.
 */
export interface MapModel {
  activities: CapActivityT[];
  stories: CapStoryT[];
  slices: CapSliceT[];
}

export interface MapNode {
  id: string;
  type: "activity" | "step" | "story";
  position: { x: number; y: number };
  /** Set for activities, which span their step group plus its trailing blank; steps and stories use STEP_W. */
  width?: number;
  data: Record<string, unknown>;
  draggable: boolean;
  dragHandle?: string;
}

/** One slot on the horizontal axis — a real step's column, or a blank composer's. */
interface Column {
  /** Node id of the card occupying this slot: a real step id, or a synthetic blank id. */
  id: string;
  x: number;
  blank: boolean;
}

/**
 * Every slot on the horizontal axis, left to right, blanks included.
 *
 * The blanks are in here rather than bolted on afterwards because they OCCUPY
 * SPACE: an activity's trailing "add a step" card is a full-width column, and if
 * the cursor did not advance past it, the next activity's first real step would
 * be laid down on top of it.
 */
function columns(activities: CapActivityT[]): Column[] {
  const cols: Column[] = [];
  let x = 0;
  for (const act of [...activities].sort((a, b) => a.order - b.order)) {
    const steps = [...act.steps].sort((a, b) => a.order - b.order);
    for (const step of steps) {
      cols.push({ id: step.id, x, blank: false });
      x += STEP_W + STEP_GAP;
    }
    // Every activity ends with a blank step slot, including an activity with no
    // steps at all — which is exactly what typing into the blank activity card
    // produces, so it is the common case and not an edge one.
    cols.push({ id: blankStepId(act.id), x, blank: true });
    x += STEP_W + STEP_GAP;
    // The loop already added a STEP_GAP after the activity's blank step; the
    // space before the next activity should be ACTIVITY_GAP instead.
    x += ACTIVITY_GAP - STEP_GAP;
  }
  cols.push({ id: BLANK_ACTIVITY_ID, x, blank: true });
  return cols;
}

/**
 * Every REAL step column's x, left to right in render order. The single place
 * column geometry is computed — both layoutMap and cellAt call `columns`, so
 * neither can disagree with the other about where a column is.
 */
export function stepColumns(activities: CapActivityT[]): Array<{ stepId: string; x: number }> {
  return columns(activities)
    .filter((c) => !c.blank)
    .map((c) => ({ stepId: c.id, x: c.x }));
}

/** Derives every node's position from the model. Layout is never stored. */
export function layoutMap(model: MapModel): { nodes: MapNode[] } {
  const nodes: MapNode[] = [];
  const xOf = new Map(columns(model.activities).map((c) => [c.id, c.x]));

  for (const act of [...model.activities].sort((a, b) => a.order - b.order)) {
    const steps = [...act.steps].sort((a, b) => a.order - b.order);
    // An activity card spans its real steps AND its trailing blank. The blank is
    // inside the span because typing into it creates a step in THIS activity: an
    // affordance that belongs to a parent has to render under that parent, or
    // with several activities side by side the user cannot tell which one they
    // are adding to. `+ 1` also makes the step-less case fall out on its own —
    // span 1, exactly STEP_W — which is what the old Math.max was there to
    // protect.
    const span = steps.length + 1;
    const x = xOf.get(steps[0]?.id ?? blankStepId(act.id));
    if (x !== undefined) {
      nodes.push({
        id: activityNodeId(act.id),
        type: "activity",
        position: { x, y: 0 },
        width: span * STEP_W + (span - 1) * STEP_GAP,
        data: { activity: act },
        draggable: false,
      });
    }

    for (const step of steps) {
      const stepX = xOf.get(step.id);
      if (stepX === undefined) continue;
      nodes.push({
        id: stepNodeId(step.id),
        type: "step",
        position: { x: stepX, y: ACTIVITY_H + COL_GAP },
        data: { step, activity: act },
        draggable: false,
      });
      const stories = model.stories.filter((s) => s.stepId === step.id).sort((a, b) => a.order - b.order);
      stories.forEach((story, i) => {
        nodes.push({
          id: storyNodeId(story.id),
          type: "story",
          position: { x: stepX, y: STORIES_Y + i * SLOT_H },
          data: { story },
          draggable: true,
          dragHandle: ".map-story__handle",
        });
      });
      nodes.push({
        id: blankStoryId(step.id),
        type: "story",
        position: { x: stepX, y: STORIES_Y + stories.length * SLOT_H },
        // `stepId` rather than the parsed id: the component that turns typed
        // text into a real story needs the parent, and should not have to take
        // the id apart to find it.
        data: { blank: true, stepId: step.id },
        draggable: false,
      });
    }

    const blankStepX = xOf.get(blankStepId(act.id));
    if (blankStepX !== undefined) {
      nodes.push({
        id: blankStepId(act.id),
        type: "step",
        position: { x: blankStepX, y: ACTIVITY_H + COL_GAP },
        data: { blank: true, activityId: act.id },
        draggable: false,
      });
    }
  }

  const blankActivityX = xOf.get(BLANK_ACTIVITY_ID);
  if (blankActivityX !== undefined) {
    nodes.push({
      id: BLANK_ACTIVITY_ID,
      type: "activity",
      position: { x: blankActivityX, y: 0 },
      width: STEP_W,
      data: { blank: true },
      draggable: false,
    });
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
 * Boundary behaviour: forgiving inside the grid, strict outside it. Gaps snap to the
 * nearest column; drops past the last story append; drops outside the grid are
 * rejected with null so the caller snaps back.
 *
 * A drop whose nearest column is a BLANK one is rejected too, and that is the
 * rejection that matters: it means "file this story under a step that does not
 * exist yet", which cannot be persisted. Note what is NOT rejected — the blank
 * story slot at the bottom of a real column. That slot sits at order === count,
 * i.e. it IS the append target, in a step that already exists; rejecting it would
 * delete drag-to-end-of-column, and no cell would be missing in any case.
 */
export function cellAt(pos: { x: number; y: number }, model: MapModel): { stepId: string; order: number } | null {
  const cols = columns(model.activities);
  const real = cols.filter((c) => !c.blank);
  if (real.length === 0) return null;

  const left = real[0].x;
  const right = real[real.length - 1].x + STEP_W;
  // Asymmetric in practice, and deliberately kept that way. The LEFT half is
  // live — nothing sits left of the first column. The RIGHT half is currently
  // unreachable as a cause: the last real column is always followed by its
  // activity's blank step at `right + STEP_GAP`, and STEP_GAP < STEP_W, so this
  // threshold falls INSIDE that blank column and the `best.blank` guard below
  // returns null first. Deleting this term changes no behaviour today, which is
  // why no test can pin it. It stays because it does not depend on the blank
  // invariant: a mode that stops emitting trailing composers would make it live
  // again, and correct.
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
  if (best.blank) return null;

  const count = model.stories.filter((s) => s.stepId === best.id).length;
  const raw = Math.round((pos.y - STORIES_Y) / SLOT_H);
  return { stepId: best.id, order: Math.max(0, Math.min(raw, count)) };
}
