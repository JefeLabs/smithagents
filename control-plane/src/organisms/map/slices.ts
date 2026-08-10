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
