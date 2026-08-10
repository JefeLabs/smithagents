import { describe, expect, it } from "vitest";
import type { CapSliceT } from "../../api/types";
import { blockedBy, slicesWithoutExclusiveStory } from "./slices";

const sl = (id: string, storyIds: string[]): CapSliceT => ({ id, name: id, order: 0, storyIds });

describe("slicesWithoutExclusiveStory", () => {
  // The SAME table as swarm/src/capabilities.test.ts. These two copies of the rule
  // have no shared module; this table is what keeps them honest.
  const cases: Array<[string, CapSliceT[], string[]]> = [
    ["single slice owns everything", [sl("A", ["s1", "s2", "s3"])], []],
    ["overlap, each owns one", [sl("A", ["s1", "s2"]), sl("B", ["s2", "s3"])], []],
    ["identical single story", [sl("A", ["s1"]), sl("B", ["s1"])], ["A", "B"]],
    ["identical sets", [sl("A", ["s1", "s2"]), sl("B", ["s1", "s2"])], ["A", "B"]],
    ["subset", [sl("A", ["s1"]), sl("B", ["s1", "s2"])], ["A"]],
    ["storyless", [sl("A", [])], ["A"]],
    ["no slices at all", [], []],
    // FIXTURE CORRECTED IN TASK 1 — copy this row as written. The first draft was
    // A[s1] B[s2] C[s1,s2] expecting ["C"], but there A's only story is in C and B's
    // only story is in C, so nothing owns anything and the true answer is
    // ["A","B","C"]. Giving A and B a story of their own keeps the property this row
    // exists for: a slice invalidated by the COMBINATION of two neighbours that are
    // each healthy, which is what stops the check being rewritten as pairwise
    // containment. Must match swarm/src/capabilities.test.ts exactly.
    ["covered by two neighbours", [sl("A", ["s1", "s3"]), sl("B", ["s2", "s4"]), sl("C", ["s1", "s2"])], ["C"]],
  ];
  for (const [name, slices, invalid] of cases) {
    it(name, () => {
      expect(slicesWithoutExclusiveStory(slices).map((s) => s.id)).toEqual(invalid);
    });
  }
});

describe("blockedBy", () => {
  it("allows an overlapping write where every slice still owns something", () => {
    const before = [sl("A", ["s1", "s2"])];
    const after = [sl("A", ["s1", "s2"]), sl("B", ["s2", "s3"])];
    expect(blockedBy(before, after)).toEqual([]);
  });

  it("names the slice a write would strip", () => {
    const before = [sl("A", ["s1"])];
    const after = [sl("A", ["s1"]), sl("B", ["s1", "s2"])];
    expect(blockedBy(before, after).map((s) => s.id)).toEqual(["A"]);
  });

  it("grandfathers a slice that was already invalid", () => {
    const before = [sl("OLD", []), sl("A", ["s1"])];
    const after = [sl("OLD", []), sl("A", ["s1"]), sl("B", ["s2"])];
    expect(blockedBy(before, after)).toEqual([]);
  });

  it("catches a write that repairs one slice while breaking another", () => {
    // FIXTURE CORRECTED IN TASK 1 — match swarm/src/capabilities.test.ts exactly.
    // BROKEN gains an exclusive story (s1) AND takes HEALTHY's only exclusive one
    // (s2): invalid COUNT stays at 1 while the invalid SET flips {BROKEN} → {HEALTHY},
    // so a length comparison waves it through. That is the single thing this test
    // exists to fail.
    //
    // Two wrong versions to avoid. BROKEN[s1], HEALTHY[s1,s2] leaves s2 exclusive to
    // HEALTHY, so nothing breaks and nothing throws. BROKEN[s2], HEALTHY[s2] does
    // break HEALTHY, but BROKEN stays invalid too, so the count goes 1 → 2 and a
    // length check catches it — the test passes while proving nothing.
    const before = [sl("BROKEN", []), sl("HEALTHY", ["s2"])];
    const after = [sl("BROKEN", ["s1", "s2"]), sl("HEALTHY", ["s2"])];
    expect(blockedBy(before, after).map((s) => s.id)).toEqual(["HEALTHY"]);
  });
});
