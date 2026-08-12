import type { CapSliceT } from "../../api/types";
import type { ArtifactKind } from "./layout";
import { artifactNodeId } from "./layout";

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
