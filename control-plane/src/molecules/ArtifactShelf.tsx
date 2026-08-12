import type { DocT } from "../api/types";

interface ArtifactShelfProps {
  /** The SESSION's shelf — the artifacts this conversation owns. */
  docs: DocT[];
  onOpen: (docId: string) => void;
  /** The revealed slice on /map — tiles that look associated light up. */
  spotlight?: { name: string; paths: string[] } | null;
  /**
   * The workspace/group's OWN shelf (Edwin, 2026-08-12): docs pinned to the
   * context that the session doesn't already carry — rendered under a labeled
   * divider so context-level items are DENOTED, never silently merged.
   */
  contextDocs?: DocT[];
  /** The divider's label — the workspace or lens-group name. */
  contextLabel?: string;
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
 * The two shelves (Edwin, 2026-08-12: workspace/group → session → artifacts,
 * pins the override up): the session's own artifacts, and separately the docs
 * pinned to the current pin target the session doesn't already carry — bare
 * workspace name, or "group:<name>" under a lens (the group's OWN pins only,
 * never members' — the no-upward rule).
 */
export function splitShelfDocs(
  session: { artifacts?: string[] } | null | undefined,
  docs: DocT[],
  pinTarget: string | null,
): { sessionDocs: DocT[]; contextDocs: DocT[] } {
  const sessionDocs = shelfDocsFor(session, docs);
  if (!pinTarget) return { sessionDocs, contextDocs: [] };
  const seen = new Set(sessionDocs.map((d) => d.id));
  return { sessionDocs, contextDocs: docs.filter((d) => !seen.has(d.id) && d.pins?.includes(pinTarget)) };
}

/**
 * Stage-manager shelf: the active session's documents as portrait page tiles,
 * stacked at the top-left of the chat. Clicking one brings it to center stage
 * (spec 2026-08-10, artifacts pivot). Offsets, rules and the hover fan are all
 * CSS — nothing inline.
 */
export function ArtifactShelf({ docs, onOpen, spotlight, contextDocs = [], contextLabel }: ArtifactShelfProps) {
  if (docs.length === 0 && contextDocs.length === 0) return null;
  const tile = (d: DocT, context: boolean) => (
    <button
      key={d.id}
      type="button"
      className={`artifact-shelf__card${d.pins?.length ? " artifact-shelf__card--pinned" : ""}${
        context ? " artifact-shelf__card--context" : ""
      }${isSpotlit(d, spotlight) ? " artifact-shelf__card--spotlit" : ""}`}
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
  );
  return (
    // Every document renders — past the viewport the shelf scrolls (CSS
    // bounds it to the stage and overflows), so nothing hides behind a count.
    <aside className="artifact-shelf" aria-label="session documents">
      {docs.map((d) => tile(d, false))}
      {contextDocs.length > 0 && (
        <>
          {/* The workspace/group's OWN shelf begins here — denoted, not merged. */}
          <div className="artifact-shelf__divider" role="separator" aria-label={`${contextLabel ?? "context"} shelf`}>
            <span>{contextLabel ?? "context"}</span>
          </div>
          {contextDocs.map((d) => tile(d, true))}
        </>
      )}
    </aside>
  );
}
