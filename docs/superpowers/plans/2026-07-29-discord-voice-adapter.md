# Discord Voice Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The crew joins allowlisted Discord voice channels as real members — bot-per-agent presence, per-agent ElevenLabs voices routed to the right member, per-user STT in — with graceful ear-bot degradation for agents without tokens.

**Architecture:** A `DiscordVoiceSurface` (ear bot receive + one mouth connection per tokened agent) sits behind the broker's existing bridge seam via a new external-surface slot that shares mutual exclusion with LiveKit meetings. `publishPcm` gains a persona id so the surface routes each line to the speaking agent's connection. A pure presence state machine drives join/leave from voice-state events. Spec: `docs/superpowers/specs/2026-07-29-discord-voice-adapter-design.md`.

**Tech Stack:** TypeScript, node:test via `node --import tsx --test`, `@discordjs/voice` + `@discordjs/opus` + `sodium-native` + `prism-media` (broker only, lazy-loaded), system `ffmpeg` (checked at boot, required only when voice is enabled).

## Global Constraints

- Broker + docs only. No swarm/control-plane changes.
- **All-local invariant:** with `DISCORD_VOICE_CHANNELS` unset, none of the new modules load (dynamic `import()` behind the env gate) and every existing test stays green unmodified.
- Tokens NEVER enter `swarm/.smith/agents/*.json`. Env only: `DISCORD_TOKEN_<AGENTID>` (uppercase, dashes→underscores).
- Voice designation: agent `channels` contains `"discord-voice"`.
- Every log/error line is a readable operator sentence.
- The real `@discordjs/voice` API may differ in detail from the plan's `realGateway()` sketches — adapt the real-implementation internals, but the `*Like` interfaces are the tested contract: if TypeScript flags a fake/interface mismatch, fix the interface, never widen a fake with `as`.
- Tests: `cd broker && node --import tsx --test src/<file>.test.ts`; full `npm test`; `npm run typecheck`. Baseline 103 tests must remain green.
- Commit after every task, conventional messages, each ending with:
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

---

### Task 1: Broker — persona-tagged publish + external voice-surface slot

**Files:**
- Modify: `broker/src/broker.ts` (BridgeLike, enqueueSpeech publish site ~line 724, active-slot management ~lines 252-338), `broker/src/room.ts` (signature only)
- Test: `broker/src/broker.test.ts` (extend, existing fake patterns)

**Interfaces:**
- Consumes: existing `BridgeLike`, `this.active` slot, `pollOnce`/`leaveMeeting`.
- Produces (Tasks 3-5 depend on):

```ts
// BridgeLike gains an optional persona tag (LiveKit impl ignores it):
publishPcm(bytes: Uint8Array, sampleRate: number, personaId?: string): Promise<void>;

// New on SmithBroker:
/** Attach an already-connected external audio surface (e.g. Discord VC).
 *  Declines (returns false, one readable log line) when a meeting bridge
 *  is active. While attached, meeting polling declines to join. */
attachVoiceSurface(surface: { publishPcm: BridgeLike['publishPcm'] }): boolean;
detachVoiceSurface(): void;
voiceSurfaceAttached(): boolean;
```

- [ ] **Step 1: Write the failing tests** (extend `broker.test.ts` with its existing fakes)

```ts
test('speech publishes with the speaking agent\'s persona id', async () => {
  // origined or meeting turn with an active bridge; fake brain emits
  // 'Ignacio: dime' then an unprefixed continuation chunk.
  // Assert both publishPcm calls received personaId 'ignacio'
  // (sticky-speaker), and a narrator line publishes personaId undefined.
});

test('attachVoiceSurface declines while a meeting is active, and vice versa', async () => {
  // 1. join a meeting (existing fake flow) -> attachVoiceSurface() === false
  // 2. fresh broker: attachVoiceSurface() === true -> pollOnce with an open
  //    meeting -> no bridge.connect (meeting join declined, readable log)
  // 3. detachVoiceSurface() -> next pollOnce joins normally.
});

test('while a voice surface is attached, speech publishes to it', async () => {
  // no meeting; attach a fake surface capturing (bytes, rate, personaId);
  // run a turn -> surface received the chunks with the right persona.
});
```

Write them as real tests against the file's existing fake broker construction (`makeBroker`-style helpers already exist — follow them; the exact assertion plumbing is the implementer's to build faithfully).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

In `broker.ts`:
- Widen `BridgeLike.publishPcm` with `personaId?: string`; update `room.ts`'s implementation signature to accept-and-ignore it (one-line change).
- Speaker tracking for publish: in `enqueueSpeech(text)` (before scheduling `run()`), resolve the speaker with the file's existing `SPEAKER_RE`-style parse (the `^([A-Z][\w-]{1,24}):\s` pattern used for hand-lowering) + `this.deps.directory.resolve(name)?.id`, with a module-level sticky `currentSpeechPersonaId` that a prefixed line sets and an unprefixed line reuses (reset to `undefined` in the turn runner's `onTurnStart` handling — same lifecycle as the hub's sticky). Pass it into the queued `run()`'s `publishPcm(bytes, TTS_SAMPLE_RATE, personaId)` call — captured at enqueue time, not read at publish time (the chain lags the queue; capture-at-enqueue keeps attribution correct).
- External surface slot: private `externalSurface: { publishPcm: ... } | null`. `attachVoiceSurface` returns false with a readable log when `this.active` exists; `pollOnce`'s join branch (~line 253) additionally requires `!this.externalSurface` (log once per skipped meeting: `"[meetings] declined — a Discord voice session is live"`). The publish site uses `this.active?.bridge ?? this.externalSurface` (speech flows to whichever audio surface is live; when neither, the existing early-return stands).

- [ ] **Step 4: Full suite + typecheck green (103 baseline + new).**

- [ ] **Step 5: Commit** — `feat(broker): persona-tagged publish and an external voice-surface slot`

---

### Task 2: Presence state machine (pure)

**Files:**
- Create: `broker/src/voice-presence.ts`
- Test: `broker/src/voice-presence.test.ts`

**Interfaces (Task 3 consumes):**

```ts
export type PresenceEvent =
  | { type: 'human-joined'; channelId: string }
  | { type: 'human-left'; channelId: string }
  | { type: 'join-failed'; channelId: string };
export type PresenceAction =
  | { type: 'join-crew'; channelId: string }
  | { type: 'leave-crew'; channelId: string }
  | { type: 'none' };

/** Pure: allowlist + per-channel human count + joined flag -> action.
 *  Exactly one channel can host the crew at a time (first come wins). */
export class VoicePresence {
  constructor(allowlist: string[]) {}
  handle(e: PresenceEvent, humanCountFor: (channelId: string) => number): PresenceAction;
  joinedChannel(): string | null;
  markJoined(channelId: string): void;
  markLeft(): void;
}
```

- [ ] **Step 1: Failing tests** — full table: non-allowlisted channel → none; first human in allowlisted channel → join-crew; second human while joined → none; humans drop to zero → leave-crew; human joins a SECOND allowlisted channel while crew is in the first → none (single-room rule); join-failed → state stays unjoined so the next human-joined retries; events for the joined channel after markLeft behave as fresh.

- [ ] **Step 2: Verify failure. Step 3: Implement** (small pure class per the interface; module header explains the single-room rule and that Discord's voice-state events drive it). **Step 4: Green + typecheck. Step 5: Commit** — `feat(broker): pure presence state machine for voice-channel auto-join`

---

### Task 3: Voice surface — mouths, persona routing, degradation

**Files:**
- Create: `broker/src/discord-voice.ts`, `broker/src/discord-audio.ts`
- Test: `broker/src/discord-voice.test.ts`
- Modify: `broker/package.json` (deps: `@discordjs/voice`, `@discordjs/opus`, `sodium-native`, `prism-media`)

**Interfaces:**
- Consumes: Task 1's `attachVoiceSurface` shape, Task 2's `VoicePresence`.
- Produces (Task 5 wires):

```ts
export interface VoiceConnectionLike {
  playPcm(pcm44kMono: AsyncIterable<Uint8Array>): Promise<void>; // resolves when the utterance finishes
  destroy(): void;
}
export interface VoiceGatewayLike {
  /** Join channelId with the identity behind `token`. */
  join(channelId: string, token: string): Promise<VoiceConnectionLike>;
}
export interface DiscordVoiceOptions {
  allowlist: string[];
  earToken: string;
  /** agentId -> bot token; agents absent here degrade to the ear connection. */
  agentTokens: Map<string, string>;
  agents: () => Array<{ id: string; channels?: string[] }>;
  gateway?: VoiceGatewayLike; // test seam; default realGateway()
  log?: (line: string) => void;
}
export function createDiscordVoiceSurface(opts: DiscordVoiceOptions): {
  /** publishPcm-compatible: routes by personaId; unknown/undefined persona or
   *  untokened agent -> ear connection. */
  publishPcm(bytes: Uint8Array, sampleRate: number, personaId?: string): Promise<void>;
  joinAll(channelId: string): Promise<void>;   // ear + every designated agent (tokened ones as themselves)
  leaveAll(): Promise<void>;
  connectedAgentIds(): string[];               // introspection for tests/logs
};
```

- [ ] **Step 1: Failing tests** (fake gateway records joins by token and captures per-connection playback): joinAll connects ear + one connection per `"discord-voice"`-designated agent WITH a token, exactly once each; publish with `personaId: 'ignacio'` plays on Ignacio's connection; publish for a designated-but-untokened agent plays on the ear connection with ONE readable degradation log (not per-chunk spam); publish with unknown/undefined persona → ear; leaveAll destroys everything; a second joinAll after leaveAll works fresh.

- [ ] **Step 2: Verify failure. Step 3: Implement.** `discord-voice.ts` per the interface — buffering note: `publishPcm` receives chunked bytes for one utterance; aggregate per-utterance streaming through `playPcm` (an async queue per connection so one utterance finishes before the next starts on the same mouth — the broker's speech chain already serializes globally, so this is per-connection hygiene, not scheduling). `discord-audio.ts` holds the real transcode: 44.1k mono s16le → ffmpeg (via `prism-media`) → Opus for `@discordjs/voice`'s `createAudioResource`; `realGateway()` adapts `joinVoiceChannel`/`AudioPlayer` — adapt internals to the real API freely, keep `VoiceGatewayLike` as written.

- [ ] **Step 4: Green (fake-gateway tests network-free) + typecheck + baseline intact. Step 5: Commit** — `feat(broker): Discord voice surface — per-agent mouths with ear degradation`

---

### Task 4: The ear — receive, per-user STT, turns

**Files:**
- Modify: `broker/src/discord-voice.ts` (+ its test)

**Interfaces:**
- Consumes: existing `DeepgramSttStream` (`stt.ts`, factory-injected `LiveLike`), broker `handleUtterance`.
- Produces: `DiscordVoiceOptions` gains:

```ts
  /** Per-user receive: called with a decoded mono PCM stream per human speaker. */
  onUtterance: (text: string) => void;           // pre-formatted, submitted as a turn
  makeStt: (sampleRate: number) => SttLike;      // mirrors main.ts's Deepgram factory, rate-parameterized
  receiver?: VoiceReceiverLike;                   // test seam on the ear connection
```

with `VoiceReceiverLike { onSpeakingStart(cb: (userId: string, displayName: string, isBot: boolean, pcm48kMono: AsyncIterable<Uint8Array>) => void): void }`.

- [ ] **Step 1: Failing tests:** a human stream feeds a fake SttLike whose utterance callback fires → `onUtterance` receives `"Edwin (via discord-voice): que lo que"`; bot/webhook users (incl. the mouths' own ids) never create STT sessions; two humans get two independent STT sessions; a session error kills only that speaker's session (readable log), others unaffected; leaveAll stops all sessions.

- [ ] **Step 2: Verify failure. Step 3: Implement:** per-user session map keyed by userId (create on first speaking-start, reuse after); attribution format exactly `"<displayName> (via discord-voice): <text>"`; real receiver adaptation decodes Opus (48k stereo → mono mixdown) in `discord-audio.ts` and hands the ear's `VoiceReceiverLike` the mono stream; Deepgram session rate = 48000 via the parameterized factory.

- [ ] **Step 4: Green + typecheck. Step 5: Commit** — `feat(broker): the ear — per-user STT with pre-attributed voice turns`

---

### Task 5: Wiring, env, boot gating

**Files:**
- Modify: `broker/src/main.ts`, `.env.example`

- [ ] **Step 1: Env + gate.** In `main.ts`: parse `DISCORD_VOICE_CHANNELS` (comma ids). When empty/unset → nothing else happens (no imports). When set: dynamic `await import('./discord-voice.ts')` inside the gate; build the token map by scanning `process.env` for `DISCORD_TOKEN_<X>` and mapping `X.toLowerCase().replaceAll('_','-')` → agent id (skip the bare `DISCORD_TOKEN` = ear); readable boot lines: which agents have mouths, which degrade. Check `ffmpeg` availability (`spawnSync('ffmpeg', ['-version'])`) — missing → one sentence, voice disabled, boot continues.
- [ ] **Step 2: Presence wiring.** The ear's discord.js client (reuse the text adapter's client if the text adapter is enabled, else construct one) gains `GuildVoiceStates`; `voiceStateUpdate` events → `VoicePresence.handle` (human = `!member.user.bot`) → `join-crew` → `surface.joinAll(ch)` + `broker.attachVoiceSurface(surface)` (declined → log + skip join, retry on next event); `leave-crew` → `surface.leaveAll()` + `broker.detachVoiceSurface()`. `onUtterance` → `handleUserText(text)` (no origin — voice turns are meeting-shaped; text adapters stay inert; Tauri transcript gets it via the existing paths). `makeStt` mirrors main.ts's existing Deepgram factory with the rate parameter.
- [ ] **Step 3: `.env.example`:** `DISCORD_VOICE_CHANNELS=` (comment: VC ids the crew auto-joins; empty = voice off) and a commented example `# DISCORD_TOKEN_IGNACIO=` (comment: per-agent bot token; missing = that agent speaks through the ear bot).
- [ ] **Step 4: Verification.** `npm run typecheck`; full `npm test` (all baseline + Tasks 1-4 additions green). Boot smokes on `BROKER_TEXT_PORT=7791` with PID-scoped kills ONLY (never unscoped pkill; live stack on 7790/7777 untouched): (a) no `DISCORD_VOICE_CHANNELS` → boot log has no voice lines, module never imported (verify via a log grep); (b) `DISCORD_VOICE_CHANNELS=x` with no ffmpeg on PATH (PATH-stripped env) → the readable disable sentence; (c) `DISCORD_VOICE_CHANNELS=x` + ffmpeg → boot names the ear and the degraded agents.
- [ ] **Step 5: Commit** — `feat(broker): voice wiring — auto-join presence, token map, lazy boot gate`

---

### Task 6: Docs, runbook, live checklist

**Files:**
- Modify: `PRD.md`, `README.md`, `docs/FEATURES.md`, `docs/MANUAL-TESTING.md`

- [ ] **Step 1: PRD** — §5 dated line (Discord voice: bot-per-agent presence, ear STT, degradation, single-active-audio-surface); §6.2's voice-channel open item updated (shipped; remaining open: Slack, recording/minutes, in-app meeting UX).
- [ ] **Step 2: README** — Configure section gains the two new env shapes; architecture bullet mentions the voice surface beside the LiveKit bridge.
- [ ] **Step 3: FEATURES.md** — new row under Channels ("Discord voice presence") linking to a new MANUAL-TESTING section; MANUAL-TESTING gains `## Discord voice` with: per-agent app setup runbook (create app → bot → name/avatar as agent → invite with Connect+Speak → `DISCORD_TOKEN_<AGENTID>` in `.env`), the auto-join walkthrough (join VC → crew appears → address Ignacio → HIS member indicator lights with his voice → Wilkin holds → leave → channel empties), the degradation check (remove one token → that agent speaks through the ear), and the mutual-exclusion check (open a LiveKit meeting first → VC join declined with the log line).
- [ ] **Step 4: Gates** — broker suite + typecheck; `git status` clean besides intended files. Live voice verification requires Discord apps + a real VC: hand the runbook to Edwin, state plainly in the report that the live pass is the operator's.
- [ ] **Step 5: Commit** — `docs: Discord voice — the council as real VC members`
