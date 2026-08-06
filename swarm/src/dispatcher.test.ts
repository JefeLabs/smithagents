import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from './dispatcher.js';
import type { TaskManifest, OrchestratorConfig } from './types.js';
import { loadConfig } from './config.js';
import { emptyCliToolsFile, saveCliToolsFile } from './cli-tools.js';
import { ToolLaunchError } from './drivers/errors.js';

// A binary guaranteed not to resolve on PATH, so refreshCliTool's re-probe
// (fired fire-and-forget by both the gate and the catch block) fails fast on
// detection instead of hanging or touching a real installed CLI.
const NO_SUCH_BINARY: Record<TaskManifest['agent'], string> = {
  agy: 'definitely-not-a-real-binary-xyz',
  claude: 'definitely-not-a-real-binary-xyz',
  codex: 'definitely-not-a-real-binary-xyz',
  opencode: 'definitely-not-a-real-binary-xyz',
  copilot: 'definitely-not-a-real-binary-xyz',
};

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

test('resolveConnections: surfaces the matched workspace runtime; unmatched or unset stays undefined', async () => {
  const { root, repoPath } = await fixture();
  const dispatcher = new Dispatcher({} as OrchestratorConfig);
  const unset = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(unset.workspaceRuntime, undefined);
  await writeFile(
    join(root, '.smith/workspaces/acme.json'),
    JSON.stringify({ name: 'acme', repos: [{ name: 'web', path: repoPath }], runtime: 'docker' }),
  );
  const pinned = await dispatcher.resolveConnections({ context: { repoPath } } as TaskManifest, root);
  assert.equal(pinned.workspaceRuntime, 'docker');
  const nowhere = await dispatcher.resolveConnections({ context: { repoPath: '/nope' } } as TaskManifest, root);
  assert.equal(nowhere.workspaceRuntime, undefined);
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

// ---------------------------------------------------------------------------
// dispatch(): CLI tool registry gate — the first await in dispatch(), before
// resolveConnections and before the try block, so a confirmed negative blocks
// with nothing else (git, tmux, worktrees) touched.
// ---------------------------------------------------------------------------

test('dispatch: rejects with a subscription-inactive ToolLaunchError when the registry has a confirmed negative for the manifest agent', async () => {
  const smithRoot = await mkdtemp(join(tmpdir(), 'dispatch-gate-'));
  const file = emptyCliToolsFile();
  file.tools.claude = {
    detected: true,
    authOk: false,
    enabled: true,
    detail: 'not logged in — run `claude /login`',
    lastCheckedAt: '2026-08-06T00:00:00.000Z',
  };
  await saveCliToolsFile(join(smithRoot, 'cli-tools.json'), file);

  const config = loadConfig({ smithRoot, agentCommands: NO_SUCH_BINARY });
  const dispatcher = new Dispatcher(config);
  const manifest: TaskManifest = {
    taskId: 'gate-blocked-task',
    prompt: 'irrelevant — the gate blocks before this matters',
    context: { files: [], repository: 'https://github.com/acme/repo', branch: 'main' },
    agent: 'claude',
    createdAt: new Date().toISOString(),
    priority: 'normal',
  };

  await assert.rejects(
    () => dispatcher.dispatch(manifest),
    (err: unknown) => {
      assert.ok(err instanceof ToolLaunchError);
      assert.match((err as Error).message, /subscription-inactive: not logged in/);
      return true;
    },
  );
});

test('dispatch: with no cli-tools.json present, the gate does not block — dispatch proceeds past it (any later failure is unrelated to the gate)', async () => {
  const smithRoot = await mkdtemp(join(tmpdir(), 'dispatch-gate-'));
  // Deliberately not a git repo, so prepareWorktree fails fast right after the
  // gate — proof dispatch got past the gate without a real worktree/session.
  const fakeRepoPath = join(smithRoot, 'fake-repo');
  await mkdir(fakeRepoPath, { recursive: true });

  const config = loadConfig({ smithRoot, agentCommands: NO_SUCH_BINARY });
  const dispatcher = new Dispatcher(config);
  const manifest: TaskManifest = {
    taskId: 'gate-fail-open-task',
    prompt: 'irrelevant',
    context: { files: [], repository: 'https://github.com/acme/repo', branch: 'main', repoPath: fakeRepoPath },
    agent: 'claude',
    createdAt: new Date().toISOString(),
    priority: 'normal',
  };

  await assert.rejects(
    () => dispatcher.dispatch(manifest),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch((err as Error).message, /subscription-inactive/);
      return true;
    },
  );
});
