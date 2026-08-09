import { describe, expect, it } from "vitest";
import type { CapSliceT } from "../../api/types";
import { artifactNodesFor, buildEdges } from "./edges";
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

const artifactIdsIn = (model: MapModel) =>
  new Set(model.slices.flatMap((slice) => artifactNodesFor(slice).map((a) => a.id)));

describe("buildEdges", () => {
  it("fans a slice out to each of its stories", () => {
    const edges = buildEdges(MODEL);
    const artifacts = artifactIdsIn(MODEL);
    const fan = edges.filter((e) => e.source === sliceNodeId("sl1") && !artifacts.has(e.target));
    expect(fan.map((e) => e.target).sort()).toEqual([storyNodeId("s1"), storyNodeId("s2")]);
  });

  it("chains the slice to its artifacts, skipping absent ones", () => {
    const edges = buildEdges(MODEL);
    const targets = edges.filter((e) => e.sliceId === "sl1").map((e) => e.target);
    expect(targets).toContain("artifact:sl1:spec");
    expect(targets).toContain("artifact:sl1:deliveryCard");
    // No planPath and no capCardRef on this slice.
    expect(targets).not.toContain("artifact:sl1:plan");
    expect(targets).not.toContain("artifact:sl1:capCard");
  });

  it("produces no edges for a slice with no stories and no artifacts", () => {
    expect(buildEdges(MODEL).filter((e) => e.sliceId === "sl2")).toHaveLength(0);
  });

  it("skips a storyId with no story behind it rather than dangling", () => {
    const stale: MapModel = { ...MODEL, slices: [{ ...SLICE, storyIds: ["s1", "gone"] }] };
    const targets = buildEdges(stale).map((e) => e.target);
    expect(targets).toContain(storyNodeId("s1"));
    expect(targets).not.toContain(storyNodeId("gone"));
  });

  it("gives every edge a unique id", () => {
    const ids = buildEdges(MODEL).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays unique when a slice lists the same story twice", () => {
    // Malformed but reachable: xyflow keys edges by id, so a duplicate does not
    // draw twice — it drops one and warns. Emitting the story once makes the
    // uniqueness above a property of the code rather than of the fixture.
    const doubled: MapModel = { ...MODEL, slices: [{ ...SLICE, storyIds: ["s1", "s1"] }] };
    const edges = buildEdges(doubled);
    const ids = edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(edges.filter((e) => e.target === storyNodeId("s1"))).toHaveLength(1);
  });
});

describe("artifactNodesFor", () => {
  it("returns only the artifacts the slice actually has", () => {
    expect(artifactNodesFor(SLICE).map((a) => a.kind)).toEqual(["spec", "deliveryCard"]);
  });

  it("returns nothing for a bare slice", () => {
    expect(artifactNodesFor(BARE)).toEqual([]);
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
  it("names story targets with an id layoutMap actually emits", () => {
    const laidOut = layoutMap(WIRED).nodes.map((n) => n.id);
    const artifacts = artifactIdsIn(WIRED);
    const storyEdges = buildEdges(WIRED).filter((e) => !artifacts.has(e.target));
    // Guards the filter from emptying: sl1 lists two live stories, so two edges
    // must survive it. Without this a wrong format would just yield no edges to
    // check and the loop below would vacuously pass.
    expect(storyEdges).toHaveLength(2);
    for (const edge of storyEdges) {
      expect(laidOut).toContain(edge.target);
    }
  });

  it("names slice sources with layout's helper, so Task 5 lays out the same ids", () => {
    // Slice and artifact nodes are not laid out yet, so they cannot be checked
    // against `layoutMap`'s output the way story targets are. Pinning them to
    // the shared helper is the equivalent: whoever adds those levels imports the
    // same function instead of re-deriving the format from this file.
    const minted = WIRED.slices.map((s) => sliceNodeId(s.id));
    for (const edge of buildEdges(WIRED)) {
      expect(minted).toContain(edge.source);
    }
  });

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
