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
    let meetings: SwarmMeeting[];
    try {
      meetings = await this.deps.swarm.listMeetings();
    } catch {
      return; // swarm briefly unreachable — retry next tick
    }
    const open = meetings.find((m) => m.status === 'open');
    if (this.active && (!open || open.id !== this.active.meeting.id)) await this.leaveMeeting();
    if (open && !this.active) await this.joinMeeting(open);
  }

  /** Public so the stdin dev channel (and tests) can inject an utterance. */
  async handleUtterance(text: string): Promise<void> {
    await this.deps.brain.handleUtterance(text, this.makeTurn());
  }

  private async joinMeeting(meeting: SwarmMeeting): Promise<void> {
    const bridge = this.deps.makeBridge();
    const stt = this.deps.makeStt();
    stt.start((utterance) => void this.handleUtterance(utterance));
    bridge.onRemoteAudio((pcm) => stt.sendAudio(pcm));
    const token = await this.deps.mintToken(meeting.roomName);
    await bridge.connect({ url: this.deps.livekitUrl, token });
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
        void this.deps.brain.handleSystemNote(
          `${presence.agent.name} ${verdict} the delegated task (${presence.taskSummary ?? e.taskId}). Tell the human in one short sentence.`,
          this.makeTurn(),
        );
      }
    }
    this.deps.directory.onEvent(e);
  }

  private makeTurn(): BrainTurn {
    return {
      roster: this.deps.directory.describeForPrompt(),
      onSpeech: (chunk) => this.enqueueSpeech(chunk),
    };
  }

  /** Serialize TTS chunks so audio never interleaves mid-sentence. */
  private enqueueSpeech(text: string): void {
    this.speaking = this.speaking.then(async () => {
      const bridge = this.active?.bridge;
      if (!bridge) return;
      for await (const bytes of this.deps.speak(text)) {
        await bridge.publishPcm(bytes, TTS_SAMPLE_RATE);
      }
    });
  }
}
