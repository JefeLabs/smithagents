# Product Requirements: `smithagents`

> **Status:** Source of truth for the shipped TypeScript stack. Rewritten
> 2026-07-26, superseding the 2026-07-18 JVM-era PRD (that iteration —
> Spring Boot/Embabel/JDA — was deleted from the tree; see git history).
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

## 5. Shipped & Verified (as of 2026-07-26)

End-to-end, against live services: text loop with per-persona voices; squad
addressing rules; raise-hand round-trip; push-to-talk (real audio → Deepgram →
brain reply); ElevenLabs per-agent audio frames; iPhone-style roster editing
with persistence across restarts; workspaces routing a chat-initiated
delegation into a git worktree where a claude CLI produced a committed file;
sessions with transcript replay and per-session brain memory; busy-lock +
activity/steer/cancel paths. Test suites: broker 56, swarm 9, all green.

## 6. Roadmap / Open Items

### 6.1 Infrastructure gaps (from the Orca comparison, 2026-07-27)

Benchmarked against [Orca](https://www.onorca.dev/docs), an ADE for running
coding agents in parallel worktrees. It drives agents the same way we do —
long-lived CLIs in terminals, addressed by handle — so the differences are
instructive rather than cosmetic. Ours is a *council*; theirs is a *workbench*.
The items below are where their engineering is ahead and the gap is real.

* **Session reconciliation on boot (highest leverage).** tmux keeps agent
  processes alive across a swarm crash or restart — but the task registry and
  the warm-session manager are both in-memory, so the orchestrator forgets
  sessions that are still running. We pay tmux's costs and bank only half its
  benefit. Fix: session names already encode the id (`task-<uuid>`,
  `smith-warm-<uuid>`), so on boot `listByPrefix` and re-adopt live sessions,
  the same self-healing pattern the roster and sessions already use. This
  turns "agents survive a crash" from a fact about processes into a fact about
  the product.
* **Tool-driver breadth.** One working driver (claude) versus their five-plus
  with account hot-swapping. This is also the *product* stake, not just parity:
  a Gemini skeptic arguing with a Claude architect is a different product, not
  a demo. Next: opencode, then agy characterization (h3).
* **Turn completion — keep our approach, borrow their ergonomics.** They wait
  for `tui-idle` (screen state), which is tool-agnostic but misfires on
  spinners and long tool calls; we read the tool's persisted transcript, which
  is precise but needs a driver per tool. Keep session-file detection; adopt
  their documented *read-before-send* practice (we currently send blind).
* **Persistent server mode.** They run a server clients attach to, so sessions
  restore across laptop/web/mobile. Our equivalent is broker + swarm as a
  reachable runtime rather than a pair of local processes.
* **Per-workspace environment recipes.** Their `orca.yaml` spins an ephemeral
  sandbox (Fly/Modal/Vercel/Docker) per worktree. Ours would extend the
  workspace file with an environment block — a natural fit for the already
  scoped `swarm/.smith/workspaces/*.json`.
* **`--json` everywhere on the swarm CLI**, so automation does not scrape.
* **Windows is out of reach while tmux is the substrate** (Unix-only). The
  Tauri UI is cross-platform; the runtime is not. Accepted for now — revisit
  only if Windows users appear.
* **Mobile companion.** The iOS target exists; a read-mostly view (agent
  status, recent output, call-on/cancel) is the pragmatic first version.

**Deliberate non-goal:** do not build an in-app diff-review IDE. Our review
surface is the draft PR — a team-shaped output — and competing on the
individual developer's editor loop plays to someone else's strength.

### 6.2 Product gaps

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
* **iOS:** the Tauri iOS target builds from this codebase but needs Xcode.app
  on the build machine; mic permission plist is in place.
* **UI polish:** composition errors are silent in the UI (broker returns
  reasons; surface them); the composer's "Swarm ▾" route selector is
  decorative; brain-history persistence skips system-note turns until the
  next user turn.
* **Discord:** deliberately out — it lived in the deleted JVM gateway. If it
  returns, it enters the broker as another text/voice channel, not a service.
  (`DISCORD_TOKEN`/`GUILD_ID` in `.env` are vestigial and can be removed.)
* **Hosted/multi-tenant tier:** Docker/microVM isolation for unattended runs,
  BYO-compute pricing posture — direction unchanged, not scheduled.
