/**
 * Broker — the conversation coordinator's event loop. Owns no policy beyond
 * wiring: swarm meetings appear -> join the room; room audio -> STT ->
 * utterances -> brain; brain speech -> TTS -> room; brain tools -> swarm
 * delegation; swarm events -> directory updates + spoken narration.
 * Every dependency is injected (structural interfaces) so the whole loop
 * unit-tests with fakes; main.ts builds the real ones.
 */
import type { AgentDirectory } from './directory.ts';
import type { BrainTurn } from './brain.ts';
import type { RegistryAgent, SwarmEvent, SwarmMeeting } from './swarm-client.ts';

export interface SwarmClientLike {
  listMeetings(): Promise<SwarmMeeting[]>;
  registry(): Promise<RegistryAgent[]>;
  subscribe(onEvent: (e: SwarmEvent) => void): () => void;
  submitTask(req: {
    prompt: string;
    agent: 'agy' | 'claude' | 'codex';
    repository: string;
    branch?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ taskId: string; agentName: string | null }>;
  getOutput(taskIdOrName: string): Promise<{ taskId: string; output: string }>;
}

export interface BrainLike {
  handleUtterance(text: string, turn: BrainTurn): Promise<void>;
  handleSystemNote(note: string, turn: BrainTurn): Promise<void>;
}

export interface SttLike {
  start(onUtterance: (text: string) => void): void;
  sendAudio(pcm: Uint8Array): void;
  stop(): void;
}

export interface BridgeLike {
  connect(opts: { url: string; token: string }): Promise<void>;
  onRemoteAudio(cb: (pcmBytes: Uint8Array) => void): void;
  publishPcm(bytes: Uint8Array, sampleRate: number): Promise<void>;
  disconnect(): Promise<void>;
}

export interface BrokerDeps {
  swarm: SwarmClientLike;
  directory: AgentDirectory;
  brain: BrainLike;
  makeStt: () => SttLike;
  makeBridge: () => BridgeLike;
  /** TTS: text -> s16le PCM bytes (44100 Hz mono). */
  speak: (text: string) => AsyncIterable<Uint8Array>;
  mintToken: (roomName: string) => Promise<string>;
  livekitUrl: string;
  pollMs?: number;
}

const TTS_SAMPLE_RATE = 44100;

interface ActiveMeeting {
  meeting: SwarmMeeting;
  bridge: BridgeLike;
  stt: SttLike;
}

export class Broker {
  private active: ActiveMeeting | null = null;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private speaking = Promise.resolve();
  /** True while a joinMeeting() call is in flight, so overlapping pollOnce ticks don't double-join. */
  private joining = false;
  /**
   * Serializes brain turns. `handleUtterance` (mic + stdin dev channel) and
   * `handleSystemNote` (async task-completion narration) both mutate the
   * brain's single shared conversation history across `await`s — running two
   * turns concurrently can interleave history pushes and split a tool_use
   * from its tool_result, which the Anthropic API rejects with a 400. Every
   * turn is funneled through this queue so only one is ever in flight.
   */
  private turnQueue: Promise<void> = Promise.resolve();

  /** Tool executors handed to the brain; public for tests + reuse. */
  readonly executors = {
    delegate: async (input: { agent: string; task: string }): Promise<string> => {
      const agent = this.deps.directory.resolve(input.agent);
      if (!agent) return `There is no agent named "${input.agent}". Offer one from the roster.`;
      const busy = this.deps.directory.snapshot().find((p) => p.agent.id === agent.id && p.status === 'busy');
      if (busy) return `${agent.name} is busy with: ${busy.taskSummary ?? busy.taskId}. Offer an idle agent instead.`;
      const { taskId, agentName } = await this.deps.swarm.submitTask({
        prompt: `${agent.directives}\n\n---\nTask from the live meeting:\n${input.task}`,
        agent: agent.engine.cli,
        repository: this.repository,
        metadata: { source: 'broker-meeting', composedAgentId: agent.id },
      });
      this.deps.directory.bindTask(agent.id, {
        taskId,
        summary: input.task.slice(0, 80),
        swarmName: agentName ?? undefined,
      });
      return `Delegated to ${agent.name}: task ${taskId} queued. They will work asynchronously; you will be notified on completion.`;
    },
    check_status: async (input: { agent: string }): Promise<string> => {
      const agent = this.deps.directory.resolve(input.agent);
      if (!agent) return `There is no agent named "${input.agent}".`;
      const presence = this.deps.directory.snapshot().find((p) => p.agent.id === agent.id);
      if (!presence || presence.status !== 'busy' || !presence.taskId) return `${agent.name} is not working on anything right now.`;
      const { output } = await this.deps.swarm.getOutput(presence.taskId);
      const tail = output.split('\n').slice(-25).join('\n');
      return `Live terminal tail for ${agent.name} (summarize for speech, do not read verbatim):\n${tail}`;
    },
  };

  private repository = '';

  constructor(
    private readonly deps: BrokerDeps,
    opts?: { repository?: string },
  ) {
    this.repository = opts?.repository ?? '';
  }

  async start(): Promise<void> {
    this.deps.directory.seed(await this.deps.swarm.registry());
    this.unsubscribe = this.deps.swarm.subscribe((e) => this.onSwarmEvent(e));
    const pollMs = this.deps.pollMs ?? 2000;
    this.pollTimer = setInterval(() => void this.pollOnce(), pollMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubscribe?.();
    await this.leaveMeeting();
  }

  /** One poll cycle: join the first open meeting; leave when it closes. */
  async pollOnce(): Promise<void> {
    if (this.joining) return; // a join from a previous tick is still in flight
    let meetings: SwarmMeeting[];
    try {
      meetings = await this.deps.swarm.listMeetings();
    } catch {
      return; // swarm briefly unreachable — retry next tick
    }
    const open = meetings.find((m) => m.status === 'open');
    if (this.active && (!open || open.id !== this.active.meeting.id)) await this.leaveMeeting();
    if (open && !this.active) {
      this.joining = true;
      try {
        await this.joinMeeting(open);
      } finally {
        this.joining = false;
      }
    }
  }

  /** Public so the stdin dev channel (and tests) can inject an utterance. */
  handleUtterance(text: string): Promise<void> {
    return this.enqueueTurn(() => this.deps.brain.handleUtterance(text, this.makeTurn()));
  }

  private async joinMeeting(meeting: SwarmMeeting): Promise<void> {
    const bridge = this.deps.makeBridge();
    const stt = this.deps.makeStt();
    stt.start((utterance) => void this.handleUtterance(utterance));
    bridge.onRemoteAudio((pcm) => stt.sendAudio(pcm));
    try {
      const token = await this.deps.mintToken(meeting.roomName);
      await bridge.connect({ url: this.deps.livekitUrl, token });
    } catch (err) {
      stt.stop();
      console.error('[broker] failed to join meeting:', err);
      return; // this.active stays null — next poll retries
    }
    this.active = { meeting, bridge, stt };
    this.deps.directory.setMeeting(meeting.agentIds);
  }

  private async leaveMeeting(): Promise<void> {
    if (!this.active) return;
    this.active.stt.stop();
    await this.active.bridge.disconnect();
    this.active = null;
    this.deps.directory.clearMeeting();
  }

  private onSwarmEvent(e: SwarmEvent): void {
    if (e.type === 'task:completed' || e.type === 'task:failed') {
      const presence = this.deps.directory.findByTask(e.taskId);
      if (presence && this.active) {
        const verdict = e.type === 'task:completed' ? 'finished' : 'FAILED';
        const note = `${presence.agent.name} ${verdict} the delegated task (${presence.taskSummary ?? e.taskId}). Tell the human in one short sentence.`;
        void this.enqueueTurn(() => this.deps.brain.handleSystemNote(note, this.makeTurn()));
      }
    }
    this.deps.directory.onEvent(e);
  }

  /**
   * Run one brain turn after every turn already queued, isolating its errors
   * so a transient stream failure never rejects uncaught (the fire-and-forget
   * call sites — the stt callback and the system-note path — have no catch
   * of their own). `fn` is invoked lazily, only once its turn is actually
   * dequeued, so callers building a turn (e.g. `this.makeTurn()`, which
   * captures a roster snapshot) get a fresh one instead of a stale snapshot
   * taken at enqueue time. Mirrors `enqueueSpeech`: the chain itself never
   * rejects, so one failed turn never blocks the ones behind it.
   */
  private enqueueTurn(fn: () => Promise<void>): Promise<void> {
    const next = this.turnQueue.then(async () => {
      try {
        await fn();
      } catch (err) {
        console.error('[broker] brain turn failed:', err);
      }
    });
    this.turnQueue = next;
    return next;
  }

  private makeTurn(): BrainTurn {
    return {
      roster: this.deps.directory.describeForPrompt(),
      onSpeech: (chunk) => this.enqueueSpeech(chunk),
    };
  }

  /**
   * Serialize TTS chunks so audio never interleaves mid-sentence. Each link
   * catches its own failure so one bad chunk (a `speak()`/`publishPcm()`
   * rejection) never poisons the chain — `this.speaking` always settles
   * fulfilled, so later chunks still run and no unhandled rejection escapes.
   */
  private enqueueSpeech(text: string): void {
    const run = async (): Promise<void> => {
      try {
        const bridge = this.active?.bridge;
        if (!bridge) return;
        for await (const bytes of this.deps.speak(text)) {
          await bridge.publishPcm(bytes, TTS_SAMPLE_RATE);
        }
      } catch (err) {
        console.error('[broker] speech chunk failed:', err);
      }
    };
    this.speaking = this.speaking.then(run);
  }
}
