import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRepo } from './workspaces.js';
import type { Workspace } from './workspaces.js';

test('resolveRepo never resolves into an archived workspace', () => {
  const ws: Workspace[] = [
    { name: 'old', archived: true, default: true, repos: [{ name: 'r', path: '/tmp/a' }] },
    { name: 'live', repos: [{ name: 'r', path: '/tmp/b' }] },
  ];
  assert.equal(resolveRepo(ws, undefined, undefined)?.workspace.name, 'live');
  assert.equal(resolveRepo(ws, 'old', undefined), null);
});
