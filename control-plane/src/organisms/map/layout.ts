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

export interface MapModel {
  activities: CapActivityT[];
  stories: CapStoryT[];
  slices: CapSliceT[];
}

export interface MapNode {
  id: string;
  type: "activity" | "step" | "story";
  position: { x: number; y: number };
  /** Set for activities, which span their step group; steps and stories use STEP_W. */
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
    // An activity card spans its step group. `Math.max(…, 1)` is what keeps a
    // just-created, step-less activity on the canvas: it spans the one slot its
    // blank step composer sits in, rather than the -STEP_GAP the bare formula
    // would give. At one step the span term is exactly STEP_W.
    const span = Math.max(steps.length, 1);
    const x = xOf.get(steps[0]?.id ?? blankStepId(act.id));
    if (x !== undefined) {
      nodes.push({
        id: `activity:${act.id}`,
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
        id: `step:${step.id}`,
        type: "step",
        position: { x: stepX, y: ACTIVITY_H + COL_GAP },
        data: { step, activity: act },
        draggable: false,
      });
      const stories = model.stories.filter((s) => s.stepId === step.id).sort((a, b) => a.order - b.order);
      stories.forEach((story, i) => {
        nodes.push({
          id: story.id,
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
