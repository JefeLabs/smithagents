# Broker identity — Anderson

**Date:** 2026-08-06
**Status:** Approved by Edwin (approach A: full cast member with system powers;
confirm-first create; new-session greeting only; agents keep completion notes).

## Problem

The brain's prompt forbids a narrator: every line must come from a named crew
member (`broker/src/brain.ts:131` — "There is NO narrator and no 'I' outside a
named agent"). But the broker is the only actor with swarm-wide awareness, so
the moments that need that awareness have no legitimate speaker: the
session-open greeting, roster/status answers, casting a new agent, general
questions no specialist owns. Today the rule forces the "most relevant agent"
to answer coordination questions that belong to nobody.

**Decision:** the broker gets a first-class, data-driven identity — shipped
default **Anderson** (the name Agent Smith uses for Neo). He is a host, not
crew: addressable by name, speaks with his own ElevenLabs voice, performs
user-level system actions (starting with agent creation), and answers
questions no specialist owns. He never does delegated work and never appears
in the swarm roster — same boundary rule as no-helmsmith-in-swarm.

## Identity file

- `broker/.smith/identity.json`, persona-shaped like `swarm/.smith/agents/*`:
  `{ id, name, role, persona: { style }, backstory, gender, language,
  voice: { voiceId, speech }, quickAnswers }`.
- Deliberately absent: `engine` (the broker brain IS the engine), `channels`
  (Anderson exists wherever the broker fronts — he is not joinable, per the
  tauri-not-a-surface spec), `reactions`/`stereotype` (he does not vote in
  crew dynamics).
- Loaded once at startup in `broker/src/main.ts`; a missing or unparsable
  file falls back to a built-in Anderson default so the broker always has an
  identity. The name is config — "Anderson" is a default, not a constant.
- `voice.voiceId` ships as `DEFAULT_ELEVEN_VOICE` until Edwin casts a real
  voice from his library (his picks only — never premade defaults).
- Shipped persona content (style, backstory, quickAnswers) is drafted with
  the persona generator and edited by Edwin before commit, same as the crew.

## Brain contract (`broker/src/brain.ts`)

- `PERSONA` (line 131) becomes `buildPersona(identity)` — the identity's
  name, role, and style are interpolated. The universal speaker-prefix rule
  stays; "there is NO narrator" is replaced with:
  - `Anderson:` is a legal speaker. He owns: the session-open greeting,
    roster/status/meta answers, system-action announcements (agent created,
    workspace switched), and general questions no crew member plausibly owns.
  - **Deference default:** if a specialist plausibly owns the question,
    Anderson does not answer — the specialist does. Anderson fronts only
    what belongs to nobody.
  - Anderson never performs or receives delegated work. `delegate` already
    validates registry-agents-only, so this is structural as well as
    prompted.
  - "Hey team" / "everyone" addresses the crew, not Anderson. Addressed to
    Anderson by name → only Anderson replies.
- Task-completion notes injected via `injectNote` (line 223) stay in the
  working agent's voice ("Octavio: done, PR is up"). Anderson announces
  infrastructure events only.
- New tools in `TOOLS` (line 44) + `ToolExecutors` (line 13):
  - `draft_agent({ spec })` — spec is the human's free-text ask ("an
    Architect agent, female, grumpy veteran"). Executor calls
    `PersonaGenerator` with crew context and taken names, holds the draft as
    the single pending draft in broker state, and returns a summary for
    Anderson to pitch aloud (name, role, one-liner).
  - `confirm_agent({ accept })` — `accept: true` persists the pending draft
    to `swarm/.smith/agents/<id>.json` (same registry the wizard writes;
    directory refresh re-pushes the roster frame) with
    `voice.voiceId = DEFAULT_ELEVEN_VOICE`; casting a real voice stays in
    the wizard UI. `accept: false` discards. Either way the pending slot
    clears; a second `draft_agent` before confirmation replaces the pending
    draft.
  - Confirm-first is deliberate: STT mishears, and this is the first brain
    tool that mutates durable state — every existing tool is read-only or
    dispatches ephemeral work.

## Addressing + voice (`broker/src/broker.ts`, `broker/src/main.ts`)

- `addressableNames()` (used at `broker.ts:324`) gains the identity name, so
  "Hey Anderson" lights his listening ring. `whoIsAddressed` itself is
  untouched — the identity is just one more name.
- Voice resolution (`main.ts:337`) gains a leading lookup: speaker equals
  identity name → `identity.voice.voiceId`, then the existing
  directory → `SQUAD_VOICES` → `DEFAULT_ELEVEN_VOICE` chain.

## Greeting

- Fires on **session creation only** (`SessionManager.create`,
  `broker/src/sessions.ts:64`) — activation of an existing session replays
  the transcript silently, no greeting spam.
- Mechanism: after create + activate, the broker injects a system note
  directing a brief roster-aware greeting from the identity ("Ignacio and
  Wilkin are free; gamma is still on the refactor"). Reuses the
  `injectNote` path — no new speech pathway. The existing
  no-WS-client synthesis guard applies, so idle session creation burns no
  ElevenLabs credit.
- Scope: tauri sessions only for v1. Anderson's lines reaching Discord
  through the normal adapter delivery is fine (he is a speaker like any
  other); a Discord-side greeting trigger is a follow-up.

## Roster frame + control-plane

- The roster frame gains a top-level `identity: { name, role }` field —
  Anderson is never an entry in `roster.agents` (`toRosterEntries`,
  `main.ts:342`), so he can never be delegated to, squadded, or removed.
- `control-plane`: an identity tile renders **outside** the agent grid
  (header/rail slot, reusing `AgentAvatar`) to visually reinforce
  host-not-crew. Listening ring lights when he is addressed, same
  `listening` mechanics as crew tiles. No jiggle-mode participation.

## Testing

- `brain.test.ts`: Anderson-prefixed lines are legal; meta question →
  Anderson answers without tools; work request → `delegate`, not an
  Anderson answer; `draft_agent` → pitch → `confirm_agent(true)` persists /
  `(false)` discards; a second draft replaces the pending one.
- `addressing.test.ts` consumers: "hey anderson" resolves via
  `addressableNames`.
- `main`/voice: identity name resolves to `identity.voice.voiceId` ahead of
  `SQUAD_VOICES`.
- Sessions: create fires exactly one greeting note; activate fires none.
- Roster frame: `identity` field present; `agents` never contains the
  identity.
- Control-plane: identity tile renders from the roster frame's `identity`
  field; absent field (older broker) renders nothing.
