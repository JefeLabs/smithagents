/**
 * The slice-validity rule, client side.
 *
 * MIRROR of slicesWithoutExclusiveStory in swarm/src/capabilities.ts. That copy
 * is the authority — it decides what persists. This one exists only to disable a
 * button and name the reason, because the two packages share no module: there
 * are no tsconfig paths, no project references, and nothing in control-plane/src
 * imports from swarm/src. The wire types are duplicated the same way
 * (CapSliceT ↔ CapSlice).
 *
 * A duplicated rule is worse than a duplicated type: a type that drifts is
 * caught at the wire, a rule that drifts is caught by nobody — the server would
 * simply start refusing writes this file believes are fine. The identical case
 * table in slices.test.ts and capabilities.test.ts is what stands in for the
 * module they do not have. Change one, change both.
 */
import type { CapSliceT } from "../../api/types";

/**
 * Slices whose every story also appears in another slice, in input order.
 * Counts uses across the whole set first — marking duplicates while iterating
 * would report only the later of two identical slices, when both are equally
 * unowned.
 */
export function slicesWithoutExclusiveStory(slices: CapSliceT[]): CapSliceT[] {
  const uses = new Map<string, number>();
  for (const slice of slices) {
    for (const id of new Set(slice.storyIds)) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  return slices.filter((slice) => !slice.storyIds.some((id) => uses.get(id) === 1));
}

/**
 * The slices `proposed` would newly invalidate. Empty means the write is
 * allowed. Differential and keyed by id, never by count: a write that repairs
 * one slice while breaking another leaves the count level and the set changed.
 *
 * Callers must gate on THIS, not on slicesWithoutExclusiveStory being empty.
 * jefelabs-school-visits carries two grandfathered storyless slices, so the
 * predicate is permanently non-empty there and a naive gate would refuse every
 * write the server is happy to accept.
 */
export function blockedBy(current: CapSliceT[], proposed: CapSliceT[]): CapSliceT[] {
  const invalidBefore = new Set(slicesWithoutExclusiveStory(current).map((s) => s.id));
  return slicesWithoutExclusiveStory(proposed).filter((s) => !invalidBefore.has(s.id));
}

/**
 * Stories `slice` held exclusively in `current` and no longer holds exclusively
 * in `proposed` — the "what was taken" behind a blockedBy verdict.
 *
 * Differential for the same reason blockedBy is: in `proposed` a blocked slice
 * has NO exclusive story, so `proposed` alone can never name what it lost.
 *
 * NON-EMPTY for a blocked slice THAT EXISTED IN `current`: it was valid before,
 * so it held an exclusive story, and is invalid after, so it holds none.
 *
 * EMPTY for a blocked slice the write CREATES — and that is this feature's main
 * flow, not an edge case. A new slice held nothing before, so the premise above
 * is unavailable: it lost nothing, and its neighbours may all still be healthy.
 * Creating C[s1,s2] over A[s1,s3] B[s2,s4] blocks C while A and B stay valid, so
 * there is no "you took X from Y" to report. Callers MUST branch on whether the
 * blocked slice is new; see the panel copy in SlicePanel's SliceComposer.
 *
 * Both halves are pinned by tests rather than left as reasoning.
 */
export function storiesLost(current: CapSliceT[], proposed: CapSliceT[], slice: CapSliceT): string[] {
  const exclusiveIn = (slices: CapSliceT[], id: string): Set<string> => {
    const uses = new Map<string, number>();
    for (const s of slices) for (const sid of new Set(s.storyIds)) uses.set(sid, (uses.get(sid) ?? 0) + 1);
    const self = slices.find((s) => s.id === id);
    return new Set((self?.storyIds ?? []).filter((sid) => uses.get(sid) === 1));
  };
  const after = exclusiveIn(proposed, slice.id);
  return [...exclusiveIn(current, slice.id)].filter((sid) => !after.has(sid));
}
