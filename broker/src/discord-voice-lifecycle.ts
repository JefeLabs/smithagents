/**
 * Discord voice adapter boot — `setupDiscordVoice`'s full body, extracted out
 * of main.ts's composition root for the same reason Task 7 extracted the
 * text adapter (discord-text-lifecycle.ts): main.ts's top-level script shape
 * (loadBrokerConfig() throwing on missing env vars, real SDK clients built at
 * import time, top-level `await broker.start()`, a real HTTP server, a
 * SIGINT handler) means importing main.ts AT ALL runs the whole app — there
 * is no way to unit-test a function that lives there. This module holds the
 * logic verbatim (see "Ear-connection reconciliation" below — untouched by
 * this extraction, only relocated and re-scoped to injected deps),
 * constructor-injected with the directory/policy/broker slices it reads and
 * mutates, plus an `onSurfaceChange` callback that keeps main.ts's own
 * `voiceSurface`/`voicePresence` module state (read by the /channels routes,
 * presence()/info(), and the agent-PUT enforcement wrapper) in sync without
 * this module owning that state itself. Two test seams — `createEarClient`
 * and `checkFfmpeg` — let a fake ear client and a fake ffmpeg check exercise
 * boot (and the teardown closure it returns) all the way through without
 * discord.js network I/O or a real `ffmpeg` binary on PATH, mirroring
 * discord-adapter.ts's own `clientFactory` seam one level up.
 *
 * Task 9 wires this into session-activation lifecycle, alongside
 * discord-text-lifecycle.ts's equivalent; today main.ts still boots it once
 * at startup from DISCORD_VOICE_CHANNELS, same as before this extraction.
 */
import { spawnSync } from 'node:child_process';
import type { SttLike } from './broker.ts';
import type {
  createDiscordVoiceSurface as realCreateDiscordVoiceSurface,
  DiscordVoiceOptions,
  VoiceConnectionLike,
  VoiceGatewayLike,
  VoiceReceiverLike,
} from './discord-voice.ts';
import { surfaceModes } from './surface-modes.ts';
import type { PresenceEvent, VoicePresence as RealVoicePresence } from './voice-presence.ts';

type DiscordVoiceSurface = ReturnType<typeof realCreateDiscordVoiceSurface>;

/**
 * The minimal discord.js Client surface the ear needs: login/destroy, the
 * voiceStateUpdate listener, and the two channel lookups `join()` and
 * `humanCountFor()` make. Mirrors discord-adapter.ts's own `DiscordClientLike`
 * test seam — hand-rolled to the methods actually called here rather than
 * discord.js's real (much larger) `Client` type, so a test fake needs no
 * casts to satisfy it.
 */
export interface DiscordEarClientLike {
  login(token: string): Promise<unknown>;
  destroy(): Promise<unknown>;
  on(event: 'voiceStateUpdate', handler: (oldState: DiscordEarVoiceStateLike, newState: DiscordEarVoiceStateLike) => void): void;
  channels: {
    fetch(channelId: string): Promise<DiscordEarVoiceChannelLike | null>;
    cache: { get(channelId: string): DiscordEarVoiceChannelLike | undefined };
  };
}

export interface DiscordEarVoiceStateLike {
  channelId: string | null;
  id: string;
  member: { user: { bot: boolean } } | null;
  guild: { members: { fetch(id: string): Promise<{ user: { bot: boolean } } | null> } };
}

export interface DiscordEarVoiceChannelLike {
  isVoiceBased(): boolean;
  guild: { id: string; voiceAdapterCreator: unknown };
  members: { filter(pred: (m: { user: { bot: boolean } }) => boolean): { size: number } };
}

export interface DiscordVoiceLifecycleDeps {
  directory: { list(): Array<{ id: string; channels?: unknown }> };
  policy: { revokeAll(surface: string): void };
  broker: {
    attachVoiceSurface(surface: { publishPcm: DiscordVoiceSurface['publishPcm'] }): boolean;
    detachVoiceSurface(): void;
  };
  onUtterance: (text: string) => void;
  /** Mints one STT session at the given sample rate; main.ts supplies its Deepgram factory here. */
  makeStt: (sampleRate: number) => SttLike;
  /** Called once, synchronously, right after a successful boot's surface/presence
   * are constructed, and again with (null, null) once teardown completes —
   * keeps main.ts's own module-level voiceSurface/voicePresence in sync
   * without this module holding that state itself. */
  onSurfaceChange: (surface: DiscordVoiceSurface | null, presence: RealVoicePresence | null) => void;
  /** Test seam: overrides the ear's discord.js client construction + login. Defaults to a real, logged-in discord.js Client. */
  createEarClient?: () => DiscordEarClientLike | Promise<DiscordEarClientLike>;
  /** Test seam: whether voice may boot at all. Defaults to a real `ffmpeg -version` PATH check via spawnSync. */
  checkFfmpeg?: () => boolean;
}

function realFfmpegAvailable(): boolean {
  const check = spawnSync('ffmpeg', ['-version']);
  return !(check.error || check.status !== 0);
}

/** Wraps a real, freshly-constructed discord.js Client into `DiscordEarClientLike` — same shape-adapting role as discord-adapter.ts's `realClient()`. */
function realEarClient(
  DiscordClient: typeof import('discord.js').Client,
  GatewayIntentBits: typeof import('discord.js').GatewayIntentBits,
): DiscordEarClientLike {
  const client = new DiscordClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  return {
    login: (token) => client.login(token),
    destroy: () => client.destroy(),
    on: (event, handler) => {
      client.on(event, (oldState, newState) =>
        handler(oldState as unknown as DiscordEarVoiceStateLike, newState as unknown as DiscordEarVoiceStateLike),
      );
    },
    channels: {
      fetch: (channelId) => client.channels.fetch(channelId) as unknown as Promise<DiscordEarVoiceChannelLike | null>,
      cache: {
        get: (channelId) => client.channels.cache.get(channelId) as unknown as DiscordEarVoiceChannelLike | undefined,
      },
    },
  };
}

export interface DiscordVoiceLifecycle {
  /**
   * Discord voice attends only when `allowlist` names at least one channel
   * and `token` is present — same all-local invariant as the text adapter's
   * DISCORD_TOKEN gate. Every voice-only module (discord-voice.ts,
   * discord-audio.ts, discord.js, @discordjs/voice) is dynamic-imported from
   * inside this function, so an unset/empty token or allowlist means none of
   * it ever loads. Returns null when voice doesn't start (missing ffmpeg,
   * missing token) — otherwise a teardown closure bound to THIS invocation's
   * earClient/surface/presence, safe to call once to cleanly tear the whole
   * thing back down.
   *
   * Ear-connection reconciliation (the one genuinely tricky wiring decision):
   * `createDiscordVoiceSurface`'s own `joinAll` always calls
   * `gateway.join(channelId, opts.earToken)` for the ear's mouth, and
   * `opts.receiver?.onSpeakingStart(cb)` is captured once, synchronously, at
   * surface CONSTRUCTION time — before any real voice connection can possibly
   * exist (the ear only ever connects in response to a human's presence, never
   * eagerly at boot). That means the receiver can't be built ahead of time and
   * handed in; it has to be captured at the exact moment the ear's real
   * connection comes into being. The fix: a custom `gateway` (this function's
   * `earAwareGateway`) that intercepts joins for `earToken` specifically —
   * reusing the already-logged-in `earClient` (see below) instead of a second
   * gateway session under the same bot token — and wires
   * `discord-audio.ts`'s `realReceiver` onto that connection's `.receiver` at
   * the same moment. A per-connection `alive` closure — declared fresh inside
   * each `join()` call, scoped to that one connection, never shared across
   * joins — ties delivery to that specific connection's lifecycle: `true`
   * right before registering, `false` in that connection's own `destroy()`,
   * checked before every delivered speaking-start. This is deliberately NOT a
   * single flag shared across connections (that was the original design, and
   * it was a bug: a `guild.members.fetch()` left in flight by a connection
   * that's already been torn down could read a *later* connection's `true` and
   * mint a stale, orphaned STT session — see task-5-report.md's fix-round-1
   * for the exact race). Every OTHER token (agent mouths) still goes through
   * the plain, already-tested `realGateway()` — this function never touches
   * `discord-voice.ts`'s exported interfaces, only supplies its own
   * `VoiceGatewayLike`/`VoiceReceiverLike` implementations from the outside.
   */
  bootDiscordVoice(token: string | undefined, allowlist: string[]): Promise<(() => Promise<void>) | null>;
}

export function createDiscordVoiceLifecycle(deps: DiscordVoiceLifecycleDeps): DiscordVoiceLifecycle {
  async function bootDiscordVoice(token: string | undefined, allowlist: string[]): Promise<(() => Promise<void>) | null> {
    const ffmpegAvailable = deps.checkFfmpeg ?? realFfmpegAvailable;
    if (!ffmpegAvailable()) {
      console.error('[discord-voice] ffmpeg not found on PATH — voice disabled (install ffmpeg to enable Discord voice).');
      return null;
    }
    if (!token) {
      console.error('[discord-voice] DISCORD_VOICE_CHANNELS is set but DISCORD_TOKEN is empty — the ear has no bot identity. Voice disabled.');
      return null;
    }
    const earToken = token;

    const [
      { createDiscordVoiceSurface, realGateway },
      { realReceiver, pcm44kMonoToOpus },
      { VoicePresence },
      { Client: DiscordClient, GatewayIntentBits },
      voice,
    ] = await Promise.all([
      import('./discord-voice.ts'),
      import('./discord-audio.ts'),
      import('./voice-presence.ts'),
      import('discord.js'),
      import('@discordjs/voice'),
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

    // Token map: DISCORD_TOKEN_<X> (excluding the bare ear token) -> agent id.
    // The underscore->dash mapping below assumes agent ids are kebab-case only
    // (true today) — an agent id containing a literal underscore would collide
    // with one whose id uses a dash in the same spot.
    const agentTokens = new Map<string, string>();
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'DISCORD_TOKEN' || !key.startsWith('DISCORD_TOKEN_') || !value) continue;
      agentTokens.set(key.slice('DISCORD_TOKEN_'.length).toLowerCase().replaceAll('_', '-'), value);
    }
    // Not just autojoin: an on-request agent can be summoned into a live room
    // later (joinAgent), so it needs a bot token minted up front the same as
    // an autojoin agent — only 'disabled' is excluded here.
    const designated = deps.directory.list().filter((a) => surfaceModes(a)['discord-voice'] !== 'disabled');
    const mouths = designated.filter((a) => agentTokens.has(a.id)).map((a) => a.id);
    const degraded = designated.filter((a) => !agentTokens.has(a.id)).map((a) => a.id);
    console.log(`[discord-voice] ear starting — ${allowlist.length} channel(s) allowlisted`);
    console.log(`[discord-voice] agent mouths (own bot token): ${mouths.length ? mouths.join(', ') : '(none)'}`);
    console.log(`[discord-voice] agents degraded (share the ear): ${degraded.length ? degraded.join(', ') : '(none)'}`);

    const earClient = await (deps.createEarClient ?? (() => realEarClient(DiscordClient, GatewayIntentBits)))();
    await earClient.login(earToken);

    // Receiver proxy: see this interface's own doc comment above bootDiscordVoice
    // for why this indirection exists. speakingStartCb is captured once, by
    // createDiscordVoiceSurface's constructor, and outlives every join/leave
    // cycle. Liveness itself is scoped PER CONNECTION inside earAwareGateway's
    // join() below (fix round 1) — NOT a flag shared here across joins: a
    // shared flag let a rejoin's `true` unmask a still-in-flight speaking-start
    // from the previous, already-destroyed connection (see task-5-report.md's
    // fix-round section for the exact race).
    let speakingStartCb: Parameters<VoiceReceiverLike['onSpeakingStart']>[0] | null = null;
    const receiverProxy: VoiceReceiverLike = {
      onSpeakingStart(cb) {
        speakingStartCb = cb;
      },
    };

    const fallbackGateway = realGateway();
    const earAwareGateway: VoiceGatewayLike = {
      async join(channelId: string, joinToken: string): Promise<VoiceConnectionLike> {
        if (joinToken !== earToken) return fallbackGateway.join(channelId, joinToken);

        // Reuse earClient (already logged in for presence) rather than a
        // second gateway session under the same bot token.
        const channel = await earClient.channels.fetch(channelId);
        if (!channel || !channel.isVoiceBased()) {
          throw new Error(`Discord channel ${channelId} is not a voice channel`);
        }
        // Own `group` so the ear's connection gets its own slot in
        // @discordjs/voice's process-wide (group, guildId) registry, distinct
        // from every agent mouth's own token-scoped group in realGateway() —
        // sharing the default group would collide on one guild-wide entry and
        // joinVoiceChannel would just hand back whichever connection claimed
        // it first (see discord-voice.ts's realGateway() for the full dist
        // citation of this behavior).
        const connection = joinVoiceChannel({
          channelId,
          guildId: channel.guild.id,
          group: 'ear',
          adapterCreator: channel.guild.voiceAdapterCreator as Parameters<typeof joinVoiceChannel>[0]['adapterCreator'],
          selfDeaf: false,
          selfMute: false,
        });
        await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
        // See discord-voice.ts's realGateway() for why both listeners exist:
        // an unlistened EventEmitter 'error' is an uncaughtException, and
        // both AudioPlayer and VoiceConnection fire 'error' for routine,
        // non-fatal conditions.
        const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
        player.on('error', (err) => console.error(`[discord-voice] ear audio player error: ${String(err)}`));
        connection.on('error', (err) => console.error(`[discord-voice] ear voice connection error: ${String(err)}`));
        connection.subscribe(player);

        // Scoped to THIS connection only — a rejoin gets its own `alive`, so
        // this connection's destroy() can never be masked by a LATER join
        // flipping a shared flag back to true (fix round 1).
        let alive = true;
        realReceiver(connection.receiver, channel.guild as never).onSpeakingStart((userId, displayName, isBot, pcm) => {
          if (!alive) return; // this connection was already torn down — drop it, never mint a session for it
          speakingStartCb?.(userId, displayName, isBot, pcm);
        });

        return {
          async playPcm(pcm44kMono: AsyncIterable<Uint8Array>): Promise<void> {
            const opusStream = pcm44kMonoToOpus(pcm44kMono);
            const resource = createAudioResource(opusStream, { inputType: StreamType.Opus });
            player.play(resource);
            await entersState(player, AudioPlayerStatus.Idle, 120_000);
          },
          destroy(): void {
            alive = false;
            connection.destroy();
            // earClient itself is NOT destroyed here — it's shared with presence watching and must survive leaveAll.
          },
        };
      },
    };

    const surface = createDiscordVoiceSurface({
      allowlist,
      earToken,
      agentTokens,
      agents: () => deps.directory.list().map((a) => ({ id: a.id, channels: a.channels })),
      gateway: earAwareGateway,
      log: (line) => console.log(line),
      // No origin — voice turns are meeting-shaped, matching mic PTT/stdin.
      onUtterance: deps.onUtterance,
      // Rate-parameterized: discord-voice.ts always calls this with 48000
      // (Discord's receive rate), but the value is threaded through honestly
      // rather than relying on a default matching by luck.
      makeStt: (sampleRate) => deps.makeStt(sampleRate),
      receiver: receiverProxy,
    } satisfies DiscordVoiceOptions);

    const presence = new VoicePresence(allowlist);
    deps.onSurfaceChange(surface, presence);

    function humanCountFor(channelId: string): number {
      const channel = earClient.channels.cache.get(channelId);
      if (!channel || !channel.isVoiceBased()) return 0;
      return channel.members.filter((m) => !m.user.bot).size;
    }

    async function onPresenceEvent(event: PresenceEvent): Promise<void> {
      const action = presence.handle(event, humanCountFor);
      if (action.type === 'join-crew') {
        // First-come-wins per broker.ts's attachVoiceSurface contract: declined
        // (a meeting is active or joining) means log + skip + no markJoined —
        // the next qualifying presence event retries from scratch.
        if (!deps.broker.attachVoiceSurface(surface)) {
          console.log('[discord-voice] attach declined (a meeting is active or joining) — will retry on the next presence event');
          return;
        }
        try {
          await surface.joinAll(action.channelId);
          presence.markJoined(action.channelId);
          // Degraded count called out explicitly — a rollout with zero minted
          // agent tokens joins with 0 connected mouths by design (every
          // designated agent degrades to the ear), and a bare "ear + 0 agent
          // mouth(s)" reads as a failure without it.
          const connectedCount = surface.connectedAgentIds().length;
          const designatedCount = deps.directory.list().filter((a) => surfaceModes(a)['discord-voice'] !== 'disabled').length;
          const degradedCount = designatedCount - connectedCount;
          console.log(
            `[discord-voice] joined ${action.channelId} — ear + ${connectedCount} agent mouth(s)` +
              (degradedCount > 0 ? `, ${degradedCount} degraded` : ''),
          );
        } catch (err) {
          console.error(`[discord-voice] join failed for ${action.channelId}: ${String(err)}`);
          deps.broker.detachVoiceSurface();
          presence.handle({ type: 'join-failed', channelId: action.channelId }, humanCountFor);
        }
      } else if (action.type === 'leave-crew') {
        await surface.leaveAll();
        // On-request admissions are runtime-only for the life of one crew
        // presence in the room — the next room join starts every on-request
        // agent unadmitted again.
        deps.policy.revokeAll('discord-voice');
        deps.broker.detachVoiceSurface();
        presence.markLeft();
        console.log(`[discord-voice] left ${action.channelId}`);
      }
    }

    // Serialized: an independent async handler per voiceStateUpdate event (the
    // original shape) races. Two humans joining together spawn two concurrent
    // join-crew actions — two overlapping joinAll runs, leaking a duplicate
    // set of mouth Clients. A human leaving mid-joinAll can have its
    // human-left evaluated (and discarded, since presence isn't 'joined' yet)
    // before the in-flight join-crew's markJoined lands, leaving the crew
    // attached and squatting in a now-empty channel. Chaining every event's
    // FULL action (attach/joinAll/markJoined or leaveAll/detach/markLeft)
    // through one serial promise settles each before the next is evaluated —
    // mirrors broker.ts's `speaking` serial-chain pattern.
    let presenceChain: Promise<void> = Promise.resolve();
    earClient.on('voiceStateUpdate', (oldState, newState) => {
      presenceChain = presenceChain
        .then(async () => {
          const leftId = oldState.channelId;
          const joinedId = newState.channelId;
          if (leftId === joinedId) return; // mute/deafen-only change, not a channel join/leave
          const member =
            newState.member ??
            oldState.member ??
            (await newState.guild.members.fetch(newState.id).catch((err: unknown) => {
              console.error(`[discord-voice] couldn't resolve guild member ${newState.id} for a voice presence update — dropping it: ${String(err)}`);
              return null;
            }));
          if (!member || member.user.bot) return; // human = !member.user.bot; bots (our own mouths included) never drive presence
          if (leftId) await onPresenceEvent({ type: 'human-left', channelId: leftId });
          if (joinedId) await onPresenceEvent({ type: 'human-joined', channelId: joinedId });
        })
        .catch((err) => console.error(`[discord-voice] presence handling failed: ${String(err)}`)); // one bad event must not wedge the chain
    });

    const teardown = async (): Promise<void> => {
      try {
        await surface.leaveAll();
        deps.policy.revokeAll('discord-voice');
        deps.broker.detachVoiceSurface();
      } catch (err) {
        // Nothing was joined, or leaveAll itself failed — either way, still tear
        // down the client below rather than leaving a half-torn-down connection.
        console.error(`[discord-voice] leaveAll during teardown: ${String(err)}`);
      }
      await earClient.destroy();
      deps.onSurfaceChange(null, null);
    };
    return teardown;
  }

  return { bootDiscordVoice };
}
