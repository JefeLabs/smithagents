# Dock sends edit the artifact on screen — Design

**Date:** 2026-08-11
**Status:** SHIPPED (direct-apply verified live end-to-end: instruction → edit turn → section updated on canvas + transcript ack. Crew→proposal path unit/route-tested; its LIVE exercise is blocked by the pre-existing directed-send gap — the swarm agent registry returns empty, so `resolveTarget` 404s on rail crew for plain chat too. See composer-target-selector's OPEN note.)

## Problem

Chatting from a non-chat surface is normally an instruction to change the
artifact currently displayed — but today a dock send is a plain chat
utterance: the brain replies in the transcript and the document on screen
never changes. Nothing tells the broker what the user is looking at.

## Decisions (Edwin, 2026-08-11)

1. **Your own instruction applies directly** — the agent rewrites the
   relevant section(s) immediately and the canvas updates live.
2. **Section-level targeting**: you can select a section as the
   instruction's target ("I also like selecting something to make the
   change to a specific area"). Text-range targeting is a later phase.
3. **Hybrid authorship rule**: a send to Anderson/default = your hands →
   direct apply. A send directed at a crew agent (existing composer
   target selector) = that agent's contribution → a sticky-note
   **Proposal** you accept or dismiss. Multi-agent help never
   direct-writes.
4. Dashboards are excluded until they have a real backend; the intent
   (chat-driven dashboard changes) is recorded here.

## Design

### 1. The send carries what you're looking at

- On `/doc/$docId` and `/diagram/$docId`, HomePage attaches
  `doc: { docId, sectionId? }` to the send payload. The route is the
  source of truth for `docId`; `sectionId` comes from the selection
  below. Chat/board/work sends are unchanged.
- `api/broker.ts` send function gains the optional `doc` field;
  the broker's message route passes it through to the directed/brain
  seam.

### 2. Section targeting (the aim chip)

- Each `SectionCard` on the document stage gets a small "aim" affordance
  (crosshair, visible on hover). Clicking it sets
  `uiStore.docTarget = { docId, sectionId, heading }`.
- The dock composer shows a dismissible chip ("→ Approach") beside the
  agent target selector. Cleared on send, on doc/route change, or by
  clicking the chip off.
- No target selected → the agent decides which section(s) the
  instruction means.
- Diagrams have a single Mermaid section — the whole canvas is
  implicitly the target; no selection UI there.

### 3. The broker edit turn

- A send arriving with `doc` context runs a **document-edit turn**
  instead of a plain chat turn:
  - Prompt: doc title, blueprint, all sections (id + heading + body),
    the targeted section flagged, plus the instruction. Persona: the
    resolved agent's (Anderson for default sends; the targeted crew
    agent's otherwise).
  - Model: the brain's existing configured model/client (main.ts).
  - Output: structured `[{ sectionId, newBody }]` (tool-forced or
    fenced-JSON parse).
- **Default (Anderson) sends — direct apply:** each rewrite goes through
  the existing `patchSection` path (markdown normalization,
  last-write-wins), then the documents frame broadcasts — the canvas
  updates live — and a short confirmation lands in the transcript
  ("updated *Approach*").
- **Targeted crew sends — Proposals:** the same edit turn's rewrites are
  stored as `Proposal`s (`sectionId`, `agentId`, `newBody`, `rationale`,
  state `open`) on the doc — never applied. The documents frame carries
  them.
- **Failure semantics:** unparseable or failed model reply → nothing is
  written; the error lands in the transcript as a normal reply. Never a
  half-applied doc.

### 4. Sticky notes (proposal UI)

- Open proposals render as sticky-note cards pinned to their section on
  the document canvas: agent name, one-line rationale, body preview,
  **Accept / Dismiss**.
- Accept → applies via `patchSection` (same normalization), marks the
  proposal `accepted`. Dismiss → `rejected`. A section edited while a
  proposal on it is open marks that proposal `stale` (the shape's
  existing state machine).
- All transitions broadcast the documents frame, so notes appear and
  resolve live for every viewer.
- The `Proposal` scaffolding in `documents.ts` is activated, not
  reshaped.

### 5. Boundaries

- Organisms stay router-free: routes/HomePage supply doc context; the
  stage renders sticky notes from the doc it is given plus accept/dismiss
  callbacks.
- The edit turn lives beside the existing brain turn in the broker; no
  second brain, no swarm involvement (crew-agent edit turns are
  persona-flavored in-broker calls, same as directed chat's brain path).

### 6. Testing

- Frontend: send-payload assembly (with/without target); aim-chip
  lifecycle (set, chip render, clear on send/route change); sticky-note
  render + accept/dismiss wiring.
- Broker (stubbed model): edit turn applies rewrites through
  patchSection; targeted-section flagging reaches the prompt; crew-
  targeted turns produce open Proposals and write nothing; accept/
  dismiss/stale transitions; failure leaves the doc untouched and
  replies in-transcript.
- Route: the message route passes `doc` through; proposal
  accept/dismiss endpoints guard origin like every write.
- Live smoke: instruct on a real doc (direct apply), target a section,
  direct a send at a crew agent and accept the sticky note.

## Out of scope

- Text-range targeting inside a section (phase 2).
- Dashboards edit-by-chat (needs the real composition backend).
- Background/unsolicited agent proposals — v1 proposals come only from
  sends you explicitly directed at a crew agent.
- Proposal threading/discussion; one accept/dismiss decision per note.
