import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Broker, type BridgeLike, type SttLike, type SwarmClientLike } from './broker.ts';
import { AgentDirectory } from './directory.ts';
import type { BrainLike } from './broker.ts';
import type { RegistryAgent, SwarmEvent, SwarmMeeting } from './swarm-client.ts';

const AGENTS: RegistryAgent[] = [
  { id: 'manuel', name: 'Manuel', role: 'lead', directives: 'Be Manuel.', engine: { cli: 'claude', model: 'claude-sonnet-5' } },
];

function makeFakes(meetings: SwarmMeeting[]) {
  const submitted: unknown[] = [];
  let eventSink: ((e: SwarmEvent) => void) | null = null;
  const swarm: SwarmClientLike = {
    listMeetings: async () => meetings,
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
  };

  const sttAudio: Uint8Array[] = [];
  const sttStops: number[] = [];
  let utteranceSink: ((t: string) => void) | null = null;
  const stt: SttLike = {
    start: (cb) => (utteranceSink = cb),
    sendAudio: (b) => sttAudio.push(b),
    stop: () => void sttStops.push(1),
  };

  const published: Array<{ bytes: Uint8Array; sampleRate: number }> = [];
  const bridge: BridgeLike & { remoteCb: ((b: Uint8Array) => void) | null; connected: string[] } = {
    remoteCb: null,
    connected: [],
    connect: async (opts) => void bridge.connected.push(opts.token),
    onRemoteAudio: (cb) => (bridge.remoteCb = cb),
    publishPcm: async (bytes, sampleRate) => void published.push({ bytes, sampleRate }),
    disconnect: async () => {},
  };

  const heard: string[] = [];
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => {
      heard.push(text);
      turn.onSpeech('spoken reply');
    },
    handleSystemNote: async (note, turn) => {
      heard.push(`NOTE:${note}`);
      turn.onSpeech('narration');
    },
  };

  return {
    swarm, stt, bridge, brain, submitted, published, heard, sttStops,
    emitEvent: (e: SwarmEvent) => eventSink?.(e),
    emitUtterance: (t: string) => utteranceSink?.(t),
  };
}

function makeBroker(f: ReturnType<typeof makeFakes>) {
  const directory = new AgentDirectory();
  return new Broker({
    swarm: f.swarm,
    directory,
    brain: f.brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
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

test('utterance flows: stt -> brain -> speak -> publishPcm at 44100', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  f.emitUtterance('hello manuel');
  await new Promise((r) => setTimeout(r, 10)); // let the async turn settle
  assert.deepEqual(f.heard, ['hello manuel']);
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0]!.sampleRate, 44100);
  assert.match(Buffer.from(f.published[0]!.bytes).toString(), /AUDIO\(spoken reply\)/);
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
