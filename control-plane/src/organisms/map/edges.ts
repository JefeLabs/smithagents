import type { CapSliceT } from "../../api/types";
import type { ArtifactKind, MapModel } from "./layout";
import { artifactNodeId, sliceNodeId, storyNodeId } from "./layout";

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  /** Which slice's chain this edge belongs to — lets Task 5 filter without rebuilding. */
  sliceId: string;
}

export interface ArtifactSpec {
  id: string;
  kind: ArtifactKind;
  label: string;
  /**
   * The slice this hangs off. Redundant with `id`, and deliberately so: the
   * alternative is taking `artifact:sl1:spec` apart to find the parent, which
   * would be a second reader of a format `layout.ts` owns. Blank cards carry
   * their parent in `data` for the same reason.
   */
  sliceId: string;
}

/** The artifacts a slice actually has. Absent ones produce no node and no edge. */
export function artifactNodesFor(slice: CapSliceT): ArtifactSpec[] {
  const out: ArtifactSpec[] = [];
  const add = (kind: ArtifactKind, label: string) =>
    out.push({ id: artifactNodeId(slice.id, kind), kind, label, sliceId: slice.id });

  if (slice.specPath) add("spec", slice.specPath);
  if (slice.planPath) add("plan", slice.planPath);
  if (slice.capCardRef) add("capCard", slice.capCardRef.cardId);
  if (slice.deliveryCardRef) add("deliveryCard", slice.deliveryCardRef.cardId);
  return out;
}

/**
 * Every edge the map could draw, computed once from the model. Nothing here knows
 * about selection — Task 5 filters this set rather than rebuilding it, so clicking a
 * band does not recompute the graph.
 *
 * `source` and `target` are NODE ids, minted by `layout.ts` rather than assembled
 * here. That is not tidiness: an edge whose endpoint does not name a real node is
 * silent — xyflow draws nothing and reports nothing — so the only thing standing
 * between a wrong template literal and a chain that never appears is the two
 * modules calling the same function. Note in particular that `storyNodeId` is the
 * identity: writing `step:${storyId}` by analogy with the levels above it would
 * look right and draw nothing.
 *
 * BLANK CARDS ARE ABSENT ON PURPOSE. `MapModel` holds only real records; the
 * trailing "add one" cards are synthesised by `layoutMap`, so no edge can reach
 * one. That is the correct outcome rather than a gap to close later — an edge to
 * a card that stands for nothing has nothing to say.
 */
export function buildEdges(model: MapModel): MapEdge[] {
  const edges: MapEdge[] = [];
  const known = new Set(model.stories.map((s) => s.id));

  for (const slice of model.slices) {
    const source = sliceNodeId(slice.id);
    const drawn = new Set<string>();
    for (const storyId of slice.storyIds) {
      // A slice can reference a story that has since been removed, and can list
      // the same one twice. Either produces an edge xyflow cannot draw — one
      // dangling, one a duplicate key — so both are dropped here rather than
      // becoming a missing chain on the canvas.
      if (!known.has(storyId) || drawn.has(storyId)) continue;
      drawn.add(storyId);
      const target = storyNodeId(storyId);
      edges.push({ id: `${source}->${target}`, source, target, sliceId: slice.id });
    }
    for (const artifact of artifactNodesFor(slice)) {
      edges.push({
        id: `${source}->${artifact.id}`,
        source,
        target: artifact.id,
        sliceId: slice.id,
      });
    }
  }
  return edges;
}
