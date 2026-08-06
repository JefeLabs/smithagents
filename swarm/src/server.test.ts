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
import {
  buildChannelsUpdate,
  buildConnectorFields,
  buildConnectorUpdate,
  redactConnector,
  resolveAtlassianConnector,
  resolveConnector,
  workspaceProblems,
  gitInitRequestedRepos,
  resolveTaskRuntime,
} from './server.js';
import { saveUser, loadUsersFromDir } from './users.js';
import type { ConnectorInstance, User } from './users.js';
import { isGitRepo } from './workspaces.js';
import type { Workspace } from './workspaces.js';
import type { WorkspaceChannels } from './channels.js';

const git = promisify(execFile);

// redactUser (the /me and /me/connectors response shaper) is a closure
// nested inside OrchestratorServer.registerRoutes, which is only ever called
// from start() right before app.listen() — this file's own header comment
// explains why it avoids booting the full OrchestratorServer (real
// filesystem/tmux/dispatcher side effects), and no lighter route-boot
// harness exists anywhere in this package's test suite (confirmed: no
// test file constructs OrchestratorServer or calls app.inject). So this
// exercises redactUser's actual behavior through redactConnector — the
// exported, module-level piece it delegates to for every connector in the
// list — which is the closest faithful substitute available without
// inventing a new harness. The route wiring (GET /me, GET /me/connectors)
// was verified by direct code inspection against the brief's spec instead.
test('redactConnector: secret fields become has<Field> booleans, non-secret fields keep their real value, never the raw secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'users-'));
  const instance: ConnectorInstance = {
    id: 'c1',
    vendorId: 'atlassian',
    label: 'acme',
    fields: { email: 'edwin@acme.com', apiToken: 'super-secret-token' },
  };
  await saveUser(dir, { id: 'edwin', name: 'Edwin', default: true, connectors: [instance] });

  const [reloaded] = await loadUsersFromDir(dir);
  const redacted = redactConnector(reloaded!.connectors![0]!);

  assert.equal(redacted.id, 'c1');
  assert.equal(redacted.vendorId, 'atlassian');
  assert.equal(redacted.label, 'acme');
  // Non-secret field: real value passes through.
  assert.deepEqual((redacted.fields as Record<string, unknown>).email, 'edwin@acme.com');
  // Secret field: boolean presence flag, never the raw token.
  assert.equal((redacted.fields as Record<string, unknown>).hasApiToken, true);
  assert.equal(JSON.stringify(redacted).includes('super-secret-token'), false);
});

test('buildConnectorFields: POST /me/connectors — an unknown/extra field key is dropped, only registry-declared keys persist', () => {
  const result = buildConnectorFields('github', { token: 'gh-tok', notARealField: 'garbage' });
  assert.deepEqual(result, { token: 'gh-tok' });
});

test('buildConnectorFields: an unknown vendorId (already rejected upstream by the route, but defensively) yields no fields', () => {
  const result = buildConnectorFields('not-a-real-vendor', { token: 'x' });
  assert.deepEqual(result, {});
});

test('buildConnectorFields: fields undefined (nothing submitted) yields an empty object, not a crash', () => {
  const result = buildConnectorFields('github', undefined);
  assert.deepEqual(result, {});
});

test('buildConnectorUpdate: a blank submitted secret field falls back to the existing stored value', () => {
  const existing: ConnectorInstance = { id: 'c1', vendorId: 'github', label: 'personal', fields: { token: 'old-tok' } };
  const merged = buildConnectorUpdate(existing, { fields: { token: '' } });
  assert.equal(merged.fields.token, 'old-tok');
});

test('buildConnectorUpdate: a non-blank submitted field overrides the existing value', () => {
  const existing: ConnectorInstance = { id: 'c1', vendorId: 'github', label: 'personal', fields: { token: 'old-tok' } };
  const merged = buildConnectorUpdate(existing, { fields: { token: 'new-tok' } });
  assert.equal(merged.fields.token, 'new-tok');
});

test('buildConnectorUpdate: omitting fields entirely leaves all existing fields untouched, only label changes', () => {
  const existing: ConnectorInstance = {
    id: 'c1',
    vendorId: 'datadog',
    label: 'old-label',
    fields: { site: 'us1', apiKey: 'k', appKey: 'a' },
  };
  const merged = buildConnectorUpdate(existing, { label: 'new-label' });
  assert.equal(merged.label, 'new-label');
  assert.deepEqual(merged.fields, { site: 'us1', apiKey: 'k', appKey: 'a' });
});

test('buildConnectorUpdate: vendorId is immutable — even if the caller sends one, it never changes', () => {
  const existing: ConnectorInstance = { id: 'c1', vendorId: 'github', label: 'x', fields: { token: 't' } };
  const merged = buildConnectorUpdate(existing, { fields: {} } as { label?: string; fields?: Record<string, string> } & {
    vendorId?: string;
  });
  assert.equal(merged.vendorId, 'github');
});

test('buildConnectorUpdate: applies trim-then-fallback uniformly to a non-secret field too (site/region), not just secrets', () => {
  const existing: ConnectorInstance = { id: 'c1', vendorId: 'datadog', label: 'x', fields: { site: 'us1', apiKey: 'k', appKey: 'a' } };
  const merged = buildConnectorUpdate(existing, { fields: { site: '  ', apiKey: 'k', appKey: 'a' } });
  assert.equal(merged.fields.site, 'us1'); // blank (whitespace-only) submission falls back, doesn't wipe
});

test('resolveConnector: no connectorId set (undefined) returns the "pick a connector first" error, not a match', () => {
  const user: User = { id: 'edwin', name: 'Edwin', connectors: [{ id: 'c1', vendorId: 'atlassian', label: 'x', fields: {} }] };
  const resolved = resolveConnector(undefined, 'atlassian', 'an Atlassian', 'workspace', user);
  assert.deepEqual(resolved, { error: 'Pick an Atlassian connector for this workspace first' });
});

test('resolveConnector: a connectorId with no matching instance at all returns the "no longer exists" error', () => {
  const user: User = { id: 'edwin', name: 'Edwin', connectors: [{ id: 'c1', vendorId: 'atlassian', label: 'x', fields: {} }] };
  const resolved = resolveConnector('does-not-exist', 'atlassian', 'an Atlassian', 'workspace', user);
  assert.deepEqual(resolved, { error: 'The connector picked for this workspace no longer exists — pick another' });
});

test('resolveConnector: a connectorId matching an instance of the WRONG vendor is treated as not found, not returned', () => {
  const user: User = { id: 'edwin', name: 'Edwin', connectors: [{ id: 'c1', vendorId: 'github', label: 'x', fields: { token: 't' } }] };
  // c1 exists, but as a github connector — asking for it scoped to 'atlassian' must not cross-match.
  const resolved = resolveConnector('c1', 'atlassian', 'an Atlassian', 'workspace', user);
  assert.deepEqual(resolved, { error: 'The connector picked for this workspace no longer exists — pick another' });
});

test('resolveConnector: a connectorId matching a same-vendor instance returns it', () => {
  const instance: ConnectorInstance = { id: 'c1', vendorId: 'atlassian', label: 'acme', fields: { email: 'e', apiToken: 't' } };
  const user: User = { id: 'edwin', name: 'Edwin', connectors: [instance] };
  const resolved = resolveConnector('c1', 'atlassian', 'an Atlassian', 'workspace', user);
  assert.deepEqual(resolved, { instance });
});

test('resolveConnector: a null user (no current user resolved at all) is treated the same as no matching connector', () => {
  const resolved = resolveConnector('c1', 'atlassian', 'an Atlassian', 'workspace', null);
  assert.deepEqual(resolved, { error: 'The connector picked for this workspace no longer exists — pick another' });
});

// Regression coverage for fix round 2: resolveAtlassianConnector backs both
// lookup-ticket and search-docs, and its whole reason to exist is enforcing
// that the connector guard is checked BEFORE the route's own required-field
// check — the exact order the resolveConnector extraction accidentally
// inverted in both routes (caught only by manual review, not a test).
test('resolveAtlassianConnector: invalid on BOTH axes at once (no connectorId AND missing required field) returns the connector error, not the missing-field error', () => {
  const resolved = resolveAtlassianConnector(undefined, null, { name: 'ticketKey', value: undefined });
  assert.deepEqual(resolved, { error: 'Pick an Atlassian connector for this workspace first' });
});

test('resolveAtlassianConnector: a resolvable connector but a missing required field still reports the missing-field error', () => {
  const instance: ConnectorInstance = { id: 'c1', vendorId: 'atlassian', label: 'acme', fields: { email: 'e', apiToken: 't' } };
  const user: User = { id: 'edwin', name: 'Edwin', connectors: [instance] };
  const resolved = resolveAtlassianConnector('c1', user, { name: 'ticketKey', value: undefined });
  assert.deepEqual(resolved, { error: 'Missing required field: ticketKey' });
});

test('resolveAtlassianConnector: both a resolvable connector and a present required field returns the instance', () => {
  const instance: ConnectorInstance = { id: 'c1', vendorId: 'atlassian', label: 'acme', fields: { email: 'e', apiToken: 't' } };
  const user: User = { id: 'edwin', name: 'Edwin', connectors: [instance] };
  const resolved = resolveAtlassianConnector('c1', user, { name: 'ticketKey', value: 'PROJ-123' });
  assert.deepEqual(resolved, { instance });
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

test('workspaceProblems: a connectorId on atlassian or repo.github is ignored entirely — never inspected, never rejected', async () => {
  const repoDir = await mkdtemp(join(tmpdir(), 'ws-git-'));
  await git('git', ['init', '-q'], { cwd: repoDir });

  const ok = await workspaceProblems({
    name: 'acme',
    repos: [{ name: 'web', path: repoDir, github: { owner: 'acme', repo: 'web', connectorId: 'c1' } }],
    atlassian: { siteUrl: 'https://acme.atlassian.net', connectorId: 'c2' },
  });
  assert.equal(ok, null);
});

test('workspaceProblems: accepts tmux/docker/remote runtimes, rejects anything else, allows unset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-rt-'));
  await git('git', ['init'], { cwd: dir });
  const base = { name: 'acme', repos: [{ name: 'web', path: dir }] } as Partial<Workspace>;
  assert.equal(await workspaceProblems(base), null);
  assert.equal(await workspaceProblems({ ...base, runtime: 'tmux' }), null);
  assert.equal(await workspaceProblems({ ...base, runtime: 'docker' }), null);
  assert.equal(await workspaceProblems({ ...base, runtime: 'remote' }), null);
  assert.match((await workspaceProblems({ ...base, runtime: 'warp' as never }))!, /runtime/);
});

// POST /workspaces/:name/verify-atlassian's two new 400-guard branches (no
// connectorId set; connectorId set but no matching connector in
// user.connectors) are NOT covered by a route-level test here. Every other
// test in this file exercises server.ts's extracted, module-level pure
// functions (workspaceProblems, buildConnectorUpdate, buildChannelsUpdate,
// redactConnector) rather than booting OrchestratorServer — this file's own
// header comment explains why (real filesystem/tmux/dispatcher side
// effects), and registerRoutes() (where these two branches live) is only
// ever invoked from start(), immediately before app.listen() — there is no
// lighter-weight route-boot harness anywhere in this package's test suite to
// match (confirmed: grepped every *.test.ts in src/ for OrchestratorServer
// construction or Fastify .inject usage — none exists). Rather than invent a
// new harness for this task alone, the two branches were verified by direct
// code inspection against the brief's specified "after" snippet (exact
// match) instead. Flagged here for visibility rather than silently omitted.

test('gitInitRequestedRepos: inits only flagged non-repo paths, leaves existing repos alone, reports unusable paths', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'nw-fresh-'));
  const existing = await mkdtemp(join(tmpdir(), 'nw-existing-'));
  await git('git', ['init'], { cwd: existing });
  assert.equal(
    await gitInitRequestedRepos([
      { name: 'a', path: fresh, initGit: true },
      { name: 'b', path: existing, initGit: true },
      { name: 'c', path: join(fresh, 'never-flagged') },
    ]),
    null,
  );
  assert.equal(await isGitRepo(fresh), true);
  assert.equal(await isGitRepo(existing), true);
  const missing = join(fresh, 'no-such-dir', 'deeper');
  assert.match((await gitInitRequestedRepos([{ name: 'x', path: missing, initGit: true }]))!, /git init failed/);
});

test('resolveTaskRuntime: per-task override wins, then workspace runtime, then server default — location mirrors the pick', () => {
  assert.deepEqual(resolveTaskRuntime('docker', { runtime: 'remote' }, 'tmux'), { runtime: 'docker', location: 'docker' });
  assert.deepEqual(resolveTaskRuntime(undefined, { runtime: 'remote' }, 'tmux'), { runtime: 'remote', location: 'remote' });
  assert.deepEqual(resolveTaskRuntime(undefined, { runtime: undefined }, 'docker'), { runtime: 'docker', location: 'docker' });
  assert.deepEqual(resolveTaskRuntime(undefined, undefined, 'tmux'), { runtime: 'tmux', location: 'local' });
});
