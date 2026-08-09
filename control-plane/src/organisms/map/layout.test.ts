import { describe, expect, it } from "vitest";
import type { MapModel, MapNode } from "./layout";
import {
  BLANK_ACTIVITY_ID,
  blankStepId,
  blankStoryId,
  cellAt,
  layoutMap,
  SLOT_H,
  STEP_W,
  STORIES_Y,
  stepColumns,
} from "./layout";

/**
 * Two activities: `act1` has two steps, `act2` has one. Exercises ACTIVITY_GAP.
 *
 * DELIBERATELY SHUFFLED — every array here is in the WRONG order, so that array
 * order disagrees with `.order` at all three sort sites (activities, steps,
 * stories). A fixture that happens to be pre-sorted makes the sorts free: delete
 * all three and the suite still passes, while a real model whose `order` has
 * moved — which is what a reorder produces before the next fetch — lays out
 * wrong with nothing to catch it. Expected values below are unchanged by the
 * shuffle, which is the point: layout follows `.order`, never array position.
 */
const MODEL: MapModel = {
  activities: [
    { id: "act2", name: "Report", order: 1, steps: [{ id: "st3", name: "Export", order: 0 }] },
    {
      id: "act1",
      name: "Manage Tours",
      order: 0,
      steps: [
        { id: "st2", name: "Analyze", order: 1 },
        { id: "st1", name: "Define", order: 0 },
      ],
    },
  ],
  stories: [
    { id: "s2", stepId: "st1", order: 1, text: "edit slots", done: false },
    { id: "s3", stepId: "st2", order: 0, text: "view analytics", done: false },
    { id: "s1", stepId: "st1", order: 0, text: "create slots", done: true },
  ],
  slices: [],
};

const nodeById = (nodes: MapNode[], id: string): MapNode => {
  const node = nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
};

describe("stepColumns", () => {
  it("lays steps left to right, using ACTIVITY_GAP between activities", () => {
    const cols = stepColumns(MODEL.activities);
    expect(cols.map((c) => c.stepId)).toEqual(["st1", "st2", "st3"]);
    // st1 at 0; st2 one step-width + STEP_GAP later. st3 is THREE slots along,
    // not two: act1's trailing blank step card occupies a full column of its
    // own, and if the cursor did not clear it the next activity's first step
    // would be laid down on top of it.
    expect(cols[0].x).toBe(0);
    expect(cols[1].x).toBe(STEP_W + 8);
    expect(cols[2].x).toBe((STEP_W + 8) * 3 + (12 - 8));
  });

  it("returns real columns only — a blank composer slot is not a step", () => {
    const cols = stepColumns(MODEL.activities);
    expect(cols).toHaveLength(3);
    expect(cols.some((c) => c.stepId.startsWith("new:"))).toBe(false);
  });
});

describe("layoutMap sizes an activity to its step group", () => {
  const { nodes } = layoutMap(MODEL);

  it("spans its real steps plus its trailing blank", () => {
    expect(nodeById(nodes, "activity:act1").width).toBe(STEP_W * 3 + 8 * 2);
    expect(nodeById(nodes, "activity:act2").width).toBe(STEP_W * 2 + 8);
  });

  it("is exactly STEP_W wide with no steps at all", () => {
    // The boundary where an off-by-one in the (span - 1) * STEP_GAP term
    // vanishes: at span 1 there is no gap term, so a step-less activity must be
    // a plain step-width. This is also the state typing into the blank activity
    // card produces, so it is the common case rather than an edge one.
    const empty: MapModel = { ...MODEL, activities: [{ id: "act0", name: "Fresh", order: 0, steps: [] }] };
    const node = nodeById(layoutMap(empty).nodes, "activity:act0");
    expect(node.width).toBe(STEP_W);
    expect(node.width).toBe(180);
    expect(node.position).toEqual({ x: 0, y: 0 });
  });

  it("contains its own blank step card, so the affordance is never unparented", () => {
    // The property, not the arithmetic: typing into a blank step card creates a
    // step in THAT activity, so it must render within that activity's span or
    // the user cannot tell which of several side-by-side activities they are
    // adding to.
    for (const actId of ["act1", "act2"]) {
      const card = nodeById(nodes, `activity:${actId}`);
      const blank = nodeById(nodes, blankStepId(actId));
      const width = card.width;
      if (width === undefined) throw new Error(`activity ${actId} has no width`);
      expect(blank.position.x).toBeGreaterThanOrEqual(card.position.x);
      expect(blank.position.x + STEP_W).toBeLessThanOrEqual(card.position.x + width);
    }
  });
});

describe("layoutMap emits the trailing blank card at every level", () => {
  const { nodes } = layoutMap(MODEL);

  it("marks each one blank and undraggable", () => {
    for (const id of [BLANK_ACTIVITY_ID, blankStepId("act1"), blankStepId("act2"), blankStoryId("st3")]) {
      const node = nodeById(nodes, id);
      expect(node.data.blank).toBe(true);
      expect(node.draggable).toBe(false);
    }
  });

  it("carries the parent in data, so no component has to parse an id", () => {
    expect(nodeById(nodes, blankStepId("act1")).data.activityId).toBe("act1");
    expect(nodeById(nodes, blankStoryId("st1")).data.stepId).toBe("st1");
  });

  it("reserves ids no real node can collide with", () => {
    expect(BLANK_ACTIVITY_ID).toBe("new:activity");
    expect(blankStepId("act1")).toBe("new:step:act1");
    expect(blankStoryId("st1")).toBe("new:story:st1");
    const real = nodes.filter((n) => !n.data.blank);
    expect(real.some((n) => n.id.includes("new:"))).toBe(false);
  });

  it("puts a column's blank story directly below its last story", () => {
    // st1 has two stories, so its blank sits in slot 2; st3 has none, so its
    // blank is the first slot.
    expect(nodeById(nodes, blankStoryId("st1")).position.y).toBe(STORIES_Y + 2 * SLOT_H);
    expect(nodeById(nodes, blankStoryId("st3")).position.y).toBe(STORIES_Y);
  });
});

describe("cellAt is the exact inverse of layoutMap", () => {
  it("round-trips every story back to its own cell", () => {
    const { nodes } = layoutMap(MODEL);
    const storyNodes = nodes.filter((n) => n.type === "story" && !n.data.blank);
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

  it("commits to the next slot from the slot's midpoint, not its far edge", () => {
    // Pins Math.round over Math.floor. Every other y here is an exact multiple
    // of SLOT_H, where the two agree — so without this the constant that decides
    // how the insert FEELS (commit halfway through the slot, versus having to
    // drag past the whole of it) is free to change unnoticed.
    expect(cellAt({ x: cols[0].x, y: STORIES_Y + SLOT_H * 0.6 }, MODEL)).toEqual({
      stepId: "st1",
      order: 1,
    });
    expect(cellAt({ x: cols[0].x, y: STORIES_Y + SLOT_H * 0.4 }, MODEL)).toEqual({
      stepId: "st1",
      order: 0,
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

  it("returns null when every activity is step-less", () => {
    const empty: MapModel = { ...MODEL, activities: [{ id: "act0", name: "Fresh", order: 0, steps: [] }] };
    expect(cellAt({ x: 0, y: STORIES_Y }, empty)).toBeNull();
  });
});

describe("story order is assumed dense — pinned, not endorsed", () => {
  // layoutMap places stories by array index after sorting and cellAt returns a
  // SLOT index; both read as `order` only while a step's stories are 0,1,2,…
  // MODEL is dense, so nothing else in this file can tell index-based placement
  // from order-based placement apart. This fixture is sparse on purpose and
  // asserts what the code CURRENTLY does, so the assumption is visible and will
  // fail loudly if someone changes it. See MapModel's doc comment: whether the
  // broker can emit sparse orders is not knowable here, and the fix — if one is
  // ever needed — belongs where the model is written, not in geometry.
  const SPARSE: MapModel = {
    activities: [{ id: "act1", name: "Manage Tours", order: 0, steps: [{ id: "st1", name: "Define", order: 0 }] }],
    stories: [
      { id: "s1", stepId: "st1", order: 0, text: "create slots", done: false },
      { id: "s2", stepId: "st1", order: 5, text: "edit slots", done: false },
    ],
    slices: [],
  };

  it("packs a gap in order into consecutive slots", () => {
    const { nodes } = layoutMap(SPARSE);
    // order 5 renders in slot 1, NOT slot 5 — no vertical hole is left.
    expect(nodeById(nodes, "s2").position.y).toBe(STORIES_Y + SLOT_H);
    expect(nodeById(nodes, blankStoryId("st1")).position.y).toBe(STORIES_Y + SLOT_H * 2);
  });

  it("reports the slot index, which is NOT that story's order when orders are sparse", () => {
    const { nodes } = layoutMap(SPARSE);
    // The round-trip property this file asserts for MODEL breaks here, and that
    // is the finding: cellAt says 1, the story says 5.
    expect(cellAt(nodeById(nodes, "s2").position, SPARSE)).toEqual({ stepId: "st1", order: 1 });
    expect(SPARSE.stories[1].order).toBe(5);
  });
});

describe("cellAt and blank cells", () => {
  const { nodes } = layoutMap(MODEL);

  it("rejects a drop onto a blank COLUMN — that step does not exist yet", () => {
    // act1's blank step card, dead centre. It sits BETWEEN two real columns, so
    // the out-of-grid margin cannot be what rejects it: without this guard the
    // drop would snap sideways into st2 and land a story somewhere the user did
    // not aim, and with a naive guard it would resolve to a step id that has no
    // record behind it.
    const blank = nodeById(nodes, blankStepId("act1")).position;
    expect(cellAt({ x: blank.x + STEP_W / 2, y: STORIES_Y }, MODEL)).toBeNull();
    const blank2 = nodeById(nodes, blankStepId("act2")).position;
    expect(cellAt({ x: blank2.x + STEP_W / 2, y: STORIES_Y }, MODEL)).toBeNull();
  });

  it("accepts a drop onto a blank STORY slot, because that is the append target", () => {
    // The one blank that is NOT a missing cell: it sits at order === count in a
    // step that already exists, so resolving it is an append and rejecting it
    // would delete drag-to-end-of-column.
    const blank = nodeById(nodes, blankStoryId("st1")).position;
    expect(cellAt(blank, MODEL)).toEqual({ stepId: "st1", order: 2 });
  });
});
