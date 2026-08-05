// Unit tests for server.ts's pure/extracted route helpers — mirrors
// agents.test.ts's approach (import the exported helper straight from
// server.js) rather than booting the full OrchestratorServer, which has real
// filesystem side effects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildUserUpdate, workspaceProblems } from './server.js';
import { saveUser, loadUsersFromDir } from './users.js';
import type { User } from './users.js';
import type { Workspace } from './workspaces.js';

const git = promisify(execFile);

test('buildUserUpdate: partial update (no email key at all — "client only sent what changed") preserves the saved email', () => {
  const existing: User = { id: 'edwin', name: 'Edwin', atlassian: { email: 'edwin@acme.com', apiToken: 'old-tok' } };
  const merged = buildUserUpdate(existing, { atlassian: { apiToken: 'new-token' } } as unknown as Partial<User>);
  assert.equal(merged.atlassian?.email, 'edwin@acme.com');
  assert.equal(merged.atlassian?.apiToken, 'new-token');
});

test('buildUserUpdate: AccountPanel-produced shape ({email: "", apiToken}) also preserves the saved email', () => {
  const existing: User = { id: 'edwin', name: 'Edwin', atlassian: { email: 'edwin@acme.com', apiToken: 'old-tok' } };
  const merged = buildUserUpdate(existing, { atlassian: { email: '', apiToken: 'new-token' } });
  assert.equal(merged.atlassian?.email, 'edwin@acme.com');
  assert.equal(merged.atlassian?.apiToken, 'new-token');
});

test('PUT /me merge round-trips through real saveUser/loadUsersFromDir: the stored email survives both update shapes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-'));
  await saveUser(dir, {
    id: 'edwin',
    name: 'Edwin',
    default: true,
    atlassian: { email: 'edwin@acme.com', apiToken: 'old-tok' },
  });

  // Shape 1: the more realistic "client only sent what changed" body.
  {
    const [existing] = await loadUsersFromDir(dir);
    const merged = buildUserUpdate(existing ?? null, { atlassian: { apiToken: 'new-token' } } as unknown as Partial<User>);
    await saveUser(dir, merged);
    const [reloaded] = await loadUsersFromDir(dir);
    assert.equal(reloaded?.atlassian?.email, 'edwin@acme.com');
    assert.equal(reloaded?.atlassian?.apiToken, 'new-token');
  }

  // Shape 2: the actual AccountPanel-produced body — email explicitly blank.
  {
    const [existing] = await loadUsersFromDir(dir);
    const merged = buildUserUpdate(existing ?? null, { atlassian: { email: '', apiToken: 'newer-token' } });
    await saveUser(dir, merged);
    const [reloaded] = await loadUsersFromDir(dir);
    assert.equal(reloaded?.atlassian?.email, 'edwin@acme.com');
    assert.equal(reloaded?.atlassian?.apiToken, 'newer-token');
  }
});

test('workspaceProblems: rejects an atlassian block with no site URL, accepts one with', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'ws-git-'));
  await git('git', ['init', '-q'], { cwd: repoDir });
  const base: Partial<Workspace> = { name: 'acme', repos: [{ name: 'web', path: repoDir }] };

  const missing = await workspaceProblems({ ...base, atlassian: { siteUrl: '' } });
  assert.match(missing ?? '', /site URL/);

  const ok = await workspaceProblems({ ...base, atlassian: { siteUrl: 'https://acme.atlassian.net' } });
  assert.equal(ok, null);
});

test('workspaceProblems: rejects a repo github block missing owner or repo, accepts a complete one', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'ws-git-'));
  await git('git', ['init', '-q'], { cwd: repoDir });

  const missing = await workspaceProblems({
    name: 'acme',
    repos: [{ name: 'web', path: repoDir, github: { owner: 'acme', repo: '' } }],
  });
  assert.match(missing ?? '', /GitHub owner and repo/);

  const ok = await workspaceProblems({
    name: 'acme',
    repos: [{ name: 'web', path: repoDir, github: { owner: 'acme', repo: 'web' } }],
  });
  assert.equal(ok, null);
});
