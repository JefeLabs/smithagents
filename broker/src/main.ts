/**
 * Composition root — the only file that builds real SDK clients. Also runs
 * the stdin dev channel: every line typed is treated as a spoken utterance,
 * so the full brain -> delegate -> TTS pipeline is testable without a mic.
 */
import Anthropic from '@anthropic-ai/sdk';
import { DeepgramClient } from '@deepgram/sdk';
import { createInterface } from 'node:readline';
import { ElevenLabsVoiceProvider } from '@smithagents/voice';
import { BrokerBrain, type StreamFactory } from './brain.ts';
import { Broker } from './broker.ts';
import { loadBrokerConfig } from './config.ts';
import { AgentDirectory } from './directory.ts';
import { LiveKitRoomBridge } from './room.ts';
import { DeepgramSttStream, type LiveLike } from './stt.ts';
import { SwarmClient } from './swarm-client.ts';
import { mintRoomToken } from './token.ts';

const config = loadBrokerConfig();

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const streamFactory: StreamFactory = (params) =>
  anthropic.messages.stream(params as Parameters<typeof anthropic.messages.stream>[0]);

const swarm = new SwarmClient({ baseUrl: config.swarm.baseUrl, token: config.swarm.token });
const directory = new AgentDirectory();

const tts = config.elevenlabsApiKey ? new ElevenLabsVoiceProvider({ apiKey: config.elevenlabsApiKey }) : null;

async function* speak(text: string): AsyncIterable<Uint8Array> {
  if (!tts || !config.voice.voiceId) {
    console.log(`[speech-text] ${text}`); // no TTS configured — text-only mode
    return;
  }
  const stream = tts.stream({
    text,
    personaId: 'broker',
    format: 'pcm_s16le',
    sampleRate: 44100,
    voice: { provider: 'elevenlabs', voiceId: config.voice.voiceId },
  });
  for await (const chunk of stream) yield chunk.data;
}

/**
 * Deepgram adapter — the installed @deepgram/sdk (v5, Fern-generated) has no
 * `createClient` / `LiveTranscriptionEvents` (the older API stt.ts's contract
 * was drafted against). The live connection is `deepgram.listen.v1.connect(...)`,
 * which is ASYNC and returns a `V1Socket` whose messages already carry the
 * exact shape `DeepgramSttStream` expects: `{ type: 'Results', is_final,
 * speech_final, channel: { alternatives: [{ transcript }] } }`. stt.ts's
 * `LiveLike`/`LiveFactory` contract stays fixed and synchronous, so this
 * adapter bridges the gap: audio sent before the socket finishes opening is
 * queued and flushed once connected.
 */
const deepgram = new DeepgramClient({ apiKey: config.deepgramApiKey });

function makeDeepgramLive(): LiveLike {
  type Socket = Awaited<ReturnType<typeof deepgram.listen.v1.connect>>;
  let socket: Socket | null = null;
  let resultsCb: ((data?: unknown) => void) | null = null;
  const pending: Uint8Array[] = [];
  let closed = false;

  const ready: Promise<Socket | null> = deepgram.listen.v1
    .connect({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: 48000,
      channels: 1,
      interim_results: 'true',
      smart_format: 'true',
      endpointing: 300,
    })
    .then((s) => {
      if (closed) {
        s.close();
        return null;
      }
      socket = s;
      s.on('message', (message) => resultsCb?.(message));
      for (const chunk of pending.splice(0)) s.sendMedia(chunk);
      return s;
    })
    .catch((err: unknown) => {
      console.error('[stt] deepgram connect failed:', err);
      return null;
    });

  return {
    on: (event, cb) => {
      if (event === 'Results') resultsCb = cb;
    },
    send: (data) => {
      if (socket) socket.sendMedia(data);
      else pending.push(data);
    },
    requestClose: () => {
      closed = true;
      void ready.then((s) => s?.close());
    },
  };
}

// TDZ: the brain's executors close over `broker`, which this same statement
// group constructs. Declared first and assigned after — the closures only
// run per-turn, long after startup, by which time `broker` is assigned.
let broker: Broker;

const brain = new BrokerBrain(streamFactory, {
  delegate: (input) => broker.executors.delegate(input),
  check_status: (input) => broker.executors.check_status(input),
});

broker = new Broker(
  {
    swarm,
    directory,
    brain,
    makeStt: () => new DeepgramSttStream(makeDeepgramLive),
    makeBridge: () => new LiveKitRoomBridge(),
    speak,
    mintToken: (roomName) =>
      mintRoomToken({
        apiKey: config.livekit.apiKey,
        apiSecret: config.livekit.apiSecret,
        roomName,
        identity: 'smith-broker',
      }),
    livekitUrl: config.livekit.url,
  },
  { repository: config.swarm.repository },
);

await broker.start();
console.log('[broker] running — polling swarm for open meetings. Type a line to simulate an utterance.');

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (text) void broker.handleUtterance(text);
});

process.on('SIGINT', () => {
  void broker.stop().then(() => process.exit(0));
});
