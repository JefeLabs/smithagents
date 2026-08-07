# smithagents — Feature Catalog

Every shipped feature, grouped by area. Each entry links to its hands-on
verification procedure in [MANUAL-TESTING.md](./MANUAL-TESTING.md).
Product concepts and history live in [PRD.md](../PRD.md).

## Conversation & voice

| Feature | What it does | Manual test |
|---|---|---|
| Text meeting loop | Type at the crew; the brain voices every agent per meeting etiquette (speaker-prefixed lines, only the addressed party answers) | [→ test](./MANUAL-TESTING.md#text-meeting-loop) |
| Per-agent ElevenLabs voices | Each agent speaks with their own voice; serialized playback with 850ms speaker-change gaps; premade stand-ins on plan-gated voices | [→ test](./MANUAL-TESTING.md#per-agent-voices) |
| Push-to-talk | Hold the mic; audio streams to Deepgram, transcript lands in the meeting, the crew answers | [→ test](./MANUAL-TESTING.md#push-to-talk) |
| Raise-hand etiquette | Non-addressed agents with something to add raise a ✋; clicking gives them the floor; speaking lowers the hand | [→ test](./MANUAL-TESTING.md#raise-hand) |
| Crew memory | Scoped facts remembered on request, recalled across sessions and conversations | [→ test](./MANUAL-TESTING.md#crew-memory) |
| Broker host identity (Anderson) | Data-driven host persona (`broker/.smith/identity.json`): addressable by name, greets new sessions roster-aware, owns meta/status answers and system announcements, defers to specialists; own ElevenLabs voice and a tile above — never inside — the crew grid; structurally un-delegable | [→ test](./MANUAL-TESTING.md#host-identity-anderson) |
| Blocked-audio recovery | When the webview's autoplay policy suspends audio, replies hold instead of being lost; a pill says so and any click/keypress resumes playback in order | [→ test](./MANUAL-TESTING.md#blocked-audio-recovery) |

## Roster & composition

| Feature | What it does | Manual test |
|---|---|---|
| iPhone-style edit mode | 3s long-press → jiggle; drag to reorder; drag agent onto agent/squad to form/join squads; drag member out to free | [→ test](./MANUAL-TESTING.md#roster-edit-mode) |
| Avatar states | Listening pulse when addressed, glowing ring while working, group badge on squads, ✋ badge on raised hands | [→ test](./MANUAL-TESTING.md#avatar-states) |
| Agent creation wizard | Stereotype, job role, engine/model, voice catalog, reactions, quick answers, one-call AI persona generation | [→ test](./MANUAL-TESTING.md#agent-creation) |
| Voice-driven agent creation | "Anderson, create an architect agent" → full persona draft pitched aloud; persists only on your explicit yes (confirm-first); fallback voice until cast in the wizard | [→ test](./MANUAL-TESTING.md#voice-agent-creation) |
| Agent editing | Reopen any agent in the wizard from edit mode; busy agents locked (UI + server) | [→ test](./MANUAL-TESTING.md#agent-editing) |
| Agent removal (archive vs delete) | One remove intent; the broker decides from evidence — never used → deleted, any history → archived in place; outcome stated before you confirm | [→ test](./MANUAL-TESTING.md#agent-removal) |

## Sessions & workspaces

| Feature | What it does | Manual test |
|---|---|---|
| Workspace-scoped sessions | Persistent conversations with own transcript + brain memory; switching swaps both; transcript replays on reload | [→ test](./MANUAL-TESTING.md#sessions) |
| Workspace management | Create/edit/remove workspaces and repos from the sessions panel; git-path validation; exactly-one-default invariant; archive-vs-delete evidence rule | [→ test](./MANUAL-TESTING.md#workspace-management) |
| Session workspace filter | Chip row filters the session list by workspace (appears with 2+ workspaces) | [→ test](./MANUAL-TESTING.md#workspace-filter) |

## Delegation & execution

| Feature | What it does | Manual test |
|---|---|---|
| Real delegated work | Ask for work → git worktree cut from the workspace repo (`smith/<taskId>`) → real coding CLI pinned to tmux → commit → push → draft PR | [→ test](./MANUAL-TESTING.md#delegation) |
| Supervise mid-run | Click a glowing agent for live terminal output; steer with follow-up prompts; cancel | [→ test](./MANUAL-TESTING.md#supervision) |
| Warm agent sessions | Long-lived conversational CLI sessions that survive server restarts (reconciled on boot; orphans reported, never killed) | [→ test](./MANUAL-TESTING.md#warm-sessions) |
| Per-agent engine/model | Each agent's `engine.cli` + `engine.model` fully determine the process it runs in (claude, codex, opencode, copilot; agy steering-only) | [→ test](./MANUAL-TESTING.md#engine-model) |
| Archived agents un-delegable | Archived agents vanish from roster and delegation but keep resolving in history | [→ test](./MANUAL-TESTING.md#agent-removal) |

## Channels

| Feature | What it does | Manual test |
|---|---|---|
| Discord text adapter | The crew attends allowlisted channels, mention-gated (@everyone/roles ignored); each agent posts under its own name via webhook; turn-scoped origins guarantee replies only go to the channel that asked | [→ test](./MANUAL-TESTING.md#discord-adapter) |
| Discord voice presence | Allowlisted voice channels auto-join the crew as real members — bot-per-agent presence with per-agent ElevenLabs voices, ear STT with per-user attribution, ear-degradation rollout, single active-audio-surface shared with LiveKit meetings | [→ test](./MANUAL-TESTING.md#discord-voice) |
| Channel designation | `channels` map in each agent file decides which external surfaces an agent attends (`discord`, `discord-voice`); the tauri app is the management console and always shows every agent | [→ test](./MANUAL-TESTING.md#discord-adapter) |
| All-local invariant | Without `DISCORD_TOKEN`, nothing channel-related constructs — the local product is byte-for-byte unchanged | [→ test](./MANUAL-TESTING.md#all-local-invariant) |

## Meetings (LiveKit)

| Feature | What it does | Manual test |
|---|---|---|
| Voice meeting bridge | `POST /meetings` opens a LiveKit room; the broker joins, STTs room audio, speaks per-agent TTS back (in-app meeting UX not yet built) | [→ test](./MANUAL-TESTING.md#livekit-meeting) |
| TTS stall chaos test | Env-gated fault injection proving what a hung ElevenLabs call does to the turn queue (known follow-up: bounded TTS timeout) | [→ test](./MANUAL-TESTING.md#tts-stall-chaos) |

## Settings & platform

| Feature | What it does | Manual test |
|---|---|---|
| Tiered settings reset | Reset runtime / worktrees / agents in tiers from the settings panel | [→ test](./MANUAL-TESTING.md#settings-reset) |
| Theme switcher | Light/dark theme | [→ test](./MANUAL-TESTING.md#theme) |
| Web/desktop/iOS one codebase | Tauri desktop app; the same UI runs in a plain browser (vite :1420); iOS target builds | [→ test](./MANUAL-TESTING.md#platforms) |
| Settings: Agents section + API Keys | Grouped nav (App/Agents/Workspace) with CLI Tools and API Keys under Agents; provider cards (Anthropic, OpenAI, Google) with live verify that blocks only on confirmed negatives (a flaky network never marks a key bad); avatar generation runs agy-first with a verified Google key as a seconds-fast accelerator; the raw key is never exposed on 7790 | [→ test](./MANUAL-TESTING.md#api-keys--avatar-engines-2026-08-06) |

