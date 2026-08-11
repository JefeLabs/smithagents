import type { QueryClient } from "@tanstack/react-query";
import type { useNavigate } from "@tanstack/react-router";
import * as api from "../api/broker";
import type { BlueprintT, DocT } from "../api/types";
import { qk } from "../queries/keys";
import { type ArtifactKind, familyForKind } from "./artifactKinds";

type Navigate = ReturnType<typeof useNavigate>;

/**
 * The composer kind row's click handler. Chat/Dashboards/Map navigate to their
 * stage; Documents/Diagrams create a fresh blueprint doc of the matching family
 * and open it — a document-family doc on the prose stage (`/doc`), a
 * diagram-family doc on the Mermaid canvas (`/diagram`). With no blueprint of
 * the asked family, it falls back to the first blueprint and routes by whatever
 * family that turns out to be.
 *
 * Lives here, not in router.tsx, because the persistent ChatDock is mounted in
 * the shell (HomePage) — and HomePage cannot import from router.tsx, which
 * imports HomePage as the root route (a cycle).
 */
export function makePickKind(
  navigate: Navigate,
  qc: QueryClient,
  blueprints: BlueprintT[],
): (kind: ArtifactKind) => void {
  return (kind) => {
    if (kind === "chat") return void navigate({ to: "/" });
    if (kind === "dashboards") return void navigate({ to: "/dashboards" });
    if (kind === "map") return void navigate({ to: "/map" });
    const family = familyForKind(kind); // "document" | "diagram"
    const bp = blueprints.find((b) => b.family === family) ?? blueprints[0];
    void api.postDocument(bp?.id ?? "spec", "").then((r) => {
      if (!r.doc) return;
      const created = r.doc;
      qc.setQueryData<DocT[]>(qk.documents, (prev: DocT[] | undefined) => [
        created,
        ...(prev ?? []).filter((d: DocT) => d.id !== created.id),
      ]);
      const fam = blueprints.find((b) => b.id === created.blueprintId)?.family;
      void navigate({
        to: fam === "diagram" ? "/diagram/$docId" : "/doc/$docId",
        params: { docId: created.id },
      });
    });
  };
}

/**
 * Open an EXISTING doc on the canvas that matches its blueprint family — the
 * same split the kind row uses, so the artifact shelf and the composer agree.
 */
export function openDocByFamily(navigate: Navigate, blueprints: BlueprintT[], docs: DocT[], docId: string): void {
  const fam = blueprints.find((b) => b.id === docs.find((d) => d.id === docId)?.blueprintId)?.family;
  void navigate({
    to: fam === "diagram" ? "/diagram/$docId" : fam === "dashboard" ? "/dashboard/$docId" : "/doc/$docId",
    params: { docId },
  });
}
