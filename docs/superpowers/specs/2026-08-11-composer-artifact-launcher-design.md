# Composer Artifact Launcher — Design

**Date:** 2026-08-11 · **Status:** draft for review · **Repo:** smithagents (control-plane + broker)

## Goal

Replace the left-nav stage rail with a **contextual kind-switcher under the chat
box**. A reveal-on-engage row offers five kinds — `Chat`, `Dashboards`,
`Documents`, `Diagrams`, `User Story Maps` — and **clicking one immediately
switches the screen** to that kind's surface. There is no arm-then-send: the
click itself is the navigation. Authoring a Document or a Diagram is a
**three-column layout** that reuses what's already there: the session's
documents in the **left shelf** (the existing `ArtifactShelf`), the artifact
being edited in the **center**, and the **chat docked on the right**, so you
converse while you author. Clicking any document in the left shelf transitions
you to editing it. Documents edit as the prose editor; Diagrams are a **Mermaid
canvas** (a diagram deserves a visual surface, not a text column). Dashboards and
User Story Maps are existing custom stages. The row is the new navigation, so the
nav-rail entries for these kinds go away.

## The five kinds

| Kind | Surface | Main area | Chat | Backed by |
|---|---|---|---|---|
| **Chat** | home (`/`) | transcript | inline (composer) | conversation |
| **Dashboards** | `/dashboards` (`DashboardsStage`, client mock) | mock board | its own ask box | mock (`data/dashboards.ts`) |
| **Documents** | `/doc/$id` (`DocumentStage`) | prose editor (Tiptap) | **docked right** | blueprint doc, `family: "document"` |
| **Diagrams** | new `/diagram/$id` stage | **Mermaid canvas** (full-bleed, renders the diagram) | **docked right** | blueprint doc, `family: "diagram"` |
| **User Story Maps** | `/map` (`MapStage`, react-flow canvas) | node canvas | (its own) | capability story map |

**Interaction, precisely:** clicking a kind navigates immediately.
`Chat`→`/`, `Dashboards`→`/dashboards`, `User Story Maps`→`/map`. `Documents` and
`Diagrams` **create a fresh artifact of that kind and open it** (chat docked
right). Any draft text already in the composer travels with the chat to the new
surface — it is not consumed as a hidden "seed"; the conversation simply
continues where you author.

## What a Diagram is (and isn't)

- A Diagram is a blueprint-instantiated document (same store as Documents) whose
  body is **Mermaid text**, presented on a **canvas** rather than the prose
  editor. The canvas is the *presentation* — a full-bleed pan/zoom surface where
  the Mermaid renders large. It is **not** a react-flow node editor (you don't
  drag Mermaid's nodes); authoring is the Mermaid **source** plus the
  right-docked chat (ask an agent to draft/refine it — agents already edit
  document sections). "Canvas like User Story Maps" means the *visual-stage feel*,
  not the react-flow mechanism.
- **Honest scope — launch, not AI-author.** Creating a diagram opens the
  starter Mermaid for its type (an empty ER/sequence scaffold), ready to edit or
  hand to the crew. The click doesn't AI-generate a finished diagram from a
  sentence; that is a later feature.

## Architecture

### 1. Blueprint family (broker)

- Add `family: "document" | "diagram"` to the `Blueprint` type
  (`broker/src/blueprints.ts`). `spec` and `implementation-plan` →
  `family: "document"`.
- Add seed diagram blueprints, `family: "diagram"`, each a single section whose
  body is a fenced Mermaid starter: `er` (Database design) → `erDiagram` stub,
  `sequence` → `sequenceDiagram` stub. More Mermaid types (flowchart, class,
  state, …) are future blueprint files — the type switch and the launcher pick
  them up with no code.
- Blueprints stay data-driven (`loadBlueprints()`); `family` rides the
  `getBlueprints` catalog the control-plane already fetches.

### 2. Diagram stage + Mermaid canvas (control-plane)

- Add `mermaid` as a direct dependency (size is not a concern — desktop Tauri
  app; can be lazy-loaded later for the cloud SPA path if it ever matters).
- New `DiagramStage` organism (router-free, like every stage): a full-bleed
  canvas that renders the document's Mermaid body to SVG (pan/zoom), the
  right-docked **chat**, a **Mermaid source panel** for direct edits, and the
  **type switch** (below). On invalid Mermaid it shows the source + the parse
  error in place — a diagram must never render blank on a typo.
- New route `/diagram/$id` reusing the documents store/query cache (a diagram IS
  a document with `family: "diagram"`; the route just chooses the canvas
  presentation over the prose editor based on the doc's blueprint family).

### 3. Authoring layout: shelf-left, artifact-center, chat-right (control-plane)

- The session's documents render in the **left shelf** — the existing
  `ArtifactShelf` (session-artifacts pivot), already a top-left stack of page
  tiles with `onOpen(docId)`. It stays as-is except its `onOpen` now **routes by
  family**: a `family: "document"` doc → `/doc/$id` (prose editor), a
  `family: "diagram"` doc → `/diagram/$id` (canvas). Diagrams appear in the same
  shelf because a diagram *is* a session document.
- The shelf is present on the authoring stages (Document and Diagram), not only
  home — it's the persistent left column, composed by the route so the stages
  stay router-free (same `shelf?: ReactNode` prop pattern `VoiceStage` uses).
- `DocumentStage` already docks the chat; standardize the layout so the artifact
  holds the center column and the **chat dock sits on the right**
  (`document-stage__dock` → right rail). Diagrams share this three-column layout
  (shelf · canvas · chat).
- Clicking a shelf tile transitions to editing that artifact — the existing
  behavior, now family-aware.

### 4. Composer kind-switcher (control-plane)

- **Reveal-on-engage.** The row is hidden until the composer is engaged —
  `focused ∪ draft.trim() !== ""` — and collapses when idle. It never flickers
  because the row is inside the composer's own hover/focus scope.
- **Five buttons, canonical order:** `Chat · Dashboards · Documents · Diagrams ·
  User Story Maps`. The button for the current surface is highlighted.
- **Click = navigate now.** No `armed` state, no send-commit. New prop
  `onPickKind(kind)` where `kind ∈ {"chat","dashboards","documents","diagrams","map"}`;
  the router implements it (see §5). The existing `onSend` / targeted-send path is
  untouched — Chat still sends utterances exactly as today.
- The composer becomes the persistent dock: the *same* composer renders on the
  home transcript, and (docked right) on the Document and Diagram stages, so the
  kind row is available everywhere to switch again.

### 5. Kind navigation (control-plane router)

`onPickKind` handlers, mounted wherever the composer renders:

- `chat` → `navigate /`.
- `dashboards` → `navigate /dashboards`.
- `map` → `navigate /map`.
- `documents` → create a fresh `family: "document"` doc via `postDocument`
  (default document blueprint) → seed into the query cache → `navigate /doc/$id`.
- `diagrams` → create a fresh `family: "diagram"` doc via `postDocument`
  (default diagram blueprint) → seed → `navigate /diagram/$id`.
- **Empty-artifact hygiene:** creating on every click would litter empty docs.
  Resolution: a freshly-created artifact that is left untouched (no section
  edited, no rename) is ephemeral — reuse the caller's most-recent empty doc of
  that family if one exists, else create. (Exact rule is a plan detail; the
  contract: clicking twice doesn't produce two empty artifacts.)

### 6. On-page type switch (control-plane)

- The document/diagram stage's re-cast switch filters options to the **same
  `family`** as the current artifact — a prose doc lists prose blueprints, a
  diagram lists Mermaid blueprints. Re-cast stays legal only while sections are
  empty (existing `documents.ts:93`); switching a fresh diagram's type swaps its
  starter Mermaid block.

### 7. Nav cleanup (control-plane)

- Remove the `Dashboards` and `User Story Maps` entries from `ToolRail` (and any
  Documents/Diagrams entry if present) — the kind row under the chat box is the
  navigation now. All routes stay reachable.

## Data flow

```
engage composer → row reveals → click Diagrams
  → onPickKind("diagrams")
    → postDocument(er, "")            [broker: scaffold from diagram blueprint]
    → seed query cache + navigate /diagram/$id
      → DiagramStage: canvas renders the starter Mermaid; chat docked right;
        source panel + type switch {er, sequence, …}; ask the crew to draft it
```

Dashboards/Map are pure navigations; Documents/Diagrams create-then-navigate.

## Error handling

- `postDocument` already returns `{ error }`; a failed create surfaces on the
  composer's existing status line — no new error surface.
- Mermaid parse failure renders source + error inline (never blank).
- Chat/targeted-send behavior is entirely unchanged, so busy-agent refusals keep
  their current wording and draft-preservation.

## Testing

- **Composer:** row hidden when idle; revealed on focus and on draft; each button
  calls `onPickKind` with the right kind; the current-surface button is
  highlighted; Chat's `onSend` path is unchanged. (vitest + Testing Library.)
- **Kind navigation:** `documents`/`diagrams` create the correct-family doc and
  navigate to `/doc` vs `/diagram`; `dashboards`/`map`/`chat` navigate without
  creating; the empty-artifact-hygiene rule holds (two clicks, one empty doc).
- **Blueprint family:** `getBlueprints` carries `family`; the launcher's default
  per family is correct; the type switch filters by family. Broker unit test on
  the family tags.
- **Mermaid:** `MermaidBlock`/canvas compiles valid Mermaid and shows the
  source+error fallback on invalid input (jsdom can't lay out SVG — assert the
  compile call + fallback branch; a real render is a manual/Playwright check).
- Whole control-plane + broker suites stay green (Chat/home behavior unchanged).

## Build order (one feature, two natural steps)

1. **Launcher + existing kinds** — kind-switcher row (reveal-on-engage,
   click-to-navigate), `onPickKind` wiring for Chat/Dashboards/Documents/User
   Story Maps, `family` tag on blueprints, chat-on-the-right authoring layout,
   type-switch family filtering, nav cleanup. Ships the whole navigation UX with
   **no new dependency** (Diagrams button present but routes to a stub until
   step 2).
2. **Diagram canvas** — `mermaid` dependency + `DiagramStage` + `/diagram/$id`
   route + the `er`/`sequence` diagram blueprints. Turns Diagrams real.

## Out of scope (v1)

- AI-authoring the artifact contents on click (docs/diagrams open as scaffolds).
- A react-flow / drag-node diagram editor — diagrams are Mermaid text on a
  rendering canvas.
- Making dashboards data-real (stays the client mock).
- Seeding the new artifact from the typed chat text (the draft travels with the
  chat but isn't consumed as a seed).
