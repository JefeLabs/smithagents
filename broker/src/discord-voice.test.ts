import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscordVoiceSurface, type VoiceConnectionLike, type VoiceGatewayLike } from './discord-voice.ts';

interface FakeConnection extends VoiceConnectionLike {
  token: string;
  playbacks: Uint8Array[][]; // one entry per playPcm call (one entry per CLOSED segment), each the chunks drained from that call's iterable
  destroyed: boolean;
}

function fakeConnection(token: string): FakeConnection {
  const connection: FakeConnection = {
    token,
    playbacks: [],
    destroyed: false,
    async playPcm(pcm) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of pcm) chunks.push(chunk);
      connection.playbacks.push(chunks);
    },
    destroy() {
      connection.destroyed = true;
    },
  };
  return connection;
}

function fakeGateway() {
  const joins: Array<{ channelId: string; token: string }> = [];
  const connections: FakeConnection[] = [];
  const gateway: VoiceGatewayLike = {
    async join(channelId, token) {
      joins.push({ channelId, token });
      const connection = fakeConnection(token);
      connections.push(connection);
      return connection;
    },
  };
  return { gateway, joins, connections };
}

// SEGMENT_IDLE_GAP_MS in discord-voice.ts — kept in lockstep with the
// module's internal constant so tests advance fake time by exactly enough
// to close an open segment without hardcoding a second source of truth.
const SEGMENT_IDLE_GAP_MS = 400;

/**
 * Real macrotask boundary: guarantees any pending microtask chain inside the
 * segment machinery (a mock-timer tick resolving a `wake` promise, which
 * resumes an async generator, which ends a `for await` loop, ...) has fully
 * settled. Never touches the mocked setTimeout/clearTimeout pair.
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Shared roster: ignacio is discord-voice-designated with a token (real mouth),
// wilkin is discord-voice-designated with NO token (degrades to the ear),
// manuel is designated for text only (never joins voice at all).
const AGENTS = () => [
  { id: 'ignacio', channels: ['discord-voice'] },
  { id: 'wilkin', channels: ['discord-voice'] },
  { id: 'manuel', channels: ['discord'] },
];
const AGENT_TOKENS = () => new Map([['ignacio', 'ignacio-token']]);

test('joinAll connects the ear plus every discord-voice-designated agent with a token, exactly once each', async () => {
  const { gateway, joins } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
  });

  await surface.joinAll('chan-1');

  assert.deepEqual(joins, [
    { channelId: 'chan-1', token: 'ear-token' },
    { channelId: 'chan-1', token: 'ignacio-token' },
  ]);
  assert.deepEqual(surface.connectedAgentIds(), ['ignacio']);
});

test("publish with a tokened agent's persona id plays on that agent's own connection", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
  });
  await surface.joinAll('chan-1');
  const [earConn, ignacioConn] = connections;

  const bytes = new Uint8Array([1, 2, 3]);
  await surface.publishPcm(bytes, 44100, 'ignacio');

  // publishPcm resolves once the bytes are queued, not once played — the
  // segment only closes (and playbacks becomes observable) after the idle
  // gap elapses with no further publish.
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.deepEqual(ignacioConn!.playbacks, [[bytes]]);
  assert.deepEqual(earConn!.playbacks, []);
});

test('publish for a designated-but-untokened agent batches into one segment on the ear connection, with ONE degradation log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gateway, connections } = fakeGateway();
  const logs: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
    log: (line) => logs.push(line),
  });

  await surface.joinAll('chan-1');
  const wilkinLogsAfterJoin = logs.filter((l) => l.includes('wilkin'));
  assert.equal(wilkinLogsAfterJoin.length, 1, 'exactly one degradation log at join time');

  const [earConn] = connections;
  const chunks = [new Uint8Array([9]), new Uint8Array([9]), new Uint8Array([9])];
  for (const chunk of chunks) await surface.publishPcm(chunk, 44100, 'wilkin');

  assert.equal(logs.filter((l) => l.includes('wilkin')).length, 1, 'no per-chunk spam');
  assert.equal(earConn!.playbacks.length, 0, 'segment still open — nothing closed yet');

  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  // Same persona, no gap between publishes -> one open segment -> exactly
  // one playPcm() call carrying all three chunks, not three separate calls.
  assert.equal(earConn!.playbacks.length, 1, 'all three chunks batched into one playPcm call');
  assert.deepEqual(earConn!.playbacks[0], chunks);
  assert.equal(surface.connectedAgentIds().includes('wilkin'), false);
});

test('publish with an unknown persona id, then a different unknown/undefined persona id, closes the first segment and opens a second on the ear', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
  });
  await surface.joinAll('chan-1');
  const [earConn] = connections;

  const first = new Uint8Array([1]);
  const second = new Uint8Array([2]);
  await surface.publishPcm(first, 44100, 'nobody-the-broker-knows');
  // Different persona id (here: undefined) on the same connection — the ear
  // must not splice two different speakers into one continuous segment, so
  // this closes the first segment and opens a second immediately, with no
  // idle gap required.
  await surface.publishPcm(second, 44100, undefined);

  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.equal(earConn!.playbacks.length, 2, 'persona switch produced two separate playPcm calls');
  assert.deepEqual(earConn!.playbacks, [[first], [second]]);
});

test('leaveAll destroys the ear and every agent connection', async () => {
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
  });
  await surface.joinAll('chan-1');

  await surface.leaveAll();

  assert.equal(connections.length, 2); // ear + ignacio
  assert.ok(connections.every((c) => c.destroyed));
  assert.deepEqual(surface.connectedAgentIds(), []);
});

test('a second joinAll after leaveAll reconnects everything fresh', async () => {
  const { gateway, joins, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
  });

  await surface.joinAll('chan-1');
  await surface.leaveAll();
  await surface.joinAll('chan-1');

  assert.equal(joins.length, 4); // (ear + ignacio) x2
  assert.equal(connections.length, 4);
  assert.deepEqual(surface.connectedAgentIds(), ['ignacio']);
  // the fresh connections are live (not the destroyed originals)
  assert.ok(connections.slice(2).every((c) => !c.destroyed));
});

test('joinAll is a no-op when already joined the same channel, and leaves first when switching channels', async () => {
  const { gateway, joins, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1', 'chan-2'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
  });

  await surface.joinAll('chan-1');
  await surface.joinAll('chan-1'); // same channel — must not clobber or leak the existing connections

  assert.equal(joins.length, 2, 'no second round of joins for a repeat call to the same channel');
  assert.equal(connections.length, 2);
  assert.ok(connections.every((c) => !c.destroyed), 'the original connections are still live');
  assert.deepEqual(surface.connectedAgentIds(), ['ignacio']);

  await surface.joinAll('chan-2'); // different channel — must leave chan-1 before joining chan-2

  assert.ok(connections.slice(0, 2).every((c) => c.destroyed), 'chan-1 connections were torn down');
  assert.deepEqual(
    joins.slice(2),
    [
      { channelId: 'chan-2', token: 'ear-token' },
      { channelId: 'chan-2', token: 'ignacio-token' },
    ],
    'fresh joins landed on chan-2',
  );
  assert.equal(connections.length, 4);
});

test('joinAll declines a non-allowlisted channel and connects nothing', async () => {
  const { gateway, joins } = fakeGateway();
  const logs: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
    log: (line) => logs.push(line),
  });

  await surface.joinAll('some-other-channel');

  assert.deepEqual(joins, []);
  assert.deepEqual(surface.connectedAgentIds(), []);
  assert.ok(logs.some((l) => l.includes('some-other-channel')));
});

test("an agent whose real join rejects degrades to the ear with one log line, same as an untokened agent", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const earConn = fakeConnection('ear-token');
  const joinedTokens: string[] = [];
  const gateway: VoiceGatewayLike = {
    async join(_channelId, token) {
      joinedTokens.push(token);
      if (token === 'bad-token') throw new Error('4004: Authentication failed');
      return earConn;
    },
  };
  const logs: string[] = [];
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: new Map([['ignacio', 'bad-token']]),
    agents: () => [{ id: 'ignacio', channels: ['discord-voice'] }],
    gateway,
    log: (line) => logs.push(line),
  });

  await surface.joinAll('chan-1');

  assert.deepEqual(joinedTokens, ['ear-token', 'bad-token']);
  assert.deepEqual(surface.connectedAgentIds(), []);
  assert.equal(logs.filter((l) => l.includes('ignacio')).length, 1);

  await surface.publishPcm(new Uint8Array([1]), 44100, 'ignacio');
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();
  assert.equal(earConn.playbacks.length, 1);
});

test('N rapid publishes to one persona batch into exactly one playPcm call, with buffers in order', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
  });
  await surface.joinAll('chan-1');
  const [, ignacioConn] = connections;

  const chunks = Array.from({ length: 5 }, (_, i) => new Uint8Array([i]));
  for (const chunk of chunks) await surface.publishPcm(chunk, 44100, 'ignacio');

  assert.equal(ignacioConn!.playbacks.length, 0, 'segment still open — no idle gap yet');

  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.equal(ignacioConn!.playbacks.length, 1, 'all five publishes landed in one playPcm() call');
  assert.deepEqual(ignacioConn!.playbacks[0], chunks, 'buffers preserved their publish order');
});

test('an idle gap after the last publish closes the segment; the next publish opens a fresh one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { gateway, connections } = fakeGateway();
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: AGENT_TOKENS(),
    agents: AGENTS,
    gateway,
  });
  await surface.joinAll('chan-1');
  const [, ignacioConn] = connections;

  await surface.publishPcm(new Uint8Array([1]), 44100, 'ignacio');
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();
  assert.equal(ignacioConn!.playbacks.length, 1, 'first segment closed on the idle gap');

  await surface.publishPcm(new Uint8Array([2]), 44100, 'ignacio');
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.equal(ignacioConn!.playbacks.length, 2, 'the post-gap publish opened a second, independent segment');
  assert.deepEqual(ignacioConn!.playbacks, [[new Uint8Array([1])], [new Uint8Array([2])]]);
});

test('per-connection ordering: a segment that opens while the previous one is still playing waits for it to settle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let sawFirst = false;
  const connection: VoiceConnectionLike = {
    async playPcm(pcm) {
      const isFirst = !sawFirst;
      sawFirst = true;
      order.push(isFirst ? 'first-start' : 'second-start');
      if (isFirst) await gate; // simulates a still-playing first segment
      for await (const _chunk of pcm) {
        // drain
      }
      order.push(isFirst ? 'first-end' : 'second-end');
    },
    destroy() {},
  };
  const gateway: VoiceGatewayLike = { join: async () => connection };
  const surface = createDiscordVoiceSurface({
    allowlist: ['chan-1'],
    earToken: 'ear-token',
    agentTokens: new Map(),
    agents: () => [],
    gateway,
  });
  await surface.joinAll('chan-1'); // only the ear connects — agents() is empty

  await surface.publishPcm(new Uint8Array([1]), 44100); // opens segment 1; its playPcm() call is now gated
  // The idle gap closes segment 1's queue (so its playPcm() can eventually
  // drain and finish once released) without waiting for playback itself —
  // publishPcm never blocks on playback under the new design.
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  const second = surface.publishPcm(new Uint8Array([2]), 44100); // opens segment 2, chained after segment 1's tail
  await flushMicrotasks();
  assert.deepEqual(order, ['first-start'], "segment 2's playPcm must not start before segment 1's settles");

  releaseFirst();
  await second;
  t.mock.timers.tick(SEGMENT_IDLE_GAP_MS);
  await flushMicrotasks();

  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});
