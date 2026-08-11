# Staged-artifacts shelf on the /doc and /diagram canvases — Design

**Date:** 2026-08-11
**Status:** Approved by Edwin (scope: both canvases; wiring: stage slot prop)

## Problem

The stage-manager shelf (ArtifactShelf — the session's documents as tilted
portrait tiles, inward perspective, left edge) renders only in the ChatDock's
`full` variant, i.e. on the home chat. The ChatDock unification (a2ac1a1)
made `/doc` and `/diagram` document-only with chat docked right — losing the
shelf there. Edwin wants it back on both canvases.

## Decisions (Edwin, 2026-08-11)

1. **Scope:** both `/doc/$docId` and `/diagram/$docId` get the shelf — the
   two dock canvases behave identically.
2. **Wiring:** a `shelf?: ReactNode` slot prop on the stages, built by the
   route components — not a shell-level overlay (route-sniffing in
   HomePage), not inside the docked ChatDock (wrong positioning ancestor).

## Design

### Components

- **`ArtifactShelf.tsx`** additionally exports the derivation currently
  inlined in HomePage (`HomePage.tsx:158-160`):

  ```ts
  /** The active session's documents in its own order — what the shelf shows. */
  export function shelfDocsFor(session: { artifacts?: string[] } | null, docs: DocT[]): DocT[]
  ```

  HomePage switches to it. The component itself is unchanged.

- **`DocumentStage` and `DiagramStage`** each accept an optional
  `shelf?: ReactNode`, rendered as the first child inside their
  `<section className="stage …">`. `.stage` is `position: relative`
  (base.css:37), so the existing `.artifact-shelf` absolute rules
  (documents.css:296) anchor correctly with zero CSS changes. Organisms
  stay router-free — the slot is inert markup to them.

- **`DocRoute` / `DiagramRoute`** (router.tsx) already read
  `useDocuments()` + `useBlueprints()`; they add `useSession()` and
  `useNavigate()` and pass:

  ```tsx
  shelf={<ArtifactShelf docs={shelfDocsFor(session, docs)}
                        onOpen={(id) => openDocByFamily(navigate, blueprints, docs, id)} />}
  ```

  with the UNFILTERED blueprint list — `openDocByFamily` resolves the
  family itself; the family-filtered list the stages receive for their
  type switch is a separate concern.

### Behavior

- The currently-open doc appears in its own shelf (same list as home);
  clicking it is a harmless same-route navigation.
- No active session or no artifacts → empty aside, exactly as home today.
- Shelf tiles overlay the stage's left margin (z-index 3), same as they
  overlay the chat on home. The existing narrow-screen media rule in
  documents.css applies unchanged.

### Testing

- Unit: `shelfDocsFor` (order preserved, missing ids dropped, null session).
- `DocumentStage.test` / `DiagramStage.test`: the shelf slot renders when
  passed, absent when omitted.
- Route level: follow the existing router.test.tsx pattern to assert the
  shelf (aria-label "session documents") appears on `/doc/$docId` when the
  session has artifacts.
- Full control-plane suite + root typecheck + lint (zero-diagnostic
  baseline).

## Out of scope

- Shelf on `/map`, `/dashboards`, `/board` (different stage families).
- Highlighting the currently-open doc's tile.
- A document delete affordance (the smoke docs stay until that exists).
- Any broker change.
