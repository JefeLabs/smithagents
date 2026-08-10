# Pair/Mob Document Sessions

**Date:** 2026-08-10
**Status:** Approved design, ready for phased planning
**Ancestry:** the "missing spine" in the portfolio division of labor — the Plan
artifact that carries architecture work from smithagents to execution. This
feature productizes the spec/plan workflow as a collaborative surface.

## What this is

A document-centric collaboration mode. The user creates a document from a
**blueprint** (a data-driven schema for a spec, implementation plan, or other
work product), invites one or more agents — or a squad — to work on it, and the
UI shifts: the document takes center stage, chat docks to the right. Agents
discuss in the docked chat and, in the final phase, propose concrete text
changes to sections that the user accepts or rejects.

Three phases, each independently shippable:

1. **Solo editor** — blueprints, the document store, the document stage with
   the shifted layout, section-by-section editing. No agents yet.
2. **The council arrives** — invitations, document sessions in the sessions
   panel, discussion in the docked chat with section references.
3. **Direct co-editing** — the proposal protocol: agents suggest section-scoped
   changes; the user accepts or rejects; the document carries its proposal
   history.

## Non-goals

- No real-time CRDT co-editing (Yjs-class). The broker's serialized turn model
  and the accept/reject flow both favor discrete proposals over live cursors.
- No monolithic rich-text editor. Sections are markdown; HeroUI Pro's
  `rich-text-editor` is a per-section upgrade option for a later phase, gated
  on a docs spike (it is a subpath import and likely carries optional peers —
  the `markdown` lesson).
- No squad-focus chat surface in this spec. Session *kinds* are extensible and
  `squad-focus` is a recognized future kind, but only `chat` and `document`
  ship here.
- No git persistence of documents. The broker store owns them (Edwin's call);
  export-to-repo is a future concern for the execution handoff.

## Core model

**Blueprint** — data-driven config, never a hardcoded enum (personas
principle). Seeded defaults ship as config files the same way personas do;
users can add their own.

```jsonc
{
  "id": "spec",
  "name": "Design Spec",
  "workTypes": ["feature", "bugfix", "integration"],
  "sections": [
    { "id": "overview",  "heading": "What this is",   "hint": "Two paragraphs, plain language." },
    { "id": "repro",     "heading": "Reproduction",   "when": { "workType": ["bugfix"] } },
    { "id": "ui-refs",   "heading": "Design refs",    "when": { "workType": ["feature"] } },
    { "id": "non-goals", "heading": "Non-goals",      "required": true }
  ]
}
```

`when` conditions activate sections for the work type chosen at document
creation. Absent `when` = always present. `required` sections cannot be
removed from the instantiated document.

**Document** — broker-owned, stored like sessions are (one JSON per document
under the broker's state directory).

```ts
interface Doc {
  id: string;
  title: string;
  blueprintId: string;
  workType: string;
  sections: DocSection[];        // instantiated from the blueprint at creation
  participants: string[];        // invited agent ids (a squad invitation expands to its members)
  proposals: Proposal[];         // phase 3; empty until then
  status: "drafting" | "review" | "final";
  createdAt: string;
  updatedAt: string;
}

interface DocSection {
  id: string;                    // blueprint section id
  heading: string;
  body: string;                  // markdown
}

interface Proposal {             // phase 3
  id: string;
  sectionId: string;
  agentId: string;
  newBody: string;               // full replacement text for the section
  rationale: string;
  state: "open" | "accepted" | "rejected" | "stale";
  createdAt: string;
}
```

**Session kinds** — **SUPERSEDED 2026-08-10 (evening) by
`2026-08-10-session-artifacts-design.md`**: sessions carry optional
`artifacts` instead of kinds; the paragraphs below describe the shipped
phase-1 state the migration replaces. — `SessionSummary` gains `kind: "chat" | "document"` and an
optional `docId`. Absent `kind` parses as `"chat"` (legacy tolerance, same
precedent as the channels array). A document session is a real broker session
bound to a document: it appears in the SessionsPanel with a kind badge, and
activating any session navigates to its kind's surface — `chat` → `/`,
`document` → `/doc/$docId`. This adds navigation to activation, which today
stays wherever you are.

The SessionsPanel must also anchor the user's context while open: it shows
the ACTIVE workspace in its header (the panel occludes the navbar's
workspace selector, and a filter is not an anchor), and the currently-active
session's row is visually marked. (Edwin, 2026-08-10 — ships as an immediate
follow-up ahead of phase 1 if the phase is not imminent.)

## UI

- **New stage route `/doc/$docId`** (hash route, thin route component,
  organisms router-free — the stage pattern). Unknown docId redirects home.
- **Layout:** HeroUI Pro `resizable` split — document center-left, the
  existing `Transcript` + `Composer` (fresh off Phase 1b) docked in a narrow
  right column. `floating-toc` navigates sections on long documents.
- **Section editing:** read mode renders each section body through the
  installed `Markdown`; clicking a section (or an explicit edit affordance)
  swaps that section to a textarea. Save is per-section — an atomic PATCH.
  One section in edit mode at a time.
- **Creation:** from the composer/new-session surface — a "document" choice
  alongside the existing session creation: pick blueprint, work type, title,
  and (phase 2) invitees. Creating navigates into `/doc/$docId`.
- **Transition animation (Edwin, 2026-08-10):** entering the document stage
  animates — the document column rises/fades in, the chat dock slides in from
  the right — using the already-installed `motion` package with the
  `useReducedMotion` guard (the Transcript's existing pattern). Entrance-only
  in phase 1. A true shared-element morph of the chat column (layoutId +
  AnimatePresence across routes) is a phase-2+ polish item: it must reckon
  with router unmount timing, the resizable panels, and fixed chrome.
- **Invitations (phase 2):** a participant strip on the document stage —
  invited agents' avatars; add/remove from the roster or by squad. Only
  participants' replies join this session's chat.
- **Proposals (phase 3):** a proposal renders as a suggest-change diff card
  attached to its section (current body vs proposed), with accept / reject.
  Accept applies server-side and rebroadcasts; the proposal joins the
  document's history. A proposal whose section changed since it was made is
  marked `stale` and cannot be accepted without the agent re-proposing.

## Future direction: blueprint surfaces (Edwin, 2026-08-10)

The document body is deliberately a linear reading column — specs and plans
are ordered prose, and text editing inside canvas nodes fights selection,
zoom legibility, and the proposal diffs. But the surface is a property of
the DOCUMENT TYPE: a future `surface` discriminator on the blueprint
(`"sections"` — the default and phase 1's only value — vs `"canvas"`) lets
diagram-class blueprints (sequence diagram, database design, architecture
sketch) render as a zoom/pan canvas with a nodes/edges content model, reusing
the xyflow machinery the Map stage already carries — same store, same
document sessions, same (phase 3) proposal semantics with diagram-shaped
proposals. Adding the optional field later is non-breaking for stored
blueprints and documents. Not in phase 1–3 scope.

## Broker

- **Store:** documents and blueprints under the broker state directory,
  following the sessions pattern. Blueprints seed from packaged defaults
  (`spec`, `implementation-plan`) and merge with user-added files.
- **HTTP:** `GET /blueprints`; `POST /documents` (blueprintId, workType,
  title → instantiated doc + its document session); `PATCH
  /documents/:id/sections/:sectionId` (body); `PUT /documents/:id/participants`
  (phase 2); `POST /documents/:id/proposals/:pid/accept|reject` (phase 3);
  `PATCH /documents/:id` (title, status).
- **WS frames:** a `document` frame carries full document state on any change
  (creation, section save, participant change, proposal event) — same
  full-frame-on-change idiom as roster/boards. The UI's Query cache holds it;
  no route loaders, WS stays above the router.
- **Turn scoping (phase 2):** utterances sent from a document session address
  that document's participants only. Enforcement lives where surface-mode
  enforcement already lives (the brain's directory read for the session), not
  in the UI.
- **Proposal ingestion (phase 3):** participants receive the document state
  and etiquette in their session context; a proposal arrives as a structured
  block in the agent's reply that the broker parses out (behavior-level
  requirement; exact wire format is the implementation plan's decision).
  Parsed proposals never appear as chat text — the chat shows a one-line
  "Ana proposed a change to *Non-goals*" notice instead.

## Polish my input (composer feature, all chat surfaces)

A pre-dispatch refinement step in the `Composer`: the user drafts a rough
utterance, presses **polish**, and the draft is rewritten for clarity by the
broker — *without dispatching anything*. The polished text replaces the
draft in the composer, still fully editable; nothing reaches any agent until
the user sends. No agent or teammate ever acts on the unpolished text.

- **UI:** a polish action in the composer toolbar (beside the mic/sound
  actions). While polishing, the composer is busy-but-cancelable; the result
  lands in the textarea as an ordinary editable draft. Polishing is always
  optional — send works exactly as today without it.
- **Broker:** `POST /polish` `{ text, sessionId? }` → `{ text }`. A single
  brain LLM call with a rewrite instruction; the session id lets the rewrite
  use conversational context (names, the document's topic) without ever
  entering the transcript. No turn is created, no frame is broadcast, nothing
  is persisted.
- **Scope:** lives in the shared `Composer`, so it works identically on the
  voice stage and in the document session's docked chat. It is independent of
  the document feature and ships in the phase 1 plan (small, self-contained,
  and immediately useful on the existing chat).
- **Testing:** composer-level — polish replaces the draft and keeps focus;
  send-without-polish untouched; a failed polish call leaves the draft
  exactly as typed with a visible error.

## Conflict rules

- Section saves are last-write-wins at section granularity; the full-frame
  broadcast keeps every viewer current.
- Accepting a proposal whose section body changed after the proposal was
  created is refused server-side; the proposal flips to `stale`.
- One section in edit mode per client; entering edit mode takes no lock —
  the save PATCH is the atomic unit.

## Error handling

- Broker down: the stage renders the cached document read-only with the
  standard disconnected affordance; section saves fail visibly and keep the
  draft text client-side.
- Unknown blueprint/workType at creation: 400 with the valid set; the UI
  never offers combinations the blueprint doesn't declare.
- Deleted/unknown docId on navigation: redirect home (stage-routing
  convention).

## Testing

- Blueprint instantiation: conditional sections activate per work type;
  `required` enforced; unknown workType rejected.
- Store roundtrip + section PATCH atomicity (broker unit tests).
- Session-kind parsing: absent kind = chat; kind routing in `router.test.tsx`
  (activation navigates per kind).
- Document stage organisms: section read↔edit swap, per-section save calls,
  markdown rendering (reuses the 1b test idioms — role/text queries).
- Phase 2: participant filtering of turns (broker test at the enforcement
  point).
- Phase 3: proposal parse, stale detection, accept-applies-and-broadcasts;
  UI accept/reject flows.
- Real-browser smoke per phase (the 1a/1b lesson: overlays, focus, and layout
  need eyes; jsdom cannot see them).

## Phasing note

Each phase gets its own implementation plan (the 1a/1b/1c pattern). Phase 1
is fully specified above minus participants/proposals; it ships a usable
solo document editor with blueprints and the new stage. Phase 2 and 3 plans
are written when their predecessor merges, against the code as it then is.
