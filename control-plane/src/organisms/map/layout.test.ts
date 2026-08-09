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

  it("spans the whole group, gaps included", () => {
    expect(nodeById(nodes, "activity:act1").width).toBe(STEP_W * 2 + 8);
  });

  it("is exactly STEP_W wide at one step", () => {
    // The boundary where an off-by-one in the (n - 1) * STEP_GAP term vanishes:
    // a one-step activity must be a plain step-width, with no gap term at all.
    expect(nodeById(nodes, "activity:act2").width).toBe(STEP_W);
    expect(nodeById(nodes, "activity:act2").width).toBe(180);
  });

  it("keeps a step-less activity on the canvas, one slot wide", () => {
    // What typing into the blank activity card produces, so it is the common
    // case: the naive formula gives -STEP_GAP here and the card would vanish.
    const empty: MapModel = { ...MODEL, activities: [{ id: "act0", name: "Fresh", order: 0, steps: [] }] };
    const node = nodeById(layoutMap(empty).nodes, "activity:act0");
    expect(node.width).toBe(STEP_W);
    expect(node.position).toEqual({ x: 0, y: 0 });
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
