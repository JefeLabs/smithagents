import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from './dispatcher.js';
import type { TaskManifest, OrchestratorConfig } from './types.js';

// resolveConnections is exercised through the Dispatcher instance rather than
// exported standalone, since it reads from the same `.smith/workspaces` and
// `.smith/users` dirs the rest of the module resolves relative to cwd — the
// test drives it via a minimal manifest + a real repo/user fixture on disk.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-conn-'));
  await mkdir(join(root, '.smith/workspaces'), { recursive: true });
  await mkdir(join(root, '.smith/users'), { recursive: true });
  const repoPath = join(root, 'repo');
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, '.smith/workspaces/acme.json'),
    JSON.stringify({
      name: 'acme',
      repos: [{ name: 'web', path: repoPath, github: { owner: 'acme', repo: 'web' } }],
      atlassian: { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'] },
    }),
  );
  await writeFile(
    join(root, '.smith/users/edwin.json'),
    JSON.stringify({ id: 'edwin', name: 'Edwin', default: true, atlassian: { email: 'e@acme.com', apiToken: 'atl-tok' }, github: { token: 'gh-tok' } }),
  );
  return { root, repoPath };
}

test('resolveConnections: pairs the current user credential with the repo-matched workspace config', async () => {
  const { root, repoPath } = await fixture();
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const manifest = { context: { repoPath } } as TaskManifest;
  const resolved = await dispatcher.resolveConnections(manifest, root);
  assert.deepEqual(resolved.atlassian, { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'] });
  assert.equal(resolved.env.SMITH_ATLASSIAN_EMAIL, 'e@acme.com');
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, 'atl-tok');
  assert.equal(resolved.env.GH_TOKEN, 'gh-tok');
});

test('resolveConnections: missing workspace atlassian config or missing user credential both skip injection cleanly', async () => {
  const { root, repoPath } = await fixture();
  // repoPath not matched by any workspace -> everything skipped
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath: '/nope' } } as TaskManifest, root);
  assert.equal(resolved.atlassian, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, undefined);
  assert.equal(resolved.env.GH_TOKEN, undefined);
});
