# Discord Voice Adapter — Design

**Date:** 2026-07-29
**Status:** Approved (Edwin, 2026-07-29)
**Scope:** The crew joins Discord voice channels as real members — bot-per-agent presence, per-agent ElevenLabs voices, always-on meeting semantics — implemented as a sibling of the LiveKit bridge behind the broker's existing `BridgeLike` seam.

## Goal

Walking into an allowlisted Discord voice channel summons the council: each
designated agent appears in the member list under its own name and avatar,
speaks with its own voice (Discord's speaking indicator lighting under the
right member), and hears every human through per-user STT. Leaving the
channel dismisses them.

## Settled decisions

- **Join trigger:** auto-join. The ear bot watches allowlisted VCs; a human
  joining brings the crew in; the last human leaving empties it. No
  commands.
- **Listening model:** always-on meeting semantics — presence IS the
  meeting; VC audio flows through the same serialized turn queue as
  meetings today. No wake words.
- **Presence:** bot per agent (Edwin's pick over single-bot). Each
  voice-designated agent = its own Discord application + bot member.
  Degraded mode (agent lines through the ear bot) is the built-in rollout
  path, not a separate phase.
- **Architecture:** `DiscordVoiceBridge` implements the broker's existing
  `BridgeLike` seam (LiveKit's sibling) — NOT the text `ChannelAdapter`
  port, which moves text lines, not audio.

## 1. Presence & lifecycle

- The **ear** = the existing `DISCORD_TOKEN` bot, gaining the
  `GuildVoiceStates` intent. It watches the VCs in `DISCORD_VOICE_CHANNELS`
  (comma-separated ids; the legacy `VOICE_CHANNEL_IDS` values migrate here,
  old name stays vestigial).
- Human joins an allowlisted VC → ear joins + every agent whose `channels`
  array contains `"discord-voice"` joins as its own member. Last human
  leaves → all leave immediately.
- Join/leave is a small presence state machine driven by voice-state
  events; join failures retry on the next presence event.

## 2. Identity & tokens

- One-time manual setup per agent: create a Discord application + bot,
  name/avatar it as the agent, invite with Connect + Speak.
- Tokens are secrets; agent JSONs are public. Tokens live ONLY in env:
  `DISCORD_TOKEN_<AGENTID>` where `<AGENTID>` is the agent id uppercased
  with dashes mapped to underscores (`ignacio` → `DISCORD_TOKEN_IGNACIO`,
  `luz-maria` → `DISCORD_TOKEN_LUZ_MARIA`) — Secrets-Manager-shaped for
  the hosted phase. Nothing token-like ever enters
  `swarm/.smith/agents/*.json`.
- **Degradation = rollout:** a voice-designated agent with no token speaks
  through the ear bot (one readable log line, once). Day one works with
  zero agent tokens; each minted app upgrades one agent to real presence.

## 3. Audio out (the mouths)

- `DiscordVoiceBridge` implements `BridgeLike` with one contract
  extension: publish carries the **speaker's persona id**; the bridge
  multiplexes each line to that agent's voice connection (or the ear's,
  in degraded mode).
- The audio source is the existing `speak()` path — per-agent ElevenLabs
  PCM, already bounded by `TTS_TIMEOUT_MS` — transcoded to Opus for
  Discord. The existing speech chain serializes lines, so one agent talks
  at a time and Discord's native speaking indicator lights under the
  correct member.

## 4. Audio in (the ear)

- Discord provides per-user audio streams (better than LiveKit's mixed
  room). Each human speaker gets decode → downsample → its own Deepgram
  session via the existing STT machinery.
- Utterances arrive pre-attributed: `"<DisplayName> (via discord-voice):
  <text>"`.
- The ear filters ALL bot/webhook users — including the mouths — so the
  crew never hears itself. Client-side echo cancellation is Discord's
  problem, not ours.

## 5. Brain, etiquette & coexistence

- VC utterances enter the serialized turn queue as meeting-style turns
  with **no channel origin**: replies go out as voice through the bridge;
  the Tauri transcript records everything via the existing free path
  (`onSpeechText`); the Discord TEXT adapter stays inert during voice
  turns (the turn-scoped-origin invariant, already tested).
- Etiquette is unchanged brain behavior: the addressed agent answers,
  others hold or raise hands (✋ visible in the app roster).
- **Single active audio surface:** the VC session occupies the same
  active-bridge slot as LiveKit meetings. If one surface is live, the
  other's join/open is declined with a readable log line. First come
  wins.

## 6. Config, dependencies & the all-local invariant

- New broker dependencies: `@discordjs/voice` + an Opus codec + an
  encryption lib (prebuilt binaries on macOS/Linux). **Lazy-initialized:**
  with `DISCORD_VOICE_CHANNELS` unset, none of it loads and the product
  is byte-for-byte today's.
- Env contract: `DISCORD_VOICE_CHANNELS` (off when empty),
  `DISCORD_TOKEN_<AGENTID>` per mouth, existing `DISCORD_TOKEN` doubles
  as the ear.

## 7. Failure modes (all fail-closed, all readable)

- Invalid/missing agent token → one log line, degrade that agent to ear
  playback.
- Native deps missing/unbuildable → voice disabled at boot, one sentence.
- VC join failure → retry on next presence event.
- A speaker's STT session dies → that speaker's audio drops, others
  unaffected.
- TTS hang → bounded by `TTS_TIMEOUT_MS`; one chunk lost, queue moves on.

## 8. Out of scope

Wake words; meeting recording/minutes; video/screenshare; Slack; in-app
meeting UX; LiveKit guest links; per-agent bots for TEXT (webhooks already
provide identity there); automated Discord application provisioning.

## 9. Verification

- **Unit (injected fake gateway/connection surfaces, the
  `DiscordClientLike` pattern):** persona-routing in the multiplexer incl.
  degraded fallback; the presence state machine (join on first human,
  leave on last, retry-on-failure); bot-user filtering on receive;
  active-bridge mutual exclusion with meetings.
- **Live checklist:** join an allowlisted VC → crew appears as members →
  address Ignacio → his indicator lights while his voice answers → Wilkin
  holds per etiquette → the exchange lands in the Tauri transcript → leave
  → the channel empties. Repeat with one agent's token removed → that
  agent speaks through the ear bot.
- Existing suites stay green with voice unconfigured (the invariant).
