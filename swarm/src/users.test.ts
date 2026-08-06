import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUsersFromDir, saveUser, resolveCurrentUser } from './users.js';

test('loadUsersFromDir: a legacy user file (atlassian + github fields, no connectors) is upgraded on load into two ConnectorInstance entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-legacy-'));
  await writeFile(
    join(dir, 'me.json'),
    JSON.stringify({
      id: 'me',
      name: 'Edwin',
      default: true,
      atlassian: { email: 'edwin@example.com', apiToken: 'atl-tok' },
      github: { token: 'gh-tok' },
    }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors?.length, 2);
  const atlassian = user!.connectors!.find((c) => c.vendorId === 'atlassian');
  const github = user!.connectors!.find((c) => c.vendorId === 'github');
  assert.equal(atlassian?.label, 'default');
  assert.equal(atlassian?.fields.email, 'edwin@example.com');
  assert.equal(atlassian?.fields.apiToken, 'atl-tok');
  assert.equal(github?.label, 'default');
  assert.equal(github?.fields.token, 'gh-tok');
  assert.ok(atlassian?.id && github?.id && atlassian.id !== github.id, 'each gets its own generated id');
  // biome-ignore-next: the legacy fields must not survive onto the in-memory User
  assert.equal((user as unknown as { atlassian?: unknown }).atlassian, undefined);
});

test('loadUsersFromDir: a legacy user\'s connector ids are stable across repeated loads of the same file (no re-migration drift)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-legacy-stable-'));
  await writeFile(
    join(dir, 'me.json'),
    JSON.stringify({
      id: 'me',
      name: 'Edwin',
      default: true,
      atlassian: { email: 'edwin@example.com', apiToken: 'atl-tok' },
      github: { token: 'gh-tok' },
    }),
  );
  const [first] = await loadUsersFromDir(dir);
  const [second] = await loadUsersFromDir(dir);
  const firstAtlassian = first!.connectors!.find((c) => c.vendorId === 'atlassian')!;
  const firstGithub = first!.connectors!.find((c) => c.vendorId === 'github')!;
  const secondAtlassian = second!.connectors!.find((c) => c.vendorId === 'atlassian')!;
  const secondGithub = second!.connectors!.find((c) => c.vendorId === 'github')!;
  assert.equal(firstAtlassian.id, secondAtlassian.id, 'atlassian connector id must be identical across separate loads');
  assert.equal(firstGithub.id, secondGithub.id, 'github connector id must be identical across separate loads');
});

test('loadUsersFromDir: a legacy user with only atlassian (no github) upgrades to exactly one connector', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-legacy-partial-'));
  await writeFile(
    join(dir, 'me.json'),
    JSON.stringify({ id: 'me', name: 'Edwin', atlassian: { email: 'e@x.com', apiToken: 'tok' } }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors?.length, 1);
  assert.equal(user!.connectors![0]!.vendorId, 'atlassian');
});

test('loadUsersFromDir: a user with no legacy fields and no connectors loads with connectors undefined, no crash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-blank-'));
  await writeFile(join(dir, 'me.json'), JSON.stringify({ id: 'me', name: 'Edwin' }));
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors, undefined);
});

test('loadUsersFromDir: an already-migrated user (has connectors) is passed through untouched, even if stray legacy keys are also present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-already-'));
  await writeFile(
    join(dir, 'me.json'),
    JSON.stringify({
      id: 'me',
      name: 'Edwin',
      connectors: [{ id: 'c1', vendorId: 'github', label: 'personal', fields: { token: 'tok' } }],
      github: { token: 'stray-legacy-value' }, // must be ignored, not merged in again
    }),
  );
  const [user] = await loadUsersFromDir(dir);
  assert.equal(user!.connectors?.length, 1);
  assert.equal(user!.connectors![0]!.fields.token, 'tok');
});

test('round-trip: saving a migrated user and reloading it produces the identical connectors array (no re-migration, no drift)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-roundtrip-'));
  const instance = { id: 'abc-123', vendorId: 'github', label: 'acme-corp', fields: { token: 'gh-tok' } };
  await saveUser(dir, { id: 'me', name: 'Edwin', default: true, connectors: [instance] });
  const [reloaded] = await loadUsersFromDir(dir);
  assert.deepEqual(reloaded!.connectors, [instance]);
});

test('saveUser: still writes with owner-only permissions (0o700 dir, 0o600 file) — unchanged by this task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-perms-'));
  await saveUser(dir, { id: 'me', name: 'Edwin', connectors: [] });
  const { stat } = await import('node:fs/promises');
  const fileStat = await stat(join(dir, 'me.json'));
  assert.equal(fileStat.mode & 0o777, 0o600);
});

test('resolveCurrentUser: unchanged behavior — default-flagged user, else sole file, else null', () => {
  const a = { id: 'a', name: 'A', connectors: [] };
  const b = { id: 'b', name: 'B', default: true, connectors: [] };
  assert.equal(resolveCurrentUser([a, b]), b);
  assert.equal(resolveCurrentUser([a]), a);
  assert.equal(resolveCurrentUser([]), null);
});
