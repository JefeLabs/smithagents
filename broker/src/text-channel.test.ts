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

// verifyAtlassian/verifyGithubRepo go unused by tests that only exercise the
// workspace CRUD routes — spread this in so those tests don't need to repeat
// stubs the constructor type now requires.
const stubWorkspaceVerify = {
  verifyAtlassian: async () => ({}),
  verifyGithubRepo: async () => ({}),
};

/** Builds a channel with only the trailing (agent/removal/workspace/surfaces) handlers under test wired in. */
function channelWith(opts: {
  removal?: ConstructorParameters<typeof TextChannel>[8];
  workspaces?: ConstructorParameters<typeof TextChannel>[9];
  creation?: ConstructorParameters<typeof TextChannel>[7];
  surfaces?: ConstructorParameters<typeof TextChannel>[10];
  me?: ConstructorParameters<typeof TextChannel>[11];
}): TextChannel {
  return new TextChannel(
    () => {},
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.creation ?? stubCreation,
    opts.removal,
    opts.workspaces,
    opts.surfaces,
    opts.me,
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
    workspaces: { list: async () => records, save: async () => ({}), remove: async () => ({}), ...stubWorkspaceVerify },
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
      ...stubWorkspaceVerify,
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
      ...stubWorkspaceVerify,
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

test('GET /agents merges presence and discord availability', async () => {
  const agents = [
    { id: 'ignacio', name: 'Ignacio' },
    { id: 'wilkin', name: 'Wilkin' },
  ];
  const channel = channelWith({
    creation: { ...stubCreation, records: async () => agents },
    surfaces: {
      presence: () => ({ ignacio: { 'discord-voice': true } }),
      info: () => ({ configured: true, voiceReady: true }),
      join: async () => ({ ok: true }),
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/agents`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agents: Array<Record<string, unknown>>; discord: unknown };
    assert.deepEqual(body.agents, [
      { id: 'ignacio', name: 'Ignacio', presence: { 'discord-voice': true } },
      { id: 'wilkin', name: 'Wilkin', presence: {} },
    ]);
    assert.deepEqual(body.discord, { configured: true, voiceReady: true });
  } finally {
    await channel.stop();
  }
});

test('POST /agents/:id/surfaces/:surface/join maps provider results to status codes', async () => {
  const received: Array<{ id: string; surface: string }> = [];
  const channel = channelWith({
    surfaces: {
      presence: () => ({}),
      info: () => ({ configured: false, voiceReady: false }),
      join: async (id, surface) => {
        received.push({ id, surface });
        return id === 'the wolf' ? { error: 'no active voice channel', status: 409 } : { ok: true };
      },
    },
  });
  const port = await channel.start(0);
  try {
    const conflict = await fetch(
      `http://127.0.0.1:${port}/agents/${encodeURIComponent('the wolf')}/surfaces/${encodeURIComponent('discord-voice')}/join`,
      { method: 'POST' },
    );
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'no active voice channel' });

    const ok = await fetch(`http://127.0.0.1:${port}/agents/wilkin/surfaces/discord/join`, { method: 'POST' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });

    assert.deepEqual(received, [
      { id: 'the wolf', surface: 'discord-voice' },
      { id: 'wilkin', surface: 'discord' },
    ]);
  } finally {
    await channel.stop();
  }
});

test('GET /me returns the redacted profile; PUT /me forwards the body', async () => {
  const calls: Array<{ method?: string; url?: string }> = [];
  const channel = channelWith({
    me: {
      get: async () => {
        calls.push({ method: 'GET' });
        return { id: 'me', name: 'You', hasAtlassianToken: false, hasGithubToken: false };
      },
      update: async (body) => {
        calls.push({ method: 'PUT' });
        return { id: 'me', name: (body as { name?: string }).name ?? 'You', hasAtlassianToken: false, hasGithubToken: false };
      },
      verifyGithub: async () => ({ ok: true, detail: 'Authenticated as edwincruz' }),
    },
  });
  const port = await channel.start(0);
  try {
    const get = await fetch(`http://127.0.0.1:${port}/me`);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { id: 'me', name: 'You', hasAtlassianToken: false, hasGithubToken: false });

    const put = await fetch(`http://127.0.0.1:${port}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Edwin' }),
    });
    assert.equal(((await put.json()) as { name?: string }).name, 'Edwin');
    assert.deepEqual(calls, [{ method: 'GET' }, { method: 'PUT' }]);

    const verify = await fetch(`http://127.0.0.1:${port}/me/verify-github`, { method: 'POST' });
    assert.equal(((await verify.json()) as { ok?: boolean }).ok, true);
  } finally {
    await channel.stop();
  }
});

test('GET /me blocks a disallowed browser Origin, allows the control-plane dev origin', async () => {
  const channel = channelWith({
    me: {
      get: async () => ({ id: 'me', name: 'You', hasAtlassianToken: false, hasGithubToken: false }),
      update: async () => ({ id: 'me', name: 'You', hasAtlassianToken: false, hasGithubToken: false }),
      verifyGithub: async () => ({ ok: true, detail: 'Authenticated as edwincruz' }),
    },
  });
  const port = await channel.start(0);
  try {
    const blocked = await fetch(`http://127.0.0.1:${port}/me`, {
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(blocked.status, 403);
    assert.deepEqual(await blocked.json(), { error: 'origin not allowed' });
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);

    const allowed = await fetch(`http://127.0.0.1:${port}/me`, {
      headers: { origin: 'http://localhost:1420' },
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { id: 'me', name: 'You', hasAtlassianToken: false, hasGithubToken: false });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:1420');
  } finally {
    await channel.stop();
  }
});
