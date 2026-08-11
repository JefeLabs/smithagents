import type { DocT } from "../api/types";

interface ArtifactShelfProps {
  docs: DocT[];
  onOpen: (docId: string) => void;
}

/**
 * The active session's documents in its own order — what the shelf shows.
 * Missing ids (deleted doc, frame race) drop out rather than render holes.
 */
export function shelfDocsFor(session: { artifacts?: string[] } | null | undefined, docs: DocT[]): DocT[] {
  return (session?.artifacts ?? []).map((id) => docs.find((d) => d.id === id)).filter((d): d is DocT => Boolean(d));
}

/**
 * Stage-manager shelf: the active session's documents as portrait page tiles,
 * stacked at the top-left of the chat. Clicking one brings it to center stage
 * (spec 2026-08-10, artifacts pivot). Offsets, rules and the hover fan are all
 * CSS — nothing inline.
 */
export function ArtifactShelf({ docs, onOpen }: ArtifactShelfProps) {
  if (docs.length === 0) return null;
  return (
    // Every document renders — past the viewport the shelf scrolls (CSS
    // bounds it to the stage and overflows), so nothing hides behind a count.
    <aside className="artifact-shelf" aria-label="session documents">
      {docs.map((d) => (
        <button key={d.id} type="button" className="artifact-shelf__card" onClick={() => onOpen(d.id)}>
          <span className="artifact-shelf__tag">{d.blueprintId}</span>
          {/* Decorative rules: the tile reads as a page at a glance, without
              pretending to preview content the shelf never loaded. */}
          <span className="artifact-shelf__rules" aria-hidden="true" />
          <span className="artifact-shelf__title">{d.title}</span>
        </button>
      ))}
    </aside>
  );
}
