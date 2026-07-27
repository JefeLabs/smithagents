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
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RosterState, UiRoster } from './broker.ts';
import { SessionManager, type Session } from './sessions.ts';
import { DeepgramSttStream, type LiveLike } from './stt.ts';
import { SwarmClient, type SwarmSquad } from './swarm-client.ts';
import { VoiceCatalog } from './voice-catalog.ts';
import { TextChannel, type RosterEntry } from './text-channel.ts';
import { mintRoomToken } from './token.ts';

// Defense in depth: the brain-turn queue in broker.ts isolates errors from
// every turn it runs, but this catches anything outside that queue so a
// stray rejection never takes the whole process down under Node defaults.
process.on('unhandledRejection', (err) => console.error('[broker] unhandled rejection:', err));

const config = loadBrokerConfig();

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const streamFactory: StreamFactory = (params) =>
  anthropic.messages.stream(params as Parameters<typeof anthropic.messages.stream>[0]);

const swarm = new SwarmClient({ baseUrl: config.swarm.baseUrl, token: config.swarm.token });
const directory = new AgentDirectory();

const tts = config.elevenlabsApiKey ? new ElevenLabsVoiceProvider({ apiKey: config.elevenlabsApiKey }) : null;
// Voice library browsing + the fixed-line audio cache (reactions, quick answers).
const voiceCatalog = config.elevenlabsApiKey
  ? new VoiceCatalog(config.elevenlabsApiKey, process.env.BROKER_VOICE_CACHE_DIR ?? '.smith/voice-cache')
  : null;

// Meeting TTS speaks with the per-agent cast — same voices as the app's audio
// frames. Falls back to a premade stand-in when a library voice is plan-gated.
async function* speak(text: string): AsyncIterable<Uint8Array> {
  if (!tts) {
    return; // no TTS configured — onSpeechText already surfaced the text
  }
  const { speaker, spokenText } = resolveSpokenLine(text);
  const attempt = (voiceId: string) =>
    tts.stream({
      text: spokenText,
      personaId: speaker ?? 'broker',
      format: 'pcm_s16le',
      sampleRate: 44100,
      voice: { provider: 'elevenlabs', voiceId },
    });
  const voiceId = elevenVoiceFor(speaker);
  try {
    for await (const chunk of attempt(voiceId)) yield chunk.data;
  } catch (err) {
    const standIn = (speaker && PREMADE_STANDINS[speaker]) ?? PREMADE_DEFAULT;
    if (!/402|payment_required|paid_plan_required/.test(String(err)) || standIn === voiceId) throw err;
    for await (const chunk of attempt(standIn)) yield chunk.data;
  }
}

/**
 * Deepgram adapter — the installed @deepgram/sdk (v5, Fern-generated) has no
 * `createClient` / `LiveTranscriptionEvents` (the older API stt.ts's contract
 * was drafted against). The live connection is `deepgram.listen.v1.connect(...)`,
 * which is ASYNC and returns a `V1Socket` whose messages already carry the
 * exact shape `DeepgramSttStream` expects: `{ type: 'Results', is_final,
 * speech_final, channel: { alternatives: [{ transcript }] } }`. Resolving
 * that promise does NOT mean the underlying websocket is open yet — per the
 * SDK's own documented usage (README: "connection.connect(); await
 * connection.waitForOpen();"), the socket must be explicitly opened and that
 * open awaited before any `sendMedia()` call, or it throws "Socket is not
 * open." stt.ts's `LiveLike`/`LiveFactory` contract stays fixed and
 * synchronous, so this adapter bridges the gap: audio sent before the socket
 * finishes connecting *and* opening is queued and flushed once truly open.
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
    .then(async (s) => {
      if (closed) {
        s.close();
        return null;
      }
      s.on('message', (message) => resultsCb?.(message));
      // connect() resolves as soon as the socket object exists, not once the
      // websocket handshake completes — open it and wait before sending.
      s.connect();
      await s.waitForOpen();
      if (closed) {
        s.close();
        return null;
      }
      socket = s;
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
  // Delegations land in the active session's workspace unless the brain names one.
  delegate: (input) => broker.executors.delegate({ ...input, workspace: input.workspace ?? sessionManager.active().workspace }),
  check_status: (input) => broker.executors.check_status(input),
  raise_hand: (input) => broker.executors.raise_hand(input),
});

// Sessions — workspace-scoped conversations persisted under .smith/sessions/.
const sessionsDir = process.env.BROKER_SESSIONS_DIR ?? '.smith/sessions';
const sessionStore = {
  loadAll(): Session[] {
    try {
      return readdirSync(sessionsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')) as Session);
    } catch {
      return [];
    }
  },
  save(session: Session): void {
    try {
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2));
    } catch (err) {
      console.error('[sessions] persist failed:', err);
    }
  },
};
const sessionManager = new SessionManager(sessionStore);

const SQUAD_RINGS: Record<string, string> = { alpha: '#5fd0b0', beta: '#f2778f', gamma: '#9b8cff' };

// ElevenLabs voices for speakers without a persona file (squad members).
// Persona-file agents carry their own voice.voiceId. Swap freely from the voice library.
const SQUAD_VOICES: Record<string, string> = {
  Gabriel: '4GMf9CnVFI2n0w4K1Gm4', // Edwin's pick — Latin male, alpha leader
  Gustavo: 'aviXFY7Zd7b9DnCUwaCh', // Edwin's pick — Latin male, beta leader
  Graciela: 'AxFLn9byyiDbMn5fmyqu', // Edwin's pick — gamma leader
  Santiago: 'htFfPSZGJwjBv1CL0aMD', // Edwin's pick — Latin voice, alpha developer
  Soledad: '2Lb1en5ujrODDIqmp7F3', // Edwin's pick — female, gamma developer
  Francisca: 'saqk76H0L3GCnuHtLDw6', // Edwin's pick — female Latin, gamma architect
  Ofelia: 'nTkjq09AuYgsNR8E4sDe', // Edwin's pick — female, gamma senior
  // Spare (unassigned): m7yTemJqdIqrcNleANfX — female Latin. Open male slots:
  // Fabian, Osvaldo (alpha), Fernando, Orlando, Sebastian (beta).
};
const DEFAULT_ELEVEN_VOICE = 'wutgczPT1RZgTX0H3qRJ'; // Edwin's pick — female Latin, fallback for unmapped speakers

// Premade stand-ins: ElevenLabs blocks LIBRARY voices on free API plans (402
// paid_plan_required) but allows premade ones. When a picked voice 402s we
// retry with these, so the crew still speaks on the free tier — the real picks
// take over automatically once the plan is upgraded. Distinct voice per speaker.
const PREMADE_STANDINS: Record<string, string> = {
  Manuel: 'ErXwobaYiN019PkySvjV', // Antoni
  Octavio: 'pNInz6obpgDQGcFmaJgB', // Adam
  Aurelio: 'TxGEqnHWrfWFTfGW9XjX', // Josh
  Gabriel: 'yoZ06aMxZJJ28mfd3POQ', // Sam
  Gustavo: 'VR6AewLTigWG4xSOukaG', // Arnold
  Graciela: '21m00Tcm4TlvDq8ikWAM', // Rachel
  Francisca: 'EXAVITQu4vr4xnSDxMaL', // Bella
  Ofelia: 'MF3mGyEYCl7XYWbV9V6O', // Elli
  Soledad: 'AZnzlk1XvdvUeBnXmlld', // Domi
};
const PREMADE_DEFAULT = 'ErXwobaYiN019PkySvjV'; // Antoni

const SPEAKER_RE = /^([A-Z][\w-]{1,24}):\s+(.*)$/s;

// Sticky speaker: sentence chunks after the first carry no "Name:" prefix —
// they belong to whoever spoke last, not to the default voice.
let lastSpokenSpeaker: string | undefined;
function resolveSpokenLine(text: string): { speaker?: string; spokenText: string } {
  const parsed = SPEAKER_RE.exec(text);
  const speaker = parsed?.[1] ?? lastSpokenSpeaker;
  lastSpokenSpeaker = speaker;
  return { speaker, spokenText: parsed?.[2] ?? text };
}

function elevenVoiceFor(speaker?: string): string {
  return (speaker && (directory.resolve(speaker)?.voice?.voiceId ?? SQUAD_VOICES[speaker])) ?? DEFAULT_ELEVEN_VOICE;
}

const GROUP_RING_PALETTE = ['#5fd0b0', '#f2778f', '#9b8cff', '#f2b04a', '#6f8dff', '#d977c8'];

const toRosterEntries = (roster: UiRoster): RosterEntry[] => [
  ...roster.agents.map(
    (p): RosterEntry => ({
      id: p.agent.id,
      name: p.agent.name,
      role: p.agent.role,
      ring: p.agent.avatarRing,
      status: p.status,
      taskSummary: p.taskSummary,
      kind: 'agent',
      speech: p.agent.voice?.speech,
      hand: roster.hands[p.agent.name],
    }),
  ),
  ...roster.squads.map(
    (s): RosterEntry => ({
      id: `squad-${s.id}`,
      name: s.id[0]!.toUpperCase() + s.id.slice(1),
      role: `Squad — led by ${s.leader.name}`,
      ring: SQUAD_RINGS[s.id],
      status: s.status === 'active' ? 'busy' : 'idle',
      kind: 'squad',
      // A squad's hand is its leader's hand (either name may be used by the brain).
      hand: roster.hands[s.leader.name] ?? roster.hands[s.id[0]!.toUpperCase() + s.id.slice(1)],
      members: s.members
        .map((m) => m.name)
        .concat(s.extraMembers)
        .filter((name) => !s.removedMembers.includes(name)),
    }),
  ),
  ...roster.freed.map(
    (m): RosterEntry => ({
      id: `freed-${m.name.toLowerCase()}`,
      name: m.name,
      role: m.role,
      ring: SQUAD_RINGS[m.squadId], // keeps their squad lineage visible
      status: 'idle',
      kind: 'agent',
      hand: roster.hands[m.name],
    }),
  ),
  ...roster.groups.map(
    (g, i): RosterEntry => ({
      id: `group-${g.id}`,
      name: g.name[0]!.toUpperCase() + g.name.slice(1),
      role: `Squad — led by ${g.members[0]?.name ?? '?'}`,
      ring: GROUP_RING_PALETTE[i % GROUP_RING_PALETTE.length],
      status: 'idle',
      kind: 'squad',
      hand: g.members[0] ? roster.hands[g.members[0].name] : undefined,
      members: g.members.map((m) => m.name),
    }),
  ),
];

// Text I/O for UIs (Tauri control plane): POST /utterance in, WS transcript +
// live roster out. New clients get capabilities + a roster snapshot on connect.
// Same TDZ note as the executors above — the closures run long after assignment.
// A user line from any input (HTTP, stdin, mic) lands in the active session's
// transcript, runs a brain turn, then persists the brain's memory.
function handleUserText(text: string): void {
  sessionManager.appendTranscript('user', text);
  void broker.handleUtterance(text).then(() => sessionManager.saveBrainHistory(brain.exportHistory()));
}

let workspaceNames: string[] = [];

function sessionFrame() {
  const s = sessionManager.active();
  return {
    type: 'session' as const,
    session: { id: s.id, title: s.title, workspace: s.workspace },
    sessions: sessionManager.list(),
    transcript: s.transcript.map((t) => ({ role: t.role, text: t.text })),
    workspaces: workspaceNames,
  };
}

const textChannel = new TextChannel(
  handleUserText,
  () => [
    { type: 'config', audio: Boolean(tts) },
    { type: 'roster', agents: toRosterEntries(broker.uiRoster()) },
    sessionFrame(),
  ],
  (body) => {
    const op = body as { op?: string; agents?: unknown; target?: unknown; agent?: unknown };
    if (op.op === 'form' && Array.isArray(op.agents) && op.agents.every((a) => typeof a === 'string')) {
      return broker.compose({ op: 'form', agents: op.agents as string[] });
    }
    if ((op.op === 'add' || op.op === 'remove') && typeof op.target === 'string' && typeof op.agent === 'string') {
      return broker.compose({ op: op.op, target: op.target, agent: op.agent });
    }
    return 'body must be {op:"form",agents:[..]} or {op:"add"|"remove",target,agent}';
  },
  {
    activity: (name) => broker.activity(name),
    steer: (name, message) => (message.trim() ? broker.steerWork(name, message) : Promise.resolve('steering message is empty')),
    cancel: (name) => broker.cancelWork(name),
  },
  {
    // Push-to-talk from UIs: one Deepgram session per client while the mic is held.
    start: (clientId) => {
      if (micSessions.has(clientId)) return;
      const stt = new DeepgramSttStream(makeDeepgramLive);
      stt.start((utterance) => {
        textChannel.broadcast({ type: 'utterance', text: utterance });
        handleUserText(utterance);
      });
      micSessions.set(clientId, stt);
    },
    audio: (clientId, pcm) => micSessions.get(clientId)?.sendAudio(pcm),
    stop: (clientId) => {
      micSessions.get(clientId)?.stop();
      micSessions.delete(clientId);
    },
  },
  {
    create: (title, workspace) => {
      if (workspace && !workspaceNames.includes(workspace)) return `unknown workspace: ${workspace}`;
      const s = sessionManager.create(workspace ?? sessionManager.active().workspace, title);
      brain.loadHistory(s.brainHistory);
      textChannel.broadcast(sessionFrame());
      return null;
    },
    activate: (id) => {
      const s = sessionManager.activate(id);
      if (!s) return `unknown session: ${id}`;
      brain.loadHistory(s.brainHistory);
      textChannel.broadcast(sessionFrame());
      return null;
    },
  },
  // Reset (settings): tiered and explicit. Runtime is killed on the swarm side
  // (remote workers are never touched); conversations and roster arrangements
  // are cleared here. Committed work — branches and PRs — always survives.
  // (reset handler)
  async (scope) => {
    const wants = {
      runtime: scope.runtime !== false,
      conversations: scope.conversations !== false,
      worktrees: Boolean(scope.worktrees),
      agents: Boolean(scope.agents),
    };
    const swarmReport = await swarm
      .reset({ runtime: wants.runtime, worktrees: wants.worktrees, agents: wants.agents })
      .catch((err: unknown) => ({ error: `swarm reset failed: ${String(err)}` }));

    if (wants.conversations) {
      for (const file of readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))) {
        rmSync(join(sessionsDir, file), { force: true });
      }
      const fresh = sessionManager.resetAll(workspaceNames[0] ?? 'default');
      brain.loadHistory(fresh.brainHistory);
    }
    await broker.resetComposition();
    textChannel.broadcast(sessionFrame());
    textChannel.broadcast({ type: 'roster', agents: toRosterEntries(broker.uiRoster()) });
    return { ok: true, scope: wants, swarm: swarmReport };
  },
  {
    // Agent creation: the swarm owns the registry, the broker owns voices.
    catalog: () => swarm.agentCatalog(),
    voices: async (query) => {
      if (!voiceCatalog) return { voices: [], hasMore: false, error: 'no ElevenLabs key configured' };
      return voiceCatalog.browse({
        search: query.search,
        gender: query.gender,
        language: query.language,
        page: query.page ? Number(query.page) : undefined,
      });
    },
    preview: async (voiceId, text) => {
      if (!voiceCatalog) throw new Error('no ElevenLabs key configured');
      return voiceCatalog.synthesize(voiceId, text);
    },
    create: async (body) => {
      const created = await swarm.createAgent(body);
      // Warm the cache so the new agent's fixed lines play instantly. Best
      // effort: a partial cache still beats none, and never blocks creation.
      const agent = created as {
        id?: string;
        voice?: { voiceId?: string };
        reactions?: Record<string, string[]>;
        quickAnswers?: Record<string, string>;
      };
      if (voiceCatalog && agent.voice?.voiceId) {
        const lines = [
          ...Object.values(agent.reactions ?? {}).flat(),
          ...Object.values(agent.quickAnswers ?? {}),
        ];
        const warm = await voiceCatalog.warmAgent(agent.voice.voiceId, lines).catch(() => ({ cached: 0, failed: [] }));
        // Roster refresh so the new agent appears immediately.
        await broker.resetComposition().catch(() => {});
        return { ...created, voiceCache: warm };
      }
      await broker.resetComposition().catch(() => {});
      return created;
    },
  },
);
const micSessions = new Map<number, DeepgramSttStream>();

// ElevenLabs audio for text-channel replies: synthesize each speech chunk with
// the speaking agent's voice and fan the mp3 out as an audio frame. Serialized
// so frames always arrive in speech order; each link swallows its own failure
// (a bad voice id or network blip degrades to text, never breaks the chain).
let synthChain = Promise.resolve();
function broadcastSpokenAudio(text: string): void {
  if (!tts) return;
  const { speaker, spokenText } = resolveSpokenLine(text);
  const voiceId = elevenVoiceFor(speaker);
  synthChain = synthChain.then(async () => {
    if (textChannel.clientCount === 0) return; // nobody listening — don't spend credits
    const synth = (id: string) =>
      tts.synthesize({ text: spokenText, personaId: speaker ?? 'broker', format: 'mp3', voice: { provider: 'elevenlabs', voiceId: id } });
    try {
      let result;
      try {
        result = await synth(voiceId);
      } catch (err) {
        const standIn = (speaker && PREMADE_STANDINS[speaker]) ?? PREMADE_DEFAULT;
        if (!/402|payment_required|paid_plan_required/.test(String(err)) || standIn === voiceId) throw err;
        console.error(`[tts] ${speaker ?? 'default'} voice needs a paid ElevenLabs plan — using premade stand-in`);
        result = await synth(standIn);
      }
      textChannel.broadcast({
        type: 'audio',
        speaker,
        mime: 'audio/mpeg',
        dataB64: Buffer.from(result.data).toString('base64'),
      });
    } catch (err) {
      console.error('[tts] elevenlabs synthesis failed:', err);
    }
  });
}

// Roster composition survives restarts — user-formed squads are arrangements, not session state.
const stateFile = process.env.BROKER_STATE_FILE ?? '.smith/roster-state.json';
const rosterStore = {
  load(): RosterState | null {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf8')) as RosterState;
    } catch {
      return null; // first run, or unreadable — start from the config baseline
    }
  },
  save(state: RosterState): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('[roster] persist failed:', err);
    }
  },
};

broker = new Broker(
  {
    swarm,
    directory,
    brain,
    rosterStore,
    makeStt: () => new DeepgramSttStream(makeDeepgramLive),
    makeBridge: () => new LiveKitRoomBridge(),
    speak,
    onSpeechText: (text) => {
      console.log(`[speech-text] ${text}`);
      sessionManager.appendTranscript('broker', text);
      textChannel.broadcast({ type: 'speech', text });
      broadcastSpokenAudio(text);
    },
    onRosterChange: (roster) => textChannel.broadcast({ type: 'roster', agents: toRosterEntries(roster) }),
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
const bootWorkspaces = await swarm.listWorkspaces().catch(() => []);
workspaceNames = bootWorkspaces.map((w) => w.name);
const activeSession = sessionManager.init(bootWorkspaces.find((w) => w.default)?.name ?? workspaceNames[0] ?? 'default');
brain.loadHistory(activeSession.brainHistory);
const textPort = await textChannel.start(config.textPort);
console.log(`[broker] running — polling swarm for open meetings. Text channel on http://127.0.0.1:${textPort}. Type a line to simulate an utterance.`);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  textChannel.broadcast({ type: 'utterance', text }); // stdin lines show up in UI transcripts too
  handleUserText(text);
});

process.on('SIGINT', () => {
  void Promise.all([broker.stop(), textChannel.stop()]).then(() => process.exit(0));
});
