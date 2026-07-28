import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents, findAgent, saveAgent, activeAgents } from './agents.js';

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
