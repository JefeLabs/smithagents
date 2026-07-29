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
 * Utterance-boundary design decision: `publishPcm` delivers one TTS byte
 * chunk per call, with no signal marking where one line of dialogue ends and
 * the next begins — the broker's speech chain (broker.ts's `enqueueSpeech`)
 * never interleaves two chunks bound for this surface, but it doesn't flag a
 * boundary either. Rather than guess one (an idle-gap timer would be
 * fragile; inventing a flush signal would be a contract change), this
 * module treats each `publishPcm` call as its own complete playback
 * segment: the bytes are wrapped in a one-shot `AsyncIterable` and driven
 * through exactly one `playPcm()` call, whose promise is what `publishPcm`
 * itself resolves on. A small per-connection queue (`makeMouthQueue`)
 * chains these segments so a mouth never starts segment N+1 before segment
 * N's `playPcm()` settles. Today that ordering is already guaranteed
 * end-to-end by the broker's global speech serialization (see
 * `enqueueSpeech`'s doc comment), so this queue is local hygiene for a less
 * disciplined future caller, not a fix for an active bug — exactly what the
 * task brief asked for.
 */

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

const VOICE_DESIGNATION = 'discord-voice';

async function* oneShot(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/** Chains playPcm calls on one connection so segment N+1 never starts before segment N settles. */
function makeMouthQueue(connection: VoiceConnectionLike) {
  let tail: Promise<void> = Promise.resolve();
  return {
    push(bytes: Uint8Array): Promise<void> {
      const played = tail.then(() => connection.playPcm(oneShot(bytes)));
      tail = played.catch(() => undefined); // one bad segment must not wedge the queue for the next
      return played;
    },
  };
}

interface Mouth {
  connection: VoiceConnectionLike;
  queue: ReturnType<typeof makeMouthQueue>;
}

export function createDiscordVoiceSurface(opts: DiscordVoiceOptions): {
  publishPcm(bytes: Uint8Array, sampleRate: number, personaId?: string): Promise<void>;
  joinAll(channelId: string): Promise<void>;
  leaveAll(): Promise<void>;
  connectedAgentIds(): string[];
} {
  const allowlist = new Set(opts.allowlist);
  const log = opts.log ?? ((line: string) => console.log(line));

  let ear: Mouth | null = null;
  const agentMouths = new Map<string, Mouth>();

  async function joinAll(channelId: string): Promise<void> {
    if (allowlist.size > 0 && !allowlist.has(channelId)) {
      log(`[discord-voice] joinAll declined — channel ${channelId} is not allowlisted`);
      return;
    }
    const gateway = opts.gateway ?? realGateway();

    const earConnection = await gateway.join(channelId, opts.earToken);
    ear = { connection: earConnection, queue: makeMouthQueue(earConnection) };

    const designated = opts.agents().filter((a) => a.channels?.includes(VOICE_DESIGNATION));
    for (const agent of designated) {
      const token = opts.agentTokens.get(agent.id);
      if (!token) {
        log(`[discord-voice] ${agent.id} has no bot token — speaking through the ear (degraded)`);
        continue;
      }
      try {
        const connection = await gateway.join(channelId, token);
        agentMouths.set(agent.id, { connection, queue: makeMouthQueue(connection) });
      } catch (err) {
        log(`[discord-voice] ${agent.id}'s voice join failed — speaking through the ear (degraded): ${String(err)}`);
      }
    }
  }

  async function leaveAll(): Promise<void> {
    ear?.connection.destroy();
    ear = null;
    for (const mouth of agentMouths.values()) mouth.connection.destroy();
    agentMouths.clear();
  }

  async function publishPcm(bytes: Uint8Array, _sampleRate: number, personaId?: string): Promise<void> {
    const mouth: Mouth | null = (personaId ? agentMouths.get(personaId) : undefined) ?? ear;
    if (!mouth) return; // no connection is live — nothing to play to
    await mouth.queue.push(bytes);
  }

  return {
    publishPcm,
    joinAll,
    leaveAll,
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
        import('discord.js'),
        import('@discordjs/voice'),
        import('./discord-audio.ts'),
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
        await new Promise<void>((resolve) => client.once('ready', () => resolve()));
      }

      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isVoiceBased()) {
        throw new Error(`Discord channel ${channelId} is not a voice channel`);
      }

      const connection = joinVoiceChannel({
        channelId,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);

      const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
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
