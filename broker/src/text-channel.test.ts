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
  generateAvatar: async () => ({}),
  avatarFile: async () => null,
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
  channels?: ConstructorParameters<typeof TextChannel>[12];
  connectors?: ConstructorParameters<typeof TextChannel>[13];
  tasks?: ConstructorParameters<typeof TextChannel>[14];
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
    opts.channels,
    opts.connectors,
    opts.tasks,
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

test('broadcast fans a task-dispatched frame out to connected clients', async () => {
  const channel = new TextChannel(() => {});
  const port = await channel.start(0);
  try {
    const ws = await connect(port);
    const frame = nextFrame(ws);
    channel.broadcast({ type: 'task-dispatched', taskId: 't-1', agent: 'Manuel', task: 'build the thing' });
    assert.deepEqual(await frame, { type: 'task-dispatched', taskId: 't-1', agent: 'Manuel', task: 'build the thing' });
    ws.close();
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

// PUT (e.g. /me, /workspaces/:name) and DELETE (e.g. /workspaces/:name, /agents/:id)
// aren't CORS-safelisted methods — a real browser/webview preflights them and blocks
// the real request if the method isn't advertised here. This was a pre-existing gap
// (predates the credential routes) that only showed up because Node's fetch, used by
// every test in this file, doesn't enforce CORS preflight the way a real client does.
test('OPTIONS preflight advertises PUT and DELETE, not just POST', async () => {
  const channel = new TextChannel(() => {});
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/workspaces/acme`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    const allowed = res.headers.get('access-control-allow-methods') ?? '';
    assert.match(allowed, /\bPUT\b/);
    assert.match(allowed, /\bDELETE\b/);
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

test('GET /tasks/:taskId returns the status; an unknown task 404s', async () => {
  const channel = channelWith({
    tasks: {
      get: async (taskId) =>
        taskId === 't-77'
          ? { taskId: 't-77', status: 'completed', result: { pullRequestUrl: 'https://github.com/x/y/pull/1' } }
          : null,
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tasks/t-77`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { taskId: 't-77', status: 'completed', result: { pullRequestUrl: 'https://github.com/x/y/pull/1' } });

    const missing = await fetch(`http://127.0.0.1:${port}/tasks/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'task nope not found' });
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

test('GET /avatars/:file streams png bytes; misses and traversal shapes 404', async () => {
  const channel = channelWith({
    creation: { ...stubCreation, avatarFile: async (f) => (f === 'minerva.png' ? Buffer.from('PNGBYTES') : null) },
  });
  const port = await channel.start(0);
  try {
    const hit = await fetch(`http://127.0.0.1:${port}/avatars/minerva.png`);
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await hit.arrayBuffer()).toString(), 'PNGBYTES');
    assert.equal((await fetch(`http://127.0.0.1:${port}/avatars/ghost.png`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/avatars/..%2Fsecrets.png`)).status, 404);
  } finally {
    await channel.stop();
  }
});

test('POST /avatars/generate maps handler result: imageData -> 200, error -> 400', async () => {
  const channel = channelWith({
    creation: {
      ...stubCreation,
      generateAvatar: async (body) => (body.name === 'Nena' ? { imageData: 'QUJD' } : { error: 'no Gemini key configured' }),
    },
  });
  const port = await channel.start(0);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/avatars/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nena' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { imageData: 'QUJD' });
    const err = await fetch(`http://127.0.0.1:${port}/avatars/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(err.status, 400);
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
        return { id: 'me', name: 'You', connectors: [] };
      },
      update: async (body) => {
        calls.push({ method: 'PUT' });
        return { id: 'me', name: (body as { name?: string }).name ?? 'You', connectors: [] };
      },
    },
  });
  const port = await channel.start(0);
  try {
    const get = await fetch(`http://127.0.0.1:${port}/me`);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { id: 'me', name: 'You', connectors: [] });

    const put = await fetch(`http://127.0.0.1:${port}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Edwin' }),
    });
    assert.equal(((await put.json()) as { name?: string }).name, 'Edwin');
    assert.deepEqual(calls, [{ method: 'GET' }, { method: 'PUT' }]);
  } finally {
    await channel.stop();
  }
});

test('GET /me blocks a disallowed browser Origin, allows the control-plane dev origin', async () => {
  const channel = channelWith({
    me: {
      get: async () => ({ id: 'me', name: 'You', connectors: [] }),
      update: async () => ({ id: 'me', name: 'You', connectors: [] }),
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
    assert.deepEqual(await allowed.json(), { id: 'me', name: 'You', connectors: [] });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:1420');
  } finally {
    await channel.stop();
  }
});

test('GET /workspaces/:name/channels is origin-restricted like /me; PUT round-trips through', async () => {
  const calls: string[] = [];
  const channel = channelWith({
    channels: {
      get: async (name: string) => {
        calls.push(`get ${name}`);
        return { hasDiscordToken: false, textChannels: [], voiceChannels: [] };
      },
      save: async (name: string, body: unknown) => {
        calls.push(`save ${name}`);
        return { hasDiscordToken: true, textChannels: [], voiceChannels: [] };
      },
      verifyDiscord: async (name: string) => ({ ok: true, detail: 'Bot authenticated as crew' }),
    },
  });
  const port = await channel.start(0);
  try {
    const blocked = await fetch(`http://127.0.0.1:${port}/workspaces/acme/channels`, {
      headers: { Origin: 'http://evil.example' },
    });
    assert.equal(blocked.status, 403);

    const get = await fetch(`http://127.0.0.1:${port}/workspaces/acme/channels`, {
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { hasDiscordToken: false, textChannels: [], voiceChannels: [] });

    const put = await fetch(`http://127.0.0.1:${port}/workspaces/acme/channels`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:1420' },
      body: JSON.stringify({ discord: { botToken: 'tok', textChannels: [], voiceChannels: [] } }),
    });
    assert.equal(((await put.json()) as { hasDiscordToken?: boolean }).hasDiscordToken, true);
    assert.deepEqual(calls, ['get acme', 'save acme']);

    const verify = await fetch(`http://127.0.0.1:${port}/workspaces/acme/channels/verify-discord`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(verify.status, 200);
    assert.deepEqual(await verify.json(), { ok: true, detail: 'Bot authenticated as crew' });
  } finally {
    await channel.stop();
  }
});

test('GET /connectors/vendors returns the vendor catalog', async () => {
  const vendors = [{ id: 'github', name: 'GitHub' }];
  const channel = channelWith({
    connectors: {
      vendors: async () => vendors,
      list: async () => [],
      add: async () => ({}),
      update: async () => ({}),
      remove: async () => ({}),
      verify: async () => ({}),
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/connectors/vendors`, {
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), vendors);
  } finally {
    await channel.stop();
  }
});

test('GET /me/connectors lists the operator\'s connectors; POST adds one', async () => {
  const added: Array<Record<string, unknown>> = [];
  const channel = channelWith({
    connectors: {
      vendors: async () => [],
      list: async () => [{ id: 'c1', vendorId: 'github', label: 'Work GitHub' }],
      add: async (body) => {
        added.push(body);
        return (body as { label?: string }).label === 'bad' ? { error: 'label taken' } : { id: 'c2', ...body };
      },
      update: async () => ({}),
      remove: async () => ({}),
      verify: async () => ({}),
    },
  });
  const port = await channel.start(0);
  try {
    const list = await fetch(`http://127.0.0.1:${port}/me/connectors`, {
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), [{ id: 'c1', vendorId: 'github', label: 'Work GitHub' }]);

    const ok = await fetch(`http://127.0.0.1:${port}/me/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:1420' },
      body: JSON.stringify({ vendorId: 'github', label: 'New one', fields: {} }),
    });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { id: 'c2', vendorId: 'github', label: 'New one', fields: {} });

    const bad = await fetch(`http://127.0.0.1:${port}/me/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:1420' },
      body: JSON.stringify({ vendorId: 'github', label: 'bad', fields: {} }),
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'label taken' });

    assert.deepEqual(added, [
      { vendorId: 'github', label: 'New one', fields: {} },
      { vendorId: 'github', label: 'bad', fields: {} },
    ]);
  } finally {
    await channel.stop();
  }
});

test('PUT /me/connectors/:id updates; DELETE removes; both pass the swarm answer through', async () => {
  const calls: string[] = [];
  const channel = channelWith({
    connectors: {
      vendors: async () => [],
      list: async () => [],
      add: async () => ({}),
      update: async (id, body) => {
        calls.push(`update ${id}`);
        return id === 'missing' ? { error: `Unknown connector: ${id}` } : { id, ...body };
      },
      remove: async (id) => {
        calls.push(`remove ${id}`);
        return id === 'missing' ? { error: `Unknown connector: ${id}` } : { ok: true };
      },
      verify: async () => ({}),
    },
  });
  const port = await channel.start(0);
  try {
    const put = await fetch(`http://127.0.0.1:${port}/me/connectors/c1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:1420' },
      body: JSON.stringify({ label: 'Renamed' }),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { id: 'c1', label: 'Renamed' });

    const putMissing = await fetch(`http://127.0.0.1:${port}/me/connectors/missing`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:1420' },
      body: JSON.stringify({ label: 'x' }),
    });
    assert.equal(putMissing.status, 400);
    assert.deepEqual(await putMissing.json(), { error: 'Unknown connector: missing' });

    const del = await fetch(`http://127.0.0.1:${port}/me/connectors/c1`, {
      method: 'DELETE',
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true });

    const delMissing = await fetch(`http://127.0.0.1:${port}/me/connectors/missing`, {
      method: 'DELETE',
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(delMissing.status, 400);
    assert.deepEqual(await delMissing.json(), { error: 'Unknown connector: missing' });

    assert.deepEqual(calls, ['update c1', 'update missing', 'remove c1', 'remove missing']);
  } finally {
    await channel.stop();
  }
});

test('POST /me/connectors/:id/verify forwards optional extra fields and the swarm answer', async () => {
  const received: Array<{ id: string; extra: Record<string, string> | undefined }> = [];
  const channel = channelWith({
    connectors: {
      vendors: async () => [],
      list: async () => [],
      add: async () => ({}),
      update: async () => ({}),
      remove: async () => ({}),
      verify: async (id, extra) => {
        received.push({ id, extra });
        return id === 'bad' ? { error: 'invalid token' } : { ok: true, detail: 'verified' };
      },
    },
  });
  const port = await channel.start(0);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/me/connectors/c1/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'http://localhost:1420' },
      body: JSON.stringify({ extra: { otp: '123456' } }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, detail: 'verified' });

    const bad = await fetch(`http://127.0.0.1:${port}/me/connectors/bad/verify`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:1420' },
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid token' });

    assert.deepEqual(received, [
      { id: 'c1', extra: { otp: '123456' } },
      { id: 'bad', extra: undefined },
    ]);
  } finally {
    await channel.stop();
  }
});

test('connector routes block a disallowed Origin, same as /me', async () => {
  const connectors = {
    vendors: async () => [],
    list: async () => [],
    add: async () => ({}),
    update: async () => ({}),
    remove: async () => ({}),
    verify: async () => ({}),
  };
  const channel = channelWith({ connectors });
  const port = await channel.start(0);
  const blockedHeaders = { headers: { origin: 'http://evil.example' } };
  try {
    const requests: Array<[string, RequestInit?]> = [
      [`http://127.0.0.1:${port}/connectors/vendors`, blockedHeaders],
      [`http://127.0.0.1:${port}/me/connectors`, blockedHeaders],
      [`http://127.0.0.1:${port}/me/connectors`, { method: 'POST', ...blockedHeaders }],
      [`http://127.0.0.1:${port}/me/connectors/c1`, { method: 'PUT', ...blockedHeaders }],
      [`http://127.0.0.1:${port}/me/connectors/c1`, { method: 'DELETE', ...blockedHeaders }],
      [`http://127.0.0.1:${port}/me/connectors/c1/verify`, { method: 'POST', ...blockedHeaders }],
    ];
    for (const [url, init] of requests) {
      const res = await fetch(url, init);
      assert.equal(res.status, 403, `${init?.method ?? 'GET'} ${url} should 403`);
      assert.deepEqual(await res.json(), { error: 'origin not allowed' });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
  } finally {
    await channel.stop();
  }
});
