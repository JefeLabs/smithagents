import { describe, expect, it } from "vitest";
import type { MapModel, MapNode } from "./layout";
import {
  artifactRowStartX,
  artifactRowX,
  artifactRowY,
  BLANK_ACTIVITY_ID,
  blankStepId,
  blankStoryId,
  CAPABILITY_CARD_W,
  CAPABILITY_GAP,
  CAPABILITY_MORE_W,
  capabilityCardsThatFit,
  cellAt,
  layoutMap,
  SLOT_H,
  STEP_GAP,
  STEP_W,
  STORIES_Y,
  STORY_H,
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

  it("contains every column it owns — real steps AND the blank", () => {
    // The property, not the arithmetic. A child rendering outside its parent's
    // span is the defect, whichever child it is: typing into a blank step card
    // creates a step in THAT activity, and a real step column that escapes its
    // card is the same failure mirrored — the user cannot tell which of several
    // side-by-side activities a column belongs to. Bounding only the blank left
    // the real columns free to drift left when the card moved right.
    const cols = stepColumns(MODEL.activities);
    for (const actId of ["act1", "act2"]) {
      const card = nodeById(nodes, `activity:${actId}`);
      const width = card.width;
      if (width === undefined) throw new Error(`activity ${actId} has no width`);
      const own = MODEL.activities.find((a) => a.id === actId);
      if (!own) throw new Error(`no activity ${actId}`);
      const stepIds = new Set(own.steps.map((s) => s.id));
      const children = [
        ...cols.filter((c) => stepIds.has(c.stepId)).map((c) => c.x),
        nodeById(nodes, blankStepId(actId)).position.x,
      ];
      expect(children).toHaveLength(own.steps.length + 1);
      for (const x of children) {
        expect(x).toBeGreaterThanOrEqual(card.position.x);
        expect(x + STEP_W).toBeLessThanOrEqual(card.position.x + width);
      }
    }
  });
});

describe("layoutMap node emission order", () => {
  it("emits activities in order, because node order is paint and tab order", () => {
    // The only thing layoutMap's activities sort controls: every position comes
    // from `xOf`, so this array's order is all that is left of it. xyflow renders
    // nodes in array order, making this the DOM order a keyboard user tabs
    // through — user-facing, and otherwise unpinned. MODEL lists act2 first.
    const { nodes } = layoutMap(MODEL);
    const activityIds = nodes.filter((n) => n.type === "activity").map((n) => n.id);
    expect(activityIds).toEqual(["activity:act1", "activity:act2", BLANK_ACTIVITY_ID]);
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

  it("snaps a drop in the gap between columns to the one it actually sits on", () => {
    // REWRITTEN, not re-tuned. This case used to drop at st1.x + STEP_W + 2 and expect
    // st1, with the comment "still nearer st1's centre than st2's" — which is a
    // description of the old metric (a left EDGE measured against column CENTRES), not
    // of anything a user could want. A card whose left edge is two pixels past st1's
    // right edge spans 182..362: it covers st2 almost entirely and st1 not at all.
    // Resolving it to st1 was always wrong; the test pinned the bug, so the fixture
    // went with it and the name stayed.
    const x = cols[0].x + STEP_W + 2;
    expect(cellAt({ x, y: STORIES_Y }, MODEL)?.stepId).toBe("st2");
  });

  it("keeps a card nudged LEFT of its own column in that column", () => {
    // The user-visible defect, and the reason this was worth fixing. Under the old
    // comparison a card sitting exactly on st2 had four pixels of leftward tolerance
    // against 184 to the right: nudge it five pixels back the way it came and the drop
    // landed a whole column earlier. At st2.x - 4 the old metric was an exact tie
    // between st1 and st2, which the loop's strict `<` broke in favour of the FIRST
    // column — st1. It resolves to st2 now, as the card plainly shows.
    expect(cellAt({ x: cols[1].x - 4, y: STORIES_Y }, MODEL)?.stepId).toBe("st2");
    expect(cellAt({ x: cols[1].x - 30, y: STORIES_Y }, MODEL)?.stepId).toBe("st2");
  });

  it("gives each column exactly half the pitch either side, and no more", () => {
    // The window is symmetric now, so pin both edges of it. The pitch is
    // STEP_W + STEP_GAP = 188, so the changeover sits at 94 — assert either side of it
    // rather than the midpoint itself, where a tie is decided by iteration order rather
    // than by distance.
    const half = (STEP_W + STEP_GAP) / 2;
    expect(cellAt({ x: cols[0].x + half - 1, y: STORIES_Y }, MODEL)?.stepId).toBe("st1");
    expect(cellAt({ x: cols[0].x + half + 1, y: STORIES_Y }, MODEL)?.stepId).toBe("st2");
    // Symmetric means the mirror case holds too: one pixel short of a full pitch back
    // from st2 is still st2's, not st1's.
    expect(cellAt({ x: cols[1].x - half + 1, y: STORIES_Y }, MODEL)?.stepId).toBe("st2");
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

  it("hands over to the blank column at half a pitch, the same as any other neighbour", () => {
    // WHERE the rejection starts, which moved with the comparison fix and is worth
    // pinning rather than leaving implied. A blank column is a neighbour like any
    // other, so the changeover is half a pitch past the last real column — not the 184
    // it used to be when a left edge was measured against centres. Dragging right out
    // of a column now stops being a valid drop twice as early, which is the same
    // symmetry the real columns got.
    const half = (STEP_W + STEP_GAP) / 2;
    const lastReal = stepColumns(MODEL.activities)[1].x; // st2, the last real column of act1
    expect(cellAt({ x: lastReal + half - 1, y: STORIES_Y }, MODEL)?.stepId).toBe("st2");
    expect(cellAt({ x: lastReal + half + 1, y: STORIES_Y }, MODEL)).toBeNull();
  });

  it("accepts a drop onto a blank STORY slot, because that is the append target", () => {
    // The one blank that is NOT a missing cell: it sits at order === count in a
    // step that already exists, so resolving it is an append and rejecting it
    // would delete drag-to-end-of-column.
    const blank = nodeById(nodes, blankStoryId("st1")).position;
    expect(cellAt(blank, MODEL)).toEqual({ stepId: "st1", order: 2 });
  });
});

/**
 * The artifact row for a revealed slice. It sits BELOW the story stacks — it used to
 * be a vertical rail past the right edge, which made every edge traverse the whole
 * map, so the lines measured the map's width rather than saying anything about the
 * model.
 */
describe("capabilityCardsThatFit", () => {
  const slot = CAPABILITY_CARD_W + CAPABILITY_GAP;

  it("shows every card when they all fit beside the blank one", () => {
    // Three cards plus the blank, exactly: 3 slots + one card's width.
    expect(capabilityCardsThatFit(3 * slot + CAPABILITY_CARD_W, 3)).toBe(3);
  });

  it("RESERVES the blank card's width before allocating any, at every width", () => {
    // The property that matters most here: whenever the row shows cards at all, it has
    // already set aside a card's width for the composer — so the composer is never the
    // thing that collapses, and creating a capability never requires opening a menu.
    //
    // Stated for `shown > 0` because below that there is nothing to reserve FROM: at a
    // width narrower than one card the row cannot honour anything, and asserting that it
    // does would be asking the arithmetic for a guarantee the pixels cannot give.
    for (const width of [0, 100, 250, 400, 600, 900, 1400, 2000]) {
      const shown = capabilityCardsThatFit(width, 12);
      expect(shown).toBeLessThanOrEqual(12);
      if (shown > 0) expect(shown * slot + CAPABILITY_CARD_W).toBeLessThanOrEqual(width);
    }
  });

  it("pays for the +N control out of the cards' space, not the blank's", () => {
    // One slot short of fitting all three. The answer is not simply "two": the menu
    // control has to be afforded as well, and it comes out of the card budget.
    const width = 3 * slot + CAPABILITY_CARD_W - 1;
    const shown = capabilityCardsThatFit(width, 3);
    expect(shown).toBeLessThan(3);
    expect(shown * slot + CAPABILITY_MORE_W + CAPABILITY_GAP + CAPABILITY_CARD_W).toBeLessThanOrEqual(width);
  });

  it("collapses everything rather than reporting a negative count", () => {
    expect(capabilityCardsThatFit(0, 5)).toBe(0);
    expect(capabilityCardsThatFit(120, 5)).toBe(0);
  });

  it("is monotonic in width — more room never shows fewer cards", () => {
    let last = -1;
    for (let w = 0; w <= 2000; w += 17) {
      const shown = capabilityCardsThatFit(w, 8);
      expect(shown).toBeGreaterThanOrEqual(last);
      last = shown;
    }
  });
});

describe("artifactRowY clears the story stacks", () => {
  /** Bottom edge of the lowest card in a column: its trailing blank composer. */
  const deepestCardBottom = (model: MapModel) => {
    const nodes = layoutMap(model).nodes;
    return Math.max(...nodes.filter((n) => n.type === "story").map((n) => n.position.y + STORY_H));
  };

  it("clears the deepest column's trailing blank composer, not just its last real story", () => {
    // The property, not the number. Measuring to the last REAL story would land the
    // row on top of the composer — an overlap that only appears once a column is
    // full, which is the worst time to discover it.
    expect(artifactRowY(MODEL)).toBeGreaterThan(deepestCardBottom(MODEL));
  });

  it("follows the DEEPEST stack, not the first column's", () => {
    // st1 has 2 stories and st2 has 1. Deepening st2 must move the row, or the row
    // is really keyed on whichever column happens to come first.
    const deeper: MapModel = {
      ...MODEL,
      stories: [
        ...MODEL.stories,
        { id: "s4", stepId: "st2", order: 1, text: "b", done: false },
        { id: "s5", stepId: "st2", order: 2, text: "c", done: false },
      ],
    };
    expect(artifactRowY(deeper)).toBeGreaterThan(artifactRowY(MODEL));
    expect(artifactRowY(deeper)).toBeGreaterThan(deepestCardBottom(deeper));
  });

  it("ignores a story whose step no longer exists — it renders nowhere", () => {
    // layoutMap iterates STEPS, so a story pointing at a deleted step draws no card.
    // Counting it here would push the row down to clear something invisible.
    const orphaned: MapModel = {
      ...MODEL,
      stories: [
        ...MODEL.stories,
        { id: "s9", stepId: "gone", order: 0, text: "orphan", done: false },
        { id: "s10", stepId: "gone", order: 1, text: "orphan", done: false },
        { id: "s11", stepId: "gone", order: 2, text: "orphan", done: false },
      ],
    };
    expect(artifactRowY(orphaned)).toBe(artifactRowY(MODEL));
  });

  it("still clears the header when no step has any stories", () => {
    const empty: MapModel = { ...MODEL, stories: [] };
    expect(artifactRowY(empty)).toBeGreaterThan(STORIES_Y);
  });
});

describe("artifactRowX lays a row on the step pitch", () => {
  it("starts under the first column and advances one column at a time", () => {
    const first = stepColumns(MODEL.activities)[0].x;
    expect(artifactRowX(0)).toBe(first);
    expect(artifactRowX(1) - artifactRowX(0)).toBe(STEP_W + STEP_GAP);
  });

  it("leaves a real gap between cards rather than butting or overlapping them", () => {
    expect(artifactRowX(1)).toBeGreaterThan(artifactRowX(0) + STEP_W);
  });

  it("starts where the slice does, so the row can be placed under its own stories", () => {
    const slice = { id: "sl1", name: "v1", order: 0, storyIds: ["s3"] };
    const start = artifactRowStartX(MODEL, slice);
    expect(artifactRowX(0, start)).toBe(start);
    expect(artifactRowX(1, start)).toBe(start + STEP_W + STEP_GAP);
  });

  it("does NOT track columns across an activity boundary — pinned, not endorsed", () => {
    // st3 belongs to act2, so `columns` put a blank step slot and ACTIVITY_GAP in
    // front of it and the third column is far right of a uniform third slot. The row
    // is deliberately uniform: an artifact belongs to the slice, not to whatever step
    // it happens to sit under. This pins the divergence so that "align them" is a
    // decision someone makes, not a bug someone reports.
    const third = stepColumns(MODEL.activities)[2].x;
    expect(artifactRowX(2)).toBeLessThan(third);
  });
});

/**
 * WHERE the row begins. Chosen by looking at both options in the browser against a
 * slice whose stories all sit in the second activity: anchoring at the map's origin
 * put that slice's spec and card under two columns whose stories were, at that moment,
 * all dimmed — the reveal split into two bright clusters in opposite corners with
 * nothing tying them together. Anchoring to the slice keeps the documents under the
 * stories they belong to, and the whole chain reads as one thing.
 */
describe("artifactRowStartX anchors the row to the slice, not to the map", () => {
  it("starts under the LEFTMOST column holding one of the slice's stories", () => {
    const cols = stepColumns(MODEL.activities);
    // s3 lives in st2, the second column; s1 lives in st1, the first.
    expect(artifactRowStartX(MODEL, { id: "a", name: "a", order: 0, storyIds: ["s3"] })).toBe(cols[1].x);
    expect(artifactRowStartX(MODEL, { id: "b", name: "b", order: 0, storyIds: ["s3", "s1"] })).toBe(cols[0].x);
  });

  it("falls back to the origin for a slice that owns nothing yet", () => {
    // Exactly what a slice looks like between being created and having a story
    // dragged in — the common state, not an edge case.
    expect(artifactRowStartX(MODEL, { id: "c", name: "c", order: 0, storyIds: [] })).toBe(0);
  });

  it("ignores story ids the model no longer has", () => {
    // A slice can outlive a story it names; edges.ts drops those for the same reason.
    // Left in, `xOf.get(undefined)` would contribute nothing but a silent NaN risk.
    expect(artifactRowStartX(MODEL, { id: "d", name: "d", order: 0, storyIds: ["gone", "s3"] })).toBe(
      stepColumns(MODEL.activities)[1].x,
    );
    expect(artifactRowStartX(MODEL, { id: "e", name: "e", order: 0, storyIds: ["gone"] })).toBe(0);
  });
});
