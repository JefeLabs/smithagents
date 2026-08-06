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
  type CliToolStatus,
} from './cli-tools.js';

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
