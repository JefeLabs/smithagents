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
import { buildUserUpdate, buildChannelsUpdate, workspaceProblems } from './server.js';
import { saveUser, loadUsersFromDir } from './users.js';
import type { User } from './users.js';
import type { Workspace } from './workspaces.js';
import type { WorkspaceChannels } from './channels.js';

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

test('buildChannelsUpdate: a submitted discord block replaces the existing one wholesale (no partial-field merge needed — unlike User.atlassian, there is only one credential field, botToken, so there is no sibling-field-blanking risk to guard against)', () => {
  const existing = { discord: { botToken: 'old-tok', textChannels: ['1'], voiceChannels: [] } };
  const merged = buildChannelsUpdate(existing, { discord: { botToken: 'new-tok', textChannels: ['1', '2'], voiceChannels: ['9'] } });
  assert.deepEqual(merged, { discord: { botToken: 'new-tok', textChannels: ['1', '2'], voiceChannels: ['9'] } });
});

test('buildChannelsUpdate: omitting discord in the submitted body preserves the existing config', () => {
  const existing = { discord: { botToken: 'old-tok', textChannels: ['1'], voiceChannels: [] } };
  const merged = buildChannelsUpdate(existing, {});
  assert.deepEqual(merged, existing);
});

test('buildChannelsUpdate: no existing config and no submitted discord block yields an empty config', () => {
  assert.deepEqual(buildChannelsUpdate(null, {}), {});
});

test('buildChannelsUpdate: an empty submitted botToken preserves the existing token, only channel lists update', () => {
  const existing = { discord: { botToken: 'saved-tok', textChannels: ['1'], voiceChannels: [] } };
  const merged = buildChannelsUpdate(existing, { discord: { botToken: '', textChannels: ['1', '2'], voiceChannels: ['9'] } });
  assert.deepEqual(merged, { discord: { botToken: 'saved-tok', textChannels: ['1', '2'], voiceChannels: ['9'] } });
});

test('buildChannelsUpdate: no existing token and an empty submitted botToken yields an empty-string token, not a crash', () => {
  const merged = buildChannelsUpdate(null, { discord: { botToken: '', textChannels: ['1'], voiceChannels: [] } });
  assert.deepEqual(merged, { discord: { botToken: '', textChannels: ['1'], voiceChannels: [] } });
});

test('buildChannelsUpdate: a submission that omits both channel lists (e.g. {"discord":{"botToken":"x"}}) falls back to the existing lists rather than persisting undefined', () => {
  const existing = { discord: { botToken: 'old-tok', textChannels: ['1'], voiceChannels: ['9'] } };
  const merged = buildChannelsUpdate(existing, { discord: { botToken: 'new-tok' } } as Partial<WorkspaceChannels>);
  assert.deepEqual(merged, { discord: { botToken: 'new-tok', textChannels: ['1'], voiceChannels: ['9'] } });
});

test('buildChannelsUpdate: omitting both lists with no existing config falls back to empty arrays, not undefined', () => {
  const merged = buildChannelsUpdate(null, { discord: { botToken: 'tok' } } as Partial<WorkspaceChannels>);
  assert.deepEqual(merged, { discord: { botToken: 'tok', textChannels: [], voiceChannels: [] } });
});

test('buildChannelsUpdate: omitting only voiceChannels preserves the existing voice list while textChannels updates', () => {
  const existing = { discord: { botToken: 'tok', textChannels: ['1'], voiceChannels: ['9'] } };
  const merged = buildChannelsUpdate(existing, { discord: { botToken: 'tok', textChannels: ['2', '3'] } } as Partial<WorkspaceChannels>);
  assert.deepEqual(merged, { discord: { botToken: 'tok', textChannels: ['2', '3'], voiceChannels: ['9'] } });
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
