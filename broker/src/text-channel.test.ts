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

// The removal/workspace routes live inside the same `if (this.creation)` block
// as the agent routes (per the task brief), so exercising them needs a
// creation handler present too — its own methods just go unused here.
const stubCreation: ConstructorParameters<typeof TextChannel>[7] = {
  records: async () => [],
  update: async () => ({}),
  catalog: async () => ({}),
  generate: async () => ({}),
  voices: async () => ({}),
  preview: async () => Buffer.from(''),
  create: async () => ({}),
};

/** Builds a channel with only the trailing (agent/removal/workspace) handlers under test wired in. */
function channelWith(opts: {
  removal?: ConstructorParameters<typeof TextChannel>[8];
  workspaces?: ConstructorParameters<typeof TextChannel>[9];
}): TextChannel {
  return new TextChannel(
    () => {},
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    stubCreation,
    opts.removal,
    opts.workspaces,
  );
}

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

test('GET /agents/:id/removal returns the preview; an unknown agent 404s', async () => {
  const channel = channelWith({
    removal: {
      preview: async (id) =>
        id === 'wilkin' ? { outcome: 'archive', reasons: ['has spoken in a session'] } : { error: `Unknown agent: ${id}` },
      execute: async () => ({ outcome: 'deleted' }),
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/agents/wilkin/removal`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { outcome: 'archive', reasons: ['has spoken in a session'] });

    const missing = await fetch(`http://127.0.0.1:${port}/agents/nobody/removal`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Unknown agent: nobody' });
  } finally {
    await channel.stop();
  }
});

test('DELETE /agents/:id executes removal and returns the outcome; a swarm error 409s', async () => {
  const channel = channelWith({
    removal: {
      preview: async () => ({ outcome: 'delete', reasons: [] }),
      execute: async (id) => (id === 'busy' ? { error: 'agent busy: locked' } : { outcome: 'deleted' }),
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/agents/wilkin`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { outcome: 'deleted' });

    const conflict = await fetch(`http://127.0.0.1:${port}/agents/busy`, { method: 'DELETE' });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'agent busy: locked' });
  } finally {
    await channel.stop();
  }
});

test('GET /workspaces lists full workspace records', async () => {
  const records = [{ name: 'jefelabs', default: true, archived: false, repos: [] }];
  const channel = channelWith({
    workspaces: { list: async () => records, save: async () => ({}), remove: async () => ({}) },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/workspaces`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { workspaces: records });
  } finally {
    await channel.stop();
  }
});

test('POST /workspaces passes the handler answer through: 201 on success, 400 on error', async () => {
  const channel = channelWith({
    workspaces: {
      list: async () => [],
      save: async (body, isNew) => {
        assert.equal(isNew, true);
        const name = (body as { name?: string }).name;
        return name === 'bad' ? { error: 'workspace name taken' } : { name, default: false, repos: [] };
      },
      remove: async () => ({}),
    },
  });
  const port = await channel.start(0);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'good', repos: [] }),
    });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { name: 'good', default: false, repos: [] });

    const bad = await fetch(`http://127.0.0.1:${port}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad', repos: [] }),
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'workspace name taken' });
  } finally {
    await channel.stop();
  }
});

test('PUT /workspaces/:name saves with the URL name folded into the body; DELETE returns the archive-vs-delete outcome', async () => {
  const saved: Array<{ body: Record<string, unknown>; isNew: boolean }> = [];
  const channel = channelWith({
    workspaces: {
      list: async () => [],
      save: async (body, isNew) => {
        saved.push({ body, isNew });
        return { ...body, default: false };
      },
      remove: async (name) =>
        name === 'busy' ? { error: 'workspace busy: locked' } : { outcome: name === 'archiveme' ? 'archived' : 'deleted' },
    },
  });
  const port = await channel.start(0);
  try {
    const put = await fetch(`http://127.0.0.1:${port}/workspaces/jefelabs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'new desc' }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(saved, [{ body: { description: 'new desc', name: 'jefelabs' }, isNew: false }]);

    const archived = await fetch(`http://127.0.0.1:${port}/workspaces/archiveme`, { method: 'DELETE' });
    assert.equal(archived.status, 200);
    assert.deepEqual(await archived.json(), { outcome: 'archived' });

    const deleted = await fetch(`http://127.0.0.1:${port}/workspaces/gone`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { outcome: 'deleted' });

    const conflict = await fetch(`http://127.0.0.1:${port}/workspaces/busy`, { method: 'DELETE' });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'workspace busy: locked' });
  } finally {
    await channel.stop();
  }
});
