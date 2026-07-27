# Product Requirements: `smithagents`

> **Status:** Source of truth for the shipped TypeScript stack.
> Amend this file — do not fork it into side docs.

## 1. Product Overview

**The pitch:** not one Jarvis — a *council*. A cast of specialist AI agents with
persistent personas who meet with you like a team: they debate with meeting
etiquette, defer to each other's domains, raise hands instead of interrupting,
and take on real coding work you can watch, steer, and cancel. The crew has an
identity: a Latino team out of the Dominican Republic, each member with their
own voice (literally — per-agent TTS) and communication style.

**Local-first:** everything runs on the operator's machine. The only external
calls are model APIs (Anthropic for the brain, Deepgram for STT, ElevenLabs for
voices). Delegated work executes in git worktrees on the host.

## 2. Core Concepts

**Hierarchy (settled 2026-07-26): workspace → repos, workspace → sessions.**
No "project" layer — if one is ever needed it becomes an additive label on
sessions, never a restructure.

* **Workspace** — a named group of one or more local repos
  (`swarm/.smith/workspaces/*.json`). Delegations route to a workspace repo;
  the server resolves repo paths (client-sent paths are never trusted).
* **Session** — a persistent conversation inside a workspace
  (`broker/.smith/sessions/*.json`). Owns its transcript *and* the brain's
  memory; switching sessions swaps both. One active at a time.
* **Agent (persona)** — data, never code (`swarm/.smith/agents/*.json`):
  `directives` (the work prompt prepended to delegated tasks), `persona.style`
  (meeting character), `voice.voiceId` (ElevenLabs) + `voice.speech` (fallback
  profile). Registry agents are the only *delegable* units.
* **Squad** — a working unit rendered as one circle. Swarm squads
  (alpha/beta/gamma; 4 members with G/F/O/S initial-coded roles:
  leader/architect/senior/developer) are execution config; user-formed squads
  (delta, epsilon, …) are created in the UI by dragging agents together.
  An agent exists solo **or** in exactly one squad, never both.
* **Meeting etiquette** — enforced in the brain prompt: every spoken line is
  speaker-prefixed; only the addressed party answers; a squad speaks through
  its leader (even when asked to "introduce yourselves"); non-addressed agents
  with something to add use the `raise_hand` tool → ✋ badge in the roster;
  the human clicks to give them the floor; speaking lowers the hand.

## 3. Architecture (three services + a library)

* **`swarm/` — execution orchestrator (:7777).** Agents-as-data registry,
  squads, workspaces, meetings, WS events, `smith` CLI. A task = git worktree
  cut from the target workspace repo (branch `smith/<taskId>`) + a real coding
  CLI (`claude --dangerously-skip-permissions`) pinned to a tmux session,
  with steer (`send-keys`) and kill endpoints. `smith-delegate` is injected
  into each worktree so agents can sub-delegate through the API. Docker is the
  isolation upgrade path for unattended/multi-tenant runs.
* **`broker/` — conversation coordinator (:7790).** ONE Claude Haiku call per
  turn: streamed text is speech (chunked at sentence/newline boundaries for
  TTS), `tool_use` blocks are routing (`delegate`, `check_status`,
  `raise_hand`). Inputs: text channel (HTTP), push-to-talk (binary PCM over
  WS → per-client Deepgram sessions), stdin (dev), LiveKit rooms (meetings).
  Outputs: WS frames — transcript, live roster (presence, hands, squads),
  per-agent ElevenLabs mp3 audio (with premade stand-ins when the plan gates
  library voices), session snapshots. Roster composition and sessions persist
  under `broker/.smith/`. Busy agents are locked from roster edits; their
  tasks are inspectable/steerable/cancellable.
* **`control-plane/` — Tauri 2 app (desktop + iOS, one codebase).** The
  meeting stage: transcript with speaker labels, composer, push-to-talk mic,
  sound toggle with serialized playback and turn-taking gaps (850ms on speaker
  change). Roster rail: iPhone-style edit mode (3s long-press → jiggle;
  drag to reorder; drag agent onto agent/squad to form/join; tap squad to
  expand members; drag member out to free them), group badge on multi-member
  circles, glowing ring on working units, click-to-open work view (live
  output, steering composer, cancel). Sessions panel on the left rail.
* **`voice/` — provider library.** `ElevenLabsVoiceProvider` (streaming TTS,
  BYO key), `LocalVoiceProvider` (spawn a local binary), and a router keyed by
  each persona's `voice.provider`.

## 4. Interaction Model

1. **Meet:** type or hold push-to-talk. The brain voices the crew per
   etiquette; replies stream as text and per-agent audio.
2. **Compose:** long-press the roster to arrange the org — form squads, add
   or free members. Composition is conversation-layer for swarm squads
   (execution rosters stay fixed config) and fully real for user squads.
   The brain always sees the current arrangement.
3. **Delegate:** ask for work. The brain picks the specialist (directives
   define domains: Manuel — architecture/routing; Octavio — security and
   integration boundaries; Aurelio — atomic-design UI), names the repo when
   it isn't the session default, and the swarm runs it for real.
4. **Supervise:** working agents glow; click to watch live terminal output,
   send steering mid-run, or cancel. Completion is announced in the meeting
   by the responsible agent.

## 5. Shipped & Verified (as of 2026-07-27)

End-to-end, against live services: text loop with per-persona voices; squad
addressing rules; raise-hand round-trip; push-to-talk (real audio → Deepgram →
brain reply); ElevenLabs per-agent audio frames; iPhone-style roster editing
with persistence across restarts; workspaces routing a chat-initiated
delegation into a git worktree where a claude CLI produced a committed file;
sessions with transcript replay and per-session brain memory; busy-lock +
activity/steer/cancel paths.

Added 2026-07-27: draft PRs opened for completed tasks; warm conversational
sessions with per-tool drivers (claude, codex, opencode, copilot; agy
steering-only) and profile materialization; the agent-creation wizard
(stereotype, job role, engine/model, voice catalog, reactions, cached quick
answers, AI-generated personas); tiered settings reset; theme switcher; and
crew memory — scoped facts recalled across conversations, verified by a fresh
session answering from a prior one.

## 6. Roadmap / Open Items

### 6.1 Infrastructure gaps (benchmarked against Orca, 2026-07-27)

Benchmarked against [Orca](https://www.onorca.dev/docs), an ADE for running
coding agents in parallel worktrees. It drives agents the way we do — long-lived
CLIs in terminals, addressed by handle — so the differences are instructive.
Ours is a *council*; theirs is a *workbench*.

**Next up (ordered by leverage):**

1. ~~**Honor `engine.cli` + `engine.model` at launch.**~~ **Done (2026-07-27).**
   Each driver now owns its model flag via `interactiveCommand(base, model)` /
   `taskCommand(base, prompt, model)`, so the process an agent is instantiated
   in is fully determined by its definition — for both warm tmux sessions and
   task runs. A blank or `default` model emits no flag rather than an invalid
   one. Wiring this up surfaced a second, larger bug: `POST /tasks` computed
   the composed agent's `profile` but never attached it to the manifest, so
   `driver.materialize` was a silent no-op and **every delegated task ran with
   no persona at all** — generic agents wearing a name. Both fields now flow
   through `enrichFromComposedAgent()`, covered by tests, and verified live
   (the persona file lands in the task worktree; `--model` appears in the real
   tmux command). Lesson worth keeping: unit tests passed while the feature was
   dead, because the bug was in the wiring, not the units.
2. ~~**Session reconciliation on boot.**~~ **Warm sessions done (2026-07-27).**
   Sessions now persist a durable record (`.smith/sessions/<id>.json`), and
   boot cross-checks those records against live tmux: survivors are adopted
   (handle still works — verified by sending a turn through a re-adopted
   session), records with no process are forgotten, and live `smith-warm-*`
   sessions with no record are *reported, never killed* — an unexplained live
   process is what a human should look at first. The policy is a pure function
   (`session-reconcile.ts`), so every branch is testable without a process.
   On its first real boot it surfaced 6 orphaned sessions that had been
   invisible. **Still open:** task sessions (`task-<uuid>`) are not yet
   reconciled — only warm sessions are. And the changed-profile branch is
   deliberately conservative (adopt and keep) pending a decision on whether a
   session whose agent file moved should be killed instead.
3. **Read-before-send in warm sessions.** We send blind; their CLI documents
   reading terminal state first. Cheap, and prevents typing into a TUI that is
   mid-prompt.
4. **Persistent server mode.** A runtime clients attach to, so sessions restore
   across laptop/web/mobile instead of living in two local processes.
5. **Per-workspace environment recipes.** Their `orca.yaml` spins an ephemeral
   sandbox per worktree; ours would be an environment block in the existing
   `swarm/.smith/workspaces/*.json`.
6. **`--json` everywhere on the swarm CLI**, so automation never scrapes.
7. **Mobile companion** — read-mostly first (status, recent output, call-on,
   cancel). The iOS target already builds.

**Closed:** tool-driver breadth — claude, codex, opencode and copilot all have
drivers; agy is steering-only *by evidence* (it keeps conversations
server-side, so turn completion cannot be observed honestly). Turn completion
stays session-file based rather than screen-idle.

**Accepted constraints:** Windows is out of reach while tmux is the substrate
(the UI is cross-platform; the runtime is not). Revisit only if Windows users
appear.

**Deliberate non-goal:** no in-app diff-review IDE. Our review surface is the
draft PR — a team-shaped output — and competing on the individual developer's
editor loop plays to someone else's strength.

### 6.2 Product gaps

* **Memory (shipped, with room):** scoped facts recall across conversations
  via a `MemoryPort` with a dependency-free lexical implementation. Open:
  memory is written only when the brain calls `remember` (no passive
  extraction); recall is lexical, so a similarity backend behind the same port
  is the upgrade path if the corpus outgrows it; agents in task worktrees
  cannot read it yet — injecting a memory CLI like `smith-delegate` is the
  obvious next step.
* **Voices:** upgrade the ElevenLabs plan so the picked Latin library voices
  replace premade stand-ins (automatic — the fallback only fires on the 402).
  The same plan gate blocks pre-caching of a new agent's reaction lines, and
  catalog browsing additionally needs the key's `voices_read` permission.
  Remaining uncast: Fabian, Osvaldo, Fernando, Orlando, Sebastian.
* **Voice meetings:** LiveKit path exists (room bridge, meeting polling,
  per-agent meeting TTS) but the in-app meeting UX (join/leave, who's
  speaking) is unbuilt.
* **Squad execution vs conversation:** user-formed squads and swarm-squad
  edits are conversation-layer only; making arbitrary squads *executable*
  requires generalizing swarm's fixed 4-pane squad dispatch.
* **PR flow:** shipped — completed tasks commit, push, and open a draft PR.
  Still open: worktree cleanup policy after merge, and surfacing the PR link
  in the work view (it currently rides the task result and the spoken note).
* **Agent creation (shipped, with room):** the wizard covers stereotype, job
  role, engine/model, voice, reactions and quick answers, with one-call AI
  generation. Open: no edit/delete surface for an existing agent (only create
  and archive-by-API), and generated personas are never previewed aloud before
  the voice cache is warmed.
* **iOS:** the Tauri iOS target builds from this codebase but needs Xcode.app
  on the build machine; mic permission plist is in place.
* **UI polish:** composition errors are silent in the UI (broker returns
  reasons; surface them); the composer's "Swarm ▾" route selector is
  decorative; brain-history persistence skips system-note turns until the
  next user turn.
* **Discord:** deliberately out. If it returns, it enters the broker as
  another text/voice channel, not a service. (`DISCORD_TOKEN`/`GUILD_ID` in
  `.env` are vestigial and can be removed.)
* **Hosted/multi-tenant tier:** Docker/microVM isolation for unattended runs,
  BYO-compute pricing posture — direction unchanged, not scheduled.
