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
      repos: [{ name: 'web', path: repoPath, github: { owner: 'acme', repo: 'web', connectorId: 'gh-conn-1' } }],
      atlassian: { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'], connectorId: 'atl-conn-1' },
    }),
  );
  await writeFile(
    join(root, '.smith/users/edwin.json'),
    JSON.stringify({
      id: 'edwin',
      name: 'Edwin',
      default: true,
      connectors: [
        { id: 'atl-conn-1', vendorId: 'atlassian', label: 'default', fields: { email: 'e@acme.com', apiToken: 'atl-tok' } },
        { id: 'gh-conn-1', vendorId: 'github', label: 'default', fields: { token: 'gh-tok' } },
      ],
    }),
  );
  return { root, repoPath };
}

test('resolveConnections: pairs the current user credential with the repo-matched workspace config', async () => {
  const { root, repoPath } = await fixture();
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const manifest = { context: { repoPath } } as TaskManifest;
  const resolved = await dispatcher.resolveConnections(manifest, root);
  assert.deepEqual(resolved.atlassian, { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'], connectorId: 'atl-conn-1' });
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

test('resolveConnections: resolves Atlassian env vars through workspace.atlassian.connectorId, not "any atlassian connector the user has"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-conn-'));
  await mkdir(join(root, '.smith/workspaces'), { recursive: true });
  await mkdir(join(root, '.smith/users'), { recursive: true });
  const repoPath = join(root, 'repo');
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, '.smith/workspaces/acme.json'),
    JSON.stringify({
      name: 'acme',
      repos: [{ name: 'web', path: repoPath }],
      atlassian: { siteUrl: 'https://acme.atlassian.net', connectorId: 'atl-conn-2' },
    }),
  );
  await writeFile(
    join(root, '.smith/users/edwin.json'),
    JSON.stringify({
      id: 'edwin',
      name: 'Edwin',
      default: true,
      connectors: [
        { id: 'atl-conn-1', vendorId: 'atlassian', label: 'personal', fields: { email: 'first@acme.com', apiToken: 'first-tok' } },
        { id: 'atl-conn-2', vendorId: 'atlassian', label: 'acme-corp', fields: { email: 'second@acme.com', apiToken: 'second-tok' } },
      ],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(resolved.env.SMITH_ATLASSIAN_EMAIL, 'second@acme.com');
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, 'second-tok');
});

test('resolveConnections: an unset connectorId resolves to no Atlassian injection, not a crash and not a guess', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-conn-'));
  await mkdir(join(root, '.smith/workspaces'), { recursive: true });
  await mkdir(join(root, '.smith/users'), { recursive: true });
  const repoPath = join(root, 'repo');
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, '.smith/workspaces/acme.json'),
    JSON.stringify({
      name: 'acme',
      repos: [{ name: 'web', path: repoPath }],
      atlassian: { siteUrl: 'https://acme.atlassian.net' },
    }),
  );
  await writeFile(
    join(root, '.smith/users/edwin.json'),
    JSON.stringify({
      id: 'edwin',
      name: 'Edwin',
      default: true,
      connectors: [
        { id: 'atl-conn-1', vendorId: 'atlassian', label: 'default', fields: { email: 'e@acme.com', apiToken: 'atl-tok' } },
      ],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(resolved.atlassian, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_EMAIL, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, undefined);
});

test('resolveConnections: a connectorId pointing at a deleted/nonexistent connector resolves to no injection, same as unset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-conn-'));
  await mkdir(join(root, '.smith/workspaces'), { recursive: true });
  await mkdir(join(root, '.smith/users'), { recursive: true });
  const repoPath = join(root, 'repo');
  await mkdir(repoPath, { recursive: true });
  await writeFile(
    join(root, '.smith/workspaces/acme.json'),
    JSON.stringify({
      name: 'acme',
      repos: [{ name: 'web', path: repoPath }],
      atlassian: { siteUrl: 'https://acme.atlassian.net', connectorId: 'does-not-exist' },
    }),
  );
  await writeFile(
    join(root, '.smith/users/edwin.json'),
    JSON.stringify({
      id: 'edwin',
      name: 'Edwin',
      default: true,
      connectors: [
        { id: 'atl-conn-1', vendorId: 'atlassian', label: 'default', fields: { email: 'e@acme.com', apiToken: 'atl-tok' } },
      ],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(resolved.atlassian, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_EMAIL, undefined);
  assert.equal(resolved.env.SMITH_ATLASSIAN_TOKEN, undefined);
});

test('resolveConnections: GH_TOKEN resolves through repo.github.connectorId, per-repo — two repos in the same workspace can resolve different GitHub tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dispatch-conn-'));
  await mkdir(join(root, '.smith/workspaces'), { recursive: true });
  await mkdir(join(root, '.smith/users'), { recursive: true });
  const repoPathA = join(root, 'repo-a');
  const repoPathB = join(root, 'repo-b');
  await mkdir(repoPathA, { recursive: true });
  await mkdir(repoPathB, { recursive: true });
  await writeFile(
    join(root, '.smith/workspaces/acme.json'),
    JSON.stringify({
      name: 'acme',
      repos: [
        { name: 'a', path: repoPathA, github: { owner: 'acme', repo: 'a', connectorId: 'gh-conn-1' } },
        { name: 'b', path: repoPathB, github: { owner: 'acme', repo: 'b', connectorId: 'gh-conn-2' } },
      ],
    }),
  );
  await writeFile(
    join(root, '.smith/users/edwin.json'),
    JSON.stringify({
      id: 'edwin',
      name: 'Edwin',
      default: true,
      connectors: [
        { id: 'gh-conn-1', vendorId: 'github', label: 'personal', fields: { token: 'tok-a' } },
        { id: 'gh-conn-2', vendorId: 'github', label: 'acme-corp', fields: { token: 'tok-b' } },
      ],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolvedA = await dispatcher.resolveConnections({ context: { repoPath: repoPathA } } as TaskManifest, root);
  const resolvedB = await dispatcher.resolveConnections({ context: { repoPath: repoPathB } } as TaskManifest, root);
  assert.equal(resolvedA.env.GH_TOKEN, 'tok-a');
  assert.equal(resolvedB.env.GH_TOKEN, 'tok-b');
});

test('resolveConnections: a repo with no github.connectorId set resolves no GH_TOKEN, even if the user has GitHub connectors', async () => {
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
    }),
  );
  await writeFile(
    join(root, '.smith/users/edwin.json'),
    JSON.stringify({
      id: 'edwin',
      name: 'Edwin',
      default: true,
      connectors: [{ id: 'gh-conn-1', vendorId: 'github', label: 'default', fields: { token: 'gh-tok' } }],
    }),
  );
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const resolved = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(resolved.env.GH_TOKEN, undefined);
});
