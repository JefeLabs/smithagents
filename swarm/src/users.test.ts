import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUsersFromDir, saveUser, resolveCurrentUser } from './users.js';
import type { User } from './users.js';

test('resolveCurrentUser prefers the default-flagged user, falls back to the sole file', () => {
  assert.equal(resolveCurrentUser([]), null);
  const solo: User[] = [{ id: 'edwin', name: 'Edwin' }];
  assert.equal(resolveCurrentUser(solo)?.id, 'edwin');
  const multi: User[] = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', default: true },
  ];
  assert.equal(resolveCurrentUser(multi)?.id, 'b');
});

test('saveUser rejects a bad slug and round-trips a good one, including credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-'));
  await assert.rejects(() => saveUser(dir, { id: 'Bad Id', name: 'x' }));
  await saveUser(dir, {
    id: 'edwin',
    name: 'Edwin',
    atlassian: { email: 'edwin@acme.com', apiToken: 'secret-tok' },
    github: { token: 'ghp_secret' },
  });
  const [loaded] = await loadUsersFromDir(dir);
  assert.equal(loaded?.id, 'edwin');
  assert.deepEqual(loaded?.atlassian, { email: 'edwin@acme.com', apiToken: 'secret-tok' });
  assert.deepEqual(loaded?.github, { token: 'ghp_secret' });
});

test('loadUsersFromDir returns [] for a missing dir', async () => {
  assert.deepEqual(await loadUsersFromDir('/tmp/does-not-exist-users-dir'), []);
});
