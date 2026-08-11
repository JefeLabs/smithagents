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
| **Dashboards** | `/dashboards` (`DashboardsStage`) | role-aware home: **centered chat**, priority slice cards above, dashboards list below (§9) | centered (mid-screen) | mock (`data/dashboards.ts`) |
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

### 8. Shared canvas-stage chrome (Diagrams + User Story Maps)

- **Canvas stages** = the two kinds presented on a working canvas: **Diagrams**
  and **User Story Maps**. (Dashboards has its own layout — §9 — not this
  chrome.) Because both are canvas-presented, they share the same chrome
  regardless of their different data models:
  - **right-docked chat** (the composer dock on the right, so you converse while
    you work the canvas) — User Story Maps gains the docked chat it lacks today,
    matching the diagram stage;
  - **full-screen focus mode** with Esc (§8.1 below);
  - the canvas layout + corner controls (pan/zoom feel, full-screen toggle).
- **Zoom/controls reposition for the chat dock:** the canvas's zoom/pan control
  panel defaults to a corner the right chat dock would occlude, so with chat
  docked right it moves clear of it (e.g. to the bottom-left). In full-screen
  (chat collapsed to a slim input) the panel can return to its natural spot. The
  rule: canvas controls are never hidden behind the chat.
- **Implementation:** a shared `CanvasStage` layout wrapper (chat dock +
  full-screen affordance + Esc wiring) that `DiagramStage` and `MapStage` render
  inside. Data models are untouched — a story map stays the capability-story-map
  model, a diagram a `family: "diagram"` document. Parity is in the *chrome*,
  not the storage.

### 8.1 Full-screen mode

- **Which kinds:** the two canvas stages — **Diagrams** and **User Story Maps**.
  Documents (a prose column) and Dashboards (its own centered layout, §9) do not
  get full-screen.
- **Behavior:** a full-screen toggle (a control in the canvas's corner) enters a
  focus mode that shows **only the canvas and a minimal chat input**. Everything
  else hides: the top navbar, the left rail, and the **left shelf of the
  session's other documents** ("other docs" — the `ArtifactShelf` tiles). The
  chat **collapses to just its input** (the composer input bar only — no
  transcript panel), so the canvas fills the viewport. **Esc returns to the
  normal three-column view.**
- **Mechanism:** a single `uiStore.fullscreen` boolean drives it (app shell hides
  navbar/rail when set; the stage collapses shelf + chat). A global `keydown`
  Esc handler (registered while `fullscreen`) clears it. The minimal chat input
  still works — you can talk to the crew while focused — and the kind row still
  reveals on engage, so switching kinds or exiting stays reachable without the
  rail.
- **Non-canvas stays put:** entering a Document (prose) never engages
  full-screen; Chat/home is unaffected.

### 9. Dashboards: its own centered layout (not canvas chrome)

Dashboards does **not** share the canvas chrome — clicking `Dashboards` lands on
a role-aware home whose shape echoes the empty/new-session screen:

- **Chat box mid-screen** — centered, calm, the same feel as `NewSessionScreen`.
  This is the primary affordance: describe the dashboard you want, or just ask.
- **Above the chat — priority "slice" cards.** A row of the most important slices
  for **your role**, e.g. *priority maintenance*, *support issues*, *prioritized
  plan / delivery items*. They're the at-a-glance "what matters now" surfaced as
  cards; clicking one opens that dashboard/board.
- **Below the chat (optional) — a collapsed list** of saved/generatable
  dashboards, expandable to pick or generate one.
- **Generating / opening a dashboard** shows the board itself (today's mock
  `ask→composing→board`); the board view can go full-bleed but does not adopt
  the diagram/map canvas chrome.
- **Role source:** "based on your role" reads the current operator/user role
  (the same identity the app already resolves) to choose which slice cards show;
  the card *contents* stay the client mock in v1 (see scope). Making the slices
  data-real is deferred with the rest of the dashboard-realness work.

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
- **Full-screen:** toggling `uiStore.fullscreen` on a canvas stage hides
  navbar/rail/shelf and collapses chat to its input; Esc clears it; a Document
  (prose) stage never enters full-screen. (Assert the store flag + conditional
  render/keydown, not pixels.)
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
- Folding User Story Maps into the session document shelf as first-class
  artifacts (they keep their capability-story-map model; parity is the canvas
  *chrome*, not shelf membership).

---

## Revision (2026-08-11): Composer unification — the ChatDock

Live decisions by Edwin that supersede §3, §4, and §8's "same composer per stage"
language with a stronger invariant: **all views use the same chat box — literally
one instance, not one-per-route.**

**One persistent `ChatDock`.** The chat box is today DUPLICATED (`VoiceStage` and
`DocRoute` each mount their own `<Composer>`; Map/Dashboards/Board have none). Instead,
mount a single **`ChatDock` = `Transcript` + `Composer`** once in the shell
(`HomePage`, inside `ControlPlaneLayout`'s `Sidebar.Main` as a sibling of `{stage}`),
wired to broker deps once. It never unmounts; navigation only re-positions it, so the
draft text, mic binding, focus, and scroll survive view switches.

**Router-driven layout.** A pure `layoutForPath(pathname)` returns the variant — no
new store state, the URL is the single source of truth (back/forward just work):

| Route | Variant | Shape |
| --- | --- | --- |
| `/` | `full` | Centerpiece: empty-hero ("mic is yours") → transcript, composer at bottom, **kind buttons**, artifact shelf |
| `/doc/$id` `/diagram/$id` `/map` | `dock` | Right column: mini-transcript above the input, **kind row → a `<select>`** (a narrow dock has no room for five buttons) |
| `/dashboards` | `center` (Plan 4) | Mid-screen. **Deferred:** shipped `hidden` in Plan 3 — the dashboards mock owns its own centre compose box, so a second center dock collided (caught in the Plan 3 smoke). Plan 4 rebuilds the stage to host the dock and flips the mapping to `center`; the variant + CSS are already in place. |
| `/board` `/work/$agent`, and while the session-birth `NewSessionScreen` shows | `hidden` | No chat box |

**Consequences.** `VoiceStage` is retired — its hero + transcript become the `full`
variant's own empty/active states, and `VoiceRoute`'s `/` Outlet goes near-empty (the
dock covers it over the dot-grid). `DocRoute` loses its private `<Composer>` and
Resizable split; `DocumentStage` becomes document-only, matching `DiagramStage` (already
chat-free as of Plan 2). The kind control is one component with a `variant` prop:
buttons in `full`/`center`, a `<select>` in `dock`.

**Scope split.** This is **Plan 3 = the ChatDock lift + reposition + buttons→select
ONLY.** Full-screen focus mode (Esc, hide nav/rails, shrink the dock — old §8/§8.1)
moves to its own follow-up **Plan 3b**. Plan 4 (Dashboards centered layout) is unchanged.
