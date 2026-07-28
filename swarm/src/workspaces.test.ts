import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRepo, saveWorkspace, removeWorkspaceFile, isGitRepo, defaultViolation, loadWorkspacesFromDir } from './workspaces.js';
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
