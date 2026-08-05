import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  resolveRepo,
  saveWorkspace,
  removeWorkspaceFile,
  isGitRepo,
  defaultViolation,
  loadWorkspacesFromDir,
  normalizeRepoBranch,
} from './workspaces.js';
import type { Workspace } from './workspaces.js';

test('resolveRepo never resolves into an archived workspace', () => {
  const ws: Workspace[] = [
    { name: 'old', archived: true, default: true, repos: [{ name: 'r', path: '/tmp/a' }] },
    { name: 'live', repos: [{ name: 'r', path: '/tmp/b' }] },
  ];
  assert.equal(resolveRepo(ws, undefined, undefined)?.workspace.name, 'live');
  assert.equal(resolveRepo(ws, 'old', undefined), null);
});

test('saveWorkspace rejects a bad slug and round-trips a good one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-'));
  await assert.rejects(() => saveWorkspace(dir, { name: 'Bad Name', repos: [{ name: 'r', path: '/tmp' }] }));
  await saveWorkspace(dir, { name: 'good', repos: [{ name: 'r', path: '/tmp' }] });
  assert.equal((await loadWorkspacesFromDir(dir))[0]?.name, 'good');
});

test('isGitRepo: true for a real repo, false for a plain dir', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'git-'));
  await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
  assert.equal(await isGitRepo(repo), true);
  const plain = await mkdtemp(join(tmpdir(), 'plain-'));
  assert.equal(await isGitRepo(plain), false);
});

test('defaultViolation blocks removing the default while other active workspaces exist', () => {
  const all: Workspace[] = [
    { name: 'a', default: true, repos: [{ name: 'r', path: '/tmp' }] },
    { name: 'b', repos: [{ name: 'r', path: '/tmp' }] },
  ];
  assert.match(defaultViolation(all, 'a') ?? '', /default/);
  assert.equal(defaultViolation(all, 'b'), null);
  assert.equal(defaultViolation([all[0]!], 'a'), null); // last one may go
});

test('normalizeRepoBranch: defaults a blank or omitted branch to main, leaves a real one alone', () => {
  const repos = normalizeRepoBranch([
    { name: 'r1', path: '/tmp/a', branch: '' },
    { name: 'r2', path: '/tmp/b', branch: '   ' },
    { name: 'r3', path: '/tmp/c' },
    { name: 'r4', path: '/tmp/d', branch: 'develop' },
  ]);
  assert.deepEqual(
    repos.map((r) => r.branch),
    ['main', 'main', 'main', 'develop'],
  );
});

test('removeWorkspaceFile: rejects missing workspace with readable error, succeeds on existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rm-'));
  await assert.rejects(
    () => removeWorkspaceFile(dir, 'nope'),
    /Workspace "nope" not found/,
  );
  await saveWorkspace(dir, { name: 'exist', repos: [{ name: 'r', path: '/tmp' }] });
  await removeWorkspaceFile(dir, 'exist');
  assert.equal((await loadWorkspacesFromDir(dir)).length, 0);
});

test('atlassian and github config round-trip through save/load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-'));
  const ws: Workspace = {
    name: 'acme',
    repos: [{ name: 'web', path: '/tmp', branch: 'main', github: { owner: 'acme', repo: 'web' } }],
    atlassian: { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'], confluenceSpaceKeys: ['DOCS'] },
  };
  await saveWorkspace(dir, ws);
  const [loaded] = await loadWorkspacesFromDir(dir);
  assert.deepEqual(loaded?.atlassian, ws.atlassian);
  assert.deepEqual(loaded?.repos[0]?.github, { owner: 'acme', repo: 'web' });
});
