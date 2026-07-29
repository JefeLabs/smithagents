import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents, findAgent, saveAgent, activeAgents, type ComposedAgent } from './agents.js';
import { buildAgentUpdate } from './server.js';

async function seedDir(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agents-'));
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(body));
  }
  return dir;
}

test('loadAgents parses valid agent files', async () => {
  const dir = await seedDir({
    'manuel.json': {
      id: 'manuel', name: 'Manuel', role: 'Architect',
      directives: 'Own multi-tenant routing.',
      engine: { cli: 'claude', model: 'claude-opus' },
    },
  });
  const agents = await loadAgents(dir);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'Manuel');
  assert.equal(agents[0].engine.model, 'claude-opus');
});

test('loadAgents throws on a malformed file, naming it', async () => {
  const dir = await seedDir({ 'broken.json': { name: 'x' } }); // missing id/role/directives/engine
  await assert.rejects(() => loadAgents(dir), /broken\.json/);
});

test('findAgent matches id or name case-insensitively', async () => {
  const dir = await seedDir({
    'a.json': { id: 'manuel', name: 'Manuel', role: 'Architect', directives: 'x', engine: { cli: 'claude', model: 'm' } },
  });
  const agents = await loadAgents(dir);
  assert.equal(findAgent(agents, 'MANUEL')?.id, 'manuel');
  assert.equal(findAgent(agents, 'manuel')?.id, 'manuel');
  assert.equal(findAgent(agents, 'nobody'), undefined);
});

test('activeAgents filters archived records; loadAgents keeps them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-'));
  const base = { id: 'x', name: 'X', role: 'r', directives: 'd', engine: { cli: 'claude' as const, model: 'claude-sonnet' } };
  await saveAgent(dir, { ...base, id: 'alive' });
  await saveAgent(dir, { ...base, id: 'gone', archived: true });
  const all = await loadAgents(dir);
  assert.equal(all.length, 2);
  assert.deepEqual(activeAgents(all).map((a) => a.id), ['alive']);
});

// `channels` covers both the legacy `string[]` (listed = designated) form and
// the newer per-surface mode map (`{ tauri: 'autojoin', discord: 'on-request' }`)
// the control-plane presence popover PUTs. There is no route-level (fastify
// inject) test harness in this package — registerRoutes() only runs behind
// the full OrchestratorServer constructor, which has real filesystem side
// effects tied to process.cwd() (loadConfig() mkdirSyncs under .smith/) — so
// this exercises the same saveAgent/loadAgents round-trip PUT /agents/:id
// relies on, and calls the PUT handler's own exported `buildAgentUpdate`
// (server.ts) directly rather than mirroring its merge expression, so a
// regression to that function fails these tests too.
test('saveAgent/loadAgents round-trip channels as a per-surface mode map, not just the legacy array', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-'));
  const base = { id: 'mapped', name: 'Mapped', role: 'r', directives: 'd', engine: { cli: 'claude' as const, model: 'claude-sonnet' } };
  const channels = { tauri: 'autojoin', discord: 'on-request', 'discord-voice': 'disabled' };
  await saveAgent(dir, { ...base, channels });
  const [reloaded] = await loadAgents(dir);
  assert.deepEqual(reloaded.channels, channels);
});

test('buildAgentUpdate: a channels map in the body replaces legacy array channels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-'));
  const existing: ComposedAgent = {
    id: 'wilkin', name: 'Wilkin', role: 'r', directives: 'd',
    engine: { cli: 'claude', model: 'claude-sonnet' },
    channels: ['tauri'],
  };
  await saveAgent(dir, existing);

  const body: Partial<ComposedAgent> = { channels: { tauri: 'autojoin', discord: 'disabled' } };
  const updated = buildAgentUpdate(existing, body);
  await saveAgent(dir, updated);

  const [reloaded] = await loadAgents(dir);
  assert.deepEqual(reloaded.channels, { tauri: 'autojoin', discord: 'disabled' });
});

test('buildAgentUpdate: omitting channels from the body preserves the existing value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agents-'));
  const existing: ComposedAgent = {
    id: 'aurelio', name: 'Aurelio', role: 'r', directives: 'd',
    engine: { cli: 'claude', model: 'claude-sonnet' },
    channels: { tauri: 'autojoin' },
  };
  await saveAgent(dir, existing);

  const body: Partial<ComposedAgent> = { name: 'Aurelio the Second' }; // no channels field sent
  const updated = buildAgentUpdate(existing, body);
  await saveAgent(dir, updated);

  const [reloaded] = await loadAgents(dir);
  assert.equal(updated.name, 'Aurelio the Second'); // sanity: the merge did apply the body
  assert.deepEqual(reloaded.channels, { tauri: 'autojoin' });
});
