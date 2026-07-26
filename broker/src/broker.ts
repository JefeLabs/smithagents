/**
 * Broker — the conversation coordinator's event loop. Owns no policy beyond
 * wiring: swarm meetings appear -> join the room; room audio -> STT ->
 * utterances -> brain; brain speech -> TTS -> room; brain tools -> swarm
 * delegation; swarm events -> directory updates + spoken narration.
 * Every dependency is injected (structural interfaces) so the whole loop
 * unit-tests with fakes; main.ts builds the real ones.
 */
import type { AgentDirectory, AgentPresence } from './directory.ts';
import type { BrainTurn } from './brain.ts';
import type { RegistryAgent, SwarmEvent, SwarmMeeting, SwarmSquad, SwarmWorkspace } from './swarm-client.ts';

export interface SwarmClientLike {
  listMeetings(): Promise<SwarmMeeting[]>;
  listSquads(): Promise<SwarmSquad[]>;
  listWorkspaces(): Promise<SwarmWorkspace[]>;
  listLiveTaskIds(): Promise<Set<string>>;
  registry(): Promise<RegistryAgent[]>;
  subscribe(onEvent: (e: SwarmEvent) => void): () => void;
  submitTask(req: {
    prompt: string;
    agent: 'agy' | 'claude' | 'codex';
    repository: string;
    branch?: string;
    metadata?: Record<string, unknown>;
    workspace?: string;
    repo?: string;
  }): Promise<{ taskId: string; agentName: string | null }>;
  getOutput(taskIdOrName: string): Promise<{ taskId: string; output: string }>;
  steer(taskIdOrName: string, message: string): Promise<void>;
  killTask(taskIdOrName: string): Promise<void>;
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
  /**
   * Every speech chunk as plain text, fired whether or not a meeting is
   * active — the transcript sink for text UIs and the stdin dev channel.
   * TTS/publish still requires an active bridge (no synthesis spend
   * between meetings); this callback is the free path.
   */
  onSpeechText?: (text: string) => void;
  /** Fired with a fresh roster snapshot after every directory, squad, group, or hand change. */
  onRosterChange?: (roster: UiRoster) => void;
  /** Durable store for roster composition (user squads, edits). Loaded on start, saved on every change. */
  rosterStore?: { load(): RosterState | null; save(state: RosterState): void };
  mintToken: (roomName: string) => Promise<string>;
  livekitUrl: string;
  pollMs?: number;
}

const TTS_SAMPLE_RATE = 44100;

/** Roster composition state that survives broker restarts. */
export interface RosterState {
  groups: Array<{ id: string; name: string; memberIds: string[] }>;
  squadEdits: Array<[string, { added: string[]; removed: string[] }]>;
  groupSeq: number;
}

/** The who's-who snapshot UIs render: presence, squads (with UI edits), user groups, freed members, hands. */
export interface UiRoster {
  agents: AgentPresence[];
  squads: Array<SwarmSquad & { extraMembers: string[]; removedMembers: string[] }>;
  groups: Array<{ id: string; name: string; members: Array<{ id: string; name: string }> }>;
  /** Original squad members dragged out — they stand alone until dragged back home. */
  freed: Array<{ name: string; role: string; squadId: string }>;
  hands: Record<string, string>;
}

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
    delegate: async (input: { agent: string; task: string; workspace?: string; repo?: string }): Promise<string> => {
      const agent = this.deps.directory.resolve(input.agent);
      if (!agent) return `There is no agent named "${input.agent}". Offer one from the roster.`;
      const busy = this.deps.directory.snapshot().find((p) => p.agent.id === agent.id && p.status === 'busy');
      if (busy) return `${agent.name} is busy with: ${busy.taskSummary ?? busy.taskId}. Offer an idle agent instead.`;
      const { taskId, agentName } = await this.deps.swarm.submitTask({
        prompt: `${agent.directives}\n\n---\nTask from the live meeting:\n${input.task}`,
        agent: agent.engine.cli,
        repository: this.repository,
        workspace: input.workspace,
        repo: input.repo,
        metadata: { source: 'broker-meeting', composedAgentId: agent.id },
      });
      this.deps.directory.bindTask(agent.id, {
        taskId,
        summary: input.task.slice(0, 80),
        swarmName: agentName ?? undefined,
      });
      this.notifyRoster();
      return `Delegated to ${agent.name}: task ${taskId} queued. They will work asynchronously; you will be notified on completion.`;
    },
    raise_hand: async (input: { agent: string; reason: string }): Promise<string> => {
      const name = input.agent.trim();
      if (!name) return 'raise_hand needs an agent name.';
      this.raisedHands.set(name, input.reason);
      this.notifyRoster();
      return `${name}'s hand is up (${input.reason}). The human sees it and may call on them — do not speak for them now.`;
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
  private squads: SwarmSquad[] = [];
  private workspaces: SwarmWorkspace[] = [];
  /** Raised hands by display name (agents or squad leaders) -> one-line reason. */
  private raisedHands = new Map<string, string>();
  /** User-formed squads (from the UI's edit mode). First member leads. */
  private groups: Array<{ id: string; name: string; memberIds: string[] }> = [];
  /** Conversation-layer edits to swarm squads: agents dragged in/out via the UI. */
  private squadEdits = new Map<string, { added: string[]; removed: string[] }>();
  private groupSeq = 0;

  constructor(
    private readonly deps: BrokerDeps,
    opts?: { repository?: string },
  ) {
    this.repository = opts?.repository ?? '';
  }

  async start(): Promise<void> {
    this.deps.directory.seed(await this.deps.swarm.registry());
    this.squads = await this.fetchSquads();
    this.workspaces = await this.deps.swarm.listWorkspaces().catch(() => []);
    this.restoreRosterState();
    this.notifyRoster();
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
    // Self-heal busy state: a placement whose task the swarm no longer runs is
    // stale (missed event, fast-fail race) — release the agent.
    try {
      if (this.deps.directory.reconcile(await this.deps.swarm.listLiveTaskIds())) this.notifyRoster();
    } catch {
      // swarm briefly unreachable — retry next tick
    }
    // Squad formation/dispatch happens outside the broker — refresh each tick
    // so squad circles in UIs track reality.
    const squads = await this.fetchSquads();
    if (JSON.stringify(squads) !== JSON.stringify(this.squads)) {
      this.squads = squads;
      this.notifyRoster();
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
    this.notifyRoster();
  }

  private async leaveMeeting(): Promise<void> {
    if (!this.active) return;
    this.active.stt.stop();
    await this.active.bridge.disconnect();
    this.active = null;
    this.deps.directory.clearMeeting();
    this.notifyRoster();
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
    this.notifyRoster();
  }

  /** Combined who's-who for UIs: solo agents with presence, squads (with edits), user groups, raised hands. */
  uiRoster(): UiRoster {
    const byId = (id: string) => this.deps.directory.resolve(id);
    const grouped = this.groupedAgentIds();
    return {
      // Solo circles only — an agent inside a squad exists as that squad, not as themselves.
      agents: this.deps.directory.snapshot().filter((p) => !grouped.has(p.agent.id)),
      squads: this.squads.map((s) => {
        const edits = this.squadEdits.get(s.id);
        return {
          ...s,
          extraMembers: (edits?.added ?? []).map((id) => byId(id)?.name ?? id),
          removedMembers: edits?.removed ?? [],
        };
      }),
      groups: this.groups.map((g) => ({
        id: g.id,
        name: g.name,
        members: g.memberIds.map((id) => ({ id, name: byId(id)?.name ?? id })),
      })),
      freed: [...this.squadEdits.entries()].flatMap(([squadId, edits]) =>
        edits.removed.flatMap((name) => {
          const member = this.squads.find((s) => s.id === squadId)?.members.find((m) => m.name === name);
          return member ? [{ name: member.name, role: member.role, squadId }] : [];
        }),
      ),
      hands: Object.fromEntries(this.raisedHands),
    };
  }

  /**
   * Roster composition ops from the UI's edit mode. Returns an error string or
   * null on success. Groups are user-formed squads over registry agents; ops on
   * swarm squads (alpha/beta/gamma) are conversation-layer edits — swarm's
   * execution roster is static config and is not touched.
   */
  /** Reload persisted composition, dropping references that no longer exist (removed personas, renamed squads). */
  private restoreRosterState(): void {
    const saved = this.deps.rosterStore?.load();
    if (!saved) return;
    const knownAgent = (id: string) => Boolean(this.deps.directory.resolve(id));
    this.groups = saved.groups
      .map((g) => ({ ...g, memberIds: g.memberIds.filter(knownAgent) }))
      .filter((g) => g.memberIds.length >= 2);
    this.squadEdits = new Map(
      saved.squadEdits
        .filter(([squadId]) => this.squads.some((s) => s.id === squadId))
        .map(([squadId, edits]) => {
          const squad = this.squads.find((s) => s.id === squadId)!;
          return [
            squadId,
            {
              added: edits.added.filter(knownAgent),
              removed: edits.removed.filter((name) => squad.members.some((m) => m.name === name)),
            },
          ];
        }),
    );
    this.groupSeq = saved.groupSeq;
  }

  private persistRosterState(): void {
    this.deps.rosterStore?.save({
      groups: this.groups.map((g) => ({ ...g, memberIds: [...g.memberIds] })),
      squadEdits: [...this.squadEdits.entries()].map(([id, e]) => [id, { added: [...e.added], removed: [...e.removed] }]),
      groupSeq: this.groupSeq,
    });
  }

  /** IDs of registry agents currently living inside a group or squad — they have no solo existence. */
  private groupedAgentIds(): Set<string> {
    return new Set([...this.groups.flatMap((g) => g.memberIds), ...[...this.squadEdits.values()].flatMap((e) => e.added)]);
  }

  /** An agent exists solo OR in exactly one squad — joining anywhere detaches them from everywhere else. */
  private detachEverywhere(agentId: string): void {
    for (const g of [...this.groups]) {
      if (!g.memberIds.includes(agentId)) continue;
      g.memberIds = g.memberIds.filter((id) => id !== agentId);
      if (g.memberIds.length < 2) this.groups = this.groups.filter((x) => x !== g); // a squad of one dissolves
    }
    for (const edits of this.squadEdits.values()) {
      edits.added = edits.added.filter((id) => id !== agentId);
    }
  }

  /** Working units are locked: cancel or wait before recomposing them. */
  private busyReason(nameOrId: string): string | null {
    const agent = this.deps.directory.resolve(nameOrId);
    if (agent) {
      const p = this.deps.directory.snapshot().find((x) => x.agent.id === agent.id);
      return p?.status === 'busy' ? `${agent.name} is working (${p.taskSummary ?? p.taskId}) — cancel or wait before editing` : null;
    }
    const key = nameOrId.replace(/^(squad|group)-/, '').toLowerCase();
    const squad = this.squads.find((s) => s.id === key);
    if (squad?.status === 'active') return `squad ${squad.id} is working — cancel or wait before editing`;
    const group = this.groups.find((g) => g.id === key || g.name === key);
    if (group) for (const id of group.memberIds) {
      const reason = this.busyReason(id);
      if (reason) return `squad ${group.name}: ${reason}`;
    }
    return null;
  }

  compose(op: { op: 'form'; agents: string[] } | { op: 'add' | 'remove'; target: string; agent: string }): string | null {
    const GROUP_NAMES = ['delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];
    const resolveId = (nameOrId: string) => this.deps.directory.resolve(nameOrId)?.id;
    const locked = op.op === 'form' ? op.agents.map((a) => this.busyReason(a)).find(Boolean) : (this.busyReason(op.agent) ?? this.busyReason(op.target));
    if (locked) return locked;
    if (op.op === 'form') {
      const ids = [...new Set(op.agents.map(resolveId))];
      if (ids.length < 2 || ids.some((id) => !id)) return 'form needs two distinct known agents';
      for (const id of ids as string[]) this.detachEverywhere(id);
      const name = GROUP_NAMES[this.groupSeq % GROUP_NAMES.length]!;
      this.groupSeq += 1;
      this.groups.push({ id: `g${this.groupSeq}`, name, memberIds: ids as string[] });
      this.persistRosterState();
      this.notifyRoster();
      return null;
    }
    op = { ...op, agent: op.agent.replace(/^freed-/, '') }; // UI roster ids for freed members carry a prefix
    const registryId = resolveId(op.agent);
    const group = this.groups.find((g) => g.id === op.target || `group-${g.id}` === op.target);
    if (group) {
      if (!registryId) return `unknown agent: ${op.agent}`; // groups hold registry agents only
      if (op.op === 'add' && !group.memberIds.includes(registryId)) {
        this.detachEverywhere(registryId);
        if (!this.groups.includes(group)) return `squad dissolved while moving ${op.agent}`; // detaching emptied it
        group.memberIds.push(registryId);
      }
      if (op.op === 'remove') {
        group.memberIds = group.memberIds.filter((id) => id !== registryId);
        if (group.memberIds.length < 2) this.groups = this.groups.filter((g) => g !== group); // a squad of one dissolves
      }
      this.persistRosterState();
      this.notifyRoster();
      return null;
    }
    const squad = this.squads.find((s) => s.id === op.target || `squad-${s.id}` === op.target);
    if (!squad) return `unknown squad or group: ${op.target}`;
    const edits = this.squadEdits.get(squad.id) ?? { added: [], removed: [] };
    if (op.op === 'add') {
      const freedName = squad.members.find((m) => m.name.toLowerCase() === op.agent.toLowerCase() && edits.removed.includes(m.name))?.name;
      if (freedName) {
        // A freed original member dragged back home rejoins their squad.
        edits.removed = edits.removed.filter((n) => n !== freedName);
      } else if (!registryId) {
        const home = this.squads.find((s) => s.members.some((m) => m.name.toLowerCase() === op.agent.toLowerCase()));
        return home ? `${op.agent} can only rejoin the ${home.id} squad` : `unknown agent: ${op.agent}`;
      } else if (!edits.added.includes(registryId)) {
        this.detachEverywhere(registryId);
        edits.added.push(registryId);
      }
    }
    if (op.op === 'remove') {
      if (registryId && edits.added.includes(registryId)) edits.added = edits.added.filter((id) => id !== registryId);
      else {
        // Removing an original squad member (Fabian, Osvaldo, …) is a
        // conversation-layer exclusion by name — swarm's config is untouched.
        const name = this.deps.directory.resolve(op.agent)?.name ?? op.agent;
        if (!edits.removed.includes(name)) edits.removed.push(name);
      }
    }
    this.squadEdits.set(squad.id, edits);
    this.persistRosterState();
    this.notifyRoster();
    return null;
  }

  private notifyRoster(): void {
    this.deps.onRosterChange?.(this.uiRoster());
  }

  /** The running task behind a roster name — agents via presence, squads/groups via their task binding. */
  private taskFor(name: string): { taskId: string; label: string } | null {
    const agent = this.deps.directory.resolve(name);
    if (agent) {
      const p = this.deps.directory.snapshot().find((x) => x.agent.id === agent.id);
      return p?.status === 'busy' && p.taskId ? { taskId: p.taskId, label: agent.name } : null;
    }
    const key = name.replace(/^(squad|group)-/, '').toLowerCase();
    const squad = this.squads.find((s) => s.id === key);
    if (squad?.status === 'active' && squad.taskId) return { taskId: squad.taskId, label: `squad ${squad.id}` };
    const group = this.groups.find((g) => g.id === key || g.name === key);
    if (group) {
      for (const id of group.memberIds) {
        const hit = this.taskFor(id);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** Live output for a working agent/squad — the UI's click-to-inspect view. */
  async activity(name: string): Promise<{ busy: boolean; label?: string; output?: string }> {
    const task = this.taskFor(name);
    if (!task) return { busy: false };
    const { output } = await this.deps.swarm.getOutput(task.taskId);
    return { busy: true, label: task.label, output: output.split('\n').slice(-40).join('\n') };
  }

  /** Steer a working agent/squad mid-task. Returns an error string or null. */
  async steerWork(name: string, message: string): Promise<string | null> {
    const task = this.taskFor(name);
    if (!task) return `${name} is not working on anything`;
    await this.deps.swarm.steer(task.taskId, message);
    return null;
  }

  /** Cancel a working agent/squad's task. Returns an error string or null. */
  async cancelWork(name: string): Promise<string | null> {
    const task = this.taskFor(name);
    if (!task) return `${name} is not working on anything`;
    await this.deps.swarm.killTask(task.taskId);
    return null;
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
      roster: this.describeRosterForBrain(),
      onSpeech: (chunk) => this.enqueueSpeech(chunk),
    };
  }

  /** Agents (with live status) plus squad structure and raised hands — the brain's who's-who each turn. */
  private describeRosterForBrain(): string {
    // Grouped agents don't exist solo — they appear only inside their squad's line.
    let out = this.deps.directory.describeForPrompt(this.groupedAgentIds());
    const freed = [...this.squadEdits.entries()].flatMap(([squadId, edits]) =>
      edits.removed.flatMap((name) => {
        const m = this.squads.find((s) => s.id === squadId)?.members.find((x) => x.name === name);
        return m ? [`${m.name} (${m.role}, currently solo — formerly of ${squadId}) — idle`] : [];
      }),
    );
    if (freed.length > 0) out += `\n${freed.join('\n')}`;
    const delegable = this.deps.directory
      .snapshot()
      .map((p) => p.agent.name)
      .join(', ');
    out += `\n\nDelegable (ONLY these can take delegated tasks — squad members and squad leaders cannot, they only speak): ${delegable}`;
    if (this.workspaces.length > 0) {
      const wsLines = this.workspaces
        .map((w) => `${w.name}${w.default ? ' (default)' : ''}: ${w.repos.map((r) => r.name).join(', ')}`)
        .join('\n');
      out += `\n\nWorkspaces & repos (pass repo — and workspace if not the default — when delegating):\n${wsLines}`;
    }
    if (this.squads.length > 0) {
      const squadLines = this.squads
        .map((s) => {
          const edits = this.squadEdits.get(s.id);
          const members = s.members
            .map((m) => `${m.name} (${m.role})`)
            .concat((edits?.added ?? []).map((id) => `${this.deps.directory.resolve(id)?.name ?? id} (guest)`))
            .filter((line) => !(edits?.removed ?? []).some((name) => line.startsWith(`${name} (`)));
          return `${s.id} — leader: ${s.leader.name}; members: ${members.join(', ')} — ${s.status}`;
        })
        .join('\n');
      out += `\n\nSquads (address one and only its leader answers):\n${squadLines}`;
    }
    if (this.groups.length > 0) {
      const groupLines = this.groups
        .map((g) => {
          const names = g.memberIds.map((id) => this.deps.directory.resolve(id)?.name ?? id);
          return `${g.name} — leader: ${names[0]}; members: ${names.join(', ')}`;
        })
        .join('\n');
      out += `\n\nUser-formed squads (same rule — only the leader answers for the squad):\n${groupLines}`;
    }
    if (this.raisedHands.size > 0) {
      const handLines = [...this.raisedHands].map(([name, reason]) => `${name}: ${reason}`).join('\n');
      out += `\n\nRaised hands (already up — do not re-raise; they speak only when the human calls on them):\n${handLines}`;
    }
    return out;
  }

  /** Squad structure is optional context — an older swarm without it is not an error. */
  private async fetchSquads(): Promise<SwarmSquad[]> {
    try {
      return await this.deps.swarm.listSquads();
    } catch {
      return [];
    }
  }

  /**
   * Serialize TTS chunks so audio never interleaves mid-sentence. Each link
   * catches its own failure so one bad chunk (a `speak()`/`publishPcm()`
   * rejection) never poisons the chain — `this.speaking` always settles
   * fulfilled, so later chunks still run and no unhandled rejection escapes.
   */
  /** A speaker taking the floor lowers their own hand. */
  private lowerHandFor(chunk: string): void {
    const m = /^([A-Z][\w-]{1,24}):\s/.exec(chunk);
    if (m?.[1] && this.raisedHands.delete(m[1])) this.notifyRoster();
  }

  private enqueueSpeech(text: string): void {
    this.lowerHandFor(text);
    const run = async (): Promise<void> => {
      try {
        this.deps.onSpeechText?.(text);
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
