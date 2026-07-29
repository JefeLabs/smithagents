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
import { Broker, TTS_SAMPLE_RATE } from './broker.ts';
import { AdapterHub } from './channels.ts';
import { loadBrokerConfig } from './config.ts';
import { createDiscordAdapter } from './discord-adapter.ts';
import { AgentDirectory } from './directory.ts';
import { LiveKitRoomBridge } from './room.ts';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RosterState, TurnOrigin, UiRoster } from './broker.ts';
// Type-only — erased at compile time, so this does NOT violate the voice
// module's lazy-boot gate below (nothing runtime-loads unless
// DISCORD_VOICE_CHANNELS is set; see setupDiscordVoice).
import type { DiscordVoiceOptions, VoiceConnectionLike, VoiceGatewayLike, VoiceReceiverLike } from './discord-voice.ts';
import type { PresenceEvent } from './voice-presence.ts';
import { LocalMemory, type MemoryEntry } from './memory.ts';
import { SessionManager, type Session } from './sessions.ts';
import { DeepgramSttStream, type LiveLike } from './stt.ts';
import { SwarmClient, type SwarmSquad, type WorkspaceBody } from './swarm-client.ts';
import { PersonaGenerator } from './persona-generator.ts';
import { VoiceCatalog } from './voice-catalog.ts';
import { TextChannel, type RosterEntry } from './text-channel.ts';
import { createRemovalService } from './removal.ts';
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

// Routes external channel (Discord, …) traffic through the same turn the app
// uses. resolveSpokenLineForChannels/handleUserText are `function`
// declarations further down this file — hoisted, so referencing them here
// ahead of their textual definition is safe.
//
// The hub gets its OWN pure resolver, not the stateful resolveSpokenLine used
// for TTS voice picking. resolveSpokenLine's `lastSpokenSpeaker` is a
// module-global that persists across every turn (meeting, system-note,
// Tauri, Discord alike); the hub already resets its own sticky speaker on
// every setActiveOrigin call (channels.ts), so feeding it a resolver with
// its own cross-turn memory would defeat that reset — an unprefixed first
// chunk of a new turn could resolve to whoever last spoke in ANY prior turn.
const adapterHub = new AdapterHub({
  resolveSpeaker: resolveSpokenLineForChannels,
  agents: () => directory.list().map((a) => ({ id: a.id, name: a.name, channels: a.channels })),
  submitUserText: handleUserText,
});

const tts = config.elevenlabsApiKey ? new ElevenLabsVoiceProvider({ apiKey: config.elevenlabsApiKey }) : null;
// Voice library browsing + the fixed-line audio cache (reactions, quick answers).
const voiceCatalog = config.elevenlabsApiKey
  ? new VoiceCatalog(config.elevenlabsApiKey, process.env.BROKER_VOICE_CACHE_DIR ?? '.smith/voice-cache')
  : null;
// Bound on a single TTS request. speak() runs inside the serialized turn
// queue (broker.ts's enqueueSpeech chain) — a hung ElevenLabs call with no
// deadline would park every subsequent turn, voice or text, until Node's
// underlying socket timeout finally gives up (minutes). 30s covers any
// legitimate sentence-length synthesis.
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 30_000);

// AbortSignal.timeout()'s firing surfaces as a `TimeoutError` DOMException
// (or, depending on where fetch/undici observes the abort, a generic
// `AbortError`) whose message is the unhelpful "The operation was aborted."
// Recognize either by name so the caller can rethrow something readable.
function isTtsTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

// Meeting TTS speaks with the per-agent cast — same voices as the app's audio
// frames. Falls back to a premade stand-in when a library voice is plan-gated.
async function* speak(text: string): AsyncIterable<Uint8Array> {
  if (!tts) {
    return; // no TTS configured — onSpeechText already surfaced the text
  }
  const { speaker, spokenText } = resolveSpokenLine(text);
  // Fresh AbortSignal.timeout(...) per call: the 402-fallback retry below
  // invokes attempt() a second time and must get its OWN timeout window, not
  // the first attempt's (already fired-or-consumed) signal.
  const attempt = (voiceId: string) =>
    tts.stream({
      text: spokenText,
      personaId: speaker ?? 'broker',
      format: 'pcm_s16le',
      sampleRate: TTS_SAMPLE_RATE,
      voice: { provider: 'elevenlabs', voiceId },
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
  const voiceId = elevenVoiceFor(speaker);
  try {
    for await (const chunk of attempt(voiceId)) yield chunk.data;
  } catch (err) {
    if (isTtsTimeout(err)) throw new Error(`TTS timed out after ${TTS_TIMEOUT_MS}ms — skipping this chunk`);
    const standIn = (speaker && PREMADE_STANDINS[speaker]) ?? PREMADE_DEFAULT;
    if (!/402|payment_required|paid_plan_required/.test(String(err)) || standIn === voiceId) throw err;
    try {
      for await (const chunk of attempt(standIn)) yield chunk.data;
    } catch (err2) {
      if (isTtsTimeout(err2)) throw new Error(`TTS timed out after ${TTS_TIMEOUT_MS}ms — skipping this chunk`);
      throw err2;
    }
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

// sampleRate defaults to 48000 (mic/meeting PTT's rate) so the existing
// `new DeepgramSttStream(makeDeepgramLive)` call sites below need no change;
// discord-voice.ts's ear also runs at 48000 (Discord's receive rate) but
// passes it explicitly rather than relying on the default matching by
// coincidence — see makeVoiceStt below.
function makeDeepgramLive(sampleRate = 48000): LiveLike {
  type Socket = Awaited<ReturnType<typeof deepgram.listen.v1.connect>>;
  let socket: Socket | null = null;
  let resultsCb: ((data?: unknown) => void) | null = null;
  const pending: Uint8Array[] = [];
  let closed = false;

  const ready: Promise<Socket | null> = deepgram.listen.v1
    .connect({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: sampleRate,
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
  remember: (input) => broker.executors.remember(input),
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

// Crew memory — durable facts recalled into every turn. One inspectable JSON
// file; the crew's continuity across conversations lives here.
const memoryFile = process.env.BROKER_MEMORY_FILE ?? '.smith/memory.json';
const memory = new LocalMemory({
  load(): MemoryEntry[] {
    try {
      return JSON.parse(readFileSync(memoryFile, 'utf8')) as MemoryEntry[];
    } catch {
      return [];
    }
  },
  save(entries: MemoryEntry[]): void {
    try {
      mkdirSync(dirname(memoryFile), { recursive: true });
      writeFileSync(memoryFile, JSON.stringify(entries, null, 2));
    } catch (err) {
      console.error('[memory] persist failed:', err);
    }
  },
});

// One model call fills the whole creation wizard (structured output).
const personaGenerator = new PersonaGenerator(anthropic as never);

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

// Pure, stateless counterpart for the AdapterHub: parses the same "Name: …"
// prefix but carries no memory between calls. The hub owns its own per-turn
// sticky speaker (channels.ts's `lastSpeaker`, reset on every
// setActiveOrigin) — this resolver must never supply state of its own, or
// that reset is defeated.
function resolveSpokenLineForChannels(text: string): { speaker?: string; spokenText: string } {
  const parsed = SPEAKER_RE.exec(text);
  return { speaker: parsed?.[1], spokenText: parsed?.[2] ?? text };
}

function elevenVoiceFor(speaker?: string): string {
  return (speaker && (directory.resolve(speaker)?.voice?.voiceId ?? SQUAD_VOICES[speaker])) ?? DEFAULT_ELEVEN_VOICE;
}

const GROUP_RING_PALETTE = ['#5fd0b0', '#f2778f', '#9b8cff', '#f2b04a', '#6f8dff', '#d977c8'];

const toRosterEntries = (roster: UiRoster): RosterEntry[] => {
  // Names are matched case-insensitively: the brain and the human both say
  // "manuel" and "Manuel", and a listening ring that depends on casing would
  // light up unpredictably.
  const addressed = new Set(roster.listening.map((n) => n.toLowerCase()));
  const isListening = (...names: Array<string | undefined>) =>
    names.some((n) => n !== undefined && addressed.has(n.toLowerCase())) || undefined;
  return [
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
      listening: isListening(p.agent.name),
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
      // A squad listens when addressed by its id or through its leader.
      listening: isListening(s.id, s.leader.name),
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
      listening: isListening(m.name),
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
      listening: isListening(g.name, g.members[0]?.name),
      members: g.members.map((m) => m.name),
    }),
  ),
  ];
};

// Text I/O for UIs (Tauri control plane): POST /utterance in, WS transcript +
// live roster out. New clients get capabilities + a roster snapshot on connect.
// Same TDZ note as the executors above — the closures run long after assignment.
// A user line from any input (HTTP, stdin, mic) lands in the active session's
// transcript, runs a brain turn, then persists the brain's memory.
function handleUserText(text: string, origin?: TurnOrigin): void {
  // Every other inbound path (HTTP /utterance, mic PTT, stdin) already
  // broadcasts the utterance frame at its own entry point before reaching
  // here. Channel-originated text (Discord, …) has no such entry point of
  // its own — the hub calls straight into this function — so this is the
  // one place to do it for that path, matching the existing frame shape.
  if (origin) textChannel.broadcast({ type: 'utterance', text });
  sessionManager.appendTranscript('user', text);
  void broker.handleUtterance(text, origin).then(() => sessionManager.saveBrainHistory(brain.exportHistory()));
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

// Re-fetch workspace names (active only — archived workspaces can't host new
// sessions) and re-push the session frame that carries them to every client.
async function refreshWorkspaceNames(): Promise<void> {
  workspaceNames = (await swarm.listWorkspaces().catch(() => [])).filter((w) => !w.archived).map((w) => w.name);
  await broker.refreshWorkspaces();
  textChannel.broadcast(sessionFrame());
}

// One remove intent for agents: the broker decides archive-vs-delete from
// cross-service evidence (transcript speech, warm sessions, running tasks),
// then reseeds the directory and pushes a fresh roster — same refresh path
// agent creation already drives.
const removal = createRemovalService({
  registry: () => swarm.registry(),
  agentUsage: (id) => swarm.agentUsage(id),
  deleteAgent: (id) => swarm.deleteAgent(id),
  archiveAgent: (id) => swarm.archiveAgent(id),
  sessions: () => sessionManager.allSessions(),
  onChanged: () => broker.resetComposition(),
});

// Workspace CRUD for the manager UI. remove() mirrors removal.execute's
// evidence-then-decide shape: any session parked in the workspace, or an
// active swarm task inside it, means archive; otherwise it's safe to delete.
const workspaces = {
  list: () => swarm.listWorkspaces() as unknown as Promise<Record<string, unknown>[]>,
  save: async (body: Record<string, unknown>, isNew: boolean): Promise<Record<string, unknown>> => {
    try {
      const result = isNew
        ? await swarm.createWorkspace(body as unknown as WorkspaceBody)
        : await swarm.updateWorkspace(String(body.name), body as Partial<WorkspaceBody>);
      await refreshWorkspaceNames();
      return result as unknown as Record<string, unknown>;
    } catch (err) {
      return { error: String((err as Error).message) };
    }
  },
  remove: async (name: string): Promise<Record<string, unknown>> => {
    try {
      const inUse =
        sessionManager.allSessions().some((s) => s.workspace === name) ||
        (await swarm.workspaceUsage(name)).activeTasks > 0;
      if (inUse) await swarm.archiveWorkspace(name);
      else await swarm.deleteWorkspace(name);
      await refreshWorkspaceNames();
      return { outcome: inUse ? 'archived' : 'deleted' };
    } catch (err) {
      return { error: String((err as Error).message) };
    }
  },
};

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
    records: async () => (await swarm.registry()) as unknown as Record<string, unknown>[],
    update: (id, body) => swarm.updateAgent(id, body),
    generate: async (body) => {
      const b = body as Record<string, string>;
      const catalog = (await swarm.agentCatalog()) as {
        stereotypes?: Array<{ id: string; label: string; style: string }>;
        jobRoles?: Array<{ id: string; label: string; directives: string }>;
        quickQuestions?: Array<{ id: string; question: string }>;
        reactionLevels?: string[];
        languages?: Array<{ id: string; label: string; speech: string }>;
      };
      const stereotype = catalog.stereotypes?.find((s) => s.id === b.stereotype);
      const jobRole = catalog.jobRoles?.find((r) => r.id === b.jobRole);
      const crew = directory.snapshot().map((p) => `${p.agent.name} (${p.agent.role})`);
      const draft = await personaGenerator.generate({
        stereotypeLabel: stereotype?.label,
        stereotypeStyle: stereotype?.style,
        jobRoleLabel: jobRole?.label,
        jobRoleDirectives: jobRole?.directives,
        gender: b.gender,
        hint: b.hint,
        // The chosen primary language decides how every generated line sounds.
        speech: catalog.languages?.find((l) => l.id === b.language)?.speech,
        crewContext: crew.join(', '),
        existingNames: directory.snapshot().map((p) => p.agent.name),
        reactionLevels: catalog.reactionLevels ?? [],
        quickQuestions: catalog.quickQuestions ?? [],
      });
      return draft as unknown as Record<string, unknown>;
    },
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
  removal,
  workspaces,
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
    memory,
    memoryScope: () => {
      const active = sessionManager.active();
      return { workspace: active.workspace, session: active.id };
    },
    rosterStore,
    makeStt: () => new DeepgramSttStream(makeDeepgramLive),
    makeBridge: () => new LiveKitRoomBridge(),
    speak,
    onSpeechText: (text) => {
      console.log(`[speech-text] ${text}`);
      sessionManager.appendTranscript('broker', text);
      textChannel.broadcast({ type: 'speech', text });
      broadcastSpokenAudio(text);
      adapterHub.dispatchSpeech(text);
    },
    // Turn-scoped: activates the hub's origin for exactly the turn now
    // running, so external delivery can never leak across turns or into a
    // meeting-sourced turn (which passes no origin — see channels.ts).
    onTurnStart: (origin) => adapterHub.setActiveOrigin(origin),
    onTurnEnd: () => adapterHub.setActiveOrigin(undefined),
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
const bootWorkspaces = (await swarm.listWorkspaces().catch(() => [])).filter((w) => !w.archived);
workspaceNames = bootWorkspaces.map((w) => w.name);
const activeSession = sessionManager.init(bootWorkspaces.find((w) => w.default)?.name ?? workspaceNames[0] ?? 'default');
brain.loadHistory(activeSession.brainHistory);
const textPort = await textChannel.start(config.textPort);
console.log(`[broker] running — polling swarm for open meetings. Text channel on http://127.0.0.1:${textPort}. Type a line to simulate an utterance.`);

// Discord attends only when a token is present — the all-local invariant:
// nothing about Discord constructs or logs without DISCORD_TOKEN set.
const discordToken = process.env.DISCORD_TOKEN;
if (discordToken) {
  const allowlist = (process.env.DISCORD_CHANNELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowlist.length === 0) {
    console.error('[discord] DISCORD_TOKEN is set but DISCORD_CHANNELS is empty — the crew would attend nowhere. Adapter not started.');
  } else {
    void createDiscordAdapter({
      token: discordToken,
      allowlist,
      onUtterance: (u) => adapterHub.onUtterance('discord', u),
    }).then(
      ({ adapter }) => {
        adapterHub.register(adapter);
        console.log(`[discord] crew attending ${allowlist.length} channel(s)`);
      },
      (err) => console.error(`[discord] failed to start: ${String(err)}`),
    );
  }
}

/**
 * Discord voice attends only when DISCORD_VOICE_CHANNELS names at least one
 * channel — same all-local invariant as the text adapter's DISCORD_TOKEN
 * gate. Every voice-only module (discord-voice.ts, discord-audio.ts,
 * discord.js, @discordjs/voice) is dynamic-imported from inside this
 * function, so an unset/empty env var means none of it ever loads.
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
async function setupDiscordVoice(allowlist: string[]): Promise<void> {
  const ffmpegCheck = spawnSync('ffmpeg', ['-version']);
  if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
    console.error('[discord-voice] ffmpeg not found on PATH — voice disabled (install ffmpeg to enable Discord voice).');
    return;
  }
  const earToken = process.env.DISCORD_TOKEN;
  if (!earToken) {
    console.error('[discord-voice] DISCORD_VOICE_CHANNELS is set but DISCORD_TOKEN is empty — the ear has no bot identity. Voice disabled.');
    return;
  }

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
  const designated = directory.list().filter((a) => a.channels?.includes('discord-voice'));
  const mouths = designated.filter((a) => agentTokens.has(a.id)).map((a) => a.id);
  const degraded = designated.filter((a) => !agentTokens.has(a.id)).map((a) => a.id);
  console.log(`[discord-voice] ear starting — ${allowlist.length} channel(s) allowlisted`);
  console.log(`[discord-voice] agent mouths (own bot token): ${mouths.length ? mouths.join(', ') : '(none)'}`);
  console.log(`[discord-voice] agents degraded (share the ear): ${degraded.length ? degraded.join(', ') : '(none)'}`);

  const earClient = new DiscordClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  await earClient.login(earToken);

  // Receiver proxy: see the module-level doc comment above setupDiscordVoice
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
    async join(channelId: string, token: string): Promise<VoiceConnectionLike> {
      if (token !== earToken) return fallbackGateway.join(channelId, token);

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
        adapterCreator: channel.guild.voiceAdapterCreator,
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
      realReceiver(connection.receiver, channel.guild).onSpeakingStart((userId, displayName, isBot, pcm) => {
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
    agents: () => directory.list().map((a) => ({ id: a.id, channels: a.channels })),
    gateway: earAwareGateway,
    log: (line) => console.log(line),
    // No origin — voice turns are meeting-shaped, matching mic PTT/stdin.
    onUtterance: (text) => handleUserText(text),
    // Rate-parameterized: discord-voice.ts always calls this with 48000
    // (Discord's receive rate), but the value is threaded through honestly
    // rather than relying on makeDeepgramLive's default matching by luck.
    makeStt: (sampleRate) => new DeepgramSttStream(() => makeDeepgramLive(sampleRate)),
    receiver: receiverProxy,
  } satisfies DiscordVoiceOptions);

  const presence = new VoicePresence(allowlist);

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
      if (!broker.attachVoiceSurface(surface)) {
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
        const designatedCount = directory.list().filter((a) => a.channels?.includes('discord-voice')).length;
        const degradedCount = designatedCount - connectedCount;
        console.log(
          `[discord-voice] joined ${action.channelId} — ear + ${connectedCount} agent mouth(s)` +
            (degradedCount > 0 ? `, ${degradedCount} degraded` : ''),
        );
      } catch (err) {
        console.error(`[discord-voice] join failed for ${action.channelId}: ${String(err)}`);
        broker.detachVoiceSurface();
        presence.handle({ type: 'join-failed', channelId: action.channelId }, humanCountFor);
      }
    } else if (action.type === 'leave-crew') {
      await surface.leaveAll();
      broker.detachVoiceSurface();
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
}

const voiceChannelAllowlist = (process.env.DISCORD_VOICE_CHANNELS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (voiceChannelAllowlist.length > 0) {
  await setupDiscordVoice(voiceChannelAllowlist).catch((err) => console.error(`[discord-voice] failed to start: ${String(err)}`));
}

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
