import type { CapActivityT, CapSliceT, CapStoryT } from "../../api/types";

/**
 * Geometry for the story-map canvas.
 *
 * These constants are the SOURCE, not measurements — node CSS is written to match
 * them. `layoutMap` and `cellAt` both consume them, which is what makes the two
 * functions exact inverses rather than two implementations that drift.
 *
 * Note STEP_GAP and ACTIVITY_GAP are different: 8px separates steps inside one
 * activity, 12px separates activities. Conflating them misplaces every column past
 * the first.
 *
 * That pair used to be documented as "read from components.css (.map-activity__steps
 * / .map-stage__grid)". Both selectors were the flexbox backbone and Task 4 deleted
 * them with it — nothing lays these cards out now, xyflow translates each node to a
 * position computed here. So the provenance is inverted, in fact and now in print:
 * these numbers are the source, and the card CSS is written to match them. A constant
 * whose stated origin points at nothing is worse than an undocumented one, because it
 * sends the next reader looking for a rule that cannot be found.
 *
 * This module imports no React and no @xyflow/react, deliberately: the inverse
 * property below is a property of the numbers, and it must be testable without a
 * DOM.
 */
export const STEP_W = 180;
export const STEP_GAP = 8;
export const ACTIVITY_GAP = 12;
/**
 * A story card holds TWO LINES of title, its own row of controls, and nothing else.
 *
 * 56 = 2 border + 6 padding + 28 title + 4 gap + 16 controls, where the title is two
 * 14px line boxes. `line-height` is pinned in the CSS rather than left at `normal`
 * precisely so this addition is exact and does not move with the font stack.
 *
 * The title got its own full-width row here, and that — not the second line — is what
 * made story titles legible. The slice `<select>` beside them is a native one, so it
 * sizes to its widest OPTION rather than its value: measured, it took 123.5px of a
 * 180px card and left the title box **12.5px, about two characters**, on every story
 * in the capability. Naming one slice something long shrank every title on the map,
 * including stories in the backlog. Two lines of a 12.5px box would have been four
 * characters instead of two, so rows alone could never have fixed it.
 */
export const STORY_H = 56;
export const STORY_GAP = 6;
export const COL_GAP = 8;
export const ACTIVITY_H = 32;
/**
 * A step head holds two lines of title beside its remove button.
 *
 * 34 = 2 border + 32 content, and the content box holds two 14px line boxes with the
 * flex centring absorbing the remainder — so a one-line step still sits centred and
 * the height never moves.
 *
 * Steps did NOT have the story cards' problem: their title box measured 142px and
 * every real step name fits on one line. They are clamped anyway, and deliberately —
 * at 142px a title runs out around 26 characters while the longest in `jefelabs` draws
 * 134px, so the next step name anyone types is as likely as not to be cut. This buys
 * the same protection before the second half breaks rather than after.
 */
export const STEP_HEAD_H = 34;

/** Vertical offset where a step's story stack begins. */
export const STORIES_Y = ACTIVITY_H + COL_GAP + STEP_HEAD_H + COL_GAP;
/** Vertical pitch of one story slot. */
export const SLOT_H = STORY_H + STORY_GAP;
/**
 * Separates the revealed slice's row from the story stacks above it.
 *
 * This used to be a HORIZONTAL gap — artifacts sat right of the last column, in a
 * vertical stack. That is why the edges were the loudest thing on the map: reaching a
 * rail past the right edge, every line had to traverse every column, so its length
 * measured the width of the map rather than anything about the model. The row moved
 * underneath; the constant kept its name and its value and changed axis.
 */
export const ARTIFACT_GAP = ACTIVITY_GAP * 2;
/**
 * Height of an anchor or artifact card.
 *
 * It USED to be `SLOT_H` — one story slot, so the band rhymed with the columns above
 * it — and that stopped being true the moment story cards grew to hold two lines:
 * SLOT_H went 38 to 62 while these cards, which already held their two lines in 38,
 * had no reason to follow. The number stayed correct and its stated derivation went
 * stale, which is the failure mode a constant is supposed to prevent. So it is a
 * constant of its own now, and `.map-artifact` mirrors THIS.
 *
 * 38 holds the two lines (kind 11.5 + gap 2 + label 14 + 2 border = 29.5 measured
 * against the compiled bundle) with the flex centring absorbing the rest.
 */
export const ARTIFACT_H = 38;
/**
 * Vertical pitch of the artifact STACK — the one a story reveals beside itself.
 *
 * Re-derived rather than recovered: the horizontal band retired the old pitch because
 * a row is spaced by the column pitch, and this is a different question in a different
 * direction. A stack needs a card plus a gap, so it is ARTIFACT_H + STORY_GAP, and it
 * takes STORY_GAP specifically because these cards read as a list of one story's
 * things — the same relationship stories in a column have to each other.
 *
 * That it lands on the same number the deleted constant held is a coincidence worth
 * naming: the artifact card did not change size, only the story card did.
 */
export const ARTIFACT_STACK_PITCH = ARTIFACT_H + STORY_GAP;

/**
 * The FLOOR a capability card may shrink to, not the width it is drawn at.
 *
 * Cards are fluid: they divide the whole row between them, so the rendered width is
 * whatever the row has to give — roughly 303 each at a 1230px row, roughly 203 at 830.
 * This number is the point below which a card must COLLAPSE into the `+N` menu instead
 * of getting narrower, which is why `capabilityCardsThatFit` still counts in it and why
 * it did not change when the layout became fluid: the same arithmetic answers a
 * different question. It reaches the CSS as `--cap-card-w`, a `min-width` and a
 * flex-basis rather than a `width`.
 *
 * CHROME, not canvas — nothing here positions a node — but it lives with the other
 * geometry because the value is needed twice: the CSS draws against it and the fit
 * calculation counts in it. Two copies of a number that must agree is exactly what this
 * module exists to prevent.
 *
 * 192 is Edwin's number: he asked for 20% off the 240 he was looking at, back when this
 * was a fixed width. The two findings from choosing it are kept because they explain
 * where the floor sits, not because the choice is still live:
 *
 * IT IS NOT 12PX ABOVE A STEP CARD. 192 against STEP_W's 180 looks like nothing, and
 * every argument about whether a capability reads as a level above an activity was made
 * against that pair. They are not comparable: STEP_W is a FLOW-SPACE constant and only
 * equals screen pixels at zoom 1, which is not a state this canvas is normally in —
 * `fitView` settles around 0.71 on real data, where a step card draws 128px. The header
 * is not zoomed at all. Measure the rendered widths, not the constants.
 *
 * THE ROW HOLDS THE BLANK CARD TOO, which is what makes the floor bite where it does:
 * three capabilities need FOUR slots, so the count a window shows turns over at
 * `4W + 3 * CAPABILITY_GAP <= rowWidth`. Against a measured row of 855 that boundary is
 * W <= 209.25 — which is why a 210 floor hid a capability behind the menu on a full
 * window and 192 does not. Re-measure rather than nudge.
 */
export const CAPABILITY_CARD_MIN_W = 192;
export const CAPABILITY_GAP = 6;
/** The `+N` disclosure that holds whatever did not fit. */
export const CAPABILITY_MORE_W = 44;

/**
 * How many capability cards fit before the rest have to collapse into the `+N` menu.
 *
 * THE BLANK CARD IS RESERVED FIRST and is never part of the count, so it cannot be the
 * thing that collapses — creating a capability must not require opening a menu to find
 * the composer. When anything is hidden, the `+N` control has to be paid for too, which
 * is why the second branch reserves it before dividing.
 *
 * Pure and DOM-free like the rest of this module: the caller measures, this decides.
 */
export function capabilityCardsThatFit(rowWidth: number, total: number): number {
  const slot = CAPABILITY_CARD_MIN_W + CAPABILITY_GAP;
  if (total * slot + CAPABILITY_CARD_MIN_W <= rowWidth) return total;
  const forCards = rowWidth - CAPABILITY_CARD_MIN_W - (CAPABILITY_MORE_W + CAPABILITY_GAP);
  return Math.max(0, Math.floor(forCards / slot));
}

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
 * The card a revealed story shows when it belongs to no slice. Keyed by the STORY,
 * because that is the only record involved — there is no slice to name.
 */
export const unassignedNodeId = (storyId: string) => `unassigned:${storyId}`;

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

/**
 * NOT every one of these comes out of `layoutMap`. Activities, steps and stories are
 * the MODEL's levels and are laid out unconditionally; slice anchors and artifacts
 * are EPHEMERAL — MapStage emits them only while a slice is revealed, and `cellAt`
 * never has to resolve a drop onto one because neither is draggable.
 *
 * They are in the union anyway, and only since something emits them: this is the
 * shape every node on the canvas has, not the shape `layoutMap` returns, so the
 * ephemeral nodes are declared `MapNode` at their emission site and typed by it.
 * While nothing emitted them the honest thing was to leave them out — a union member
 * no producer can reach looks supported and is worse than a visible gap.
 */
export interface MapNode {
  id: string;
  type: "activity" | "step" | "story" | "slice" | "artifact";
  position: { x: number; y: number };
  /** Set for activities, which span their step group plus its trailing blank; steps and stories use STEP_W. */
  width?: number;
  data: Record<string, unknown>;
  draggable: boolean;
  /**
   * Selection is how a slice is made, so only REAL story nodes carry it —
   * a lasso across the canvas must not pick up activities, steps, or the blank
   * composers, and a blank has no story id to put in a slice.
   *
   * Non-optional on purpose. Omitting it would let a new node type default to
   * unselectable silently; required, the compiler names every emission site,
   * including the ephemeral slice and artifact nodes MapStage appends.
   */
  selectable: boolean;
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

/**
 * Every REAL activity's left edge, in render order — the horizontal axis one level up.
 *
 * An activity starts at its first step's column, or at its own trailing blank when it
 * has no steps yet. `layoutMap` reads this rather than deriving the same x again, for
 * the reason `stepColumns` exists: the reorder resolver below has to agree with where
 * the card was actually drawn, and two expressions computing "the same" left edge are
 * two things that can disagree.
 */
export function activityColumns(activities: CapActivityT[]): Array<{ activityId: string; x: number }> {
  const xOf = new Map(columns(activities).map((c) => [c.id, c.x]));
  const out: Array<{ activityId: string; x: number }> = [];
  for (const act of [...activities].sort((a, b) => a.order - b.order)) {
    const first = [...act.steps].sort((a, b) => a.order - b.order)[0];
    const x = xOf.get(first?.id ?? blankStepId(act.id));
    if (x !== undefined) out.push({ activityId: act.id, x });
  }
  return out;
}

/**
 * Resolves a dragged ACTIVITY card's position to the index it should take.
 *
 * The inverse of `activityColumns`, and edge-to-edge like `cellAt`: `pos.x` is the
 * dragged card's left edge and so is every candidate. Comparing an edge to a slot's
 * CENTRE is the defect that made a story land a column to its left for years — it is
 * one file away from here and must not come back by analogy.
 *
 * Activities have DIFFERENT widths, since each spans its own step group, so there is no
 * single pitch to divide by. Nearest left edge is what stays correct when the slots are
 * ragged; a midpoint rule would need each neighbour's width and would still have to
 * pick a side at the boundary.
 *
 * Returns null for a drop outside the backbone's own band, so the caller snaps back
 * rather than reordering on a gesture that was heading somewhere else.
 */
export function activityAt(pos: { x: number; y: number }, model: MapModel): number | null {
  const cols = activityColumns(model.activities);
  if (cols.length === 0) return null;
  if (!withinBackboneBand(pos, model)) return null;

  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  cols.forEach((col, index) => {
    const distance = Math.abs(pos.x - col.x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/**
 * Resolves a dragged STEP card's position to the activity and index it should take.
 *
 * Returns the ACTIVITY as well as the index because a step genuinely belongs to one —
 * the resolution has no way to express "somewhere in the same activity" without first
 * saying which activity the position is in. Whether a caller acts on a cross-activity
 * answer is its decision; this only reports where the card was dropped.
 *
 * A drop whose nearest column is a BLANK one resolves to null, exactly as `cellAt`
 * does. That is what keeps the trailing composer from being displaced: it is a slot no
 * record can take.
 */
export function stepAt(pos: { x: number; y: number }, model: MapModel): { activityId: string; index: number } | null {
  const cols = columns(model.activities);
  if (cols.filter((c) => !c.blank).length === 0) return null;
  if (!withinBackboneBand(pos, model)) return null;

  let best = cols[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const col of cols) {
    const distance = Math.abs(pos.x - col.x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = col;
    }
  }
  if (best.blank) return null;

  for (const act of [...model.activities].sort((a, b) => a.order - b.order)) {
    const steps = [...act.steps].sort((a, b) => a.order - b.order);
    const index = steps.findIndex((s) => s.id === best.id);
    if (index >= 0) return { activityId: act.id, index };
  }
  return null;
}

/**
 * The horizontal and vertical extent a backbone drop has to land in.
 *
 * Shared by both resolvers so they cannot disagree about what counts as "on the map".
 * The vertical bound is generous — anywhere above the first story slot — because a card
 * dragged sideways wanders vertically and rejecting that would make the gesture feel
 * broken; it is the drop that leaves the map entirely that has to be refused.
 */
function withinBackboneBand(pos: { x: number; y: number }, model: MapModel): boolean {
  // EVERY column, blanks included, because this is the map's physical extent and not a
  // list of drop targets — which slots are takeable is the callers' business. Measuring
  // it from real step columns alone put a step-less activity OUTSIDE the map it was
  // drawn on: such an activity starts at its own blank step slot, and a trailing one
  // sits beyond the last real step by more than REJECT_MARGIN, so its own card resolved
  // to null when dropped exactly where it was drawn.
  const cols = columns(model.activities);
  if (cols.length === 0) return false;
  const left = cols[0].x;
  const right = cols[cols.length - 1].x + STEP_W;
  if (pos.x < left - REJECT_MARGIN || pos.x > right + REJECT_MARGIN) return false;
  return pos.y < STORIES_Y;
}

/**
 * Where the revealed slice's artifact row sits, measured from the DEEPEST story
 * stack rather than from a fixed offset — anything fixed would either float far above
 * a tall column or be buried by it.
 *
 * `+ 1` counts the trailing blank composer, which is a real card at the bottom of
 * every column including an empty one. Measuring to the last REAL story instead lands
 * the row exactly on top of that composer, which is the kind of overlap that only
 * shows up with a full column and reads as a rendering bug when it does.
 *
 * Stories are counted only against steps that exist. A story whose step has been
 * removed renders nowhere — `layoutMap` iterates steps, not stories — so letting one
 * count here would push the row down to clear a card nobody can see.
 */
export function artifactRowY(model: MapModel): number {
  const realSteps = new Set(stepColumns(model.activities).map((c) => c.stepId));
  const perStep = new Map<string, number>();
  for (const story of model.stories) {
    if (!realSteps.has(story.stepId)) continue;
    perStep.set(story.stepId, (perStep.get(story.stepId) ?? 0) + 1);
  }
  const deepest = Math.max(0, ...perStep.values());
  return STORIES_Y + (deepest + 1) * SLOT_H + ARTIFACT_GAP;
}

/**
 * Where the artifact at `index` sits horizontally: a plain row on the step pitch,
 * starting under the first column.
 *
 * UNIFORM, and it does not track the columns past the first activity — deliberately.
 * Real columns are not evenly spaced: `columns` inserts a whole blank step slot plus
 * ACTIVITY_GAP at every activity boundary, so by the second activity a uniform row
 * has drifted a full column left of the step above it. Chasing that with
 * `stepColumns(...)[index].x` would look tidier and claim something false — an
 * artifact belongs to the SLICE, not to the step it happens to sit beneath, and
 * lining them up would invite exactly that reading. It also runs out: a slice has up
 * to four artifacts and a map may have one step.
 *
 * There is no ARTIFACT_PITCH any more. It spaced a VERTICAL stack, and a row is
 * spaced by the column pitch — `STEP_W + STEP_GAP`, the same expression `columns`
 * advances by. Keeping it would have left a constant nothing computes with.
 */
export function artifactRowX(index: number, startX = 0): number {
  return startX + index * (STEP_W + STEP_GAP);
}

/**
 * Where the `index`th card of a STORY's revealed stack sits, given that story's own
 * position.
 *
 * BESIDE the story, not below it, and the difference is what the reveal costs: a stack
 * below runs straight down the story's own column and buries every story under it,
 * which is the column the reader is asking about. One column to the right lands on the
 * neighbouring column instead — still an overlap, since the reveal is ephemeral and
 * nothing reflows for it, but it obscures the stories the question is NOT about.
 *
 * Starting level with the story rather than one slot down is what makes the relation
 * readable without an edge: the first card of the stack and the story it belongs to
 * share a top edge, so they read as a pair the moment they appear.
 */
export function storyStackPosition(story: { x: number; y: number }, index: number): { x: number; y: number } {
  return { x: story.x + STEP_W + STEP_GAP, y: story.y + index * ARTIFACT_STACK_PITCH };
}

/**
 * Where a revealed slice's artifact row BEGINS: under the leftmost column holding one
 * of its own stories.
 *
 * Anchoring the row to the slice rather than to the map's origin is what keeps the
 * cards next to the thing they describe. A slice whose stories all sit in the second
 * activity would otherwise hang its spec and its cards under the FIRST activity's
 * columns — whose stories are, at that moment, all dimmed — so the map would show a
 * document under a column it has nothing to do with.
 *
 * Falls back to the origin for a slice that owns no stories, which is what a slice
 * looks like between being created and having anything dragged into it.
 */
export function artifactRowStartX(model: MapModel, slice: CapSliceT): number {
  const owned = new Set(slice.storyIds);
  const xOf = new Map(stepColumns(model.activities).map((c) => [c.stepId, c.x]));
  const xs = model.stories
    .filter((s) => owned.has(s.id))
    .map((s) => xOf.get(s.stepId))
    .filter((x): x is number => x !== undefined);
  return xs.length > 0 ? Math.min(...xs) : 0;
}

/** Derives every node's position from the model. Layout is never stored. */
export function layoutMap(model: MapModel): { nodes: MapNode[] } {
  const nodes: MapNode[] = [];
  const xOf = new Map(columns(model.activities).map((c) => [c.id, c.x]));
  const activityX = new Map(activityColumns(model.activities).map((c) => [c.activityId, c.x]));

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
    // From activityColumns, not derived again here — the reorder resolver inverts that
    // function, and a second expression for "this activity's left edge" is a second
    // thing that can disagree with where the card was drawn.
    const x = activityX.get(act.id);
    if (x !== undefined) {
      nodes.push({
        id: activityNodeId(act.id),
        type: "activity",
        position: { x, y: 0 },
        width: span * STEP_W + (span - 1) * STEP_GAP,
        data: { activity: act },
        // Draggable to REORDER. The handle is the card's text, so the remove button —
        // which carries `nodrag` — stays clickable, and dragging an activity is a
        // deliberate grab of its title rather than anything that happens on the card.
        draggable: true,
        selectable: false,
        dragHandle: ".map-card__text",
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
        // Same as its activity: draggable to reorder, by the title rather than the card.
        draggable: true,
        selectable: false,
        dragHandle: ".map-card__text",
      });
      const stories = model.stories.filter((s) => s.stepId === step.id).sort((a, b) => a.order - b.order);
      stories.forEach((story, i) => {
        nodes.push({
          id: storyNodeId(story.id),
          type: "story",
          position: { x: stepX, y: STORIES_Y + i * SLOT_H },
          data: { story },
          draggable: true,
          // The only true in this function: a slice is a set of real stories.
          selectable: true,
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
        selectable: false,
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
        selectable: false,
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
      selectable: false,
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
    // BOTH OPERANDS ARE LEFT EDGES, and that is the entire point. `pos.x` is the
    // dragged node's left edge — xyflow reports a node's position as its top-left —
    // and `col.x` is the column's. This used to read `pos.x - (col.x + STEP_W / 2)`,
    // comparing an edge against a CENTRE, which silently asked the card's left edge to
    // sit at the column's middle and so shifted the whole acceptance window half a card
    // to the right.
    //
    // The arithmetic, with `d` the node's offset from its own column's left edge and a
    // column pitch of STEP_W + STEP_GAP = 188. Before: the column won for
    // d ∈ (-4, 184) — |d - 90| < |d + 98| gives d > -4, and |d - 90| < |d - 278| gives
    // d < 184. FOUR pixels of tolerance to the left against 184 to the right. Nudge a
    // card five pixels left of where it already sits and the drop lands a column back.
    // After: d ∈ (-94, 94), symmetric, exactly half the pitch, which is what "nearest
    // column" should always have meant.
    //
    // Comparing centre to centre would be algebraically identical AND carry a trap: the
    // card's half-width only cancels the column's while the two are both STEP_W. Edge
    // to edge needs no width at all.
    const distance = Math.abs(pos.x - col.x);
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
