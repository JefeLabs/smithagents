import { FileText } from "lucide-react";
import type { DocT } from "../api/types";

interface ArtifactShelfProps {
  docs: DocT[];
  onOpen: (docId: string) => void;
}

/**
 * Stage-manager shelf: the active session's documents, stacked at the chat's
 * edge. Clicking one brings it to center stage (spec 2026-08-10, artifacts
 * pivot). Offsets and the hover fan are CSS — nothing inline.
 */
export function ArtifactShelf({ docs, onOpen }: ArtifactShelfProps) {
  if (docs.length === 0) return null;
  return (
    <aside className="artifact-shelf" aria-label="session documents">
      {docs.map((d) => (
        <button key={d.id} type="button" className="artifact-shelf__card" onClick={() => onOpen(d.id)}>
          <FileText size={14} aria-hidden="true" />
          <span className="artifact-shelf__title">{d.title}</span>
          <span className="artifact-shelf__tag">{d.blueprintId}</span>
        </button>
      ))}
    </aside>
  );
}
