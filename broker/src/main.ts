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
import { createDiscordTextLifecycle } from './discord-text-lifecycle.ts';
import { createDiscordVoiceLifecycle } from './discord-voice-lifecycle.ts';
import { createDiscordWorkspaceSwitcher } from './discord-workspace-switcher.ts';
import { AgentDirectory } from './directory.ts';
import { LiveKitRoomBridge } from './room.ts';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RosterState, TurnOrigin, UiRoster } from './broker.ts';
// Type-only — erased at compile time, so this does NOT violate
// discord-voice-lifecycle.ts's own lazy-boot gate (nothing voice-specific
// runtime-loads unless the active workspace's own Discord config has voice
// channels configured; see that module's header).
import type { createDiscordVoiceSurface } from './discord-voice.ts';
import type { VoicePresence } from './voice-presence.ts';
import { applyModeChange, decideJoin, surfaceModes, SurfacePolicy } from './surface-modes.ts';
import { LocalMemory, type MemoryEntry } from './memory.ts';
import { SessionManager, type Session } from './sessions.ts';
import { DeepgramSttStream, type LiveLike, deepgramLiveOptions } from './stt.ts';
import { SwarmClient, type SwarmSquad, type WorkspaceBody } from './swarm-client.ts';
import { PersonaGenerator } from './persona-generator.ts';
import { VoiceCatalog } from './voice-catalog.ts';
import { TextChannel, type RosterEntry } from './text-channel.ts';
import { createRemovalService } from './removal.ts';
import { mintRoomToken } from './token.ts';
import { isDiscordTextActive } from './discord-state.ts';

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
// Shared presence policy (surface-modes): the single source of truth for
// which external surfaces each agent attends. Wired into adapter text
// delivery and the Discord join endpoint; the tauri roster is never gated.
const policy = new SurfacePolicy(() => directory.list());
// Null until discordWorkspaceSwitcher (below) boots voice for the active
// workspace's own Discord config, and assigned there once the real
// surface/presence exist. The agent-PUT wrapper below closes over these
// names, so a wrapper built before boot still reaches the live
// surface/presence once they're assigned.
let voiceSurface: ReturnType<typeof createDiscordVoiceSurface> | null = null;
let voicePresence: VoicePresence | null = null;
// Discord-text's own "is it active" state is NOT held as a local flag here —
// isDiscordTextActive(discordTextLifecycle), imported above, reads
// discordTextLifecycle.activeDiscordText directly. Boot itself is
// workspace-driven (discordWorkspaceSwitcher, below) and can change on every
// session activation/create, not just once at startup, so there's no single
// point where a cached flag could be safely assigned.

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
adapterHub.attendsPolicy = (agentId, kind) => policy.attends(agentId, kind);

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

  // Record<string, unknown> can't structurally satisfy the SDK's ConnectArgs; the payload shape is pinned by stt.test.ts.
  const ready: Promise<Socket | null> = deepgram.listen.v1
    .connect(deepgramLiveOptions(sampleRate) as any)
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
  // Scoped to the current conversation's workspace only — never model-choosable, unlike delegate's optional workspace.
  lookup_ticket: (input) => broker.executors.lookup_ticket({ ...input, workspace: sessionManager.active().workspace }),
  search_docs: (input) => broker.executors.search_docs({ ...input, workspace: sessionManager.active().workspace }),
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
  // The tauri app is the management console: every agent always appears in
  // its roster. Surface attendance (SurfacePolicy) gates Discord only.
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
  verifyAtlassian: (name: string) => swarm.verifyWorkspaceAtlassian(name) as unknown as Promise<Record<string, unknown>>,
  verifyGithubRepo: (name: string, repoName: string) =>
    swarm.verifyRepoGithub(name, repoName) as unknown as Promise<Record<string, unknown>>,
};

// The current operator's profile + credentials (account panel): swarm holds
// the record (redacted on read — tokens never round-trip to the UI), this is
// a thin passthrough matching every other TextChannel dependency's shape.
const me = {
  get: () => swarm.getMe() as unknown as Promise<Record<string, unknown>>,
  update: (body: Record<string, unknown>) =>
    swarm.updateMe(body as { name?: string }) as unknown as Promise<
      Record<string, unknown>
    >,
};

// Per-workspace Discord channel config (channels manager UI): same thin
// passthrough shape as `me`, origin-restricted the same way.
const channels = {
  get: (name: string) => swarm.getWorkspaceChannels(name) as unknown as Promise<Record<string, unknown>>,
  save: (name: string, body: Record<string, unknown>) =>
    swarm.saveWorkspaceChannels(name, body as { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } }) as unknown as Promise<
      Record<string, unknown>
    >,
  verifyDiscord: (name: string) => swarm.verifyWorkspaceDiscord(name) as unknown as Promise<Record<string, unknown>>,
};

// Connector registry (Integrations settings group): same thin passthrough
// shape as `me`/`channels`, origin-restricted the same way.
const connectors = {
  vendors: () => swarm.getConnectorVendors() as unknown as Promise<Record<string, unknown>[]>,
  list: () => swarm.getMyConnectors() as unknown as Promise<Record<string, unknown>[]>,
  add: (body: Record<string, unknown>) =>
    swarm.addConnector(body as { vendorId: string; label: string; fields: Record<string, string> }) as unknown as Promise<
      Record<string, unknown>
    >,
  update: (id: string, body: Record<string, unknown>) =>
    swarm.updateConnector(id, body as { label?: string; fields?: Record<string, string> }) as unknown as Promise<
      Record<string, unknown>
    >,
  remove: (id: string) => swarm.deleteConnector(id) as unknown as Promise<Record<string, unknown>>,
  verify: (id: string, extra?: Record<string, string>) =>
    swarm.verifyConnector(id, extra) as unknown as Promise<Record<string, unknown>>,
};

// Task status passthrough for the external bridge (broker/bin/smith-broker-check.mjs).
const tasks = {
  get: (taskId: string) => swarm.getTask(taskId) as unknown as Promise<Record<string, unknown> | null>,
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
      void discordWorkspaceSwitcher
        .switchDiscordForWorkspace(s.workspace)
        .catch((err: unknown) => console.error(`[discord] workspace switch failed for "${s.workspace}": ${String(err)}`));
      textChannel.broadcast(sessionFrame());
      return null;
    },
    activate: (id) => {
      const s = sessionManager.activate(id);
      if (!s) return `unknown session: ${id}`;
      brain.loadHistory(s.brainHistory);
      void discordWorkspaceSwitcher
        .switchDiscordForWorkspace(s.workspace)
        .catch((err: unknown) => console.error(`[discord] workspace switch failed for "${s.workspace}": ${String(err)}`));
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
      // Reset can change the active workspace (falls back to workspaceNames[0])
      // — matches every other place that changes it (create/activate above,
      // boot-time init below): without this, a reset out of a workspace with
      // Discord configured would leave that connection live, still routing
      // into whatever session is now active.
      void discordWorkspaceSwitcher
        .switchDiscordForWorkspace(fresh.workspace)
        .catch((err: unknown) => console.error(`[discord] workspace switch failed after reset: ${String(err)}`));
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
    update: async (id, body) => {
      // Fail open on the BEFORE read: this registry read did not exist before
      // this wrapper, so a transient read hiccup must never block a PUT that
      // previously had zero read dependency. `before === null` means "no
      // reliable diff possible" — enforcement below falls back to
      // restrictive-only (never guesses at a join; see the `before` branch
      // further down) — the write itself still proceeds either way.
      let before: ReturnType<typeof surfaceModes> | null = null;
      try {
        before = surfaceModes((await swarm.registry()).find((a) => a.id === id) ?? {});
      } catch (err) {
        console.error(`[surface-modes] pre-PUT registry read failed for ${id}; write proceeds, enforcement falls back to restrictive-only: ${String(err)}`);
      }
      const result = await swarm.updateAgent(id, body);
      if (!result.error) {
        // The write already succeeded and persisted by this point — nothing
        // below may reject the update promise or override `result`; every
        // failure here is logged and swallowed, never surfaced to the client.
        try {
          let after: ReturnType<typeof surfaceModes>;
          try {
            const registryAfterPut = await swarm.registry();
            after = surfaceModes(registryAfterPut.find((a) => a.id === id) ?? {});
            // directory is otherwise seeded only at broker start() and
            // resetComposition() (broker.ts) — never on an individual PUT,
            // and the 2s poll timer doesn't touch it either. Reusing the
            // registry read this PUT already made to re-seed here (same
            // archived filter as those two call sites) is what keeps
            // SurfacePolicy (which reads directory.list()) from enforcing a
            // STALE pre-PUT mode: without this, Discord text would keep
            // relaying a disabled agent, and the next crew VC join would use
            // stale designation (an ejected agent comes back when the crew
            // rejoins). Broadcast afterward matches every other
            // roster-changing path's own frame.
            directory.seed(registryAfterPut.filter((a) => !a.archived));
            textChannel.broadcast({ type: 'roster', agents: toRosterEntries(broker.uiRoster()) });
          } catch (err) {
            // Registry outage right after a successful write: fall back to
            // deriving the after-map from the PUT body itself. This is
            // genuinely correct for the SurfacePolicyPopover's PUT
            // (useSurfacePolicy.ts's setMode sends the full stored record
            // plus the updated channels) and for swarm's own merge
            // (buildAgentUpdate: channels: b.channels ?? existing.channels).
            // The remaining exposure is narrower: a client that omits
            // `channels` on its PUT body — today, the edit wizard
            // (AddAgentModal.tsx) — hits the legacy absent-channels default
            // (discord-voice: disabled) here instead of its real persisted
            // channels, if this exact read fails. Also: the directory.seed()
            // above did NOT run on this path (no fresh registry list to seed
            // from), so it stays stale until some other PUT's AFTER read
            // succeeds — there is no poll that corrects this on its own.
            console.error(`[surface-modes] AFTER registry read failed for ${id}; enforcement uses the PUT body as the after-map: ${String(err)}`);
            after = surfaceModes(body);
          }

          if (before) {
            await applyModeChange(
              {
                leaveAgent: (agentId) => voiceSurface?.leaveAgent(agentId),
                joinAgent: async (agentId) => {
                  await voiceSurface?.joinAgent(agentId);
                },
                roomActive: () => voiceSurface !== null && voicePresence !== null && voicePresence.joinedChannel() !== null,
                revoke: (agentId, surface) => policy.revoke(agentId, surface),
                log: (line) => console.log(line),
              },
              id,
              before,
              after,
            );
          } else {
            // BEFORE was unknowable (its registry read failed): no reliable
            // diff exists, so never guess at a JOIN (the permissive side —
            // skipping it is safe). An explicit disable must never silently
            // no-op just because a read hiccuped, though, so run
            // restrictive-only enforcement off the after-map alone: revoke
            // every non-autojoin surface, and eject from voice if it's
            // explicitly disabled.
            for (const [surface, mode] of Object.entries(after)) {
              if (mode !== 'autojoin') policy.revoke(id, surface);
            }
            if (after['discord-voice'] === 'disabled') voiceSurface?.leaveAgent(id);
          }
        } catch (err) {
          console.error(`[surface-modes] enforcement skipped after PUT ${id}: ${String(err)}`);
        }
      }
      return result;
    },
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
  {
    presence: () => {
      const out: Record<string, Record<string, boolean>> = {};
      const voiceIds = new Set(voiceSurface?.connectedAgentIds() ?? []);
      for (const a of directory.list()) {
        out[a.id] = {
          discord: isDiscordTextActive(discordTextLifecycle) && policy.attends(a.id, 'discord'),
          'discord-voice': voiceIds.has(a.id),
        };
      }
      return out;
    },
    info: () => ({ configured: isDiscordTextActive(discordTextLifecycle), voiceReady: voiceSurface !== null }),
    join: async (agentId, surface) => {
      if (surface === 'discord-voice') {
        // Mode check first: an explicitly disabled agent must never end up
        // in the VC just because it holds a minted bot token.
        const decision = decideJoin(agentId, surface, policy.modeFor(agentId, surface));
        if (decision.type === 'reject') return { error: decision.error, status: decision.status };
        if (!voiceSurface) return { error: 'Discord voice is not configured', status: 409 };
        try {
          await voiceSurface.joinAgent(agentId);
        } catch (err) {
          return { error: String(err instanceof Error ? err.message : err), status: 409 };
        }
        // autojoin needs no admission (it already attends by mode alone);
        // only on-request records one.
        if (decision.type === 'admit') policy.admit(agentId, surface);
        return { ok: true } as const;
      }
      if (surface !== 'discord') return { error: `unknown surface: ${surface}`, status: 404 };
      const decision = decideJoin(agentId, surface, policy.modeFor(agentId, surface));
      if (decision.type === 'reject') return { error: decision.error, status: decision.status };
      if (surface === 'discord' && !isDiscordTextActive(discordTextLifecycle)) return { error: 'Discord is not configured', status: 409 };
      if (decision.type === 'admit') policy.admit(agentId, surface);
      return { ok: true } as const;
    },
  },
  me,
  channels,
  connectors,
  tasks,
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
    onTaskDispatched: (d) => textChannel.broadcast({ type: 'task-dispatched', taskId: d.taskId, agent: d.agent, task: d.task }),
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

// Discord attends only when a workspace has its own bot token configured (via
// the Task 6 channels manager UI) — the all-local invariant now flows through
// swarm.getWorkspaceDiscordConfig() per workspace rather than a single
// process-wide DISCORD_TOKEN. discordTextLifecycle/discordVoiceLifecycle hold
// the per-surface boot/teardown logic (Tasks 7-8); discordWorkspaceSwitcher
// (Task 9) is what actually decides WHEN each fires — once at boot, and again
// on every session activation/create below, since switching the active
// session can switch the active workspace.
// TDZ note: discordTextLifecycle/discordVoiceLifecycle/discordWorkspaceSwitcher
// below are non-hoisted `const`s assigned AFTER `await textChannel.start()`
// above, yet closures registered earlier (sessions.activate/create,
// surfaces.presence/info/join) already reference them — safe only because
// there's no `await` between textChannel.start() resolving and these three
// consts being assigned, so no event-loop turn can deliver a request into
// that window. Keep it that way: an `await` inserted in between would let an
// early request hit a ReferenceError.
const discordTextLifecycle = createDiscordTextLifecycle({ hub: adapterHub });
// setupDiscordVoice's full body (the earAwareGateway reconciliation,
// presence-driven join/leave, and its teardown closure) lives in
// discord-voice-lifecycle.ts — see that module's header for why, and its
// exported bootDiscordVoice's own doc comment for the ear-connection
// reconciliation.
const discordVoiceLifecycle = createDiscordVoiceLifecycle({
  directory,
  policy,
  broker,
  onUtterance: (text) => handleUserText(text),
  // Rate-parameterized: discord-voice.ts always calls this with 48000
  // (Discord's receive rate), but the value is threaded through honestly
  // rather than relying on makeDeepgramLive's default matching by luck.
  makeStt: (sampleRate) => new DeepgramSttStream(() => makeDeepgramLive(sampleRate)),
  onSurfaceChange: (surface, presence) => {
    voiceSurface = surface;
    voicePresence = presence;
  },
});
const discordWorkspaceSwitcher = createDiscordWorkspaceSwitcher({ swarm, discordTextLifecycle, discordVoiceLifecycle });
void discordWorkspaceSwitcher
  .switchDiscordForWorkspace(activeSession.workspace)
  .catch((err: unknown) => console.error(`[discord] initial workspace connect failed: ${String(err)}`));

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
