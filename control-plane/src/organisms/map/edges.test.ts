import { describe, expect, it } from "vitest";
import type { CapSliceT } from "../../api/types";
import { artifactNodesFor } from "./edges";
import type { MapModel } from "./layout";
import { activityNodeId, layoutMap, sliceNodeId, stepNodeId, storyNodeId } from "./layout";

const SLICE: CapSliceT = {
  id: "sl1",
  name: "tour scheduling v1",
  order: 0,
  storyIds: ["s1", "s2"],
  specPath: "docs/specs/x.md",
  deliveryCardRef: { boardId: "b1", cardId: "c1" },
};

const BARE: CapSliceT = { id: "sl2", name: "empty", order: 1, storyIds: [] };

/**
 * All four artifacts, with boardId and cardId DELIBERATELY DIFFERENT at both
 * card levels.
 *
 * `SLICE` has no `planPath` and no `capCardRef`, so two of the four branches
 * only ever run in their absent form — a label taken from the wrong field there
 * is unobservable. Distinct board/card values are what make the two
 * distinguishable at all: with `{ boardId: "b1", cardId: "b1" }` the assertion
 * would hold either way.
 */
const FULL: CapSliceT = {
  id: "sl3",
  name: "everything",
  order: 2,
  storyIds: [],
  specPath: "docs/specs/x.md",
  planPath: "docs/plans/x.md",
  capCardRef: { boardId: "cap-board", cardId: "cap-card" },
  deliveryCardRef: { boardId: "del-board", cardId: "del-card" },
};

const MODEL: MapModel = {
  activities: [],
  stories: [
    { id: "s1", stepId: "st1", order: 0, text: "a", done: false },
    { id: "s2", stepId: "st1", order: 1, text: "b", done: false },
  ],
  slices: [SLICE, BARE],
};

/**
 * The same slices, but with the activity/step spine that actually puts those
 * stories on the canvas. MODEL has no activities, so `layoutMap` emits no story
 * nodes for it at all — a cross-module check against MODEL would compare edges
 * to an empty node set and pass no matter what.
 */
const WIRED: MapModel = {
  ...MODEL,
  activities: [{ id: "act1", name: "Manage Tours", order: 0, steps: [{ id: "st1", name: "Define", order: 0 }] }],
};

describe("artifactNodesFor", () => {
  it("returns only the artifacts the slice actually has", () => {
    expect(artifactNodesFor(SLICE).map((a) => a.kind)).toEqual(["spec", "deliveryCard"]);
  });

  it("returns nothing for a bare slice", () => {
    expect(artifactNodesFor(BARE)).toEqual([]);
  });

  it("labels each artifact with the text a node renders, not the id beside it", () => {
    expect(artifactNodesFor(SLICE).map((a) => a.label)).toEqual(["docs/specs/x.md", "c1"]);
    // `boardId` where `cardId` belongs is the slip that ships: right shape,
    // right type, wrong value. It is only observable where the two differ AND
    // the branch actually runs, which is why FULL exists.
    expect(artifactNodesFor(FULL).map((a) => a.label)).toEqual([
      "docs/specs/x.md",
      "docs/plans/x.md",
      "cap-card",
      "del-card",
    ]);
  });

  it("emits the four kinds in a fixed order", () => {
    // Task 5 stacks these down a slice's row, so the order is what the user
    // sees. Nothing else pins it once every branch is live.
    expect(artifactNodesFor(FULL).map((a) => a.kind)).toEqual(["spec", "plan", "capCard", "deliveryCard"]);
  });

  it("carries its slice, so nothing downstream has to take the id apart", () => {
    // Same rule layout.ts follows for blank cards: the parent travels in the
    // record. Task 5 positions artifacts against their slice's row, and parsing
    // it back out of `artifact:sl1:spec` would be the second definition of a
    // format this module already owns.
    expect(artifactNodesFor(SLICE).map((a) => a.sliceId)).toEqual(["sl1", "sl1"]);
  });
});

/**
 * The assertion no isolated edge test can make.
 *
 * `buildEdges` emits NODE IDS, and `layoutMap` is what decides what a node id
 * looks like — formats that are not uniform (activities and steps are prefixed,
 * stories are raw). Tested apart, both files can be internally consistent and
 * still disagree, and the symptom is edges silently missing from the canvas with
 * a green suite. These run both halves over ONE model and compare.
 */
describe("edge endpoints and layoutMap node ids", () => {
  it("mints every level through the same helpers layoutMap uses", () => {
    const ids = layoutMap(WIRED).nodes.map((n) => n.id);
    expect(ids).toContain(activityNodeId("act1"));
    expect(ids).toContain(stepNodeId("st1"));
    expect(ids).toContain(storyNodeId("s1"));
  });

  it("pins the formats themselves, including the story level being raw", () => {
    // The asymmetry is the trap: two of three are prefixed and one is not, so
    // "the obvious thing" is wrong exactly once. Spelling the strings out means
    // a change to any of them fails here first, next to this comment.
    expect(activityNodeId("act1")).toBe("activity:act1");
    expect(stepNodeId("st1")).toBe("step:st1");
    expect(storyNodeId("s1")).toBe("s1");
    expect(sliceNodeId("sl1")).toBe("slice:sl1");
  });
});
