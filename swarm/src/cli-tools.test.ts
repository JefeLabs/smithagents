import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCliToolListings,
  emptyCliToolsFile,
  gateReason,
  inactiveDetail,
  isActive,
  loadCliToolsFile,
  saveCliToolsFile,
  sweepCliTools,
  type CliToolStatus,
  type SweepDeps,
} from './cli-tools.js';
import type { CommandRunner } from './drivers/types.js';

const status = (over: Partial<CliToolStatus> = {}): CliToolStatus => ({
  detected: true,
  authOk: true,
  enabled: true,
  detail: 'ok',
  lastCheckedAt: '2026-08-06T00:00:00.000Z',
  ...over,
});

test('isActive: truth table — ignorance never blocks, confirmed negatives do', () => {
  assert.equal(isActive(undefined), true); // never probed
  assert.equal(isActive(status()), true);
  assert.equal(isActive(status({ authOk: 'unknown' })), true); // no reliable probe
  assert.equal(isActive(status({ detected: false })), false);
  assert.equal(isActive(status({ authOk: false })), false);
  assert.equal(isActive(status({ enabled: false })), false);
});

test('inactiveDetail: empty when active, reason otherwise, toggle beats auth wording', () => {
  assert.equal(inactiveDetail(undefined), '');
  assert.equal(inactiveDetail(status()), '');
  assert.equal(inactiveDetail(status({ detected: false, detail: 'binary not found' })), 'binary not found');
  assert.equal(inactiveDetail(status({ enabled: false })), 'disabled in Settings → CLI Tools');
  assert.equal(inactiveDetail(status({ authOk: false, detail: 'not logged in' })), 'not logged in');
});

test('gateReason: empty for unknown tool (no entry) and for active tools', () => {
  const file = emptyCliToolsFile();
  file.tools.codex = status({ authOk: false, detail: 'not logged in — run `codex login`' });
  assert.equal(gateReason(file, 'claude'), ''); // no entry -> assignable
  assert.equal(gateReason(file, 'codex'), 'not logged in — run `codex login`');
});

test('load/save round-trip, 0600 file mode, and corrupt/missing files regenerate empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'nested', 'cli-tools.json');
  assert.deepEqual(await loadCliToolsFile(path), emptyCliToolsFile()); // missing
  const file = emptyCliToolsFile();
  file.tools.claude = status();
  await saveCliToolsFile(path, file);
  assert.deepEqual(await loadCliToolsFile(path), file);
  const st = await stat(path);
  assert.equal(st.mode & 0o777, 0o600);
  await writeFile(path, '{not json');
  assert.deepEqual(await loadCliToolsFile(path), emptyCliToolsFile()); // corrupt
});

test('buildCliToolListings joins the catalog with statuses; unprobed tools list as active with null status', () => {
  const engines = [
    { cli: 'claude', label: 'Claude Code', models: ['claude-opus'], warmSessions: true },
    { cli: 'codex', label: 'Codex', models: ['gpt-5'], warmSessions: true },
  ];
  const file = emptyCliToolsFile();
  file.tools.codex = status({ authOk: false, detail: 'not logged in' });
  const listings = buildCliToolListings(engines, file);
  assert.equal(listings.length, 2);
  assert.equal(listings[0]!.cli, 'claude');
  assert.equal(listings[0]!.status, null);
  assert.equal(listings[0]!.active, true);
  assert.equal(listings[1]!.active, false);
  assert.equal(listings[1]!.status?.detail, 'not logged in');
});

const fixedNow = () => '2026-08-06T12:00:00.000Z';

/** Runner scripted by argv[1] ('auth'/'login'/'--version') and argv[0] (binary). */
const scriptedRun =
  (script: Record<string, { code: number | null; stdout: string; stderr?: string }>): CommandRunner =>
  async (argv) => {
    const key = argv.join(' ');
    const hit = Object.entries(script).find(([k]) => key.includes(k));
    return hit ? { stderr: '', ...hit[1] } : { code: 127, stdout: '', stderr: 'not found' };
  };

test('sweepCliTools: detected+auth-ok tool gets a full active entry with version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'cli-tools.json');
  const deps: SweepDeps = {
    agentCommands: { claude: 'claude --dangerously-skip-permissions' },
    clis: ['claude'],
    run: scriptedRun({
      'command -v': { code: 0, stdout: '/usr/local/bin/claude\n' },
      '--version': { code: 0, stdout: '2.1.0 (Claude Code)\n' },
    }),
    resolveDriver: () => ({
      verifyAuth: async () => ({ ok: true, detail: 'logged in as edwin' }),
    }),
    now: fixedNow,
  };
  const file = await sweepCliTools(path, deps);
  assert.deepEqual(file.tools.claude, {
    detected: true,
    authOk: true,
    enabled: true,
    detail: 'logged in as edwin',
    version: '2.1.0 (Claude Code)',
    lastCheckedAt: fixedNow(),
  });
  assert.deepEqual(await loadCliToolsFile(path), file); // persisted
});

test('sweepCliTools: missing binary -> detected:false; no driver probe -> authOk unknown; enabled survives', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'cli-tools.json');
  const prior = emptyCliToolsFile();
  prior.tools.agy = status({ enabled: false }); // user toggled off earlier
  await saveCliToolsFile(path, prior);
  const deps: SweepDeps = {
    agentCommands: { agy: 'agy --dangerously-skip-permissions', ghost: 'ghost' },
    clis: ['agy', 'ghost'],
    run: scriptedRun({ 'command -v -- agy': { code: 0, stdout: '/usr/local/bin/agy\n' } }),
    resolveDriver: () => null, // no verifyAuth anywhere
    now: fixedNow,
  };
  const file = await sweepCliTools(path, deps);
  assert.equal(file.tools.agy?.detected, true);
  assert.equal(file.tools.agy?.authOk, 'unknown');
  assert.equal(file.tools.agy?.enabled, false); // preserved, not reset to true
  assert.equal(file.tools.ghost?.detected, false);
  assert.equal(isActive(file.tools.ghost), false);
});

test('sweepCliTools with `only` re-probes one tool and leaves other entries untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'cli-tools.json');
  const prior = emptyCliToolsFile();
  prior.tools.claude = status({ detail: 'stale-but-not-mine-to-touch' });
  await saveCliToolsFile(path, prior);
  const deps: SweepDeps = {
    agentCommands: { claude: 'claude', codex: 'codex --full-auto' },
    clis: ['claude', 'codex'],
    run: scriptedRun({ 'command -v -- codex': { code: 0, stdout: '/usr/local/bin/codex\n' } }),
    resolveDriver: () => ({ verifyAuth: async () => ({ ok: false, detail: 'not logged in' }) }),
    now: fixedNow,
  };
  const file = await sweepCliTools(path, deps, 'codex');
  assert.equal(file.tools.claude?.detail, 'stale-but-not-mine-to-touch'); // untouched
  assert.equal(file.tools.codex?.authOk, false);
});

test('sweepCliTools: a throwing verifyAuth lands as unknown, never rejects the sweep', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-tools-'));
  const path = join(dir, 'cli-tools.json');
  const deps: SweepDeps = {
    agentCommands: { codex: 'codex' },
    clis: ['codex'],
    run: scriptedRun({ 'command -v': { code: 0, stdout: '/usr/local/bin/codex\n' } }),
    resolveDriver: () => ({
      verifyAuth: async () => {
        throw new Error('driver bug');
      },
    }),
    now: fixedNow,
  };
  const file = await sweepCliTools(path, deps);
  assert.equal(file.tools.codex?.authOk, 'unknown');
  assert.match(file.tools.codex?.detail ?? '', /driver bug/);
});
