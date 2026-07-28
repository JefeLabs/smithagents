import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SwarmClient, type SwarmEvent, type WsLike } from './swarm-client.ts';

interface Call { url: string; init?: RequestInit }

function fakeFetch(routes: Record<string, unknown>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const f = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const path = new URL(String(url)).pathname;
    const body = routes[path];
    if (body === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, fetch: f };
}

test('submitTask posts prompt/agent/context and returns taskId', async () => {
  const { calls, fetch } = fakeFetch({ '/tasks': { taskId: 't-1', agentName: 'Manuel', status: 'queued', position: 1 } });
  const c = new SwarmClient({ baseUrl: 'http://127.0.0.1:7777', token: 'secret', fetchImpl: fetch });
  const r = await c.submitTask({ prompt: 'do it', agent: 'claude', repository: 'git@x:y.git' });
  assert.equal(r.taskId, 't-1');
  const sent = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(sent.agent, 'claude');
  // branch '' -> the server substitutes the workspace repo's default branch
  assert.deepEqual(sent.context, { files: [], repository: 'git@x:y.git', branch: '' });
  assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, 'Bearer secret');
});

test('registry unwraps the agents array', async () => {
  const agents = [{ id: 'manuel', name: 'Manuel', role: 'lead', directives: 'd', engine: { cli: 'claude', model: 'sonnet' } }];
  const { fetch } = fakeFetch({ '/agents/registry': { agents } });
  const c = new SwarmClient({ baseUrl: 'http://x', fetchImpl: fetch });
  assert.deepEqual(await c.registry(), agents);
});

test('getOutput returns output; a failure surfaces swarm\'s own reason', async () => {
  const { fetch } = fakeFetch({ '/tasks/t-1/output': { taskId: 't-1', output: 'pane text' } });
  const c = new SwarmClient({ baseUrl: 'http://x', fetchImpl: fetch });
  assert.equal((await c.getOutput('t-1')).output, 'pane text');
  // The reason is what a human reads in the UI ("Invalid model id: …"), so it
  // must reach the caller rather than being flattened to a status code.
  await assert.rejects(() => c.getOutput('nope'), /not found/);
});

test('a failure with no reason in the body still reports the status', async () => {
  const f = (async () => new Response('<html>gateway blew up</html>', { status: 502 })) as typeof fetch;
  const c = new SwarmClient({ baseUrl: 'http://x', fetchImpl: f });
  await assert.rejects(() => c.getOutput('t-1'), /502/);
});

test('subscribe parses events and reconnects; unsubscribe stops it', async () => {
  const sockets: Array<EventEmitter & { close(): void; closed: boolean }> = [];
  const wsFactory = (url: string): WsLike => {
    assert.match(url, /\/ws\?token=tok$/);
    const s = Object.assign(new EventEmitter(), { closed: false, close() { (this as { closed: boolean }).closed = true; } });
    sockets.push(s as never);
    return s as unknown as WsLike;
  };
  const events: SwarmEvent[] = [];
  const c = new SwarmClient({ baseUrl: 'http://h:7777', token: 'tok', wsFactory });
  const stop = c.subscribe((e) => events.push(e));
  sockets[0]!.emit('message', JSON.stringify({ type: 'task:dispatched', taskId: 't-9', sessionName: 's' }));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'task:dispatched');
  stop();
  assert.equal(sockets[0]!.closed, true);
});

test('lifecycle methods hit the right swarm routes', async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url).replace('http://s', '')}`);
      return new Response(JSON.stringify({ ok: true, warmSessions: 0, activeTasks: 0, workspaces: [] }));
    }) as typeof fetch,
  });
  await client.agentUsage('wilkin');
  await client.archiveAgent('wilkin');
  await client.deleteAgent('wilkin');
  await client.createWorkspace({ name: 'w', repos: [] });
  await client.updateWorkspace('w', { description: 'd' });
  await client.archiveWorkspace('w');
  await client.deleteWorkspace('w');
  await client.workspaceUsage('w');
  assert.deepEqual(calls, [
    'GET /agents/wilkin/usage',
    'POST /agents/wilkin/archive',
    'DELETE /agents/wilkin',
    'POST /workspaces',
    'PUT /workspaces/w',
    'POST /workspaces/w/archive',
    'DELETE /workspaces/w',
    'GET /workspaces/w/usage',
  ]);
});

test('deleteAgent/deleteWorkspace send no body and no content-type header', async () => {
  // A bodiless DELETE with Content-Type: application/json 400s against a real
  // fastify server (FST_ERR_CTP_EMPTY_JSON_BODY) — this was live-broken end
  // to end (verified against swarm) until http() stopped setting the header
  // when there is nothing to send.
  const { calls, fetch } = fakeFetch({ '/agents/wilkin': { ok: true, deleted: 'wilkin' }, '/workspaces/w': { ok: true, deleted: 'w' } });
  const client = new SwarmClient({ baseUrl: 'http://s', fetchImpl: fetch });
  await client.deleteAgent('wilkin');
  await client.deleteWorkspace('w');
  for (const call of calls) {
    assert.equal(call.init?.body, undefined);
    assert.equal((call.init?.headers as Record<string, string> | undefined)?.['content-type'], undefined);
  }
});
