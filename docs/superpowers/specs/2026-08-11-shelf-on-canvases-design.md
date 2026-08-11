# Staged-artifacts shelf on every kind surface + focus view — Design

**Date:** 2026-08-11 (v2 — scope expanded mid-review)
**Status:** Approved by Edwin (v2: all five kind surfaces; focus view collapses shelf + docked chat; toggle = left-rail control above Settings + Esc)

## Problem

The stage-manager shelf (ArtifactShelf — the session's documents as tilted
portrait tiles, inward perspective, left edge) renders only in the ChatDock's
`full` variant on home. Edwin wants it on **all five kind surfaces** — Chat,
Dashboards, Documents, Diagrams, User Story Maps — plus a **focus view** that
collapses both the shelf and the chat panel for a clean canvas.

## Decisions (Edwin, 2026-08-11)

1. **Scope:** shelf on `/` (has it), `/dashboards`, `/doc/$docId`,
   `/diagram/$docId`, `/map`.
2. **Focus toggle:** a control on the left rail (ToolRail footer menu),
   placed **above Settings**; Esc also exits while focus is on.
3. **Collapse:** fully hidden — no minimized edge tabs.

## Design

### Shelf wiring (extends the v1 slot-prop pattern)

- **`ArtifactShelf.tsx`** exports the derivation currently inlined in
  HomePage:

  ```ts
  /** The active session's documents in its own order — what the shelf shows. */
  export function shelfDocsFor(session: { artifacts?: string[] } | null | undefined, docs: DocT[]): DocT[]
  ```

  HomePage adopts it. The component itself is unchanged; it returns `null`
  on an empty list, so surfaces without artifacts render nothing.

- **`DocumentStage`, `DiagramStage`, `MapStage`, `DashboardsStage`** each
  accept an optional `shelf?: ReactNode`, rendered as the FIRST child of
  their `<section className="stage …">`. `.stage` is `position: relative`
  (base.css:37), so the existing `.artifact-shelf` absolute rules
  (documents.css:296) anchor with zero CSS changes. Organisms stay
  router-free — the slot is inert markup.

- **`DocRoute`, `DiagramRoute`, `MapRoute`, `DashboardsRoute`**
  (router.tsx) build the shelf. They add `useSession()` (+ `useNavigate()`
  and `useDocuments()`/`useBlueprints()` where not already read) ABOVE
  their early returns and pass:

  ```tsx
  shelf={<ArtifactShelf docs={shelfDocsFor(session, docs)}
                        onOpen={(id) => openDocByFamily(navigate, blueprints, docs, id)} />}
  ```

  with the UNFILTERED blueprint list — `openDocByFamily` resolves family
  itself; the family-filtered lists the stages receive for their type
  switches are a separate concern.

### Focus view

- **State:** `focusMode: boolean` in the existing zustand `uiStore`
  (`toggleFocus()`, `exitFocus()`). Ephemeral UI state per the
  state-stack boundary rule — never in the URL, persists across surface
  switches, does not survive reload.

- **Collapse is CSS, not conditional mounting.** HomePage stamps
  `data-focus` on the shell's stage/dock wrapper when `focusMode`. Three
  rules (chatdock.css):
  - `[data-focus] .artifact-shelf { display: none }`
  - `[data-focus] .chat-dock:not(.chat-dock--full) { display: none }` —
    the docked chat collapses; home's full chat survives, because on Chat
    the conversation IS the stage (focus there hides only the shelf).
  - `[data-focus] .stage.document-stage, [data-focus] .stage.diagram-stage,
    [data-focus] .stage.map-stage { padding-right: 0 }` — the canvas
    reclaims the dock's reserved width (the "Plan 3b full-screen drops
    this" note in chatdock.css:48-50, now real).

  Nothing unmounts, so the mounted-once ChatDock keeps its state.

- **Toggle:** `ToolRail` gains footer-menu item "Focus" ABOVE Settings
  (lucide `Focus` icon), props `onToggleFocus?: () => void`,
  `focusActive?: boolean` (rendered as the item's `isCurrent` highlight —
  stays inside the verified HeroUI compound API), and `showFocus?:
  boolean`. HomePage shows it only on the five kind surfaces via a new
  `isKindSurface(pathname)` predicate in `lib/composerLayout.ts`
  (`"/" | "/dashboards" | "/map" | /doc/* | /diagram/*`).

- **Esc:** a `keydown` listener HomePage binds only while `focusMode` is
  on → `exitFocus()`.

### Testing

- Unit: `shelfDocsFor` (session order kept, unknown ids dropped, null
  session), `isKindSurface`, uiStore focus actions.
- Stage tests (all four): the shelf slot renders when passed.
- Router tests: the shelf (aria-label "session documents") appears on
  `/doc/$docId` when the session has artifacts (pattern extends to the
  other canvases through the same wiring).
- HomePage/ToolRail tests: Focus item present above Settings on kind
  surfaces, absent on `/board`; toggling stamps `data-focus`; Esc clears
  it.
- Full control-plane suite + root typecheck + lint (zero-diagnostic
  baseline).

## Out of scope

- Minimized/edge-tab collapse affordances.
- Persisting focus across reloads.
- Focus on `/board` and `/work/*` (not kind surfaces).
- Highlighting the currently-open doc's tile; document deletion.
- Any broker change.
