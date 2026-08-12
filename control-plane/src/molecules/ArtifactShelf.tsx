import type { DocT } from "../api/types";

interface ArtifactShelfProps {
  docs: DocT[];
  onOpen: (docId: string) => void;
  /** The revealed slice on /map — tiles that look associated light up. */
  spotlight?: { name: string; paths: string[] } | null;
}

/**
 * Does a shelf doc look associated with the revealed slice? Best-effort by
 * construction — slices carry repo file paths (specPath/planPath) while shelf
 * tiles are broker documents, and no stored reference joins them yet — so this
 * matches on names: containment either way between the doc title and the slice
 * name, or the doc title appearing inside one of the slice's artifact paths.
 * When slices grow real doc refs, this is the one function to replace.
 */
export function isSpotlit(doc: { title: string }, spotlight: { name: string; paths: string[] } | null | undefined) {
  if (!spotlight) return false;
  const title = doc.title.trim().toLowerCase();
  const name = spotlight.name.trim().toLowerCase();
  if (!title || !name) return false;
  if (title.includes(name) || name.includes(title)) return true;
  return spotlight.paths.some((p) => p.toLowerCase().includes(title));
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
export function ArtifactShelf({ docs, onOpen, spotlight }: ArtifactShelfProps) {
  if (docs.length === 0) return null;
  return (
    // Every document renders — past the viewport the shelf scrolls (CSS
    // bounds it to the stage and overflows), so nothing hides behind a count.
    <aside className="artifact-shelf" aria-label="session documents">
      {docs.map((d) => (
        <button
          key={d.id}
          type="button"
          className={`artifact-shelf__card${d.pins?.length ? " artifact-shelf__card--pinned" : ""}${
            isSpotlit(d, spotlight) ? " artifact-shelf__card--spotlit" : ""
          }`}
          onClick={() => onOpen(d.id)}
        >
          <span className="artifact-shelf__tag">
            {d.blueprintId}
            {/* Workspace-context docs read subtly apart (Edwin: "minor distinguishing appearance"). */}
            {Boolean(d.pins?.length) && <i className="artifact-shelf__pin" aria-hidden="true" />}
          </span>
          {/* Decorative rules: the tile reads as a page at a glance, without
              pretending to preview content the shelf never loaded. */}
          <span className="artifact-shelf__rules" aria-hidden="true" />
          <span className="artifact-shelf__title">{d.title}</span>
        </button>
      ))}
    </aside>
  );
}
