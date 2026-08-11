/**
 * Composition root — the only file that builds real SDK clients. Also runs
 * the stdin dev channel: every line typed is treated as a spoken utterance,
 * so the full brain -> delegate -> TTS pipeline is testable without a mic.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import { DeepgramClient } from "@deepgram/sdk";
import { ElevenLabsVoiceProvider } from "@smithagents/voice";
import { BrokerAuth } from "./auth.ts";
import { resolveAvatarEngine } from "./avatar-engine.ts";
import { AvatarGenerator, type AvatarRequest } from "./avatar-generator.ts";
import { loadBlueprints } from "./blueprints.ts";
import { BrokerBrain, type StreamFactory } from "./brain.ts";
import type { RosterState, TurnOrigin, UiRoster } from "./broker.ts";
import { Broker, TTS_SAMPLE_RATE } from "./broker.ts";
import { AdapterHub } from "./channels.ts";
import { loadBrokerConfig } from "./config.ts";
import { AgentDirectory } from "./directory.ts";
import { isDiscordTextActive } from "./discord-state.ts";
import { createDiscordTextLifecycle } from "./discord-text-lifecycle.ts";
// Type-only — erased at compile time, so this does NOT violate
// discord-voice-lifecycle.ts's own lazy-boot gate (nothing voice-specific
// runtime-loads unless the active workspace's own Discord config has voice
// channels configured; see that module's header).
import type { createDiscordVoiceSurface } from "./discord-voice.ts";
import { createDiscordVoiceLifecycle } from "./discord-voice-lifecycle.ts";
import { createDiscordWorkspaceSwitcher } from "./discord-workspace-switcher.ts";
import { type Doc, DocumentManager } from "./documents.ts";
import { type AskFactory, ElectionScheduler, runElection } from "./election.ts";
import { EXEC_TO_RUNTIME, isExecutionMode } from "./execution-modes.ts";
import { approve, repoKey } from "./feeds/approve.ts";
import { latestFromAtom } from "./feeds/atom-release.ts";
import { parseBundle } from "./feeds/bundle.ts";
import { cardForRelease } from "./feeds/cards.ts";
import { deriveSources } from "./feeds/derive.ts";
import { buildDigest } from "./feeds/digest.ts";
import { startDiscovery } from "./feeds/discovery.ts";
import { dueSources, recordOutcome } from "./feeds/ingest.ts";
import { ownerRole } from "./feeds/interests.ts";
import { readManifests } from "./feeds/manifests.ts";
import { diffBundle } from "./feeds/rediscover.ts";
import { parseFeed, youtubeFeedUrl } from "./feeds/rss.ts";
import { FeedStore } from "./feeds/store.ts";
import { slugify, type Topic, TopicStore } from "./feeds/topics.ts";
import type { FeedItem, FeedSource } from "./feeds/types.ts";
import { urlRejectionReason } from "./feeds/url-guard.ts";
import {
  classifyBump,
  type Ecosystem,
  githubAtomUrl,
  latestVersion,
  mentionsSecurity,
  qualifies,
  repositoryUrl,
} from "./feeds/versions.ts";
import { weatherLine, weatherUrl } from "./feeds/weather.ts";
import { loadIdentity, promptInfo } from "./identity.ts";
import { LocalMemory, type MemoryEntry } from "./memory.ts";
import { MicSessionGate } from "./mic-gate.ts";
import { draftToAgentBody, type PersonaDraft, PersonaGenerator } from "./persona-generator.ts";
import { polishText } from "./polish.ts";
import { createRemovalService } from "./removal.ts";
import { LiveKitRoomBridge } from "./room.ts";
import { generateSessionTitle } from "./session-title.ts";
import { type ExecutionMode, resolveLazyWorkspace, type Session, SessionManager, truncateTitle } from "./sessions.ts";
import { DeepgramSttStream, deepgramLiveOptions, type LiveLike } from "./stt.ts";
import { applyModeChange, decideJoin, SurfacePolicy, surfaceModes } from "./surface-modes.ts";
import { SwarmClient, type SwarmWorkspace, type WorkspaceBody } from "./swarm-client.ts";
import { parseTarget, resolveTarget } from "./targets.ts";
import { type ChannelFrame, type RosterEntry, TextChannel } from "./text-channel.ts";
import { mintRoomToken } from "./token.ts";
import { VoiceCatalog } from "./voice-catalog.ts";
import { VOICE_STT_HINT, VOICE_TTS_HINT, VoiceKeyResolver } from "./voice-keys.ts";
import type { VoicePresence } from "./voice-presence.ts";

// Defense in depth: the brain-turn queue in broker.ts isolates errors from
// every turn it runs, but this catches anything outside that queue so a
// stray rejection never takes the whole process down under Node defaults.
process.on("unhandledRejection", (err) => console.error("[broker] unhandled rejection:", err));

const config = loadBrokerConfig();

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const streamFactory: StreamFactory = (params) =>
  anthropic.messages.stream(params as Parameters<typeof anthropic.messages.stream>[0]);

const swarm = new SwarmClient({ baseUrl: config.swarm.baseUrl, token: config.swarm.token });

// Portrait generation resolved per request (spec §Avatar generation):
// verified google key (api-keys store, or legacy .env) accelerates to the
// Gemini API; otherwise agy (if active per the CLI registry) covers the
// subscription path; neither → the wizard's Generate button shows the two
// remedies (see avatarGen catalog flag below).
const avatarEngine = () =>
  resolveAvatarEngine({
    getGoogleKey: async () => {
      if (config.geminiApiKey) return config.geminiApiKey; // legacy .env still honored
      const r = await swarm.getApiKeyCredential("google").catch(() => ({ error: "swarm unreachable" }) as const);
      return "key" in r && r.key ? r.key : null;
    },
    isAgyActive: async () => {
      const r = (await swarm.listCliTools().catch(() => null)) as {
        tools?: Array<{ cli: string; active: boolean }>;
      } | null;
      return Boolean(r?.tools?.find((t) => t.cli === "agy")?.active);
    },
  });
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

const voiceKeys = new VoiceKeyResolver(swarm);
// Prime the cache at boot: the first client to hit GET /agents or open the WS
// (its hello frame's config.audio) reads statusSync()'s cold snapshot
// otherwise, which is always {stt:false,tts:false} until the 20s TTL's
// background refresh happens to land — the mic stays dimmed/hidden and
// audioMode stays off for that connection's whole lifetime even with both
// keys configured. Best-effort: the resolver already keeps last-good on
// failure and never rejects (see refresh()), so no error handling here.
void voiceKeys.status();

// Both classes bind the key in their constructors, so "rebuilt only when the
// key changes" (spec §4) is a memoized {key, provider, catalog} triple, not a
// per-call key thread.
let ttsCache: { key: string; provider: ElevenLabsVoiceProvider; catalog: VoiceCatalog } | null = null;
async function currentTts(): Promise<{ provider: ElevenLabsVoiceProvider; catalog: VoiceCatalog } | null> {
  const key = await voiceKeys.ttsKey();
  if (!key) {
    ttsCache = null;
    return null;
  }
  if (ttsCache?.key !== key) {
    ttsCache = {
      key,
      provider: new ElevenLabsVoiceProvider({ apiKey: key }),
      catalog: new VoiceCatalog(key, process.env.BROKER_VOICE_CACHE_DIR ?? ".smith/voice-cache"),
    };
  }
  return ttsCache;
}

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
  return name === "TimeoutError" || name === "AbortError";
}

// Meeting TTS speaks with the per-agent cast — same voices as the app's audio
// frames. Falls back to a premade stand-in when a library voice is plan-gated.
async function* speak(text: string): AsyncIterable<Uint8Array> {
  const t = await currentTts();
  if (!t) {
    return; // no TTS configured — onSpeechText already surfaced the text
  }
  const { speaker, spokenText } = resolveSpokenLine(text);
  // Fresh AbortSignal.timeout(...) per call: the 402-fallback retry below
  // invokes attempt() a second time and must get its OWN timeout window, not
  // the first attempt's (already fired-or-consumed) signal.
  const attempt = (voiceId: string) =>
    t.provider.stream({
      text: spokenText,
      personaId: speaker ?? "broker",
      format: "pcm_s16le",
      sampleRate: TTS_SAMPLE_RATE,
      voice: { provider: "elevenlabs", voiceId },
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

// sampleRate defaults to 48000 (mic/meeting PTT's rate) so the existing
// `new DeepgramSttStream(makeDeepgramLive)` call sites below need no change;
// discord-voice.ts's ear also runs at 48000 (Discord's receive rate) but
// passes it explicitly rather than relying on the default matching by
// coincidence — see makeVoiceStt below.
function makeDeepgramLive(sampleRate = 48000): LiveLike {
  type Socket = Awaited<ReturnType<DeepgramClient["listen"]["v1"]["connect"]>>;
  type ConnectArgs = Parameters<DeepgramClient["listen"]["v1"]["connect"]>[0];
  let socket: Socket | null = null;
  let resultsCb: ((data?: unknown) => void) | null = null;
  const pending: Uint8Array[] = [];
  let closed = false;

  // Record<string, unknown> can't structurally satisfy the SDK's ConnectArgs; the payload shape is pinned by stt.test.ts.
  const ready: Promise<Socket | null> = voiceKeys
    .sttKey()
    .then((key) => {
      if (!key) return null; // no STT key — session yields no results (callers gate before starting)
      const deepgram = new DeepgramClient({ apiKey: key });
      return deepgram.listen.v1.connect(deepgramLiveOptions(sampleRate) as unknown as ConnectArgs);
    })
    .then(async (s) => {
      if (!s) return null;
      if (closed) {
        s.close();
        return null;
      }
      s.on("message", (message) => resultsCb?.(message));
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
      console.error("[stt] deepgram connect failed:", err);
      return null;
    });

  return {
    on: (event, cb) => {
      if (event === "Results") resultsCb = cb;
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

// The broker's own identity (host persona, default Anderson) — data, not code.
const identityFile = process.env.BROKER_IDENTITY_FILE ?? ".smith/identity.json";
const identity = loadIdentity(() => readFileSync(identityFile, "utf8"));

// TDZ: the brain's executors close over `broker` and `creation`, which this
// same statement group constructs. Declared first and assigned after — the
// closures only run per-turn, long after startup, by which time both are
// assigned.
let broker: Broker;
// The single unconfirmed teammate draft (voice-driven creation): draft_agent
// sets it, confirm_agent consumes it, a new draft replaces it.
let pendingDraft: PersonaDraft | null = null;

const brain = new BrokerBrain(
  streamFactory,
  {
    // Delegations land in the active session's workspace unless the brain names one.
    // A meeting-sourced turn (broker.ts's stt.start callback) can run with no
    // active session — activeOrNull() falls back to the default workspace
    // rather than throwing (sessionManager.active() would).
    delegate: (input) =>
      broker.executors.delegate({
        ...input,
        workspace: input.workspace ?? sessionManager.activeOrNull()?.workspace ?? defaultWorkspaceName,
      }),
    check_status: (input) => broker.executors.check_status(input),
    raise_hand: (input) => broker.executors.raise_hand(input),
    remember: (input) => broker.executors.remember(input),
    // Scoped to the current conversation's workspace only — never model-choosable, unlike delegate's optional workspace.
    lookup_ticket: (input) =>
      broker.executors.lookup_ticket({
        ...input,
        workspace: sessionManager.activeOrNull()?.workspace ?? defaultWorkspaceName,
      }),
    search_docs: (input) =>
      broker.executors.search_docs({
        ...input,
        workspace: sessionManager.activeOrNull()?.workspace ?? defaultWorkspaceName,
      }),
    /**
     * Depth, when small talk turns into a real question (spec §7). Keyword
     * matching over a few hundred short items — no embeddings, no vector
     * store, because at this size substring matching answers it.
     */
    track_topic: async ({ name }) => {
      const id = slugify(name);
      const existing = topicStore.get(id);
      if (existing?.status === "discovering") return `Already looking into ${name}.`;
      const topic: Topic = existing ?? { id, name, status: "discovering", candidates: [], declined: [] };
      topicStore.put(topic);
      await beginDiscovery(topic);
      const after = topicStore.get(id);
      return after?.note
        ? `Could not start: ${after.note}`
        : `Looking into ${name} — the sources will be in Settings › Topics when they land.`;
    },
    check_feeds: async ({ query, tag, sinceDays }) => {
      const days = Math.min(Math.max(sinceDays ?? 7, 1), 30);
      const cutoff = Date.now() - days * 86_400_000;
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = feedStore
        .items()
        .filter((i) => Date.parse(i.publishedAt) >= cutoff)
        .filter((i) => !tag || i.tag === tag)
        .filter((i) => {
          const haystack = `${i.title} ${i.summary}`.toLowerCase();
          return tokens.some((t) => haystack.includes(t));
        })
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
        .slice(0, 10);
      if (!hits.length) return `Nothing in the feeds about "${query}" in the last ${days} days.`;
      return hits
        .map((i) => {
          const ageHours = Math.round((Date.now() - Date.parse(i.publishedAt)) / 3_600_000);
          const age = ageHours < 24 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)}d ago`;
          return `- ${i.title} (${age})${i.summary ? `\n  ${i.summary}` : ""}`;
        })
        .join("\n");
    },
    // Voice-driven agent creation: draft under the host's control, persist
    // only on the human's explicit yes.
    draft_agent: async ({ spec }) => {
      const draft = (await creation.generate({ hint: spec })) as unknown as PersonaDraft;
      pendingDraft = draft;
      return `Draft ready — pitch it and ask before creating. Name: ${draft.name}. Role: ${draft.role}. Backstory: ${draft.backstory}`;
    },
    confirm_agent: async ({ accept }) => {
      const draft = pendingDraft;
      pendingDraft = null;
      if (!draft) return "no pending draft — call draft_agent first";
      if (!accept) return `discarded the draft for ${draft.name}`;
      const created = (await creation.create(
        draftToAgentBody(draft, { language: "en-do", voiceId: DEFAULT_ELEVEN_VOICE }),
      )) as { error?: string };
      return created.error
        ? `creation failed: ${created.error}`
        : `${draft.name} is on the crew — their real voice still needs casting in the wizard`;
    },
  },
  { identity: promptInfo(identity) },
);

// Sessions — workspace-scoped conversations persisted under .smith/sessions/.
const sessionsDir = process.env.BROKER_SESSIONS_DIR ?? ".smith/sessions";
const sessionStore = {
  loadAll(): Session[] {
    try {
      return readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(sessionsDir, f), "utf8")) as Session);
    } catch {
      return [];
    }
  },
  save(session: Session): void {
    try {
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2));
    } catch (err) {
      console.error("[sessions] persist failed:", err);
    }
  },
  remove(id: string): void {
    try {
      rmSync(join(sessionsDir, `${id}.json`), { force: true });
    } catch (err) {
      console.error("[sessions] delete failed:", err);
    }
  },
};
const sessionManager = new SessionManager(sessionStore);

// Documents — blueprint-instantiated work products persisted under .smith/documents/.
const documentsDir = process.env.BROKER_DOCUMENTS_DIR ?? ".smith/documents";
const documentStore = {
  loadAll(): Doc[] {
    try {
      return readdirSync(documentsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(documentsDir, f), "utf8")) as Doc);
    } catch {
      return [];
    }
  },
  save(doc: Doc): void {
    try {
      mkdirSync(documentsDir, { recursive: true });
      writeFileSync(join(documentsDir, `${doc.id}.json`), JSON.stringify(doc, null, 2));
    } catch (err) {
      console.error("[documents] persist failed:", err);
    }
  },
};
const documentManager = new DocumentManager(documentStore);
documentManager.init();
const blueprints = loadBlueprints();

// Crew memory — durable facts recalled into every turn. One inspectable JSON
// file; the crew's continuity across conversations lives here.
const memoryFile = process.env.BROKER_MEMORY_FILE ?? ".smith/memory.json";
const memory = new LocalMemory({
  load(): MemoryEntry[] {
    try {
      return JSON.parse(readFileSync(memoryFile, "utf8")) as MemoryEntry[];
    } catch {
      return [];
    }
  },
  save(entries: MemoryEntry[]): void {
    try {
      mkdirSync(dirname(memoryFile), { recursive: true });
      writeFileSync(memoryFile, JSON.stringify(entries, null, 2));
    } catch (err) {
      console.error("[memory] persist failed:", err);
    }
  },
});

// One model call fills the whole creation wizard (structured output).
const personaGenerator = new PersonaGenerator(anthropic as never);

const SQUAD_RINGS: Record<string, string> = { alpha: "#5fd0b0", beta: "#f2778f", gamma: "#9b8cff" };

// ElevenLabs voices for speakers without a persona file (squad members).
// Persona-file agents carry their own voice.voiceId. Swap freely from the voice library.
const SQUAD_VOICES: Record<string, string> = {
  Gabriel: "4GMf9CnVFI2n0w4K1Gm4", // Edwin's pick — Latin male, alpha leader
  Gustavo: "aviXFY7Zd7b9DnCUwaCh", // Edwin's pick — Latin male, beta leader
  Graciela: "AxFLn9byyiDbMn5fmyqu", // Edwin's pick — gamma leader
  Santiago: "htFfPSZGJwjBv1CL0aMD", // Edwin's pick — Latin voice, alpha developer
  Soledad: "2Lb1en5ujrODDIqmp7F3", // Edwin's pick — female, gamma developer
  Francisca: "saqk76H0L3GCnuHtLDw6", // Edwin's pick — female Latin, gamma architect
  Ofelia: "nTkjq09AuYgsNR8E4sDe", // Edwin's pick — female, gamma senior
  // Spare (unassigned): m7yTemJqdIqrcNleANfX — female Latin. Open male slots:
  // Fabian, Osvaldo (alpha), Fernando, Orlando, Sebastian (beta).
};
const DEFAULT_ELEVEN_VOICE = "wutgczPT1RZgTX0H3qRJ"; // Edwin's pick — female Latin, fallback for unmapped speakers

// Premade stand-ins: ElevenLabs blocks LIBRARY voices on free API plans (402
// paid_plan_required) but allows premade ones. When a picked voice 402s we
// retry with these, so the crew still speaks on the free tier — the real picks
// take over automatically once the plan is upgraded. Distinct voice per speaker.
const PREMADE_STANDINS: Record<string, string> = {
  Manuel: "ErXwobaYiN019PkySvjV", // Antoni
  Octavio: "pNInz6obpgDQGcFmaJgB", // Adam
  Aurelio: "TxGEqnHWrfWFTfGW9XjX", // Josh
  Gabriel: "yoZ06aMxZJJ28mfd3POQ", // Sam
  Gustavo: "VR6AewLTigWG4xSOukaG", // Arnold
  Graciela: "21m00Tcm4TlvDq8ikWAM", // Rachel
  Francisca: "EXAVITQu4vr4xnSDxMaL", // Bella
  Ofelia: "MF3mGyEYCl7XYWbV9V6O", // Elli
  Soledad: "AZnzlk1XvdvUeBnXmlld", // Domi
};
const PREMADE_DEFAULT = "ErXwobaYiN019PkySvjV"; // Antoni

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
  // The host identity resolves first — it lives in identity.json, not the registry.
  if (speaker && identity.voice.voiceId && speaker.toLowerCase() === identity.name.toLowerCase())
    return identity.voice.voiceId;
  return (speaker && (directory.resolve(speaker)?.voice?.voiceId ?? SQUAD_VOICES[speaker])) ?? DEFAULT_ELEVEN_VOICE;
}

const GROUP_RING_PALETTE = ["#5fd0b0", "#f2778f", "#9b8cff", "#f2b04a", "#6f8dff", "#d977c8"];

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
        avatar: p.agent.avatar,
        status: p.status,
        taskSummary: p.taskSummary,
        kind: "agent",
        speech: p.agent.voice?.speech,
        hand: roster.hands[p.agent.name],
        listening: isListening(p.agent.name),
      }),
    ),
    ...roster.squads.map(
      (s): RosterEntry => ({
        id: `squad-${s.id}`,
        name: s.id[0].toUpperCase() + s.id.slice(1),
        role: `Squad — led by ${s.leader.name}`,
        ring: SQUAD_RINGS[s.id],
        status: s.status === "active" ? "busy" : "idle",
        kind: "squad",
        // A squad's hand is its leader's hand (either name may be used by the brain).
        hand: roster.hands[s.leader.name] ?? roster.hands[s.id[0].toUpperCase() + s.id.slice(1)],
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
        status: "idle",
        kind: "agent",
        hand: roster.hands[m.name],
        listening: isListening(m.name),
      }),
    ),
    ...roster.groups.map((g, i): RosterEntry => {
      // Until the composer-target work this read `members[0]` — the first agent
      // dragged in, presented as the leader. It is now whoever the group's own
      // members claimed (or the rank ladder, while a vote is still in flight).
      const leaderName = g.members.find((m) => m.id === g.leader)?.name ?? g.members[0]?.name ?? "?";
      return {
        id: `group-${g.id}`,
        name: g.name[0].toUpperCase() + g.name.slice(1),
        role: `Squad — led by ${leaderName}`,
        ring: GROUP_RING_PALETTE[i % GROUP_RING_PALETTE.length],
        status: "idle",
        kind: "squad",
        hand: roster.hands[leaderName],
        listening: isListening(g.name, leaderName),
        members: g.members.map((m) => m.name),
      };
    }),
  ];
};

/** The full roster frame: crew entries plus the host identity — the host is never in `agents`. */
const rosterFrame = (roster: UiRoster): ChannelFrame => ({
  type: "roster",
  agents: toRosterEntries(roster),
  identity: {
    name: identity.name,
    role: identity.role,
    ring: identity.avatarRing,
    listening: roster.listening.some((n) => n.toLowerCase() === identity.name.toLowerCase()) || undefined,
  },
});

let workspaceNames: string[] = [];
let workspaceRecords: SwarmWorkspace[] = [];
let defaultWorkspaceName = "default";

// Which workspace Discord is currently attending — set by every switchDiscord
// call (boot, session create/activate, reset). Feeds resolveLazyWorkspace so a
// Discord-originated turn with no active session lands in the workspace
// Discord is already attending, not the global default.
let attendedDiscordWorkspace: string | null = null;
function switchDiscord(workspaceName: string): void {
  attendedDiscordWorkspace = workspaceName;
  void discordWorkspaceSwitcher
    .switchDiscordForWorkspace(workspaceName)
    .catch((err: unknown) => console.error(`[discord] workspace switch failed for "${workspaceName}": ${String(err)}`));
}

// Null-tolerant: zero sessions is a legal state (spec §4b) — fresh install,
// or every session was removed. `session: null` is distinct from "hello frame
// not sent yet"; UIs render an empty/creation state rather than treating it
// as still-loading.
function sessionFrame() {
  const s = sessionManager.activeOrNull();
  return {
    type: "session" as const,
    session: s
      ? { id: s.id, title: s.title, workspace: s.workspace, runtime: s.runtime, artifacts: s.artifacts ?? [] }
      : null,
    sessions: sessionManager.list(),
    transcript: (s?.transcript ?? []).map((t) => ({ role: t.role, text: t.text })),
    workspaces: workspaceNames,
  };
}

/** Full-frame-on-change, like `sessionFrame()` — every document, not a diff. */
function documentsFrame() {
  return { type: "documents" as const, documents: documentManager.list() };
}

// Re-fetch workspace records (active only — archived workspaces can't host new
// sessions) and re-push the session frame that carries them to every client.
async function refreshWorkspaceNames(): Promise<void> {
  const all = await swarm.listWorkspaces().catch(() => []);
  workspaceRecords = all.filter((w) => !w.archived);
  workspaceNames = workspaceRecords.map((w) => w.name);
  defaultWorkspaceName = workspaceRecords.find((w) => w.default)?.name ?? workspaceNames[0] ?? "default";
  await broker.refreshWorkspaces();
  textChannel.broadcast(sessionFrame());
}

/**
 * Session birth core — create it, load its brain history, seed workspace
 * context (description/links) onto the brain once, switch Discord attendance,
 * and broadcast. Used by the sessions HTTP route (explicit create) and lazy
 * creation (handleUserText) alike, so both paths stay in lockstep.
 */
function startSession(
  workspace: string,
  opts: { runtime: ExecutionMode; title: string; awaitingTitle?: boolean },
): Session {
  const s = sessionManager.create(workspace, { ...opts });
  brain.loadHistory(s.brainHistory);
  const rec = workspaceRecords.find((w) => w.name === workspace);
  if (rec?.description || rec?.links?.length) {
    const links = rec.links?.length ? `\nlinks:\n${rec.links.join("\n")}` : "";
    brain.seedContext(`workspace "${workspace}": ${rec.description ?? ""}${links}`);
    sessionManager.saveBrainHistory(brain.exportHistory());
  }
  switchDiscord(workspace);
  textChannel.broadcast(sessionFrame());
  return s;
}

// Text I/O for UIs (Tauri control plane): POST /utterance in, WS transcript +
// live roster out. New clients get capabilities + a roster snapshot on connect.
// Same TDZ note as the executors above — the closures run long after assignment.
// A user line from any input (HTTP, stdin, mic) lands in the active session's
// transcript, runs a brain turn, then persists the brain's memory. No active
// session (spec §4b: legal after boot with nothing persisted, or after a
// reset) lazily creates one first — voice/stdin/HTTP land in the default
// workspace, Discord lands in whichever workspace it's currently attending.
function handleUserText(text: string, origin?: TurnOrigin): void {
  // Every other inbound path (HTTP /utterance, mic PTT, stdin) already
  // broadcasts the utterance frame at its own entry point before reaching
  // here. Channel-originated text (Discord, …) has no such entry point of
  // its own — the hub calls straight into this function — so this is the
  // one place to do it for that path, matching the existing frame shape.
  if (origin) textChannel.broadcast({ type: "utterance", text });
  const lazilyCreated = !sessionManager.hasActive();
  if (lazilyCreated) {
    const workspace = resolveLazyWorkspace(origin, attendedDiscordWorkspace, defaultWorkspaceName);
    startSession(workspace, { runtime: "local-in-process", title: truncateTitle(text), awaitingTitle: true });
  }
  sessionManager.appendTranscript("user", text);
  // startSession (above) already broadcast a session frame, but with an
  // EMPTY transcript — this line hadn't been appended yet. The client's
  // session frame is a full replace of the message list (useBrokerChat's
  // setMessages(frame.transcript...)), so if that empty frame is the last
  // one the client sees for this turn, it wipes the very utterance that
  // triggered the lazy create — permanently, if maybeRetitle below never
  // re-broadcasts (generateSessionTitle returning null). Re-broadcast now,
  // AFTER the append, so the last frame for this turn is always the correct
  // one — regardless of whether the utterance frame (Discord: above; HTTP/
  // mic/stdin: at their own entry point, before this function ever runs)
  // landed before or after startSession's.
  if (lazilyCreated) textChannel.broadcast(sessionFrame());
  const spokenThisTurn = unspokenReleaseIds;
  void broker.handleUtterance(text, origin).then(async () => {
    // The crew has now had the chance to say them; a release is mentioned once
    // (spec §5), and with no bell this marker is the only thing preventing a
    // repeat on every following turn.
    if (spokenThisTurn.length) {
      feedStore.markSpoken(spokenThisTurn, new Date().toISOString());
      refreshDigest();
    }
    if (sessionManager.hasActive()) sessionManager.saveBrainHistory(brain.exportHistory());
    await maybeRetitle();
  });
}

/** One-shot post-first-reply rename (spec §3); silent on failure. */
async function maybeRetitle(): Promise<void> {
  const s = sessionManager.activeOrNull();
  if (!s?.awaitingTitle) return;
  const firstUser = s.transcript.find((t) => t.role === "user")?.text ?? "";
  const firstReply = s.transcript.find((t) => t.role === "broker")?.text ?? "";
  if (!firstReply) return; // no reply landed yet — the next turn retries
  const title = await generateSessionTitle(streamFactory, "claude-haiku-4-5", firstUser, firstReply);
  if (title && sessionManager.retitle(s.id, title)) textChannel.broadcast(sessionFrame());
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
      return { outcome: inUse ? "archived" : "deleted" };
    } catch (err) {
      return { error: String((err as Error).message) };
    }
  },
  verifyAtlassian: (name: string) =>
    swarm.verifyWorkspaceAtlassian(name) as unknown as Promise<Record<string, unknown>>,
  verifyGithubRepo: (name: string, repoName: string) =>
    swarm.verifyRepoGithub(name, repoName) as unknown as Promise<Record<string, unknown>>,
};

// The current operator's profile + credentials (account panel): swarm holds
// the record (redacted on read — tokens never round-trip to the UI), this is
// a thin passthrough matching every other TextChannel dependency's shape.
const me = {
  get: () => swarm.getMe() as unknown as Promise<Record<string, unknown>>,
  update: (body: Record<string, unknown>) =>
    swarm.updateMe(body as { name?: string }) as unknown as Promise<Record<string, unknown>>,
};

// Per-workspace Discord channel config (channels manager UI): same thin
// passthrough shape as `me`, origin-restricted the same way.
const channels = {
  get: (name: string) => swarm.getWorkspaceChannels(name) as unknown as Promise<Record<string, unknown>>,
  save: (name: string, body: Record<string, unknown>) =>
    swarm.saveWorkspaceChannels(
      name,
      body as { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
    ) as unknown as Promise<Record<string, unknown>>,
  verifyDiscord: (name: string) => swarm.verifyWorkspaceDiscord(name) as unknown as Promise<Record<string, unknown>>,
};

// Connector registry (Integrations settings group): same thin passthrough
// shape as `me`/`channels`, origin-restricted the same way.
const connectors = {
  vendors: () => swarm.getConnectorVendors() as unknown as Promise<Record<string, unknown>[]>,
  list: () => swarm.getMyConnectors() as unknown as Promise<Record<string, unknown>[]>,
  add: (body: Record<string, unknown>) =>
    swarm.addConnector(
      body as { vendorId: string; label: string; fields: Record<string, string> },
    ) as unknown as Promise<Record<string, unknown>>,
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

// CLI tool registry (CLI Tools settings group + rail badge): same thin
// passthrough shape as `connectors`, origin-restricted the same way.
const cliTools = {
  list: () => swarm.listCliTools() as unknown as Promise<Record<string, unknown>>,
  refresh: (tool?: string) => swarm.refreshCliTools(tool) as unknown as Promise<Record<string, unknown>>,
  setEnabled: (id: string, enabled: boolean) =>
    swarm.setCliToolEnabled(id, enabled) as unknown as Promise<Record<string, unknown>>,
};

// Work boards: verbatim proxy to the swarm's /work/* routes plus the one
// dispatch route, which reuses the meeting delegation path via
// broker.dispatchWork so busy-refusal and task binding never drift from the
// brain's own delegate tool. `broker` is assigned further down (`let broker`
// above) — safe here because this closure only runs once a request lands,
// by which point module init has completed (same pattern as the `compose`
// and `work` handlers passed into TextChannel just below).
//
// Deliberately NOT passing `inheritSessionRuntime` here: a board card dispatch
// is a standalone instruction, not a continuation of "the active session", so
// it must go unstamped and let the server default decide (human ruling
// 2026-08-07) — see dispatchWork's doc comment in broker.ts.
const workBoards = {
  proxy: (method: string, path: string, body?: unknown) => swarm.work(method, path, body),
  delegate: async (body: Record<string, unknown>): Promise<{ taskId: string } | { error: string }> => {
    const b = body as {
      boardId?: string;
      cardId?: string;
      agentId?: string;
      workspace?: string;
      repo?: string;
      prompt?: string;
    };
    if (!b.boardId || !b.cardId || !b.agentId || !b.prompt?.trim()) {
      return { error: "body must be {boardId, cardId, agentId, prompt, workspace?, repo?}" };
    }
    const r = await broker.dispatchWork({
      agent: b.agentId,
      task: b.prompt,
      workspace: b.workspace,
      repo: b.repo,
      metadata: { source: "work-board", workCardRef: { boardId: b.boardId, cardId: b.cardId } },
    });
    if ("error" in r) return r;
    // Bind the card before answering so the board's next fetch shows the working badge.
    await swarm.work("PATCH", `/work/boards/${encodeURIComponent(b.boardId)}/cards/${encodeURIComponent(b.cardId)}`, {
      delegation: { agentId: b.agentId, taskId: r.taskId, state: "working" },
    });
    return { taskId: r.taskId };
  },
};

// API key registry (Settings → API Keys): same thin passthrough shape as
// cliTools, origin-restricted the same way. The credential route is
// deliberately NOT passed through (spec invariant).
const apiKeys = {
  list: () => swarm.listApiKeys(),
  save: (id: string, key: string) => swarm.saveApiKey(id, key),
  verify: (id: string) => swarm.verifyApiKey(id),
  remove: (id: string) => swarm.deleteApiKey(id),
};

// Voice status + settings passthrough (Settings → Voice group), origin-restricted
// the same way as apiKeys/cliTools. status() rides the same cached resolver
// snapshot the hello-frame config and mic gate use — never a second source of
// truth for whether keys are configured.
const voice = {
  status: () => voiceKeys.statusSync(),
  get: () => swarm.getMyVoice(),
  save: (body: unknown) => swarm.saveMyVoice(body),
};

// Agent creation: the swarm owns the registry, the broker owns voices. A
// named const (not an inline TextChannel argument) because the brain's
// draft_agent/confirm_agent executors drive the same generate/create path
// the wizard uses. avatarGen rides on the catalog the wizard already
// fetches — the UI learns in one request whether to render the Generate
// button at all.
const creation = {
  catalog: async () => ({ ...(await swarm.agentCatalog()), avatarGen: (await avatarEngine())?.kind ?? null }),
  records: async () => (await swarm.registry()) as unknown as Record<string, unknown>[],
  update: async (id: string, body: Record<string, unknown>) => {
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
      console.error(
        `[surface-modes] pre-PUT registry read failed for ${id}; write proceeds, enforcement falls back to restrictive-only: ${String(err)}`,
      );
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
          textChannel.broadcast(rosterFrame(broker.uiRoster()));
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
          console.error(
            `[surface-modes] AFTER registry read failed for ${id}; enforcement uses the PUT body as the after-map: ${String(err)}`,
          );
          after = surfaceModes(body);
        }

        if (before) {
          await applyModeChange(
            {
              leaveAgent: (agentId) => voiceSurface?.leaveAgent(agentId),
              joinAgent: async (agentId) => {
                await voiceSurface?.joinAgent(agentId);
              },
              roomActive: () =>
                voiceSurface !== null && voicePresence !== null && voicePresence.joinedChannel() !== null,
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
            if (mode !== "autojoin") policy.revoke(id, surface);
          }
          if (after["discord-voice"] === "disabled") voiceSurface?.leaveAgent(id);
        }
      } catch (err) {
        console.error(`[surface-modes] enforcement skipped after PUT ${id}: ${String(err)}`);
      }
    }
    return result;
  },
  generate: async (body: Record<string, unknown>) => {
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
      crewContext: crew.join(", "),
      existingNames: directory.snapshot().map((p) => p.agent.name),
      reactionLevels: catalog.reactionLevels ?? [],
      quickQuestions: catalog.quickQuestions ?? [],
    });
    return draft as unknown as Record<string, unknown>;
  },
  voices: async (query: Record<string, string>) => {
    const t = await currentTts();
    if (!t) return { voices: [], hasMore: false, error: VOICE_TTS_HINT };
    return t.catalog.browse({
      search: query.search,
      gender: query.gender,
      language: query.language,
      page: query.page ? Number(query.page) : undefined,
    });
  },
  preview: async (voiceId: string, text: string) => {
    const t = await currentTts();
    if (!t) throw new Error(VOICE_TTS_HINT);
    return t.catalog.synthesize(voiceId, text);
  },
  create: async (body: Record<string, unknown>) => {
    const created = await swarm.createAgent(body);
    // Warm the cache so the new agent's fixed lines play instantly. Best
    // effort: a partial cache still beats none, and never blocks creation.
    const agent = created as {
      id?: string;
      voice?: { voiceId?: string };
      reactions?: Record<string, string[]>;
      quickAnswers?: Record<string, string>;
    };
    const t = await currentTts();
    if (t && agent.voice?.voiceId) {
      const lines = [...Object.values(agent.reactions ?? {}).flat(), ...Object.values(agent.quickAnswers ?? {})];
      const warm = await t.catalog.warmAgent(agent.voice.voiceId, lines).catch(() => ({ cached: 0, failed: [] }));
      // Roster refresh so the new agent appears immediately.
      await broker.resetComposition().catch(() => {});
      return { ...created, voiceCache: warm };
    }
    await broker.resetComposition().catch(() => {});
    return created;
  },
  generateAvatar: async (body: Record<string, unknown>) => {
    const engine = await avatarEngine();
    if (!engine) {
      return {
        error: "no image engine available — add a Google key in Settings → API Keys, or install Antigravity (agy)",
      };
    }
    try {
      const generator = new AvatarGenerator(engine.client, config.geminiImageModel);
      return { imageData: await generator.generate(body as AvatarRequest), engine: engine.kind };
    } catch (err) {
      return { error: String((err as Error).message) };
    }
  },
  avatarFile: (file: string) => swarm.avatarFile(file),
};

const brokerAuth = new BrokerAuth(config.auth.file, {
  rpId: config.auth.rpId,
  webOrigin: config.auth.webOrigin,
  bridgeToken: config.auth.bridgeToken,
  required: config.auth.required,
});
await brokerAuth.load();
if (config.auth.required) console.log("[broker] inbound auth REQUIRED — passkey sessions + bridge token");

const textChannel = new TextChannel(
  handleUserText,
  () => [
    { type: "config", audio: voiceKeys.statusSync().tts },
    rosterFrame(broker.uiRoster()),
    sessionFrame(),
    documentsFrame(),
  ],
  (body) => {
    const op = body as { op?: string; agents?: unknown; target?: unknown; agent?: unknown };
    if (op.op === "form" && Array.isArray(op.agents) && op.agents.every((a) => typeof a === "string")) {
      return broker.compose({ op: "form", agents: op.agents as string[] });
    }
    if ((op.op === "add" || op.op === "remove") && typeof op.target === "string" && typeof op.agent === "string") {
      return broker.compose({ op: op.op, target: op.target, agent: op.agent });
    }
    return 'body must be {op:"form",agents:[..]} or {op:"add"|"remove",target,agent}';
  },
  {
    activity: (name) => broker.activity(name),
    steer: (name, message) =>
      message.trim() ? broker.steerWork(name, message) : Promise.resolve("steering message is empty"),
    cancel: (name) => broker.cancelWork(name),
  },
  {
    // Push-to-talk from UIs: one Deepgram session per client while the mic is
    // held. `reserve` claims the slot synchronously — before the STT-key
    // await below — so a second mic-start (or a mic-stop) landing while the
    // gate is in flight can never end up with two sessions or an orphaned
    // one; see mic-gate.ts's header for the full race this closes.
    start: (clientId) => {
      if (!micSessions.reserve(clientId)) return;
      void (async () => {
        if (!(await voiceKeys.sttKey())) {
          textChannel.broadcast({ type: "notice", text: VOICE_STT_HINT });
          micSessions.cancel(clientId);
          return;
        }
        const stt = new DeepgramSttStream(makeDeepgramLive);
        stt.start((utterance) => {
          textChannel.broadcast({ type: "utterance", text: utterance });
          handleUserText(utterance);
        });
        // A mic-stop can land while we were awaiting the key above — commit()
        // fails in that case, and the session we just built must still be
        // torn down rather than left running unreferenced.
        if (!micSessions.commit(clientId, stt)) stt.stop();
      })();
    },
    audio: (clientId, pcm) => micSessions.get(clientId)?.sendAudio(pcm),
    stop: (clientId) => {
      micSessions.stop(clientId)?.stop();
    },
  },
  {
    create: async (body) => {
      const workspace = body.workspace;
      const prompt = body.prompt?.trim() ?? "";
      if (!workspace || !workspaceNames.includes(workspace))
        return { error: `unknown workspace: ${body.workspace ?? "(none)"}` };
      if (!prompt) return { error: "prompt is required" };
      if (!isExecutionMode(body.runtime))
        return { error: `runtime must be one of: ${Object.keys(EXEC_TO_RUNTIME).join(", ")}` };
      const modes = await swarm.executionModes().catch(() => null);
      if (modes && modes[body.runtime] === false) {
        return { error: `execution mode "${body.runtime}" is not available`, status: 409 };
      }
      startSession(workspace, { runtime: body.runtime, title: truncateTitle(prompt), awaitingTitle: true });
      textChannel.broadcast({ type: "utterance", text: prompt }); // entry-point broadcast, same as POST /utterance
      handleUserText(prompt);
      return null;
    },
    activate: (id) => {
      const s = sessionManager.activate(id);
      if (!s) return `unknown session: ${id}`;
      brain.loadHistory(s.brainHistory);
      switchDiscord(s.workspace);
      textChannel.broadcast(sessionFrame());
      return null;
    },
    remove: (id) => {
      const wasActive = sessionManager.activeOrNull()?.id === id;
      const outcome = sessionManager.remove(id);
      if (!outcome) return `unknown session: ${id}`;
      // Deleting the active session leaves the brain holding a dead
      // conversation and Discord attending its workspace. Hand both to the
      // successor — or clear them when nothing survives, exactly as the
      // conversations reset does below.
      if (wasActive) {
        brain.loadHistory(outcome.active?.brainHistory ?? []);
        switchDiscord(outcome.active?.workspace ?? defaultWorkspaceName);
      }
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
      for (const file of readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))) {
        rmSync(join(sessionsDir, file), { force: true });
      }
      sessionManager.resetAll();
      brain.loadHistory([]);
      // Reset creates no session — the UI lands on the composer (spec §4b).
      // Discord attendance falls back to the default workspace, matching
      // every other place that changes it (create/activate above, boot below):
      // without this, a reset out of a workspace with Discord configured
      // would leave that connection live with no session backing it.
      switchDiscord(defaultWorkspaceName);
    }
    await broker.resetComposition();
    textChannel.broadcast(sessionFrame());
    textChannel.broadcast(rosterFrame(broker.uiRoster()));
    return { ok: true, scope: wants, swarm: swarmReport };
  },
  creation,
  removal,
  workspaces,
  {
    presence: () => {
      const out: Record<string, Record<string, boolean>> = {};
      const voiceIds = new Set(voiceSurface?.connectedAgentIds() ?? []);
      for (const a of directory.list()) {
        out[a.id] = {
          discord: isDiscordTextActive(discordTextLifecycle) && policy.attends(a.id, "discord"),
          "discord-voice": voiceIds.has(a.id),
        };
      }
      return out;
    },
    info: () => ({ configured: isDiscordTextActive(discordTextLifecycle), voiceReady: voiceSurface !== null }),
    join: async (agentId, surface) => {
      if (surface === "discord-voice") {
        // Mode check first: an explicitly disabled agent must never end up
        // in the VC just because it holds a minted bot token.
        const decision = decideJoin(agentId, surface, policy.modeFor(agentId, surface));
        if (decision.type === "reject") return { error: decision.error, status: decision.status };
        if (!voiceSurface) {
          const caps = voiceKeys.statusSync();
          return {
            error:
              !caps.stt && !caps.tts
                ? `Discord voice needs voice keys — ${VOICE_STT_HINT}`
                : "Discord voice is not configured",
            status: 409,
          };
        }
        try {
          await voiceSurface.joinAgent(agentId);
        } catch (err) {
          return { error: String(err instanceof Error ? err.message : err), status: 409 };
        }
        // autojoin needs no admission (it already attends by mode alone);
        // only on-request records one.
        if (decision.type === "admit") policy.admit(agentId, surface);
        // Spec §5: voice boots on either capability alone — hint the missing
        // half rather than blocking the join outright.
        const caps = voiceKeys.statusSync();
        if (!caps.stt || !caps.tts) {
          textChannel.broadcast({ type: "notice", text: caps.stt ? VOICE_TTS_HINT : VOICE_STT_HINT });
        }
        return { ok: true } as const;
      }
      if (surface !== "discord") return { error: `unknown surface: ${surface}`, status: 404 };
      const decision = decideJoin(agentId, surface, policy.modeFor(agentId, surface));
      if (decision.type === "reject") return { error: decision.error, status: decision.status };
      if (surface === "discord" && !isDiscordTextActive(discordTextLifecycle))
        return { error: "Discord is not configured", status: 409 };
      if (decision.type === "admit") policy.admit(agentId, surface);
      return { ok: true } as const;
    },
  },
  me,
  channels,
  connectors,
  tasks,
  cliTools,
  workBoards,
  apiKeys,
  voice,
  { list: () => swarm.executionModes() },
  {
    get: () => swarm.containers(),
    set: (enabled: boolean) => swarm.setContainers(enabled),
    verify: () => swarm.verifyContainers(),
  },
  (text) => {
    const s = sessionManager.activeOrNull();
    const context = s?.transcript
      .slice(-6)
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n");
    return polishText(streamFactory, "claude-haiku-4-5", text, context);
  },
  () => blueprints,
  {
    create: async (body) => {
      const bp = blueprints.find((b) => b.id === body.blueprintId);
      if (!bp) return { error: `unknown blueprint: ${body.blueprintId ?? "(none)"}` };
      // An absent work type takes the blueprint's first — the composer sends a
      // blueprint chip and its text, nothing more.
      const workType = body.workType ?? bp.workTypes[0] ?? "";
      if (!bp.workTypes.includes(workType)) return { error: `workType must be one of: ${bp.workTypes.join(", ")}` };
      const text = (body.text ?? "").trim();
      if (!text) return { error: "text is required" };
      const doc = documentManager.create(bp, workType, truncateTitle(text));
      if (!doc) return { error: "could not create document" };
      // The send is still a send: the room hears it, the brain answers it in
      // context, and a session gets lazily created here exactly as it would for
      // a plain chat send — which is also how the document inherits the active
      // session's runtime and workspace (it attaches, it never spawns).
      textChannel.broadcast({ type: "utterance", text });
      handleUserText(text);
      const active = sessionManager.activeOrNull();
      if (active) sessionManager.addArtifact(active.id, doc.id);
      textChannel.broadcast(documentsFrame());
      textChannel.broadcast(sessionFrame());
      return { doc };
    },
    rename: (docId, title) => {
      const doc = documentManager.rename(docId, title);
      if (!doc) return `cannot rename ${docId} — unknown document, or the title was blank`;
      textChannel.broadcast(documentsFrame());
      return null;
    },
    changeBlueprint: (docId, blueprintId) => {
      const bp = blueprints.find((b) => b.id === blueprintId);
      if (!bp) return `unknown blueprint: ${blueprintId}`;
      const doc = documentManager.changeBlueprint(docId, bp);
      // 409, not 404: the usual cause is a document that already has text —
      // switching blueprints would throw that away (documents.ts guards it).
      if (!doc) return `cannot re-cast ${docId} as "${blueprintId}" — unknown document, or it already has content`;
      textChannel.broadcast(documentsFrame());
      return null;
    },
    patchSection: (docId, sectionId, body) => {
      const doc = documentManager.patchSection(docId, sectionId, body);
      if (!doc) return `unknown document or section: ${docId}/${sectionId}`;
      textChannel.broadcast(documentsFrame());
      return null;
    },
  },
  brokerAuth,
  {
    /**
     * A message with a target on it. Host and crew stay a brain turn — the
     * crew's leader IS Anderson — and everyone else resolves to exactly one
     * agent, who gets the typed text as a task with no brain in between
     * (spec §2, Edwin's "no mediation" ruling).
     */
    send: async (text, rawTarget) => {
      const target = parseTarget(rawTarget);
      const roster = broker.uiRoster();
      const resolution = resolveTarget(target, {
        squads: roster.squads,
        groups: roster.groups.map((g) => ({
          id: g.id,
          name: g.name,
          leader: g.leader,
          members: g.members.map((m) => ({ id: m.id, name: m.name, roles: [directory.resolve(m.id)?.role ?? ""] })),
        })),
        agents: roster.agents.map((p) => ({ id: p.agent.id, name: p.agent.name })),
      });

      if ("error" in resolution) return { error: resolution.error, status: 404 };
      if (resolution.kind === "brain") {
        textChannel.broadcast({ type: "utterance", text });
        handleUserText(text);
        return { ok: true as const };
      }
      // The THIRD caller of the one dispatch path (delegate tool, work board,
      // and now the composer): busy-refusal, the directives-prefixed prompt,
      // task binding and roster refresh all come from there.
      const dispatched = await broker.dispatchWork({ agent: resolution.name, task: text, inheritSessionRuntime: true });
      if ("error" in dispatched) return { error: dispatched.error, status: 409 };
      textChannel.broadcast({ type: "utterance", text });
      return { ok: true as const, taskId: dispatched.taskId };
    },
  },
  {
    /** Settings › Feeds (spec §8). Sources are global — personal feeds follow you across workspaces. */
    list: async () => ({
      sources: feedStore.sources().map((s) => ({ ...s, lastError: feedStore.state().sources[s.id]?.lastError })),
      weather: feedStore.state().weather ?? null,
    }),
    add: async ({ url, tag }) => {
      if (!url.trim()) return { error: "a feed needs a URL" };
      // A YouTube channel URL is not itself a feed; every channel has one.
      const locator = youtubeFeedUrl(url) ?? url;
      // The broker fetches this on a timer from inside the trust boundary, so
      // an internal or non-http target is refused before it is ever stored.
      const refusal = urlRejectionReason(locator);
      if (refusal) return { error: refusal };
      const id = `m${Date.now().toString(36)}`;
      feedStore.putSource({
        id,
        label: new URL(locator).hostname.replace(/^www\./, ""),
        kind: "rss",
        locator,
        tag: (tag as FeedSource["tag"]) || "news",
        origin: "manual",
        enabled: true,
      });
      return { ok: true, id };
    },
    update: async (id, body) => {
      const source = feedStore.sources().find((s) => s.id === id);
      if (!source) return { error: `unknown feed: ${id}` };
      feedStore.putSource({
        ...source,
        enabled: body.enabled ?? source.enabled,
        // A dismissal is a standing instruction — derivation must not undo it.
        dismissed: body.dismissed ?? source.dismissed,
      });
      return { ok: true };
    },
    remove: async (id) => {
      feedStore.removeSource(id);
      return { ok: true };
    },
    weather: async ({ location }) => {
      const [lat, lon] = location.split(",").map(Number);
      feedStore.putSource({
        id: "weather",
        label: location,
        kind: "weather",
        locator: Number.isFinite(lat) && Number.isFinite(lon) ? `${lat},${lon}` : "18.48,-69.93",
        tag: "weather",
        origin: "manual",
        enabled: true,
      });
      return { ok: true };
    },
  },
  {
    /** Settings › Topics (topics spec §7). */
    list: async () => ({
      topics: topicStore.all(),
      sources: feedStore.sources().filter((src) => src.topicId),
    }),
    track: async ({ name }) => {
      if (!name.trim()) return { error: "a topic needs a name" };
      const id = slugify(name);
      const existing = topicStore.get(id);
      if (existing?.status === "discovering") return { error: `already looking into ${name}` };
      const topic: Topic = existing ?? { id, name, status: "discovering", candidates: [], declined: [] };
      topicStore.put(topic);
      await beginDiscovery(topic);
      return { ok: true, id };
    },
    approve: async (id, body) => {
      const topic = topicStore.get(id);
      if (!topic) return { error: `unknown topic: ${id}` };
      const { topic: next, sources, baselines } = approve(topic, body.keep, body.baseline);
      for (const source of sources) feedStore.putSource(source);
      if (Object.keys(baselines).length) {
        feedStore.patchState({ seenVersions: { ...feedStore.state().seenVersions, ...baselines } });
      }
      topicStore.put(next);
      return { ok: true, approved: sources.length };
    },
    rediscover: async (id) => {
      const topic = topicStore.get(id);
      if (!topic) return { error: `unknown topic: ${id}` };
      await beginDiscovery(topic);
      return { ok: true };
    },
    remove: async (id) => {
      // A topic's sources go with it; manifest-derived ones are untouched.
      for (const src of feedStore.sources()) if (src.topicId === id) feedStore.removeSource(src.id);
      topicStore.remove(id);
      return { ok: true };
    },
  },
);

/**
 * Re-discovery every 30 days per topic (topics spec §6). Never two at once for
 * the same topic, and the result is diffed rather than applied.
 */
const REDISCOVER_MS = 30 * 86_400_000;
setInterval(() => {
  const inFlight = new Set(Object.values(feedStore.state().pendingDiscoveries));
  for (const topic of topicStore.all()) {
    if (topic.status !== "active" || inFlight.has(topic.id)) continue;
    const last = topic.lastDiscoveredAt ? Date.parse(topic.lastDiscoveredAt) : 0;
    if (Date.now() - last < REDISCOVER_MS) continue;
    void beginDiscovery(topic);
  }
}, 60 * 60_000).unref();

/**
 * One tick a minute asks which sources are due (ingest.ts decides), fetches
 * those, and records the outcome. Everything here is contained per source: a
 * dead feed can never stop the others, and five failures in a row disables it
 * with the reason visible in Settings (spec §10).
 */
const FEEDS_TICK_MS = 60_000;
/** Manifests are re-read this often; a dependency added today is watched today. */
const DERIVE_TICK_MS = 60 * 60_000;

/**
 * A qualifying release becomes a Triage card (spec §5b) — this is how the
 * maintenance and reactive boards get filled. Failure is logged, never thrown:
 * the release is still spoken, because conversation does not depend on boards.
 */
async function makeCard(item: FeedItem, workspace: string, currentVersion: string): Promise<void> {
  const result = await cardForRelease(
    {
      boards: async () => {
        const { payload } = await workBoards.proxy("GET", "/work/boards");
        return ((payload as { boards?: Array<{ id: string; type: string; workspaceId?: string }> }).boards ?? []).map(
          (b) => ({ id: b.id, type: b.type, workspaceId: b.workspaceId }),
        );
      },
      addCard: async (boardId, card) => {
        const { status } = await workBoards.proxy("POST", `/work/boards/${boardId}/cards`, card);
        if (status >= 400) throw new Error(`board rejected the card (${status})`);
      },
      plan: async (release, from) => {
        const message = await anthropic.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 400,
          system:
            "You write short upgrade plans for a working engineer. At most 5 numbered steps, imperative, specific to the change. No preamble.",
          messages: [
            {
              role: "user",
              content: `We are on ${release.release.name} ${from} and ${release.release.version} is out.\n\nRelease notes:\n${release.summary || "(none available)"}\n\nWhat should we do?`,
            },
          ],
        });
        return message.content.map((b) => ("text" in b ? b.text : "")).join("");
      },
      now: () => new Date().toISOString(),
    },
    item,
    { workspace, currentVersion },
  );
  if (result.carded) {
    feedStore.markCarded(item.id, new Date().toISOString());
    console.log(`[feeds] carded ${item.title} → ${workspace}`);
  } else {
    console.error(`[feeds] no card for ${item.title}: ${result.reason}`);
  }
}

/** The agent a discovery goes to: any idle one, else the first on the roster. */
function discoveryAgent(): string {
  const roster = broker.uiRoster().agents;
  return (roster.find((p) => p.status === "idle") ?? roster[0])?.agent.name ?? "";
}

/**
 * Send someone looking (topics spec §3). The dispatch is the composer's own
 * path, so busy-refusal and task binding come from there; the returned taskId
 * is the ONLY correlation available, because SwarmEvent carries no metadata.
 */
async function beginDiscovery(topic: Topic): Promise<void> {
  const { topic: next, taskId } = await startDiscovery(
    {
      dispatch: async (task) => {
        const r = await broker.dispatchWork({ agent: discoveryAgent(), task, inheritSessionRuntime: false });
        return "error" in r ? { error: r.error } : { taskId: r.taskId };
      },
      bundlePath,
    },
    topic,
  );
  topicStore.put({ ...next, lastDiscoveredAt: new Date().toISOString() });
  if (taskId) {
    feedStore.patchState({ pendingDiscoveries: { ...feedStore.state().pendingDiscoveries, [taskId]: topic.id } });
  }
}

/** A discovery task finished: read its bundle, or say why there isn't one. */
function landDiscovery(taskId: string): void {
  const pending = feedStore.state().pendingDiscoveries;
  const topicId = pending[taskId];
  if (!topicId) return; // not one of ours
  const { [taskId]: _done, ...rest } = pending;
  feedStore.patchState({ pendingDiscoveries: rest });

  const topic = topicStore.get(topicId);
  if (!topic) return;
  let raw: string | null = null;
  try {
    raw = readFileSync(bundlePath(topicId), "utf8");
  } catch {
    raw = null;
  }
  const { candidates, note } = parseBundle(raw);
  // A re-run diffs against what is already approved, so an unchanged bundle
  // produces an empty pending list rather than re-offering everything.
  const approved = feedStore.sources().filter((src) => src.topicId === topicId);
  const additions = approved.length
    ? diffBundle({ topic, fresh: candidates, approved, now: new Date().toISOString() }).additions
    : candidates;
  topicStore.put({ ...topic, status: "pending", candidates: additions, note });
  console.log(`[topics] ${topicId}: ${additions.length} candidate(s)${note ? ` — ${note}` : ""}`);
}

/**
 * The stack declares its own interests (spec §4.1): every workspace repo's
 * manifests become derived release sources. Manual sources are never touched —
 * deriveSources returns only the derived set, and the merge preserves the rest.
 */
async function deriveFromManifests(): Promise<void> {
  const workspaces = await swarm.listWorkspaces().catch(() => []);
  const manifestIo = {
    read(path: string) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
  };
  /**
   * A repo root plus its immediate subdirectories. Monorepos — this one
   * included — keep no manifest at the root: smithagents' live workspace
   * points at the repo root while every package.json sits one level down in
   * broker/, control-plane/, swarm/. Depth 1 covers that without walking a
   * whole tree.
   */
  const scanDirs = (root: string): string[] => {
    try {
      const children = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => `${root}/${e.name}`);
      return [root, ...children];
    } catch {
      return [root];
    }
  };

  const deps = workspaces
    .filter((w) => !w.archived)
    .flatMap((w) =>
      (w.repos ?? []).flatMap((repo) =>
        scanDirs(repo.path).flatMap((dir) =>
          readManifests(manifestIo, dir).map((d) => ({
            ...d,
            // Name the package, not just the file: "broker/package.json".
            manifest: dir === repo.path ? d.manifest : `${dir.slice(repo.path.length + 1)}/${d.manifest}`,
            workspace: w.name,
          })),
        ),
      ),
    );
  if (!deps.length) return;

  const existing = feedStore.sources();
  const derived = deriveSources({ deps, promoted: [], existing });
  const manual = existing.filter((s) => s.origin === "manual");
  const state = feedStore.state();
  const seen = { ...state.seenVersions };
  // Seed each dependency's baseline from the manifest, so the first poll
  // compares against what you actually run rather than announcing everything.
  for (const dep of deps) if (!seen[dep.name] && dep.version) seen[dep.name] = dep.version;

  feedStore.patchState({ seenVersions: seen });
  for (const source of [...manual, ...derived]) feedStore.putSource(source);
  const removed = existing.filter((s) => s.origin === "derived" && !derived.some((d) => d.id === s.id));
  for (const gone of removed) feedStore.removeSource(gone.id);
  console.log(`[feeds] derived ${derived.length} release sources from ${deps.length} dependencies`);
}

void deriveFromManifests();
setInterval(() => void deriveFromManifests(), DERIVE_TICK_MS).unref();

async function fetchSource(source: FeedSource): Promise<{ ok: boolean; error?: string }> {
  try {
    if (source.kind === "weather") {
      const [lat, lon] = source.locator.split(",").map(Number);
      const res = await fetch(weatherUrl(lat ?? 18.48, lon ?? -69.93));
      const line = weatherLine(await res.json());
      if (!line) return { ok: false, error: "unreadable weather response" };
      feedStore.patchState({ weather: { text: line, at: new Date().toISOString() } });
      return { ok: true };
    }
    // A topic's github source is a RELEASE source: without this it would fall
    // to the generic rss branch below and store entries as plain items with no
    // metadata — the exact bug this feature exists to fix.
    if (source.kind === "rss" && source.tag === "release" && source.topicId) {
      const res = await fetch(source.locator);
      const latest = latestFromAtom(await res.text());
      if (!latest) return { ok: false, error: "no versioned release found in the feed" };

      const key = repoKey(source.locator) ?? source.locator;
      const state = feedStore.state();
      const from = state.seenVersions[key];
      // Approval always sets a baseline; an absent one means state was lost, so
      // seed rather than announce — history is still never carded.
      if (!from) {
        feedStore.patchState({ seenVersions: { ...state.seenVersions, [key]: latest.version } });
        return { ok: true };
      }
      const bump = classifyBump(from, latest.version);
      if (!bump) return { ok: true };
      const security = mentionsSecurity(latest.notes);
      feedStore.patchState({ seenVersions: { ...feedStore.state().seenVersions, [key]: latest.version } });
      if (!qualifies(bump, security)) return { ok: true };

      const [fresh] = feedStore.addItems([
        {
          id: `${source.id}@${latest.version}`,
          sourceId: source.id,
          tag: "release",
          title: `${source.label} ${latest.version}`,
          publishedAt: latest.publishedAt ?? new Date().toISOString(),
          summary: latest.notes.slice(0, 400),
          release: { name: source.label, version: latest.version, bump, security },
        },
      ]);
      // A topic is global — it has no workspace of its own, so cards go to the default.
      if (fresh) void makeCard(fresh, defaultWorkspaceName, from);
      return { ok: true };
    }
    if (source.kind === "rss") {
      // Checked again here, not only at add time: a source written before this
      // guard existed — or edited on disk — must not get a free pass (SSRF).
      const refusal = urlRejectionReason(source.locator);
      if (refusal) return { ok: false, error: refusal };
      const res = await fetch(source.locator);
      const items = parseFeed(source, await res.text());
      // Zero items from a feed that should have some is a failure, not a quiet success.
      if (!items.length) return { ok: false, error: "no items parsed" };
      feedStore.addItems(items);
      return { ok: true };
    }
    if (source.kind === "registry") {
      const [eco, ...rest] = source.locator.split(":");
      const name = rest.join(":");
      const fetchJson = async (url: string) => (await fetch(url)).json();
      const latest = await latestVersion(fetchJson, eco as Ecosystem, name);
      if (!latest) return { ok: false, error: `no version found for ${name}` };

      const state = feedStore.state();
      const from = state.seenVersions[name];
      // First sight seeds the baseline without announcing: the version you are
      // already on is not news.
      if (!from) {
        feedStore.patchState({ seenVersions: { ...state.seenVersions, [name]: latest } });
        return { ok: true };
      }
      const bump = classifyBump(from, latest);
      if (!bump) return { ok: true }; // nothing newer

      // Cheap check done; notes are fetched ONLY now, and only to decide
      // whether a patch is a security patch (spec §5).
      let notes = "";
      const repo = await repositoryUrl(fetchJson, eco as Ecosystem, name);
      const atom = repo ? githubAtomUrl(repo) : null;
      if (atom) {
        notes = await fetch(atom)
          .then((r) => r.text())
          .catch(() => "");
      }
      const security = mentionsSecurity(notes);
      // The baseline moves whether or not this one is worth telling you about,
      // so a skipped patch is never re-evaluated forever.
      feedStore.patchState({ seenVersions: { ...feedStore.state().seenVersions, [name]: latest } });
      if (!qualifies(bump, security)) return { ok: true };

      const [fresh] = feedStore.addItems([
        {
          id: `${source.id}@${latest}`,
          sourceId: source.id,
          tag: "release",
          title: `${source.label} ${latest}`,
          publishedAt: new Date().toISOString(),
          summary: notes.slice(0, 400),
          release: { name, version: latest, bump, security },
        },
      ]);
      if (fresh && source.workspace) void makeCard(fresh, source.workspace, from);
      return { ok: true };
    }
    // x sources are polled by their own path; nothing to do here yet.
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

setInterval(() => {
  const state = feedStore.state();
  const due = dueSources(feedStore.sources(), state, Date.now());
  if (!due.length) return;
  void Promise.all(
    due.map(async (source) => {
      const outcome = await fetchSource(source);
      feedStore.patchState({
        sources: recordOutcome(feedStore.state(), source.id, {
          ok: outcome.ok,
          at: new Date().toISOString(),
          error: outcome.error,
        }).sources,
      });
    }),
  ).then(() => refreshDigest());
}, FEEDS_TICK_MS).unref();

const micSessions = new MicSessionGate<DeepgramSttStream>();

// ElevenLabs audio for text-channel replies: synthesize each speech chunk with
// the speaking agent's voice and fan the mp3 out as an audio frame. Serialized
// so frames always arrive in speech order; each link swallows its own failure
// (a bad voice id or network blip degrades to text, never breaks the chain).
let synthChain = Promise.resolve();
// Notice fires once per session (not once per missed utterance) — a session
// keeps talking without a TTS key otherwise flooding the notice frame.
let ttsHintSessionId: string | null = null;
function broadcastSpokenAudio(text: string): void {
  // resolveSpokenLine/elevenVoiceFor and the synthChain reassignment MUST
  // stay synchronous, in call order — currentTts() is the only step here
  // that needs to await, so it resolves inside the chained callback rather
  // than before the chain claims its position. Awaiting it up front would
  // let two overlapping calls interleave their sticky-speaker resolution
  // and their chain position, breaking "frames always arrive in speech
  // order" for whichever call's await happened to settle first.
  const { speaker, spokenText } = resolveSpokenLine(text);
  const voiceId = elevenVoiceFor(speaker);
  synthChain = synthChain.then(async () => {
    const t = await currentTts();
    if (!t) {
      const sid = sessionManager.activeOrNull()?.id ?? null;
      if (ttsHintSessionId !== sid) {
        ttsHintSessionId = sid;
        textChannel.broadcast({ type: "notice", text: VOICE_TTS_HINT });
      }
      return;
    }
    if (textChannel.clientCount === 0) return; // nobody listening — don't spend credits
    const synth = (id: string) =>
      t.provider.synthesize({
        text: spokenText,
        personaId: speaker ?? "broker",
        format: "mp3",
        voice: { provider: "elevenlabs", voiceId: id },
      });
    try {
      let result: Awaited<ReturnType<typeof synth>>;
      try {
        result = await synth(voiceId);
      } catch (err) {
        const standIn = (speaker && PREMADE_STANDINS[speaker]) ?? PREMADE_DEFAULT;
        if (!/402|payment_required|paid_plan_required/.test(String(err)) || standIn === voiceId) throw err;
        console.error(`[tts] ${speaker ?? "default"} voice needs a paid ElevenLabs plan — using premade stand-in`);
        result = await synth(standIn);
      }
      textChannel.broadcast({
        type: "audio",
        speaker,
        mime: "audio/mpeg",
        dataB64: Buffer.from(result.data).toString("base64"),
      });
    } catch (err) {
      console.error("[tts] elevenlabs synthesis failed:", err);
    }
  });
}

// Personal tracking feeds (spec 2026-08-11): three files under .smith/feeds/,
// read and written through the same kind of io seam the session store uses.
const feedsDir = process.env.BROKER_FEEDS_DIR ?? ".smith/feeds";
const feedsIo = {
  read(name: string) {
    try {
      return readFileSync(join(feedsDir, name), "utf8");
    } catch {
      return null;
    }
  },
  write(name: string, body: string) {
    try {
      mkdirSync(feedsDir, { recursive: true });
      writeFileSync(join(feedsDir, name), body);
    } catch (err) {
      console.error("[feeds] persist failed:", err);
    }
  },
};
const feedStore = new FeedStore(feedsIo);
const topicStore = new TopicStore(feedsIo);

// Where a discovery agent writes its bundle (topics spec §3.1).
const topicsDir = process.env.BROKER_TOPICS_DIR ?? ".smith/topics";
const bundlePath = (topicId: string) => `${topicsDir}/${topicId}.json`;

/**
 * Rebuilt on a timer, never per turn — a conversation must never wait on a
 * fetch (spec §6). Empty until feeds exist, which keeps the brain's prompt
 * byte-for-byte unchanged on a fresh install.
 */
let currentDigest = "";
/** Releases named in the digest the crew has not yet said out loud. */
let unspokenReleaseIds: string[] = [];

/**
 * dependency name → the agent who should speak its line (feeds spec §4.2).
 * A role with nobody on the roster resolves to nothing, so attribution never
 * invents a speaker.
 */
function releaseOwners(): Record<string, string> {
  // This runs at module load, before `broker` is constructed — and at boot
  // there is no roster to attribute to anyway. Anderson delivers unattributed.
  if (typeof broker === "undefined") return {};
  const roster = broker.uiRoster().agents;
  const owners: Record<string, string> = {};
  for (const source of feedStore.sources()) {
    if (source.tag !== "release") continue;
    const [eco, ...rest] = source.locator.split(":");
    const name = rest.join(":");
    const role = ownerRole({ name, eco: eco as Ecosystem, version: "", manifest: "" }, false);
    if (!role) continue;
    const agent = roster.find((p) => p.agent.role.toLowerCase() === role.toLowerCase());
    if (agent) owners[name] = agent.agent.name;
  }
  return owners;
}

function refreshDigest(): void {
  const built = buildDigest({
    items: feedStore.items(),
    weather: feedStore.state().weather?.text,
    owners: releaseOwners(),
    now: new Date().toISOString(),
  });
  currentDigest = built.text;
  unspokenReleaseIds = built.unspokenIds;
}
refreshDigest();

// Roster composition survives restarts — user-formed squads are arrangements, not session state.
const stateFile = process.env.BROKER_STATE_FILE ?? ".smith/roster-state.json";
const rosterStore = {
  load(): RosterState | null {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8")) as RosterState;
    } catch {
      return null; // first run, or unreadable — start from the config baseline
    }
  },
  save(state: RosterState): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error("[roster] persist failed:", err);
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
      const active = sessionManager.activeOrNull();
      return { workspace: active?.workspace, session: active?.id };
    },
    rosterStore,
    // Today's world, injected beside the roster so small talk needs no lookup.
    digest: () => currentDigest,
    // A group's membership changed — its members re-claim leadership (spec §5.3).
    onGroupChanged: (groupId) => elections.schedule(groupId),
    makeStt: () => new DeepgramSttStream(makeDeepgramLive),
    makeBridge: () => new LiveKitRoomBridge(),
    speak,
    onSpeechText: (text) => {
      console.log(`[speech-text] ${text}`);
      // Paths that bypass handleUserText's lazy creation — meeting STT
      // (broker.ts's stt.start callback) and swarm-event task narration
      // (onSwarmEvent's system-note turn, reachable from a work-board
      // dispatch that names no session at all) — can run in the legal,
      // durable zero-session state (fresh install; right after Reset).
      // appendTranscript throws with no active session, and since this is
      // the first statement in enqueueSpeech's try block (broker.ts), an
      // unguarded throw here would silently drop the whole speech chunk:
      // no broadcast, no TTS audio, no channel relay. A session is a
      // per-conversation transcript; the broker's own speech isn't itself a
      // reason to lazily birth one (unlike a human's first message), so
      // this narrows to "persist the line if there's somewhere to persist
      // it" rather than lazily creating a session here too.
      if (sessionManager.hasActive()) sessionManager.appendTranscript("broker", text);
      textChannel.broadcast({ type: "speech", text });
      broadcastSpokenAudio(text);
      adapterHub.dispatchSpeech(text);
    },
    // Turn-scoped: activates the hub's origin for exactly the turn now
    // running, so external delivery can never leak across turns or into a
    // meeting-sourced turn (which passes no origin — see channels.ts).
    onTurnStart: (origin) => adapterHub.setActiveOrigin(origin),
    onTurnEnd: () => adapterHub.setActiveOrigin(undefined),
    onRosterChange: (roster) => textChannel.broadcast(rosterFrame(roster)),
    onTaskDispatched: (d) =>
      textChannel.broadcast({ type: "task-dispatched", taskId: d.taskId, agent: d.agent, task: d.task }),
    // A completed/failed task carrying workCardRef (added by the swarm — see
    // Task 2/3) means a work-board card just changed; the board stage
    // refetches on this frame instead of the broker duplicating card state.
    onSwarmEvent: (e) => {
      // A discovery task finishing is how a topic's bundle arrives (topics spec §3).
      if (e.type === "task:completed" || e.type === "task:failed") landDiscovery(e.taskId);
      if ((e.type === "task:completed" || e.type === "task:failed") && e.workCardRef) {
        textChannel.broadcast({ type: "board-updated", boardId: e.workCardRef.boardId });
      }
    },
    mintToken: (roomName) =>
      mintRoomToken({
        apiKey: config.livekit.apiKey,
        apiSecret: config.livekit.apiSecret,
        roomName,
        identity: "smith-broker",
      }),
    livekitUrl: config.livekit.url,
    identityName: identity.name,
    sessionRuntime: () => {
      const s = sessionManager.activeOrNull();
      return s ? EXEC_TO_RUNTIME[s.runtime] : undefined;
    },
  },
  { repository: config.swarm.repository },
);

/**
 * Elections run on the broker's own model client — never through the agents'
 * coding CLIs, which would start a tmux session per voter and mark the whole
 * group busy just to hold a vote (spec §5.1). One short call per member,
 * seeded with only that member's directives, so each answers as itself.
 *
 * `claude-haiku-4-5` matches BrokerBrain's default: an election is a small
 * judgement call, the same weight class as a brain turn.
 */
const askForClaim: AskFactory = async ({ system, prompt }) => {
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return message.content.map((block) => ("text" in block ? block.text : "")).join("");
};

const elections = new ElectionScheduler({
  run: async (groupId) => {
    const candidates = broker.groupCandidates(groupId);
    // compose() dissolves any group below two members, so this is a guard
    // against a group vanishing mid-debounce rather than a real branch.
    if (!candidates || candidates.length < 2) return null;
    const group = broker.uiRoster().groups.find((g) => g.id === groupId);
    if (!group) return null;
    return runElection(askForClaim, { name: group.name }, candidates);
  },
  onResult: (groupId, result) => {
    if (!result.leader) return;
    broker.setGroupLeader(groupId, result.leader, {
      claims: result.claims,
      at: new Date().toISOString(),
      method: result.method,
    });
    console.log(`[election] ${groupId} → ${result.leader} (${result.method})`);
  },
});

await broker.start();
const bootWorkspaces = (await swarm.listWorkspaces().catch(() => [])).filter((w) => !w.archived);
workspaceNames = bootWorkspaces.map((w) => w.name);
workspaceRecords = bootWorkspaces;
defaultWorkspaceName = bootWorkspaces.find((w) => w.default)?.name ?? workspaceNames[0] ?? "default";
const activeSession = sessionManager.init(); // Session | null — zero sessions is legal (spec §4b)
if (activeSession) brain.loadHistory(activeSession.brainHistory);
const textPort = await textChannel.start(config.textPort, config.host);
console.log(
  `[broker] running — polling swarm for open meetings. Text channel on http://127.0.0.1:${textPort}. Type a line to simulate an utterance.`,
);

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
  voiceCapabilities: () => voiceKeys.statusSync(),
  onSurfaceChange: (surface, presence) => {
    voiceSurface = surface;
    voicePresence = presence;
  },
});
const discordWorkspaceSwitcher = createDiscordWorkspaceSwitcher({ swarm, discordTextLifecycle, discordVoiceLifecycle });
// switchDiscord (defined above) closes over discordWorkspaceSwitcher — safe
// only from here on, now that it's assigned (see the TDZ note above).
if (activeSession) switchDiscord(activeSession.workspace);
else switchDiscord(bootWorkspaces.find((w) => w.default)?.name ?? bootWorkspaces[0]?.name ?? "default");

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  textChannel.broadcast({ type: "utterance", text }); // stdin lines show up in UI transcripts too
  handleUserText(text);
});

process.on("SIGINT", () => {
  void Promise.all([broker.stop(), textChannel.stop()]).then(() => process.exit(0));
});
