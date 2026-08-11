/**
 * DiscordVoiceSurface — per-agent mouths for the crew's Discord voice
 * presence (design spec §3). Every `"discord-voice"`-designated agent WITH
 * a bot token gets its own `VoiceConnectionLike`; every other line — an
 * unknown or undefined persona id, or a designated agent with no token —
 * plays through the shared ear connection. Degradation is the built-in
 * rollout path (spec §2), not a separate phase: day one works with zero
 * agent tokens, and each minted Discord app upgrades one agent to a real
 * member with its own voice.
 *
 * `VoiceGatewayLike` is the test seam. Fake gateways record joins by token
 * and capture per-connection playback with no network involved; the real
 * adapter (`realGateway()`, below) and the Opus transcode (`discord-audio.ts`)
 * are exercised only by the live checklist (docs/MANUAL-TESTING.md), never
 * by this file's unit tests.
 *
 * Segmenting rule (fix round; supersedes the original one-segment-per-call
 * design — see task-3-report.md's fix-round sections for the full history).
 * The broker calls `publishPcm` once per TTS byte chunk, and a spoken line
 * is streamed as MANY chunks (`for await (const bytes of speak(text))
 * publishPcm(bytes, ...)` in broker.ts's `enqueueSpeech`). Driving each
 * chunk through its own `playPcm()` call means a fresh ffmpeg process +
 * Opus encoder + AudioResource per chunk in `realGateway()` — audible gaps
 * and process churn mid-sentence. Instead, each mouth (ear or an agent's
 * own connection) keeps at most ONE open playback segment: a push-fed
 * `AsyncIterable` handed to a single live `playPcm()` call. `publishPcm`
 * appends to the open segment and, while the segment's backlog stays under
 * the cap (see "Bounded backlog" below), resolves as soon as the bytes are
 * queued — it doesn't wait for those bytes to actually play, which decouples
 * TTS-chunk fetching from real-time playback speed (a correctness
 * improvement over the prior design, not just a batching one).
 *
 * A segment CLOSES on:
 *   (a) an inactivity gap — `SEGMENT_IDLE_GAP_MS` (default 400ms) with no
 *       new publish to that mouth: TTS streaming has natural gaps between
 *       ElevenLabs chunks that are well under this, but a real pause
 *       between lines (or the end of a turn) exceeds it, so playback ends
 *       promptly instead of hanging open forever. Idle detection is
 *       suspended for the duration of an in-flight push (see "Bounded
 *       backlog") so a push throttled on the backlog cap can never be
 *       mistaken for an idle gap;
 *   (b) a persona change on that connection: only the ear ever multiplexes
 *       more than one speaker (an agent's own mouth only ever receives that
 *       agent's own `personaId`, by construction of the routing lookup
 *       below), so this rule exists to stop the ear from splicing two
 *       different degraded speakers into one continuous segment;
 *   (c) its own `playPcm()` call settling — resolving, rejecting, or timing
 *       out — even with no idle gap or persona change: once that call has
 *       returned, nothing is left pulling from the segment's iterable, so
 *       leaving it "open" would silently drop any further buffered PCM (and
 *       permanently wedge a push that crosses the backlog cap, since nothing
 *       drains it). `openSegment`'s tail chain closes the segment in a
 *       `.finally()` after the `playPcm()` call settles, guarded so it never
 *       clobbers a newer segment that's since replaced it.
 * A publish after a segment closes opens a fresh one. Segment N+1's
 * `playPcm()` call is chained to start only after segment N's has settled
 * (never two concurrent `playPcm()` calls on one connection), preserving
 * the same per-connection ordering guarantee the original design had.
 *
 * `SEGMENT_IDLE_GAP_MS` is a local constant rather than a `DiscordVoiceOptions`
 * field: the interfaces are pinned verbatim for Tasks 4-5, and 400ms is a
 * reasonable default for ElevenLabs' typical inter-chunk cadence — tune the
 * constant in place if that cadence changes.
 *
 * Bounded backlog: resolving `publishPcm` on enqueue (rather than on
 * playback) removes the only pacing that used to exist between TTS
 * synthesis and real-time Discord playback — with nothing else bounding it
 * (the meeting/voice STT path has origin-less turns with no other rate
 * limit), a sustained conversation could accumulate unplayed PCM in memory
 * without limit. Each segment tracks its own backlog (bytes pushed but not
 * yet pulled by the connection's `playPcm()`); `publishPcm` resolves
 * immediately while that backlog stays under `SEGMENT_BACKLOG_CAP_BYTES`
 * (~10s of 44.1kHz mono s16le audio) and pends — gated on the backlog
 * draining back under the cap as the connection consumes more of the
 * iterable — once a push crosses it. This keeps the common case (bursty but
 * bounded TTS chunks) fully non-blocking while restoring a hard memory
 * ceiling and rough pacing for the pathological case (a consumer that's
 * genuinely falling behind real time).
 *
 * The ear (design spec §4): the flip side of the mouths above — per-user
 * RECEIVE. `opts.receiver` (a `VoiceReceiverLike`) fires once per human
 * speaking-start with that speaker's own decoded mono PCM stream; a
 * per-userId `Map<string, SttLike>` holds one live Deepgram-shaped session
 * per speaker, created on the FIRST speaking-start and reused (fed via
 * `sendAudio`) on every later one — matching the mouths' one-open-thing-
 * per-identity shape. Bot/webhook speakers (`isBot`, which also covers the
 * crew's own mouths — every mouth is itself a Discord bot account) never
 * get a session: the ear must not transcribe the crew talking to itself.
 * A session's utterance callback hands `opts.onUtterance` an already-
 * attributed line (`"<displayName> (via discord-voice): <text>"`,
 * matching channels.ts's own `"<author> (via <adapterKind>): <text>"`
 * convention for the text adapter) — pre-formatted text, submitted as a
 * turn by whoever wires this up (Task 5), same as `onUtterance` for the
 * text channel. If a speaker's own PCM stream throws mid-iteration (a
 * decode error, e.g.), only THAT speaker's session is torn down and
 * removed — logged readably — so one bad stream can't take out every other
 * open session; the next speaking-start for that same user simply opens a
 * fresh one. `leaveAll()` stops every open session alongside tearing down
 * the mouths.
 *
 * The real receiver adaptation (`discord-audio.ts`'s `realReceiver`) decodes
 * each subscribed user's Opus packets and mixes 48kHz stereo down to 48kHz
 * mono — Discord's receive side is always 48kHz, unlike the 44.1kHz mono
 * the mouths speak, so the ear's Deepgram sessions run at 48000 via the
 * rate-parameterized `makeStt` (mirrors main.ts's existing factory, which
 * mints one `DeepgramSttStream` per `LiveLike` connection). That adapter
 * isn't wired to a live connection this task — `VoiceGatewayLike.join()`
 * only returns a play/destroy handle, with no receiver exposed, by design
 * (the interface is pinned) — so it's typecheck-only scaffolding for
 * whoever threads a real ear connection through (Task 5 / the live
 * checklist), exactly like `realGateway()` and `pcm44kMonoToOpus` were for
 * Task 3.
 */

import type { SttLike } from "./broker.ts";
import { surfaceModes } from "./surface-modes.ts";

export interface VoiceConnectionLike {
  playPcm(pcm44kMono: AsyncIterable<Uint8Array>): Promise<void>; // resolves when the utterance finishes
  destroy(): void;
}

export interface VoiceGatewayLike {
  /** Join channelId with the identity behind `token`. */
  join(channelId: string, token: string): Promise<VoiceConnectionLike>;
}

/** The ear's receive side: fires once per human speaking-start with that speaker's own decoded mono PCM. */
export interface VoiceReceiverLike {
  onSpeakingStart(
    cb: (userId: string, displayName: string, isBot: boolean, pcm48kMono: AsyncIterable<Uint8Array>) => void,
  ): void;
}

export interface DiscordVoiceOptions {
  allowlist: string[];
  earToken: string;
  /** agentId -> bot token; agents absent here degrade to the ear connection. */
  agentTokens: Map<string, string>;
  agents: () => Array<{ id: string; channels?: unknown }>;
  gateway?: VoiceGatewayLike; // test seam; default realGateway()
  log?: (line: string) => void;
  /** Per-user receive: called once per finished utterance, pre-formatted, submitted as a turn. */
  onUtterance: (text: string) => void;
  /** Mints one STT session at the given sample rate; mirrors main.ts's Deepgram factory, rate-parameterized. */
  makeStt: (sampleRate: number) => SttLike;
  /** Test seam on the ear connection; see the module header's "The ear" section for the real (unwired) adapter. */
  receiver?: VoiceReceiverLike;
}

const VOICE_DESIGNATION = "discord-voice";

/** Discord's voice receive side is always 48kHz, regardless of the mouths' 44.1kHz playback rate. */
const EAR_SAMPLE_RATE = 48000;

/** See the module header's "Segmenting rule" for what opens/closes a segment and why. */
const SEGMENT_IDLE_GAP_MS = 400;

/**
 * Per-segment backlog cap, in bytes of queued-but-unconsumed 44.1kHz mono
 * s16le PCM: 44_100 samples/sec * 2 bytes/sample * 10 sec ≈ 882_000. See the
 * module header's "Bounded backlog" note for why this exists and what it
 * trades off.
 */
const SEGMENT_BACKLOG_CAP_BYTES = 882_000;

/**
 * A push-fed `AsyncIterable<Uint8Array>` backing one open playback segment.
 * `push()` buffers a chunk, wakes the consumer if it's waiting on one, and
 * returns a promise: resolved immediately while the segment's backlog
 * (bytes pushed but not yet pulled by the connection's `playPcm()`) stays
 * under `SEGMENT_BACKLOG_CAP_BYTES`, or left pending — gated on the backlog
 * draining back under the cap — once a push crosses it. `close()` signals
 * end-of-segment once whatever's already buffered drains, and releases any
 * still-pending backpressure waiters so a segment being torn down mid-push
 * (a persona switch, `leaveAll()`) can never leave a caller awaiting forever.
 */
function makeSegmentSource(): {
  iterable: AsyncIterable<Uint8Array>;
  push(bytes: Uint8Array): Promise<void>;
  close(): void;
} {
  const pending: Uint8Array[] = [];
  let backlogBytes = 0;
  let wake: (() => void) | null = null;
  let closed = false;
  let drainWaiters: Array<() => void> = [];

  function releaseDrainWaitersIfUnderCap(): void {
    if (backlogBytes >= SEGMENT_BACKLOG_CAP_BYTES || drainWaiters.length === 0) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function* generate(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const chunk = pending.shift();
      if (chunk) {
        backlogBytes -= chunk.byteLength;
        releaseDrainWaitersIfUnderCap();
        yield chunk;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    iterable: generate(),
    push(bytes: Uint8Array): Promise<void> {
      pending.push(bytes);
      backlogBytes += bytes.byteLength;
      wake?.();
      wake = null;
      if (backlogBytes < SEGMENT_BACKLOG_CAP_BYTES) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.push(resolve));
    },
    close(): void {
      closed = true;
      wake?.();
      wake = null;
      // Unconditionally release, cap or no cap — don't strand an in-flight
      // push awaiting a drain that will now never come from this segment.
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    },
  };
}

interface MouthSegment {
  personaId: string | undefined;
  push(bytes: Uint8Array): Promise<void>;
  close(): void;
}

interface Mouth {
  connection: VoiceConnectionLike;
  segment: MouthSegment | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Chains playPcm calls so segment N+1 never starts before segment N settles. */
  tail: Promise<void>;
}

function openMouth(connection: VoiceConnectionLike): Mouth {
  return { connection, segment: null, idleTimer: null, tail: Promise.resolve() };
}

function clearIdleTimer(mouth: Mouth): void {
  if (mouth.idleTimer) {
    clearTimeout(mouth.idleTimer);
    mouth.idleTimer = null;
  }
}

export function createDiscordVoiceSurface(opts: DiscordVoiceOptions): {
  publishPcm(bytes: Uint8Array, sampleRate: number, personaId?: string): Promise<void>;
  joinAll(channelId: string): Promise<void>;
  leaveAll(): Promise<void>;
  joinAgent(agentId: string): Promise<void>;
  leaveAgent(agentId: string): void;
  connectedAgentIds(): string[];
} {
  const allowlist = new Set(opts.allowlist);
  const log = opts.log ?? ((line: string) => console.log(line));

  let ear: Mouth | null = null;
  const agentMouths = new Map<string, Mouth>();
  let currentChannelId: string | null = null;

  // The ear's receive side: one live STT session per human speaker, keyed by
  // userId — created on their first speaking-start, reused (fed via
  // sendAudio) on every later one. See the module header's "The ear" note.
  const sttSessions = new Map<string, SttLike>();

  /** Pumps one speaking-start's PCM stream into its speaker's session; a mid-stream failure kills only this session. */
  async function pumpSpeakerAudio(
    userId: string,
    displayName: string,
    stt: SttLike,
    pcm48kMono: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    try {
      for await (const chunk of pcm48kMono) stt.sendAudio(chunk);
    } catch (err) {
      log(
        `[discord-voice] ${displayName}'s STT session failed — dropping their audio, other speakers unaffected: ${String(err)}`,
      );
      stt.stop();
      // Only clear the map entry if it's still THIS session — a newer
      // speaking-start for the same user may already have replaced it
      // (e.g. this pump was slow to fail); don't clobber a live session.
      if (sttSessions.get(userId) === stt) sttSessions.delete(userId);
    }
  }

  function handleSpeakingStart(
    userId: string,
    displayName: string,
    isBot: boolean,
    pcm48kMono: AsyncIterable<Uint8Array>,
  ): void {
    // Bot/webhook speakers are never transcribed — this is what stops the
    // ear from hearing the crew's own mouths (every mouth is itself a
    // Discord bot account) talk to itself.
    if (isBot) return;
    let stt = sttSessions.get(userId);
    if (!stt) {
      stt = opts.makeStt(EAR_SAMPLE_RATE);
      stt.start((text) => opts.onUtterance(`${displayName} (via discord-voice): ${text}`));
      sttSessions.set(userId, stt);
    }
    void pumpSpeakerAudio(userId, displayName, stt, pcm48kMono);
  }

  opts.receiver?.onSpeakingStart(handleSpeakingStart);

  /** Ends the mouth's open segment (if any) so its playPcm() call settles; safe to call when none is open. */
  function closeSegment(mouth: Mouth): void {
    clearIdleTimer(mouth);
    if (!mouth.segment) return;
    mouth.segment.close();
    mouth.segment = null;
  }

  /** Opens a new segment and chains its playPcm() call after the mouth's current tail settles. */
  function openSegment(mouth: Mouth, personaId: string | undefined): MouthSegment {
    const source = makeSegmentSource();
    const segment: MouthSegment = { personaId, push: source.push, close: source.close };
    mouth.segment = segment;
    mouth.tail = mouth.tail
      .then(() => mouth.connection.playPcm(source.iterable))
      .catch((err) => log(`[discord-voice] segment playback failed: ${String(err)}`)) // one bad segment must not wedge the next
      .finally(() => {
        // playPcm() has now settled (resolved, rejected, or timed out) —
        // without this, the segment stays "open" (mouth.segment still points
        // at it) with nobody left pulling from its iterable: buffered PCM
        // below the backlog cap is silently lost, and a push that crosses
        // the cap pends forever (nothing left to drain it), wedging every
        // later publishPcm on this mouth. Only close if this is STILL the
        // mouth's current segment — a persona switch or idle-gap close that
        // already happened in the meantime already nulled it out, and this
        // must not clobber a NEWER segment opened since.
        if (mouth.segment === segment) closeSegment(mouth);
      });
    return segment;
  }

  function scheduleIdleClose(mouth: Mouth): void {
    clearIdleTimer(mouth);
    mouth.idleTimer = setTimeout(() => closeSegment(mouth), SEGMENT_IDLE_GAP_MS);
  }

  function teardownMouth(mouth: Mouth): void {
    closeSegment(mouth);
    mouth.connection.destroy();
  }

  async function joinAll(channelId: string): Promise<void> {
    if (currentChannelId === channelId) {
      log(`[discord-voice] joinAll no-op — already joined ${channelId}`);
      return;
    }
    // Decline BEFORE any teardown: a rejected join (including a rejected
    // channel switch) must leave whatever's currently connected untouched —
    // fail-unsafe, not fail-disconnected. This is what makes `allowlist` a
    // real defense-in-depth check rather than one that can strand the
    // surface mid-switch if Task 5's own gating is ever wrong or racy.
    if (allowlist.size > 0 && !allowlist.has(channelId)) {
      log(`[discord-voice] joinAll declined — channel ${channelId} is not allowlisted`);
      return;
    }
    if (currentChannelId !== null) {
      log(`[discord-voice] joinAll switching channels (${currentChannelId} -> ${channelId}) — leaving first`);
      await leaveAll();
    }
    const gateway = opts.gateway ?? realGateway();

    const earConnection = await gateway.join(channelId, opts.earToken);
    ear = openMouth(earConnection);
    currentChannelId = channelId;

    const designated = opts.agents().filter((a) => surfaceModes(a)[VOICE_DESIGNATION] === "autojoin");
    for (const agent of designated) {
      const token = opts.agentTokens.get(agent.id);
      if (!token) {
        log(`[discord-voice] ${agent.id} has no bot token — speaking through the ear (degraded)`);
        continue;
      }
      try {
        const connection = await gateway.join(channelId, token);
        agentMouths.set(agent.id, openMouth(connection));
      } catch (err) {
        log(`[discord-voice] ${agent.id}'s voice join failed — speaking through the ear (degraded): ${String(err)}`);
      }
    }
  }

  async function leaveAll(): Promise<void> {
    // Each teardown is isolated: @discordjs/voice's VoiceConnection.destroy()
    // THROWS on an already-destroyed connection ("Cannot destroy
    // VoiceConnection - it has already been destroyed"), and a shared guild
    // registry (see realGateway's `group` note) used to make that the common
    // case. One mouth's throw must never abort the rest of the teardown —
    // that's what stranded the surface attached with no way to detach.
    if (ear) {
      try {
        teardownMouth(ear);
      } catch (err) {
        log(`[discord-voice] ear teardown failed: ${String(err)}`);
      }
    }
    ear = null;
    for (const [agentId, mouth] of agentMouths) {
      try {
        teardownMouth(mouth);
      } catch (err) {
        log(`[discord-voice] ${agentId}'s mouth teardown failed: ${String(err)}`);
      }
    }
    agentMouths.clear();
    currentChannelId = null;
    for (const stt of sttSessions.values()) stt.stop();
    sttSessions.clear();
  }

  /**
   * Summons a single agent's own mouth into the currently active room. Mode
   * gating (autojoin vs on-request vs disabled) is the CALLER's job — this
   * is the low-level join primitive Task 4's mode-change enforcement and
   * Task 5's join endpoint build on, not a re-check of the agent's mode.
   */
  async function joinAgent(agentId: string): Promise<void> {
    if (currentChannelId === null) throw new Error("no active voice channel");
    if (agentMouths.has(agentId)) return; // already connected — no-op
    const token = opts.agentTokens.get(agentId);
    if (!token) throw new Error(`${agentId} has no bot token`);
    const gateway = opts.gateway ?? realGateway();
    const connection = await gateway.join(currentChannelId, token);
    agentMouths.set(agentId, openMouth(connection));
  }

  /** Ejects a single agent's mouth; a no-op if that agent isn't currently connected. */
  function leaveAgent(agentId: string): void {
    const mouth = agentMouths.get(agentId);
    if (!mouth) return;
    try {
      teardownMouth(mouth); // destroy() throws on already-destroyed — same guard as leaveAll
    } catch (err) {
      log(`[discord-voice] ${agentId}'s mouth teardown failed: ${String(err)}`);
    }
    agentMouths.delete(agentId);
  }

  async function publishPcm(bytes: Uint8Array, _sampleRate: number, personaId?: string): Promise<void> {
    const mouth: Mouth | null = (personaId ? agentMouths.get(personaId) : undefined) ?? ear;
    if (!mouth) return; // no connection is live — nothing to play to
    if (mouth.segment && mouth.segment.personaId !== personaId) closeSegment(mouth); // ear must not splice speakers
    const segment = mouth.segment ?? openSegment(mouth, personaId);
    // Suspend idle detection for the duration of this push, including any
    // backpressure wait below — a push that's throttled on the backlog cap
    // is still active, not an idle gap, so the timer from the PREVIOUS push
    // must not be allowed to close this segment out from under it.
    clearIdleTimer(mouth);
    await segment.push(bytes);
    scheduleIdleClose(mouth);
  }

  return {
    publishPcm,
    joinAll,
    leaveAll,
    joinAgent,
    leaveAgent,
    connectedAgentIds: () => [...agentMouths.keys()],
  };
}

/**
 * The real gateway: one discord.js Client per token (mouths each have their
 * own bot identity), adapting `@discordjs/voice`'s `joinVoiceChannel` +
 * `AudioPlayer`. Never imported by unit tests — construction and login
 * happen lazily, inside `join()`, so a fake-gateway test run never touches
 * discord.js or the network.
 */
export function realGateway(): VoiceGatewayLike {
  return {
    async join(channelId: string, token: string): Promise<VoiceConnectionLike> {
      const [{ Client, GatewayIntentBits }, voice, { pcm44kMonoToOpus }] = await Promise.all([
        import("discord.js"),
        import("@discordjs/voice"),
        import("./discord-audio.ts"),
      ]);
      const {
        joinVoiceChannel,
        createAudioPlayer,
        createAudioResource,
        entersState,
        StreamType,
        VoiceConnectionStatus,
        AudioPlayerStatus,
        NoSubscriberBehavior,
      } = voice;

      const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
      await client.login(token);
      if (!client.isReady()) {
        await new Promise<void>((resolve) => client.once("ready", () => resolve()));
      }

      const channel = await client.channels.fetch(channelId);
      if (!channel?.isVoiceBased()) {
        throw new Error(`Discord channel ${channelId} is not a voice channel`);
      }

      if (!client.user) throw new Error("Discord client became ready without a user");
      const identity = client.user.id;
      // @discordjs/voice keys its process-wide connection registry by
      // (group, guildId), defaulting group to 'default' — every mouth in the
      // same guild would otherwise collide on that one 'default' entry and
      // joinVoiceChannel would just hand back the FIRST connection created
      // for this guild (dist src/joinVoiceChannel.ts's createVoiceConnection:
      // `getVoiceConnection(joinConfig.guildId, joinConfig.group)`), so no
      // agent bot would ever actually appear in the VC. Scoping the group to
      // this bot's own user id gives each identity its own registry slot.
      const connection = joinVoiceChannel({
        channelId,
        guildId: channel.guild.id,
        group: identity,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
      // Neither AudioPlayer nor VoiceConnection is otherwise listened for
      // 'error' — Node's EventEmitter throws (uncaughtException) on an
      // unlistened 'error' event, which would take the whole broker process
      // down. Both fire it for routine conditions (a stream error mid-play,
      // ordinary voice-networking hiccups), not just fatal ones.
      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      player.on("error", (err) => console.error(`[discord-voice] ${identity} audio player error: ${String(err)}`));
      connection.on("error", (err) =>
        console.error(`[discord-voice] ${identity} voice connection error: ${String(err)}`),
      );
      connection.subscribe(player);

      return {
        async playPcm(pcm44kMono: AsyncIterable<Uint8Array>): Promise<void> {
          const opusStream = pcm44kMonoToOpus(pcm44kMono);
          const resource = createAudioResource(opusStream, { inputType: StreamType.Opus });
          player.play(resource);
          await entersState(player, AudioPlayerStatus.Idle, 120_000);
        },
        destroy(): void {
          connection.destroy();
          void client.destroy();
        },
      };
    },
  };
}
