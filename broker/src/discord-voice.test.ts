import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscordVoiceSurface, type VoiceConnectionLike, type VoiceGatewayLike } from './discord-voice.ts';

interface FakeConnection extends VoiceConnectionLike {
  token: string;
  playbacks: Uint8Array[][]; // one entry per playPcm call, each the chunks drained from that call's iterable
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

test("publish with a tokened agent's persona id plays on that agent's own connection", async () => {
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

  assert.deepEqual(ignacioConn!.playbacks, [[bytes]]);
  assert.deepEqual(earConn!.playbacks, []);
});

test('publish for a designated-but-untokened agent plays on the ear connection with ONE degradation log, not per chunk', async () => {
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
  await surface.publishPcm(new Uint8Array([9]), 44100, 'wilkin');
  await surface.publishPcm(new Uint8Array([9]), 44100, 'wilkin');
  await surface.publishPcm(new Uint8Array([9]), 44100, 'wilkin');

  assert.equal(logs.filter((l) => l.includes('wilkin')).length, 1, 'no per-chunk spam');
  assert.equal(earConn!.playbacks.length, 3);
  assert.equal(surface.connectedAgentIds().includes('wilkin'), false);
});

test('publish with an unknown or undefined persona id plays on the ear connection', async () => {
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

  await surface.publishPcm(new Uint8Array([1]), 44100, 'nobody-the-broker-knows');
  await surface.publishPcm(new Uint8Array([2]), 44100, undefined);

  assert.equal(earConn!.playbacks.length, 2);
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

test("an agent whose real join rejects degrades to the ear with one log line, same as an untokened agent", async () => {
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
  assert.equal(earConn.playbacks.length, 1);
});

test('per-connection playback queue: a second publish to the same mouth waits for the first to finish', async () => {
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
      if (isFirst) await gate;
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

  const first = surface.publishPcm(new Uint8Array([1]), 44100);
  const second = surface.publishPcm(new Uint8Array([2]), 44100);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['first-start'], 'the second play must not start before the first settles');

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});
