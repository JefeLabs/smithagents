# Talk to your agents — LiveKit voice meetings

**Date:** 2026-07-25
**Status:** Design agreed in conversation; v1 scope below. Pending Edwin's spec review.
**Depends on / relates to:** the swarm orchestrator (`swarm/`), the control-plane Tauri app (`control-plane/`), the `voice/` VoiceProvider module, the `voice-engine/` MLX TTS, and the removal of the JVM `personas/` module (commit `ae691c7`).

## Goal

Let the operator **speak to their agents** from the Tauri app (desktop first, mobile
next), and from other surfaces (Discord, Teams) later — through live voice
"meetings" that only spin up real-time infrastructure when a conversation is
actually happening.

## The model (full picture — context for v1)

Five layers, core kept clean, edges pluggable:

```
Meeting Orchestrator   creates & runs meeting instances; drives presence↔meeting
        │
Meeting instance       { agents, target venue, mode(solo|squad|council), lifecycle }
        │  real-time media via
LiveKit room           meeting-mode-only media plane (participants + audio tracks)
        ▲  bridged into by
Connectors (edge)      Tauri app · Discord · MS Teams · Web   (adapter per surface)
        │
Agents (core)          composed agents: identity + directives + engine(CLI+model) + voice
        │
Swarm                  agent registry + dispatch + squads
```

### Core concepts

- **Composed agent** — the atomic unit of identity, owned by the swarm as data
  (`swarm/.smith/agents/*.json`): `{ id, name, role, directives, engine:{cli,model},
  voice, avatarRing, channels }`. Replaces the swarm's hardcoded `names.ts` pool and
  `squads.ts` rosters. Manuel/Octavio/Aurelio become seed composed-agents (their
  definitions are recoverable from git history, pre-`ae691c7`).
- **Connector** — an adapter bridging one external surface to the agents (Discord,
  MS Teams, the Tauri app, Web). Mirrors the repo's existing pluggable `Sandbox`
  pattern: one contract, many backends. "Channels" in the compose UI = which
  connectors an agent is exposed on.
- **Presence** — an agent is attached to a channel and *ambiently available*.
  Cheap. The only thing running is the **gate model** (below), listening for a wake
  command. No LiveKit, no capable models.
- **Meeting mode** — an activated, bounded live session. Mic engaged, a **LiveKit
  room** is live, agents are convened, and the full STT → LLM → TTS pipeline runs.
- **Gate model** — a *lesser* (cheap, fast, always-on) model that is the presence-tier
  listener. It does two jobs: (1) **activation** — detect a wake command; (2)
  **routing** — resolve which agent(s) to convene. This is the reborn
  `PersonaRouter.route()` decision, now a small model instead of a stub.
- **Meeting orchestrator** — a module inside the swarm. On activation it creates the
  LiveKit room, seats the resolved agents + the human, runs the meeting, and tears it
  down. Reuses the agent registry and connectors — no new service.
- **LiveKit** — the real-time media plane, **self-hosted** on the Mac Studio host
  (local-first, audio stays on-box). A room exists only while a meeting is active.
  Each agent joins as a LiveKit participant via LiveKit's **Agents** framework
  (STT → LLM → TTS pipeline, turn detection). The app joins as the human participant
  via the LiveKit client SDK.

### Activation — wake commands

Presence-tier gate listens ambiently; a wake command activates a meeting and sets its
scope:

- **`hey <agent-name>`** — convene that single agent (name matched against the
  registry). → `solo` meeting.
- **`let's meet` / `let's talk`** (a small configurable set, e.g. also `hey team`) —
  convene **all** agents. → `council` meeting.

Deactivation: explicit ("done"/"thanks"), idle timeout, or mic off → tear down the
LiveKit room, back to presence.

### State machine

```
Presence  (gate model listening for a wake command; no LiveKit, no capable models)
   │  "hey <name>"  → solo scope        │  "let's talk"/"let's meet" → council scope
   ▼
Meeting mode  (mic live · LiveKit room · convened agent(s) · STT→LLM→TTS · MLX voice)
   │  "done" / idle timeout / mic off
   ▼
Presence
```

### Voice data-flow (inside a meeting)

```
app mic ──> LiveKit room ──> agent participant ──> STT ──> agent LLM (composed engine)
                                                                    │
your speakers <── LiveKit room <── MLX TTS (VoiceProvider) <────────┘
```

Response is also surfaced as **text** in the app, so the loop is usable before TTS is
polished.

## v1 scope — "the app meeting" (desktop)

The smallest complete vertical that makes "speak to my agents" real.

**In scope**
1. **Composed-agent registry (read + seed)** in the swarm: a `ComposedAgent` type and a
   JSON loader from `swarm/.smith/agents/*.json`; seed with Manuel/Octavio/Aurelio.
   `/agents` returns the registry.
2. **Meeting orchestrator (minimal)** in the swarm: open a meeting (create a LiveKit
   room, mint a join token, seat one agent + the human), track state, end it (tear the
   room down). `POST /meetings`, `DELETE /meetings/:id`, `/meetings` list.
3. **LiveKit self-hosted** locally; room-per-meeting; the swarm creates rooms and mints
   tokens (server SDK). Media plane runs only while a meeting is open.
4. **Agent participant** via LiveKit Agents: the convened agent joins the room; STT on
   the inbound track → its `engine` model → **TTS via the `voice/` VoiceProvider**
   (`LocalVoiceProvider` = MLX voice-engine) published back. Text transcript emitted too.
5. **Tauri desktop app**: the mic-hero toggles meeting mode; the app joins the LiveKit
   room as the human participant (publishes mic, subscribes to agent audio) **through
   the Rust layer** (LiveKit token fetch + connection in Rust, per the transport
   decision — keeps tokens/secrets out of JS and is the mobile-ready path). Two UI
   states: **standby** (presence) vs **active meeting** ("Listening…"). Transcript +
   agent reply shown in the composer area.
6. **Activation**: wake commands via the gate model — `hey <name>` (solo) and
   `let's talk`/`let's meet` (council). *Build note:* to de-risk, the very first
   milestone proves the LiveKit + agent loop with an explicit "start meeting" tap, then
   the gate model is wired in as the next step within v1.

**Explicitly out of v1** (documented future layers, each with a clear home):
- Mobile (iOS) app meeting — same LiveKit SDK + mic permissions; immediately after v1.
- Discord / MS Teams connectors — bridging external venues into the room.
- Council (multi-agent) meetings running concurrently — v1 proves solo; `let's talk`
  convene-all can be v1.1.
- Compose-agent **write** path (the Add-agent modal persisting new agents) — v1 seeds
  read-only; wiring "Create agent" to the registry is v1.1.
- Voice cloning / paralinguistics niceties — v1 = straightforward TTS via the provider.
- mTLS / ngrok remote access — v1 is local (host + app on the same machine/LAN).

## Decisions made (flag any to revisit in review)

- **LiveKit self-hosted** on the Mac Studio host (not LiveKit Cloud) — local-first.
- **Gate model runs locally** (Ollama / small local model / MLX) — always-on, cheap,
  private.
- **Transport through the Tauri Rust layer** — required for mobile mic/permissions and
  to keep the LiveKit token out of JS.
- **Explicit activation first, wake-command gate second** — within v1, as a de-risking
  build order, not a scope cut.
- **Registry format**: `swarm/.smith/agents/*.json`, one file per agent.

## Open questions

- STT choice for v1: local (whisper.cpp / a local model) vs a cheap cloud STT
  (Deepgram/…). Lean local for on-box privacy; confirm at build time.
- Exact self-hosted LiveKit deployment (docker on the host) and how the swarm reaches
  it (localhost) — settle when we pull current LiveKit docs.
- Wake-command robustness (false triggers) — acceptable for v1 local/desktop; revisit
  before always-on mobile.

## Verification

- Registry: unit test that the loader parses seed `*.json` into `ComposedAgent`s; `/agents` returns them.
- Meeting lifecycle: `POST /meetings` creates a LiveKit room + token; `DELETE` tears it down; smoke test with the LiveKit server running locally.
- End-to-end (manual, desktop): say `hey Manuel` (or tap start) → the app joins the room, you speak, Manuel replies (text first, then spoken via MLX) → "done" ends the meeting and the room is gone.
- No regressions: `swarm` `tsc --noEmit` clean; `control-plane` `npm run build` + Biome clean; `mvn -o compile` still green.

## Sequencing (for the plan)

1. Composed-agent registry (type + loader + seed + `/agents`).
2. Self-hosted LiveKit up locally; swarm creates rooms + mints tokens; `POST/DELETE /meetings`.
3. Desktop app joins a room via Rust (prove media both ways with a manual start).
4. Agent participant: STT → model → MLX TTS in the room; text transcript.
5. Gate model: wake-command activation + routing (`hey <name>` / `let's talk`).
6. Presence/standby UI state; deactivation (done/idle/mic-off).
