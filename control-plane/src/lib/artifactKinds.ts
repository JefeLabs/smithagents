/**
 * The artifact kinds the composer row offers, in canonical order. Two families
 * (Documents, Diagrams) are blueprint-instantiated documents split by render
 * family; the rest are their own stages. `familyForKind` maps the two
 * document-creating kinds to the blueprint family they create.
 */
export type ArtifactKind = "chat" | "dashboards" | "documents" | "diagrams" | "map";

export const ARTIFACT_KINDS: ReadonlyArray<{ kind: ArtifactKind; label: string }> = [
  { kind: "chat", label: "Chat" },
  { kind: "dashboards", label: "Dashboards" },
  { kind: "documents", label: "Documents" },
  { kind: "diagrams", label: "Diagrams" },
  { kind: "map", label: "User Story Maps" },
];

/** The blueprint family a document-creating kind uses; null for stage-only kinds. */
export function familyForKind(kind: ArtifactKind): "document" | "diagram" | null {
  if (kind === "documents") return "document";
  if (kind === "diagrams") return "diagram";
  return null;
}
