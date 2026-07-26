import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { TextChannel, type ChannelFrame } from './text-channel.ts';

const post = (port: number, body: string) =>
  fetch(`http://127.0.0.1:${port}/utterance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

const connect = (port: number): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

const nextFrame = (ws: WebSocket): Promise<ChannelFrame> =>
  new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(String(d)) as ChannelFrame)));

test('POST /utterance invokes handler, echoes utterance frame to WS clients', async () => {
  const seen: string[] = [];
  const channel = new TextChannel((t) => seen.push(t));
  const port = await channel.start(0);
  try {
    const ws = await connect(port);
    const frame = nextFrame(ws);
    const res = await post(port, JSON.stringify({ text: '  ship it  ' }));
    assert.equal(res.status, 202);
    assert.deepEqual(seen, ['ship it']);
    assert.deepEqual(await frame, { type: 'utterance', text: 'ship it' });
    ws.close();
  } finally {
    await channel.stop();
  }
});

test('rejects malformed bodies without invoking the handler', async () => {
  const seen: string[] = [];
  const channel = new TextChannel((t) => seen.push(t));
  const port = await channel.start(0);
  try {
    for (const body of ['not json', '{}', '{"text": 42}', '{"text": "   "}']) {
      const res = await post(port, body);
      assert.equal(res.status, 400, `body ${body} should 400`);
    }
    assert.deepEqual(seen, []);
  } finally {
    await channel.stop();
  }
});

test('broadcast fans speech frames out to connected clients', async () => {
  const channel = new TextChannel(() => {});
  const port = await channel.start(0);
  try {
    const [a, b] = await Promise.all([connect(port), connect(port)]);
    const frames = Promise.all([nextFrame(a), nextFrame(b)]);
    channel.broadcast({ type: 'speech', text: 'On it.' });
    assert.deepEqual(await frames, [
      { type: 'speech', text: 'On it.' },
      { type: 'speech', text: 'On it.' },
    ]);
    a.close();
    b.close();
  } finally {
    await channel.stop();
  }
});

test('hello frames (roster snapshot) are sent to each client on connect', async () => {
  const roster = [{ id: 'manuel', name: 'Manuel', role: 'lead', status: 'idle' as const, kind: 'agent' as const }];
  const channel = new TextChannel(
    () => {},
    () => [{ type: 'roster', agents: roster }],
  );
  const port = await channel.start(0);
  try {
    // Listener attached before the handshake completes — the hello frame can
    // arrive in the same tick as 'open', so a post-open listener would miss it.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/events`);
    const frame = nextFrame(ws);
    assert.deepEqual(await frame, { type: 'roster', agents: roster });
    ws.close();
  } finally {
    await channel.stop();
  }
});

test('OPTIONS preflight returns CORS headers', async () => {
  const channel = new TextChannel(() => {});
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/utterance`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  } finally {
    await channel.stop();
  }
});
