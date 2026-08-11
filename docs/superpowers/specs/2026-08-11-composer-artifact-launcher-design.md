# Composer Artifact Launcher — Design

**Date:** 2026-08-11 · **Status:** draft for review · **Repo:** smithagents (control-plane + broker)

## Goal

Turn the chat box into a single launcher for every kind of work product. A
**reveal-on-engage** row under the composer offers five kinds — `Chat`,
`Dashboards`, `Documents`, `Diagrams`, `User Story Maps` — and arming one
changes what **send** does: it launches (and seeds with your typed text) the
right artifact, exactly the way arming `document` already creates a document
today. Two of the kinds (Documents, Diagrams) are one blueprint-driven system
split by a render family; two (Dashboards, User Story Maps) are existing custom
stages; Chat is the conversation. The dashboards and story-map entries leave the
left nav — they're composer-triggered now.

## The taxonomy

| Kind | Nature | On send | Renders |
|---|---|---|---|
| **Chat** | conversation | `onSend(text)` — unchanged | transcript |
| **Dashboards** | custom stage (`DashboardsStage`, a client mock) | seed query → navigate `/dashboards` → auto-run its `ask→composing→board` | the mock board |
| **Documents** | blueprint-driven, `family: "document"` | `postDocument(<default document blueprint>, text)` → `/doc/$id` | prose sections (Tiptap) |
| **Diagrams** | blueprint-driven, `family: "diagram"` | `postDocument(<default diagram blueprint>, text)` → `/doc/$id` | Mermaid, rendered |
| **User Story Maps** | custom stage (`MapStage`) | navigate `/map` | the story-map canvas |

**One system, split by family.** Documents and Diagrams are the *same* machinery
— blueprint-instantiated documents (`broker/src/documents.ts`). The only new
data is a `family: "document" | "diagram"` tag on each blueprint. The composer
groups blueprints into the two buttons by family; the document stage's existing
"re-cast type" switch offers same-family blueprints (a document re-casts among
prose types, a diagram among Mermaid types). Adding a new artifact type later is
a blueprint file, no code.

**Honest scope — launch + seed, not AI-author.** Arming a kind + send creates
the *right scaffold seeded with your text* (a spec doc, an empty ER diagram, a
dashboard from the mock) and opens it — it does not AI-generate the finished
contents. Filling a diagram is normal editing, or asking an agent in the docked
chat to draft the Mermaid (agents already edit document sections). AI
authoring-on-send is deliberately a later feature.

## Architecture

### 1. Blueprint family (broker)

- Add `family: "document" | "diagram"` to the `Blueprint` type
  (`broker/src/blueprints.ts`). Existing `spec` and `implementation-plan` →
  `family: "document"`.
- Add seed diagram blueprints with `family: "diagram"`, each whose single
  section body is a starter Mermaid block: `er` (Database design), `sequence`
  (Sequence). The section's body is fenced Mermaid text (e.g. ```` ```mermaid
  erDiagram\n  ... ````), so it round-trips through the existing markdown model
  and renders (below). More Mermaid types (flowchart, class, state, …) are
  future blueprint files — the switch and composer pick them up with no code.
- Blueprints stay data-driven (`loadBlueprints()` from `.smith/blueprints`),
  so `family` is carried on the wire in the blueprint catalog the control-plane
  already fetches (`getBlueprints`).

### 2. Mermaid rendering (control-plane)

- Add `mermaid` as a direct dependency (size is not a concern — desktop Tauri
  app; can be made lazy later for the cloud SPA path if it ever matters).
- A `MermaidBlock` component compiles Mermaid text → SVG and renders it, with a
  visible fallback showing the raw Mermaid + the parse error when Mermaid throws
  (a diagram artifact must never render blank on a typo).
- Wire it into the document stage so a fenced `mermaid` code block in a
  document's section renders as a diagram in the read view; the raw Mermaid text
  stays editable (a diagram doc is text you edit, picture you see). Exact
  Tiptap integration (node view vs preview-render) is a plan-level decision;
  the contract is: *a `mermaid` code block renders as a diagram, editable as
  text.*

### 3. Composer artifact row (control-plane)

- **Reveal-on-engage.** The kind row is hidden until the composer is *engaged*
  — `focused ∪ draft.trim() !== "" ∪ armedKind !== null` — and collapses when
  idle. This keeps the default view uncluttered and never flickers while you
  pick a kind or type (clicking a kind button doesn't hide the row because
  `armedKind` keeps it open).
- **Armed kind.** Generalize the composer's current boolean `armed` to
  `armedKind: "dashboard" | "document" | "diagram" | "map" | null` (Chat =
  `null`). The row renders the five buttons in canonical order; the active kind
  is highlighted; re-pressing `Chat` (or the active kind) disarms.
- **Send routing.** `submit()` dispatches by `armedKind`:
  - `null` → `onSend(text)` (or the targeted `onSend(text, target)`) — today's path.
  - `document` / `diagram` → `onSendArtifact("document"|"diagram", text)` — the
    route resolves the default blueprint for that family and calls
    `postDocument`.
  - `dashboard` → `onSendArtifact("dashboard", text)`.
  - `map` → `onSendArtifact("map", text)`.
- **One dispatcher prop.** Replace the single `onSendDocument` with
  `onSendArtifact(kind, text) => Promise<{ error?: string } | undefined>`; the
  chat route implements it (see §4). Placeholder/aria follow the armed kind
  ("describe the diagram you want…", etc.). Every non-armed path is byte-for-byte
  today's behavior.

### 4. Send handlers (control-plane router)

Wired on the chat/voice route's composer, mirroring today's `onSendDocument`
at `router.tsx:93`:

- `document` → `postDocument(firstBlueprintWhere(family==="document"), text)` →
  seed doc into query cache → `navigate /doc/$id`. (Today's exact flow, now
  family-filtered instead of `blueprints[0]`.)
- `diagram` → `postDocument(firstBlueprintWhere(family==="diagram"), text)` →
  same seed + navigate.
- `dashboard` → write `text` to `uiStore.pendingDashboardQuery`, `navigate
  /dashboards`. `DashboardsStage` reads the pending query on mount, seeds it,
  jumps to `composing`, and clears it (organism stays router-free — the store is
  the hand-off, matching the codebase's existing pattern).
- `map` → `navigate /map`. (Seeding a first story from the text is a possible
  nicety but out of scope v1 — the story map opens ready to author.)

### 5. On-page type switch (control-plane)

- The document stage's existing blueprint re-cast switch filters its options to
  the **same `family`** as the current document. A prose doc lists prose
  blueprints; a diagram doc lists Mermaid blueprints. Re-cast stays legal only
  while sections are empty (existing `documents.ts:93` rule) — switching a fresh
  diagram's type swaps its starter Mermaid block.

### 6. Nav cleanup (control-plane)

- Remove the `Dashboards` and `User Story Maps` (`/dashboards`, `/map`) entries
  from `ToolRail`. Both routes stay reachable — they're reached by sending now,
  not by a nav click. (`Chat`/home, boards, etc. are unchanged.)

## Data flow

```
type a request → engage → row reveals → press Diagrams (armedKind="diagram")
  → send → onSendArtifact("diagram", text)
    → postDocument(er, text) [broker: scaffold from blueprint, seed text]
    → seed query cache + navigate /doc/$id
      → DocumentStage renders the doc; the mermaid section shows a diagram
      → type switch offers {er, sequence, …}; docked chat can ask an agent to draft it
```

Dashboards is the one non-document path: `text → uiStore.pendingDashboardQuery →
/dashboards → mock animation`.

## Error handling

- `postDocument` already returns `{ error }` on failure; the composer surfaces it
  on the same status line document-send uses today (`polishError`). No new error
  surface.
- Mermaid parse failure renders the raw text + error inline (never blank).
- A disarmed/Chat send is unchanged, so targeted-send refusals (busy agent) keep
  their exact current behavior.

## Testing

- **Composer:** row hidden when idle; revealed on focus, on draft, and while
  armed; each armed kind routes `submit()` to the right dispatch (`onSend` vs
  `onSendArtifact(kind,…)`); disarm returns to chat. (vitest + Testing Library,
  mocking the handlers.)
- **Blueprint family:** `getBlueprints` carries `family`; the composer groups by
  it; the type switch filters by it. Broker unit test that `spec`/`plan` are
  `document` and the diagram blueprints are `diagram`.
- **Mermaid:** `MermaidBlock` renders valid Mermaid to SVG and renders a
  visible fallback (raw text + error) on invalid input. (jsdom can't lay out
  SVG; assert the compile call + fallback branch, not pixels — a real render is
  a manual/Playwright check.)
- **Dashboard seed:** sending with `dashboard` armed writes the query and
  navigates; `DashboardsStage` consumes and clears the pending query.
- **Nav:** `ToolRail` no longer renders `/dashboards` or `/map` items.
- Whole control-plane + broker suites stay green (local/chat behavior unchanged).

## Build order (one feature, two natural steps)

1. **Launcher** — composer artifact row + reveal-on-engage + `onSendArtifact`
   dispatch + wire the *existing* kinds (Chat, Documents via blueprint family,
   Dashboards seed, User Story Maps) + `family` tag on blueprints + on-page
   switch filtering + nav cleanup. Ships the whole UX with **no new dependency**.
2. **Diagrams** — `mermaid` dependency + `MermaidBlock` + doc-stage wiring +
   the `er`/`sequence` diagram blueprints. Turns the `Diagrams` button real.

## Out of scope (v1)

- AI authoring the artifact contents on send (docs/diagrams start as scaffolds).
- A visual (drag-and-drop) diagram editor — diagrams are Mermaid text you edit.
- Making dashboards data-real (stays the existing client mock).
- Seeding a first story into the story map from the typed text.
- A second-level sub-menu under a category — type selection happens on the page
  (re-cast switch), keeping the row uncluttered.
