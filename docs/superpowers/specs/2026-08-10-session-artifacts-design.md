# Session Artifacts — the pivot from session kinds

**Date:** 2026-08-10 (evening)
**Status:** Approved design, ready for migration planning
**Supersedes:** the "Session kinds" section of
`2026-08-10-pair-mob-document-sessions-design.md` (that spec's document,
blueprint, store, stage, and polish sections stand unchanged). Decided with
Edwin after phase 1 shipped (`dc6fc5a`), before phase 2 builds on the joint.

## The model change

**Sessions do not have kinds. Sessions have optional artifacts.**

The conversation is the primary object; documents are what it produces and
works on. A session carries `artifacts: string[]` (document ids, ordered,
usually short). Any session can hold zero, one, or several documents — a
council session that produces a spec and then its plan is one session with
two artifacts, not three sessions. There is no "document session": the
phase-1 `kind`/`docId` fields die, and with them the dock-binding problem
(the doc stage's chat dock shows the active session's transcript — which is
now correct by construction, because the document belongs to that session).

Precedent: Claude's artifacts and ChatGPT's canvas — conversation-primary,
artifacts attached.

## The composer kind toggle (Edwin's flow)

A two-item button group — `chat` | `document` — sits to the right of the
polish action in the shared Composer. It is a **view/arm toggle, never a
creator**:

- On a chat surface the group shows `chat` active. Pressing `document`
  **arms** the composer: pure client state, instantly reversible, nothing
  created. The armed composer shifts visibly (placeholder becomes
  "describe the document you want…"), and small inline **blueprint chips**
  appear (one per blueprint, `spec` preselected). No popover, no form.
- **Send is the commit.** Sending while armed creates the document ON the
  current session: the broker derives the title from the sent text
  (`truncateTitle`, the same birth ritual chat sessions use), instantiates
  the blueprint (work type defaults to the blueprint's first), attaches the
  doc id to the active session's `artifacts`, and the sent text also enters
  the session transcript as a normal utterance (the brain responds to it in
  context). The UI navigates to `/doc/$docId` with the existing entrance
  animation and the composer disarms.
- If **no session is active** when an armed send happens, the broker lazily
  creates one first (the same lazy-session path chat sends already use),
  then attaches.
- On the document stage the group shows `document` active. Pressing `chat`
  navigates to `/` — same session, same thread, nothing created or lost.
- Toggling costs nothing: arm, disarm, walk away. A document exists only
  once you have said something document-worthy, and its title is your own
  words. No rename UI is required; the future brain-retitle extension
  applies to docs exactly as it does to chat titles.

## What changes where

**Broker**
- `Session.artifacts?: string[]` (absent = `[]`); `SessionSummary.artifacts:
  string[]` (always resolved). `kind`/`docId` removed from both. Legacy
  tolerance at `init()`: a persisted session with `kind: "document"` +
  `docId` normalizes to `artifacts: [docId]`; unknown legacy fields are
  dropped in memory and disappear on next save. Parse-tolerance is
  permanent (old files must never crash a new broker).
- `SessionManager.addArtifact(sessionId, docId)`: append-if-absent, bump
  `updatedAt`, persist.
- `POST /documents` contract v2: `{blueprintId, workType?, text}` →
  `{doc}`. Title is derived server-side (`truncateTitle(text)`); `workType`
  absent defaults to the blueprint's first declared type. The closure
  ensures an active session (lazily creating one if needed), creates the
  doc, attaches it, broadcasts `documents` + `session` frames, and feeds
  `text` through the same utterance path `POST /sessions`' prompt uses
  (echo frame + brain turn). The v1 `title` field is gone.
- `sessionFrame()` and the `ChannelFrame` session-variant type carry
  `artifacts` instead of `kind`/`docId`.
- Unchanged: blueprints, the document store, `PATCH sections`,
  `GET /blueprints`, `POST /polish`, the `documents` frame.

**Control-plane**
- Types mirror the broker (lockstep): `SessionSummary.artifacts: string[]`;
  the session-frame variant likewise; absent (old broker) normalizes to
  `[]` at the socket parser. `postDocument(blueprintId, text, workType?)`.
- **SessionsPanel**: the kind badge dies. Rows restructure from a single
  `<button>` to a row container holding the activate button (title + meta —
  activates and lands on `/`) plus, when `artifacts` is non-empty, one small
  artifact chip per doc id (`FileText`) — pressing a chip activates the
  session AND navigates to that document. No nested buttons (a11y).
- **HomePage**: kind-aware activation dies — activation always navigates
  `/`. A new `onOpenArtifact(sessionId, docId)` (activate + navigate to the
  doc) wires the panel chips.
- **NewSessionScreen returns to chat-only.** The phase-1 document mode
  (kind toggle, blueprint/work-type/title fields) is removed — the composer
  toggle is how documents are born. `getBlueprints` stays (the composer
  chips consume it).
- **Composer**: the kind group + armed state + blueprint chips +
  `onSendDocument(blueprintId, text)` contract (all optional props — the
  group renders only where wired). Armed send routes to `onSendDocument`
  instead of `onSend`; the consumer (voice route) calls `postDocument`,
  seeds the documents cache from the response, navigates, disarms. The doc
  route's group renders `document` active with `chat` navigating home.
- **DocRoute**: mechanics unchanged (status-gated lookup). The dock remains
  bound to the active session — now correct by the model. Deep-linking to a
  document whose owning session is not active still shows the active
  session's chat in the dock; acceptable v1, phase 2's participant scoping
  revisits it.

## The artifact shelf (Edwin, 2026-08-10 — Stage Manager metaphor)

While in chat mode, the active session's artifacts are VISIBLE, not buried
in the panel: a stage-manager-style shelf at the left edge of the chat
stage — small stacked cards (title + blueprint tag), one per artifact,
rendered only when the active session has any. Clicking a card brings that
document to center stage (navigate to `/doc/$docId`; the existing entrance
animation carries the "moves to the center" feel in v1). The document
stage's return-to-chat is the inverse move.

- v1: a simple stacked shelf (slight card offsets, hover fans them apart
  enough to read titles), click-through navigation, existing motion
  entrance, reduced-motion respected. New molecule; no xyflow, no drag.
- The TRUE Stage-Manager morph — the card itself animating into the center
  editor via a shared element — joins the already-spec'd layoutId /
  AnimatePresence phase-2+ polish item; same constraints noted there.
- The SessionsPanel's artifact chips remain the cross-session entry; the
  shelf is the in-session one.

## Error handling

- Armed send with the broker down: the composer's existing disabled/failed
  states apply; the draft is preserved; nothing is created.
- `POST /documents` validation failures (unknown blueprint, undeclared
  workType, empty text → 400) surface exactly like failed chat sends.
- Old-broker/new-client and new-broker/old-client mixed windows stay safe:
  absent `artifacts` parses as `[]`; unknown fields ignored.

## Testing

- Broker: legacy normalization (kind+docId file → artifacts), addArtifact
  semantics, POST /documents v2 (title derivation, attach, lazy session,
  utterance feed), frame shape.
- CP: socket normalization (absent artifacts → []), panel chips render/route,
  activation lands home, NewSessionScreen chat-only regression, composer
  arm/disarm/chips/armed-send contract, create-flow router test updated to
  the v2 contract, shelf renders only with artifacts and click-through
  navigates.
- Live smoke: arm → send → land on doc → dock shows the same conversation →
  toggle back to chat → same session; artifact chip from the panel returns
  to the doc.

## Explicitly deferred

- Brain retitle for documents (machinery exists for chat; extend later).
- Work-type chips in the composer (defaulted now; phase 2 may infer from
  text).
- Pinning the dock to the owning session on deep links (phase 2, with
  participants).
- Artifact detach/delete, doc rename UI, multi-session artifact sharing.
