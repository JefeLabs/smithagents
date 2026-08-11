import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Broker, type BridgeLike, type SttLike, type SwarmClientLike, TTS_SAMPLE_RATE } from './broker.ts';
import { AgentDirectory } from './directory.ts';
import type { BrainLike, RosterState, TurnOrigin } from './broker.ts';
import type { RegistryAgent, SwarmEvent, SwarmMeeting, SwarmWorkspace } from './swarm-client.ts';

const AGENTS: RegistryAgent[] = [
  { id: 'manuel', name: 'Manuel', role: 'lead', directives: 'Be Manuel.', engine: { cli: 'claude', model: 'claude-sonnet-5' } },
];

const IGNACIO: RegistryAgent = {
  id: 'ignacio', name: 'Ignacio', role: 'specialist', directives: 'Be Ignacio.', engine: { cli: 'claude', model: 'claude-sonnet-5' },
};

function makeFakes(meetings: SwarmMeeting[]) {
  const submitted: unknown[] = [];
  let eventSink: ((e: SwarmEvent) => void) | null = null;
  const swarm: SwarmClientLike = {
    listMeetings: async () => meetings,
    listSquads: async () => [
      { id: 'alpha', status: 'idle', leader: { name: 'Gabriel', role: 'leader' }, members: [{ name: 'Gabriel', role: 'leader' }] },
      { id: 'beta', status: 'idle', leader: { name: 'Gustavo', role: 'leader' }, members: [{ name: 'Gustavo', role: 'leader' }] },
    ],
    listLiveTaskIds: async () => new Set(['t-77']),
    listWorkspaces: async () => [
      { name: 'jefelabs', default: true, repos: [{ name: 'smithagents', path: '/path/to/smithagents', branch: 'main' }] },
    ],
    registry: async () => AGENTS,
    subscribe: (cb) => {
      eventSink = cb;
      return () => {};
    },
    submitTask: async (req) => {
      submitted.push(req);
      return { taskId: 't-77', agentName: 'bold-falcon' };
    },
    getOutput: async () => ({ taskId: 't-77', output: 'line1\nline2\nDONE building the thing' }),
    steer: async () => {},
    killTask: async () => {},
    lookupTicket: async () => ({ ok: true }),
    searchDocs: async () => ({ ok: true }),
    getWorkspaceChannels: async () => ({ hasDiscordToken: false, textChannels: [], voiceChannels: [] }),
    saveWorkspaceChannels: async () => ({ hasDiscordToken: false, textChannels: [], voiceChannels: [] }),
    verifyWorkspaceDiscord: async () => ({ ok: true, detail: 'verified' }),
  };

  const sttAudio: Uint8Array[] = [];
  const sttStops: number[] = [];
  let utteranceSink: ((t: string) => void) | null = null;
  const stt: SttLike = {
    start: (cb) => (utteranceSink = cb),
    sendAudio: (b) => sttAudio.push(b),
    stop: () => void sttStops.push(1),
  };

  const published: Array<{ bytes: Uint8Array; sampleRate: number; personaId?: string }> = [];
  const bridge: BridgeLike & { remoteCb: ((b: Uint8Array) => void) | null; connected: string[] } = {
    remoteCb: null,
    connected: [],
    connect: async (opts) => void bridge.connected.push(opts.token),
    onRemoteAudio: (cb) => (bridge.remoteCb = cb),
    publishPcm: async (bytes, sampleRate, personaId) => void published.push({ bytes, sampleRate, personaId }),
    disconnect: async () => {},
  };

  const heard: string[] = [];
  const rosters: string[] = [];
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => {
      heard.push(text);
      rosters.push(turn.roster);
      turn.onSpeech('spoken reply');
    },
    handleSystemNote: async (note, turn) => {
      heard.push(`NOTE:${note}`);
      rosters.push(turn.roster);
      turn.onSpeech('narration');
    },
  };

  return {
    swarm, stt, bridge, brain, submitted, published, heard, rosters, sttStops,
    emitEvent: (e: SwarmEvent) => eventSink?.(e),
    emitUtterance: (t: string) => utteranceSink?.(t),
  };
}

function makeBroker(
  f: ReturnType<typeof makeFakes>,
  opts?: {
    onSpeechText?: (text: string) => void;
    onRosterChange?: (roster: { agents: Array<{ status: string }>; squads: unknown[] }) => void;
    onTaskDispatched?: (d: { taskId: string; agent: string; task: string }) => void;
    identityName?: string;
    onGroupChanged?: (groupId: string) => void;
    rosterStore?: { load(): RosterState | null; save(state: RosterState): void };
  },
) {
  const directory = new AgentDirectory();
  return new Broker({
    onRosterChange: opts?.onRosterChange,
    identityName: opts?.identityName,
    onTaskDispatched: opts?.onTaskDispatched,
    onGroupChanged: opts?.onGroupChanged,
    rosterStore: opts?.rosterStore,
    swarm: f.swarm,
    directory,
    brain: f.brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    onSpeechText: opts?.onSpeechText,
    speak: async function* (text) {
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
  });
}

const MEETING: SwarmMeeting = {
  id: 'm-1', roomName: 'meeting-m-1', agentIds: ['manuel'], mode: 'solo', status: 'open', createdAt: 'now',
};

test('pollOnce joins an open meeting: token minted, bridge connected, mic wired to stt', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  assert.deepEqual(f.bridge.connected, ['jwt-for-meeting-m-1']);
  f.bridge.remoteCb!(new Uint8Array([1]));
  await b.stop();
});

test('utterance flows: stt -> brain -> speak -> publishPcm at the TTS rate', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  f.emitUtterance('hello manuel');
  await new Promise((r) => setTimeout(r, 10)); // let the async turn settle
  assert.deepEqual(f.heard, ['hello manuel']);
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0]!.sampleRate, TTS_SAMPLE_RATE);
  assert.match(Buffer.from(f.published[0]!.bytes).toString(), /AUDIO\(spoken reply\)/);
  await b.stop();
});

test('speech text reaches onSpeechText even with no active meeting; no PCM published', async () => {
  const f = makeFakes([]); // no meetings — text-only mode (stdin / text channel)
  const transcript: string[] = [];
  const b = makeBroker(f, { onSpeechText: (t) => transcript.push(t) });
  await b.start();
  await b.handleUtterance('status check');
  await new Promise((r) => setTimeout(r, 10)); // speech chain settles after the turn
  assert.deepEqual(f.heard, ['status check']);
  assert.deepEqual(transcript, ['spoken reply']);
  assert.equal(f.published.length, 0); // no bridge -> no TTS spend
  await b.stop();
});

test("speech publishes with the speaking agent's persona id", async () => {
  const f = makeFakes([MEETING]);
  f.swarm.registry = async () => [...AGENTS, IGNACIO];
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => {
      if (text === 'dime algo') {
        turn.onSpeech('Ignacio: dime'); // prefixed — sets the sticky speaker
        turn.onSpeech('algo mas'); // unprefixed continuation — reuses the sticky speaker
      } else {
        turn.onSpeech('a narrator line'); // fresh turn, never prefixed — no persona
      }
    },
    handleSystemNote: async () => {},
  };
  const b = new Broker({ ...basicDeps(f, new AgentDirectory()), brain });
  try {
    await b.start();
    await b.pollOnce(); // join MEETING — active.bridge is now live

    await b.handleUtterance('dime algo');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.published.length, 2);
    assert.equal(f.published[0]!.personaId, 'ignacio');
    assert.equal(f.published[1]!.personaId, 'ignacio'); // sticky — no prefix on the second chunk

    await b.handleUtterance('narrate'); // new turn -> sticky resets at onTurnStart
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.published.length, 3);
    assert.equal(f.published[2]!.personaId, undefined); // narrator line, no speaker prefix
  } finally {
    await b.stop();
  }
});

test('a prefixed line with an unresolved speaker name publishes with no persona id', async () => {
  const f = makeFakes([MEETING]);
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => void turn.onSpeech('Ghost: nobody knows me'),
    handleSystemNote: async () => {},
  };
  const b = new Broker({ ...basicDeps(f, new AgentDirectory()), brain });
  try {
    await b.start();
    await b.pollOnce(); // join MEETING — active.bridge is now live
    await b.handleUtterance('anything');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.published.length, 1);
    assert.equal(f.published[0]!.personaId, undefined); // 'Ghost' resolves to no known agent
  } finally {
    await b.stop();
  }
});

test("a system-note turn (task completion narration) never inherits a prior turn's sticky persona", async () => {
  const f = makeFakes([MEETING]);
  f.swarm.registry = async () => [...AGENTS, IGNACIO];
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => void turn.onSpeech('Ignacio: dime'), // sets the sticky speaker
    handleSystemNote: async (note, turn) => void turn.onSpeech('narration'), // unprefixed — must be its own, clean turn
  };
  const b = new Broker({ ...basicDeps(f, new AgentDirectory()), brain });
  try {
    await b.start();
    await b.pollOnce(); // join MEETING — active.bridge is now live

    await b.handleUtterance('dime algo'); // sticky is now 'ignacio'
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.published.length, 1);
    assert.equal(f.published[0]!.personaId, 'ignacio');

    // A task-completion event queues a system-note turn through onSwarmEvent's
    // own enqueueTurn call — a different entry point than handleUtterance's.
    await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
    f.emitEvent({ type: 'task:dispatched', taskId: 't-77', sessionName: 's' });
    f.emitEvent({ type: 'task:completed', taskId: 't-77', result: { outcome: 'completed' } });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(f.published.length, 2);
    assert.equal(f.published[1]!.personaId, undefined); // narration must not inherit Ignacio's sticky persona
  } finally {
    await b.stop();
  }
});

test('attachVoiceSurface declines while a meeting is active, and vice versa', async () => {
  const surface = { publishPcm: async () => {} };

  // 1. A meeting is already active — attaching an external voice surface is declined.
  const f1 = makeFakes([MEETING]);
  const b1 = makeBroker(f1);
  try {
    await b1.start();
    await b1.pollOnce();
    assert.equal(b1.attachVoiceSurface(surface), false);
  } finally {
    await b1.stop();
  }

  // 2. Fresh broker: attach first -> the next pollOnce declines to join the open meeting.
  const f2 = makeFakes([MEETING]);
  const b2 = makeBroker(f2);
  try {
    await b2.start();
    assert.equal(b2.attachVoiceSurface(surface), true);
    assert.equal(b2.voiceSurfaceAttached(), true);
    await b2.pollOnce();
    assert.deepEqual(f2.bridge.connected, []); // meeting join declined — surface is live

    // 3. Detaching releases the slot; the next pollOnce joins normally.
    b2.detachVoiceSurface();
    assert.equal(b2.voiceSurfaceAttached(), false);
    await b2.pollOnce();
    assert.deepEqual(f2.bridge.connected, ['jwt-for-meeting-m-1']);
  } finally {
    await b2.stop();
  }
});

test('attachVoiceSurface declines while a meeting join is in flight, before this.active is ever set', async () => {
  const f = makeFakes([MEETING]);
  let releaseConnect: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => (releaseConnect = resolve));
  const published: Array<{ bytes: Uint8Array; sampleRate: number; personaId?: string }> = [];
  const bridge: BridgeLike & { connected: string[] } = {
    connected: [],
    connect: async (opts) => {
      await gate; // holds joinMeeting() in flight — this.active stays null, this.joining stays true
      bridge.connected.push(opts.token);
    },
    onRemoteAudio: () => {},
    publishPcm: async (bytes, sampleRate, personaId) => void published.push({ bytes, sampleRate, personaId }),
    disconnect: async () => {},
  };
  const b = new Broker({ ...basicDeps(f, new AgentDirectory()), makeBridge: () => bridge });
  const surface = { publishPcm: async () => {} };
  try {
    await b.start();
    const pollPromise = b.pollOnce(); // starts joinMeeting(); blocks on the gated connect()
    await new Promise((r) => setTimeout(r, 10)); // let pollOnce reach the blocked connect() call
    assert.equal(b.attachVoiceSurface(surface), false); // declined — a join is in flight, not yet this.active
    assert.equal(b.voiceSurfaceAttached(), false);

    releaseConnect!();
    await pollPromise; // the in-flight join completes normally, unaffected by the declined attach
    assert.deepEqual(bridge.connected, ['jwt-for-meeting-m-1']);

    await b.handleUtterance('hi'); // publish flows to the meeting bridge only — no external surface was ever attached
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(published.length, 1);
  } finally {
    await b.stop();
  }
});

test('while a voice surface is attached, speech publishes to it', async () => {
  const f = makeFakes([]); // no meetings at all
  f.swarm.registry = async () => [...AGENTS, IGNACIO];
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => void turn.onSpeech('Ignacio: hola'),
    handleSystemNote: async () => {},
  };
  const b = new Broker({ ...basicDeps(f, new AgentDirectory()), brain });
  const published: Array<{ bytes: Uint8Array; sampleRate: number; personaId?: string }> = [];
  const surface = {
    publishPcm: async (bytes: Uint8Array, sampleRate: number, personaId?: string) =>
      void published.push({ bytes, sampleRate, personaId }),
  };
  try {
    await b.start();
    assert.equal(b.attachVoiceSurface(surface), true);
    await b.handleUtterance('hi');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(published.length, 1);
    assert.equal(published[0]!.sampleRate, TTS_SAMPLE_RATE);
    assert.equal(published[0]!.personaId, 'ignacio');
    assert.equal(f.published.length, 0); // never touched the meeting bridge
  } finally {
    await b.stop();
  }
});

test('turn-scoped origin: two queued turns route speech only to their own origin', async () => {
  const f = makeFakes([]);
  // Fake brain that emits speech distinguishable per input turn (the shared
  // fakes' brain always emits the same 'spoken reply' string, too coarse here).
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => void turn.onSpeech(`reply to ${text}`),
    handleSystemNote: async () => {},
  };
  let active: TurnOrigin | undefined;
  const delivered: Record<string, string[]> = {};
  const b = new Broker({
    swarm: f.swarm,
    directory: new AgentDirectory(),
    brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    speak: async function* (text) {
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
    onTurnStart: (origin) => (active = origin),
    onTurnEnd: () => (active = undefined),
    onSpeechText: (text) => {
      if (!active) return; // mirrors AdapterHub.dispatchSpeech's own guard
      (delivered[active.channelRef] ??= []).push(text);
    },
  });
  try {
    await b.start();
    const originA: TurnOrigin = { kind: 'discord', channelRef: 'chan-A' };
    const originB: TurnOrigin = { kind: 'discord', channelRef: 'chan-B' };
    // Both queued back to back — turnQueue serializes them, but the OLD
    // single-mutable-origin design let the second arrival's origin clobber
    // the first turn's before its own speech had gone out.
    const p1 = b.handleUtterance('first', originA);
    const p2 = b.handleUtterance('second', originB);
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 10)); // let both turns' speech chains settle
    assert.deepEqual(delivered['chan-A'], ['reply to first']);
    assert.deepEqual(delivered['chan-B'], ['reply to second']);
  } finally {
    await b.stop();
  }
});

test('a turn with no origin (meeting-style) never reaches an adapter, even right after a prior turn had one', async () => {
  const f = makeFakes([]);
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => void turn.onSpeech(`reply to ${text}`),
    handleSystemNote: async () => {},
  };
  let active: TurnOrigin | undefined;
  const delivered: string[] = [];
  const b = new Broker({
    swarm: f.swarm,
    directory: new AgentDirectory(),
    brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    speak: async function* (text) {
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
    onTurnStart: (origin) => (active = origin),
    onTurnEnd: () => (active = undefined),
    onSpeechText: (text) => {
      if (active) delivered.push(text);
    },
  });
  try {
    await b.start();
    await b.handleUtterance('from discord', { kind: 'discord', channelRef: 'chan-A' });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(delivered, ['reply to from discord']);
    // Meeting-style: broker.ts:281's stt callback calls handleUtterance with
    // no second argument at all — same call shape as this.
    await b.handleUtterance('from the mic');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(delivered, ['reply to from discord']); // unchanged — the meeting turn never had an active origin
  } finally {
    await b.stop();
  }
});

test("Finding 3 fix: a prior turn's still-draining speech chain is drained before a Discord turn activates its origin, so a late chunk never leaks into the wrong channel", async () => {
  const f = makeFakes([MEETING]);
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => {
      if (text === 'meeting line') {
        turn.onSpeech('Manuel: first chunk, slow to speak');
        turn.onSpeech('second chunk, no prefix — sticky to Manuel');
      } else {
        turn.onSpeech(`reply to ${text}`);
      }
    },
    handleSystemNote: async () => {},
  };
  let active: TurnOrigin | undefined;
  const delivered: Record<string, string[]> = {};
  let releaseSlowChunk: (() => void) | null = null;
  const slow = new Promise<void>((resolve) => (releaseSlowChunk = resolve));
  const b = new Broker({
    swarm: f.swarm,
    directory: new AgentDirectory(),
    brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    speak: async function* (text) {
      if (text.startsWith('Manuel: first chunk')) await slow; // holds the speaking chain open
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
    onTurnStart: (origin) => (active = origin),
    onTurnEnd: () => (active = undefined),
    onSpeechText: (text) => {
      if (!active) return; // mirrors AdapterHub.dispatchSpeech's own guard
      (delivered[active.channelRef] ??= []).push(text);
    },
  });
  try {
    await b.start();
    await b.pollOnce(); // join MEETING — with no active bridge, enqueueSpeech's run() never calls speak() at all

    // Turn A: no origin (meeting-style). Its brain call resolves immediately —
    // handleUtterance never awaits the speaking chain for origin-less turns —
    // but its second chunk is still stuck behind the still-draining first one.
    const turnA = b.handleUtterance('meeting line');
    // Turn B: Discord-origined, queued right behind A.
    const turnB = b.handleUtterance('from discord', { kind: 'discord', channelRef: 'chan-1' });
    await new Promise((r) => setTimeout(r, 10)); // let A's brain call finish and B attempt to start
    // B must be blocked draining A's chain — its origin must not be active yet.
    assert.equal(active, undefined);

    releaseSlowChunk!();
    await Promise.all([turnA, turnB]);
    await new Promise((r) => setTimeout(r, 10)); // let both speaking chains fully settle

    // A's chunks went out with no origin active (dropped, like any meeting
    // speech) — none of them ever reached chan-1, which carries only B's own reply.
    assert.deepEqual(delivered['chan-1'], ['reply to from discord']);
  } finally {
    await b.stop();
  }
});

test('roster notifications fire on seed and on delegation, carrying agents and squads', async () => {
  const f = makeFakes([]);
  const rosters: Array<{ agents: Array<{ status: string }>; squads: unknown[] }> = [];
  const b = makeBroker(f, { onRosterChange: (r) => rosters.push(r) });
  await b.start();
  assert.equal(rosters.length, 1); // seeded snapshot
  assert.equal(rosters[0]!.squads.length, 2);
  await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
  assert.equal(rosters.length, 2); // busy snapshot after bindTask
  assert.equal(rosters.at(-1)!.agents[0]!.status, 'busy');
  await b.stop();
});

test('delegate fires onTaskDispatched with the taskId, agent name, and task text', async () => {
  const f = makeFakes([MEETING]);
  const dispatched: Array<{ taskId: string; agent: string; task: string }> = [];
  const b = makeBroker(f, { onTaskDispatched: (d) => dispatched.push(d) });
  await b.start();
  await b.pollOnce();
  try {
    await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
    assert.deepEqual(dispatched, [{ taskId: 't-77', agent: 'Manuel', task: 'build the thing' }]);
  } finally {
    await b.stop();
  }
});

test('refreshWorkspaces drops an archived workspace from the brain roster; start() already filters', async () => {
  const f = makeFakes([]);
  let workspaces: SwarmWorkspace[] = [
    { name: 'jefelabs', default: true, repos: [{ name: 'smithagents', path: '/path/to/smithagents', branch: 'main' }] },
  ];
  f.swarm.listWorkspaces = async () => workspaces;
  const b = makeBroker(f);
  await b.start();
  await b.handleUtterance('one');
  assert.match(f.rosters.at(-1)!, /jefelabs/); // live workspace reaches the delegation prompt

  // Archive it (as workspaces.remove would after the last usage disappears) and
  // refresh — mirrors main.ts's refreshWorkspaceNames, which now calls this too.
  workspaces = [{ ...workspaces[0]!, archived: true }];
  await b.refreshWorkspaces();
  await b.handleUtterance('two');
  assert.doesNotMatch(f.rosters.at(-1)!, /jefelabs/); // archived workspace no longer offered

  await b.stop();
});

test('delegate executor resolves agent, prefixes directives, binds task in directory', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  const result = await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
  assert.match(result, /t-77/);
  const sent = f.submitted[0] as { prompt: string; agent: string };
  assert.equal(sent.agent, 'claude');
  assert.match(sent.prompt, /Be Manuel\./);
  assert.match(sent.prompt, /build the thing/);
  await b.stop();
});

test('delegate forwards ticketKey into task metadata when given', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  await b.executors.delegate({ agent: 'Manuel', task: 'build the thing', ticketKey: 'PROJ-123' });
  const sent = f.submitted[0] as { metadata: Record<string, unknown> };
  assert.equal(sent.metadata.ticketKey, 'PROJ-123');
  await b.stop();
});

test('dispatchWork: refuses unknown and busy agents with {error}', async () => {
  const f = makeFakes([]);
  const b = makeBroker(f);
  await b.start();
  const unknown = await b.dispatchWork({ agent: 'Nobody', task: 'x' });
  assert.deepEqual(unknown, { error: 'There is no agent named "Nobody".' });

  await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' }); // binds Manuel busy
  const busy = await b.dispatchWork({ agent: 'Manuel', task: 'second task' });
  assert.ok('error' in busy);
  assert.equal((busy as { error: string }).error, 'Manuel is busy with: build the thing.');
  await b.stop();
});

test('dispatchWork: submits directives-prefixed prompt with merged metadata and binds the task', async () => {
  const f = makeFakes([]);
  const b = makeBroker(f);
  await b.start();
  const result = await b.dispatchWork({
    agent: 'Manuel',
    task: 'build the thing',
    metadata: { source: 'work-board', workCardRef: { boardId: 'b1', cardId: 'c1' } },
  });
  assert.ok(!('error' in result));
  const ok = result as { taskId: string; agentName: string | null; agentDisplayName: string };
  assert.equal(ok.taskId, 't-77');
  assert.equal(ok.agentDisplayName, 'Manuel');

  const sent = f.submitted[0] as { prompt: string; metadata: Record<string, unknown> };
  assert.match(sent.prompt, /^Be Manuel\./);
  assert.match(sent.prompt, /build the thing/);
  assert.equal(sent.metadata.composedAgentId, 'manuel');
  assert.equal(sent.metadata.source, 'work-board');
  assert.deepEqual(sent.metadata.workCardRef, { boardId: 'b1', cardId: 'c1' });

  assert.equal(b.uiRoster().agents[0]!.status, 'busy'); // bindTask ran
  await b.stop();
});

test('dispatchWork stamps the active session runtime only when inheritSessionRuntime is set (meeting-origin)', async () => {
  const f = makeFakes([]);
  const b = new Broker({ ...basicDeps(f, new AgentDirectory()), sessionRuntime: () => 'remote-docker' });
  await b.start();
  await b.dispatchWork({ agent: 'Manuel', task: 'fix the build', inheritSessionRuntime: true });
  const sent = f.submitted[0] as { runtime?: string };
  assert.equal(sent.runtime, 'remote-docker');
  await b.stop();
});

test('dispatchWork omits runtime when no session is active, even with inheritSessionRuntime set', async () => {
  const f = makeFakes([]);
  const b = new Broker({ ...basicDeps(f, new AgentDirectory()), sessionRuntime: () => undefined });
  await b.start();
  await b.dispatchWork({ agent: 'Manuel', task: 'fix the build', inheritSessionRuntime: true });
  const sent = f.submitted[0] as { runtime?: string };
  assert.equal(sent.runtime, undefined);
  await b.stop();
});

test('dispatchWork does NOT stamp runtime by default — a board dispatch never inherits the session (human ruling 2026-08-07)', async () => {
  const f = makeFakes([]);
  const b = new Broker({ ...basicDeps(f, new AgentDirectory()), sessionRuntime: () => 'remote-docker' });
  await b.start();
  // Board dispatches (main.ts workBoards.delegate) call dispatchWork directly, without
  // inheritSessionRuntime — even with an active session, the task must go unstamped.
  await b.dispatchWork({ agent: 'Manuel', task: 'fix the build' });
  const sent = f.submitted[0] as { runtime?: string };
  assert.equal(sent.runtime, undefined);
  await b.stop();
});

test('executors.delegate (the meeting brain tool) inherits the active session runtime', async () => {
  const f = makeFakes([]);
  const b = new Broker({ ...basicDeps(f, new AgentDirectory()), sessionRuntime: () => 'remote-docker' });
  await b.start();
  await b.executors.delegate({ agent: 'Manuel', task: 'fix the build' });
  const sent = f.submitted[0] as { runtime?: string };
  assert.equal(sent.runtime, 'remote-docker');
  await b.stop();
});

test("delegate executor keeps its exact success/refusal strings", async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();

  const unknown = await b.executors.delegate({ agent: 'Nobody', task: 'x' });
  assert.equal(unknown, 'There is no agent named "Nobody". Offer one from the roster.');

  const ok = await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
  assert.equal(ok, 'Delegated to Manuel: task t-77 queued. They will work asynchronously; you will be notified on completion.');

  const busy = await b.executors.delegate({ agent: 'Manuel', task: 'another thing' });
  assert.equal(busy, 'Manuel is busy with: build the thing. Offer an idle agent instead.');
  await b.stop();
});

test('delegate on unknown agent returns an error string (brain speaks it, no throw)', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  const result = await b.executors.delegate({ agent: 'Nobody', task: 'x' });
  assert.match(result, /no agent named/i);
  await b.stop();
});

test('task:completed for a bound task triggers a spoken system note', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
  f.emitEvent({ type: 'task:dispatched', taskId: 't-77', sessionName: 's' });
  f.emitEvent({ type: 'task:completed', taskId: 't-77', result: { outcome: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(f.heard.some((h) => h.startsWith('NOTE:') && /Manuel/.test(h)));
  await b.stop();
});

test('speech chain survives a failing chunk: later chunks still publish, no unhandled rejection', async () => {
  const f = makeFakes([MEETING]);
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (err: unknown) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandledRejection);
  let speakCalls = 0;
  const b = new Broker({
    swarm: f.swarm,
    directory: new AgentDirectory(),
    brain: f.brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    speak: async function* (text) {
      speakCalls += 1;
      if (speakCalls === 1) throw new Error('tts blew up');
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
  });
  try {
    await b.start();
    await b.pollOnce();
    f.emitUtterance('first');
    await new Promise((r) => setTimeout(r, 10)); // first chunk's speak() throws
    f.emitUtterance('second');
    await new Promise((r) => setTimeout(r, 10)); // second chunk must still run
    assert.equal(f.published.length, 1);
    assert.match(Buffer.from(f.published[0]!.bytes).toString(), /AUDIO\(spoken reply\)/);
    assert.deepEqual(unhandled, []);
  } finally {
    await b.stop();
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('brain turns are serialized: a system note queued mid-utterance waits for it to finish', async () => {
  const f = makeFakes([MEETING]);
  const order: string[] = [];
  let releaseA: (() => void) | null = null;
  const deferredA = new Promise<void>((resolve) => (releaseA = resolve));
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => {
      order.push(`start:${text}`);
      await deferredA;
      order.push(`end:${text}`);
      turn.onSpeech('spoken reply');
    },
    handleSystemNote: async (note, turn) => {
      order.push(`note:${note}`);
      turn.onSpeech('narration');
    },
  };
  const b = new Broker({
    swarm: f.swarm,
    directory: new AgentDirectory(),
    brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    speak: async function* (text) {
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
  });
  try {
    await b.start();
    await b.pollOnce();
    const utterancePromise = b.handleUtterance('A');
    await new Promise((r) => setTimeout(r, 10)); // let turn A start and block on deferredA
    await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
    f.emitEvent({ type: 'task:dispatched', taskId: 't-77', sessionName: 's' });
    f.emitEvent({ type: 'task:completed', taskId: 't-77', result: { outcome: 'completed' } });
    await new Promise((r) => setTimeout(r, 10)); // the queued note must NOT run while A is pending
    assert.deepEqual(order, ['start:A']);
    releaseA!();
    await utterancePromise;
    await new Promise((r) => setTimeout(r, 10)); // let the queued note run after A settles
    assert.equal(order.length, 3);
    assert.equal(order[0], 'start:A');
    assert.equal(order[1], 'end:A');
    assert.match(order[2]!, /^note:/);
  } finally {
    await b.stop();
  }
});

test('a rejecting brain turn does not kill the queue or raise an unhandled rejection', async () => {
  const f = makeFakes([MEETING]);
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (err: unknown) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandledRejection);
  let calls = 0;
  const heard: string[] = [];
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => {
      calls += 1;
      if (calls === 1) throw new Error('stream blew up');
      heard.push(text);
      turn.onSpeech('spoken reply');
    },
    handleSystemNote: async () => {},
  };
  const b = new Broker({
    swarm: f.swarm,
    directory: new AgentDirectory(),
    brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    speak: async function* (text) {
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
  });
  try {
    await b.start();
    await b.pollOnce();
    await b.handleUtterance('first');
    await b.handleUtterance('second');
    assert.deepEqual(heard, ['second']);
    assert.deepEqual(unhandled, []);
  } finally {
    await b.stop();
    process.off('unhandledRejection', onUnhandledRejection);
  }
});

test('joinMeeting failure stops the stt and leaves active unset; next pollOnce retries', async () => {
  const f = makeFakes([MEETING]);
  let connectAttempts = 0;
  const bridge: BridgeLike & { connected: string[] } = {
    connected: [],
    connect: async (opts) => {
      connectAttempts += 1;
      if (connectAttempts === 1) throw new Error('connect failed');
      bridge.connected.push(opts.token);
    },
    onRemoteAudio: () => {},
    publishPcm: async () => {},
    disconnect: async () => {},
  };
  const b = new Broker({
    swarm: f.swarm,
    directory: new AgentDirectory(),
    brain: f.brain,
    makeStt: () => f.stt,
    makeBridge: () => bridge,
    speak: async function* (text) {
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
  });
  try {
    await b.start();
    await b.pollOnce(); // bridge.connect rejects: joinMeeting must clean up, not throw
    assert.equal(connectAttempts, 1);
    assert.equal(f.sttStops.length, 1);
    assert.equal(bridge.connected.length, 0);

    await b.pollOnce(); // active is still unset, so this retries and succeeds
    assert.equal(connectAttempts, 2);
    assert.deepEqual(bridge.connected, ['jwt-for-meeting-m-1']);
  } finally {
    await b.stop();
  }
});

test('raise_hand stores the hand, roster carries it, and speaking lowers it', async () => {
  const f = makeFakes([]);
  const b = makeBroker(f);
  await b.start();
  const ack = await b.executors.raise_hand({ agent: 'Octavio', reason: 'sees a trust-boundary risk' });
  assert.match(ack, /Octavio/);
  assert.deepEqual(b.uiRoster().hands, { Octavio: 'sees a trust-boundary risk' });
  // Octavio takes the floor -> hand comes down.
  await b.handleUtterance('go ahead Octavio');
  await new Promise((r) => setTimeout(r, 10));
  // fake brain speaks as 'spoken reply' (no speaker prefix) — hand persists...
  assert.deepEqual(b.uiRoster().hands, { Octavio: 'sees a trust-boundary risk' });
  // ...until a chunk with his speaker prefix goes out.
  b.handleUtterance('x'); // enqueue another turn
  await new Promise((r) => setTimeout(r, 10));
  b['enqueueSpeech']('Octavio: The risk is contained.');
  assert.deepEqual(b.uiRoster().hands, {});
  await b.stop();
});

test('compose: form a group, add a member, remove down to one dissolves it', async () => {
  const f = makeFakes([]);
  const b = makeBroker(f);
  await b.start();
  // Registry has only Manuel; forming needs two distinct known agents.
  assert.match(b.compose({ op: 'form', agents: ['Manuel', 'Nobody'] }) ?? '', /two distinct known agents/);
  assert.equal(b.compose({ op: 'add', target: 'squad-alpha', agent: 'Manuel' }), null);
  assert.deepEqual(b.uiRoster().squads[0]!.extraMembers, ['Manuel']);
  // Removing an original alpha member is a conversation-layer exclusion by name.
  assert.equal(b.compose({ op: 'remove', target: 'squad-alpha', agent: 'Gabriel' }), null);
  assert.deepEqual(b.uiRoster().squads[0]!.removedMembers, ['Gabriel']);
  // Removing the guest again clears the addition.
  assert.equal(b.compose({ op: 'remove', target: 'squad-alpha', agent: 'Manuel' }), null);
  assert.deepEqual(b.uiRoster().squads[0]!.extraMembers, []);
  await b.stop();
});

test('an agent exists solo OR in one squad, never both', async () => {
  const f = makeFakes([]);
  const b = makeBroker(f);
  await b.start();
  assert.equal(b.uiRoster().agents.length, 1); // Manuel solo
  assert.equal(b.compose({ op: 'add', target: 'squad-alpha', agent: 'Manuel' }), null);
  assert.equal(b.uiRoster().agents.length, 0); // solo circle gone
  assert.deepEqual(b.uiRoster().squads[0]!.extraMembers, ['Manuel']);
  // Joining beta detaches from alpha — one membership at a time.
  assert.equal(b.compose({ op: 'add', target: 'squad-beta', agent: 'Manuel' }), null);
  assert.deepEqual(b.uiRoster().squads[0]!.extraMembers, []);
  assert.deepEqual(b.uiRoster().squads[1]!.extraMembers, ['Manuel']);
  assert.equal(b.uiRoster().agents.length, 0);
  // Leaving beta restores the solo circle.
  assert.equal(b.compose({ op: 'remove', target: 'squad-beta', agent: 'Manuel' }), null);
  assert.equal(b.uiRoster().agents.length, 1);
  await b.stop();
});

test('busy units are locked from composition; activity/steer/cancel route to the task', async () => {
  const f = makeFakes([]);
  const b = makeBroker(f);
  await b.start();
  await b.executors.delegate({ agent: 'Manuel', task: 'refactor the router' });
  // Manuel is busy -> composition involving him is rejected.
  assert.match(b.compose({ op: 'add', target: 'squad-alpha', agent: 'Manuel' }) ?? '', /working/);
  // Activity view maps his name to the live task output.
  const activity = await b.activity('Manuel');
  assert.equal(activity.busy, true);
  assert.match(activity.output ?? '', /DONE building the thing/);
  assert.equal(await b.steerWork('Manuel', 'focus on tenancy'), null);
  assert.equal(await b.cancelWork('Manuel'), null);
  // Idle agents have no activity and cannot be steered.
  assert.equal((await b.activity('nobody')).busy, false);
  assert.match((await b.steerWork('nobody', 'x')) ?? '', /not working/);
  await b.stop();
});

test('a squad member dragged out becomes a freed individual; dragging home rejoins', async () => {
  const f = makeFakes([]);
  const b = makeBroker(f);
  await b.start();
  assert.equal(b.compose({ op: 'remove', target: 'squad-alpha', agent: 'Gabriel' }), null);
  assert.deepEqual(b.uiRoster().freed, [{ name: 'Gabriel', role: 'leader', squadId: 'alpha' }]);
  // Freed members can only rejoin their own squad.
  assert.match(b.compose({ op: 'add', target: 'squad-beta', agent: 'Gabriel' }) ?? '', /only rejoin the alpha squad/);
  // Dragging home (UI sends the freed- prefixed id) rejoins.
  assert.equal(b.compose({ op: 'add', target: 'squad-alpha', agent: 'freed-gabriel' }), null);
  assert.deepEqual(b.uiRoster().freed, []);
  assert.deepEqual(b.uiRoster().squads[0]!.removedMembers, []);
  await b.stop();
});

test('roster composition persists: a second broker restores groups and edits, dropping stale ids', async () => {
  let saved: import('./broker.ts').RosterState | null = null;
  const store = { load: () => saved, save: (s: import('./broker.ts').RosterState) => void (saved = s) };
  const f1 = makeFakes([]);
  const dir1 = new AgentDirectory();
  const a = new Broker({ ...basicDeps(f1, dir1), rosterStore: store });
  await a.start();
  assert.equal(a.compose({ op: 'remove', target: 'squad-alpha', agent: 'Gabriel' }), null);
  const snapshot = store.load();
  assert.ok(snapshot);
  snapshot.groups.push({ id: 'g9', name: 'ghost', memberIds: ['manuel', 'deleted-agent'] }); // stale on reload
  await a.stop();

  const f2 = makeFakes([]);
  const b = new Broker({ ...basicDeps(f2, new AgentDirectory()), rosterStore: store });
  await b.start();
  assert.deepEqual(b.uiRoster().freed, [{ name: 'Gabriel', role: 'leader', squadId: 'alpha' }]); // survived restart
  assert.deepEqual(b.uiRoster().groups, []); // ghost group dropped (member no longer exists)
  await b.stop();
});

test('lookup_ticket returns a one-line summary on success', async () => {
  const f = makeFakes([]);
  f.swarm.lookupTicket = async () => ({
    ok: true,
    ticket: { key: 'PROJ-1', summary: 'Fix the thing', status: 'In Progress', url: 'https://x/browse/PROJ-1' },
  });
  const b = makeBroker(f);
  const out = await b.executors.lookup_ticket({ ticketKey: 'PROJ-1', workspace: 'acme' });
  assert.equal(out, 'PROJ-1 (In Progress): Fix the thing — https://x/browse/PROJ-1');
});

test('lookup_ticket surfaces a Jira-level not-found without throwing', async () => {
  const f = makeFakes([]);
  f.swarm.lookupTicket = async () => ({ ok: false, detail: 'Jira 404: Issue does not exist' });
  const b = makeBroker(f);
  const out = await b.executors.lookup_ticket({ ticketKey: 'NOPE-1', workspace: 'acme' });
  assert.equal(out, 'Jira 404: Issue does not exist');
});

test('search_docs lists title/url pairs, or a no-results line', async () => {
  const f = makeFakes([]);
  f.swarm.searchDocs = async () => ({ ok: true, docs: [{ title: 'Onboarding', excerpt: '', url: 'https://x/wiki/1' }] });
  const b = makeBroker(f);
  assert.equal(await b.executors.search_docs({ query: 'onboarding', workspace: 'acme' }), 'Onboarding — https://x/wiki/1');

  const f2 = makeFakes([]);
  f2.swarm.searchDocs = async () => ({ ok: true, docs: [] });
  const b2 = makeBroker(f2);
  assert.equal(await b2.executors.search_docs({ query: 'nothing', workspace: 'acme' }), 'No Confluence docs found for "nothing".');
});

test('the identity name is addressable — "hey anderson" lights its listening ring', async () => {
  const f = makeFakes([]);
  const listenings: string[][] = [];
  const b = makeBroker(f, {
    identityName: 'Anderson',
    onRosterChange: (r) => listenings.push([...(r as unknown as { listening: string[] }).listening]),
  });
  await b.start();
  await b.handleUtterance('hey Anderson, who is free?');
  assert.ok(listenings.some((l) => l.includes('Anderson')));
  await b.stop();
});

test('announce() runs a system-note brain turn', async () => {
  const f = makeFakes([]);
  const b = makeBroker(f);
  await b.start();
  await b.announce('a new session just started — greet the human');
  assert.ok(f.heard.some((h) => h.startsWith('NOTE:') && h.includes('new session just started')));
  await b.stop();
});

function basicDeps(f: ReturnType<typeof makeFakes>, directory: AgentDirectory) {
  return {
    swarm: f.swarm,
    directory,
    brain: f.brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    speak: async function* (text: string) {
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room: string) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
  };
}

// ---- group leadership (composer target selector, spec §5) ----

const JOSEFINA: RegistryAgent = {
  id: 'josefina', name: 'Josefina', role: 'Product Manager', directives: 'Be Josefina.',
  engine: { cli: 'claude', model: 'claude-sonnet-5' },
};

function memoryRosterStore() {
  const saved: RosterState[] = [];
  return { saved, load: () => null, save: (s: RosterState) => saved.push(structuredClone(s)) };
}

/** A broker whose directory knows Manuel, Ignacio and Josefina. */
async function brokerWithCrew(opts?: Parameters<typeof makeBroker>[1]) {
  const f = makeFakes([]);
  f.swarm.registry = async () => [...AGENTS, IGNACIO, JOSEFINA];
  const b = makeBroker(f, opts);
  await b.start();
  await b.stop();
  return b;
}

test('a group with no election yet is led by the highest-ranked member, not the first added', async () => {
  const b = await brokerWithCrew();
  // Ignacio (specialist, unranked) is added first; Josefina (Product Manager) outranks him.
  assert.equal(b.compose({ op: 'form', agents: ['Ignacio', 'Josefina'] }), null);
  assert.equal(b.uiRoster().groups[0]!.leader, 'josefina');
});

test('setGroupLeader records the vote and survives a roster-state round trip', async () => {
  const store = memoryRosterStore();
  const b = await brokerWithCrew({ rosterStore: store });
  b.compose({ op: 'form', agents: ['Ignacio', 'Josefina'] });
  const id = b.uiRoster().groups[0]!.id;
  b.setGroupLeader(id, 'ignacio', {
    claims: [{ agent: 'ignacio', willing: true, confidence: 0.8, reason: 'I know this system' }],
    at: '2026-08-10T00:00:00.000Z',
    method: 'vote',
  });
  assert.equal(b.uiRoster().groups[0]!.leader, 'ignacio');
  const saved = store.saved.at(-1)!;
  assert.equal(saved.groups[0]!.leader, 'ignacio');
  assert.equal(saved.groups[0]!.election?.method, 'vote');
});

test('setGroupLeader for a group that dissolved mid-vote is a no-op, not a crash', async () => {
  const b = await brokerWithCrew();
  b.setGroupLeader('g99', 'josefina', { claims: [], at: 'now', method: 'rank' });
  assert.deepEqual(b.uiRoster().groups, []);
});

test('groupCandidates carries directives and BOTH role vocabularies', async () => {
  const b = await brokerWithCrew();
  b.compose({ op: 'form', agents: ['Ignacio', 'Josefina'] });
  const id = b.uiRoster().groups[0]!.id;
  const candidates = b.groupCandidates(id)!;
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((c) => c.directives.length > 0));
  assert.ok(candidates.every((c) => typeof c.role === 'string'));
});

test('groupCandidates for an unknown group is null', async () => {
  const b = await brokerWithCrew();
  assert.equal(b.groupCandidates('nope'), null);
});

test('forming a group announces the change so an election can run', async () => {
  const changed: string[] = [];
  const b = await brokerWithCrew({ onGroupChanged: (id) => changed.push(id) });
  b.compose({ op: 'form', agents: ['Ignacio', 'Josefina'] });
  assert.equal(changed.length, 1);
  assert.equal(changed[0], b.uiRoster().groups[0]!.id);
});

test('adding and removing a member each announce the change', async () => {
  const changed: string[] = [];
  const b = await brokerWithCrew({ onGroupChanged: (id) => changed.push(id) });
  b.compose({ op: 'form', agents: ['Ignacio', 'Josefina'] });
  const id = b.uiRoster().groups[0]!.id;
  assert.equal(b.compose({ op: 'add', target: `group-${id}`, agent: 'Manuel' }), null);
  assert.equal(changed.length, 2);
  assert.equal(b.compose({ op: 'remove', target: `group-${id}`, agent: 'Manuel' }), null);
  assert.equal(changed.length, 3);
});

test('a group that dissolves to one member announces nothing — there is no group left to lead', async () => {
  const changed: string[] = [];
  const b = await brokerWithCrew({ onGroupChanged: (id) => changed.push(id) });
  b.compose({ op: 'form', agents: ['Ignacio', 'Josefina'] });
  const id = b.uiRoster().groups[0]!.id;
  changed.length = 0;
  b.compose({ op: 'remove', target: `group-${id}`, agent: 'Josefina' }); // dissolves: < 2 members
  assert.deepEqual(changed, []);
});

test("today's digest reaches the brain's turn, and its absence changes nothing", async () => {
  const withDigest: Array<string | undefined> = [];
  const brain: BrainLike = {
    handleUtterance: async (_text, turn) => void withDigest.push(turn.digest),
    handleSystemNote: async () => {},
  };
  const f = makeFakes([]);
  const withFeed = new Broker({ ...basicDeps(f, new AgentDirectory()), brain, digest: () => '\n\nTODAY · 29°C.\n' });
  await withFeed.handleUtterance('morning');
  const without = new Broker({ ...basicDeps(f, new AgentDirectory()), brain });
  await without.handleUtterance('morning');
  assert.deepEqual(withDigest, ['\n\nTODAY · 29°C.\n', undefined]);
});
