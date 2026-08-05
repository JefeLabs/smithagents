import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeDriver, encodeProjectDir } from './claude.js';
import { SessionParseError } from './errors.js';

const driver = new ClaudeDriver('/tmp/fake-claude-home');

// Fixture mirrors the real on-disk format (sampled 2026-07-26): metadata
// lines, a user turn, a mid-turn tool_use assistant entry, a sidechain
// entry, and the terminal assistant entry.
const FIXTURE = [
  JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the widget', sessionId: 's-1' }),
  JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 's-1' }),
  JSON.stringify({
    type: 'user',
    timestamp: '2026-07-26T10:00:00.000Z',
    uuid: 'u-1',
    message: { role: 'user', content: 'please fix the widget' },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-26T10:00:05.000Z',
    uuid: 'a-1',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Looking at the widget now.' }, { type: 'tool_use', id: 't1', name: 'read' }],
      stop_reason: 'tool_use',
    },
  }),
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    timestamp: '2026-07-26T10:00:06.000Z',
    uuid: 'side-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }], stop_reason: 'end_turn' },
  }),
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-26T10:00:09.000Z',
    uuid: 'a-2',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed — the widget renders.' }], stop_reason: 'end_turn' },
  }),
].join('\n');

test('encodeProjectDir replaces every non-alphanumeric with a dash', () => {
  assert.equal(encodeProjectDir('/Users/e/dev/my.repo'), '-Users-e-dev-my-repo');
});

test('parse normalizes conversation lines, skipping metadata and sidechains', () => {
  const messages = driver.parseSessionFile(FIXTURE);
  assert.deepEqual(
    messages.map((m) => [m.role, m.text, m.stopReason ?? null]),
    [
      ['user', 'please fix the widget', null],
      ['assistant', 'Looking at the widget now.', 'tool_use'],
      ['assistant', 'Fixed — the widget renders.', 'end_turn'],
    ],
  );
});

test('malformed line fails loud with the offending excerpt', () => {
  assert.throws(
    () => driver.parseSessionFile('{"type":"user", TRUNCATED'),
    (err: unknown) => err instanceof SessionParseError && /TRUNCATED/.test((err as Error).message),
  );
});

test('turn completion: terminal stop_reason after the send marker, never tool_use', () => {
  const messages = driver.parseSessionFile(FIXTURE);
  // Send happened at 10:00:01 — the 10:00:09 end_turn completes it.
  assert.equal(driver.isTurnComplete(messages, '2026-07-26T10:00:01.000Z'), true);
  // tool_use alone (messages before the final entry) is mid-turn.
  assert.equal(driver.isTurnComplete(messages.slice(0, 2), '2026-07-26T10:00:01.000Z'), false);
  // A terminal entry from before the send does not complete the new turn.
  assert.equal(driver.isTurnComplete(messages, '2026-07-26T10:00:30.000Z'), false);
});

test('sessionDir is rooted in the configured claude home', () => {
  assert.equal(driver.sessionDir('/work/x'), '/tmp/fake-claude-home/projects/-work-x');
});

test('the agent definition determines the launched process: model flag on both paths', () => {
  // A definition set to opus and one set to haiku must NOT produce the same
  // command — that was the bug this closes.
  assert.equal(driver.interactiveCommand('claude --dsp', 'claude-opus'), 'claude --dsp --model claude-opus');
  assert.equal(driver.interactiveCommand('claude --dsp', 'claude-haiku'), 'claude --dsp --model claude-haiku');
  assert.match(driver.taskCommand('claude --dsp', 'do it', 'claude-opus'), /--model claude-opus .*--print 'do it'|--model claude-opus/);
});

test('no model, or "default", emits no flag rather than an invalid one', () => {
  assert.equal(driver.interactiveCommand('claude'), 'claude');
  assert.equal(driver.interactiveCommand('claude', '  '), 'claude');
  assert.equal(driver.interactiveCommand('claude', 'default'), 'claude');
});

test('materialize: without atlassian config, only CLAUDE.md is written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mat-'));
  try {
    const testDriver = new ClaudeDriver();
    const written = await testDriver.materialize({ name: 'Wilkin', role: 'dev', directives: 'ship it' }, dir);
    assert.deepEqual(written, ['CLAUDE.md']);
    await assert.rejects(() => readFile(join(dir, '.mcp.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('materialize: with atlassian config, also writes .mcp.json referencing env placeholders, never a literal secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mat-'));
  try {
    const testDriver = new ClaudeDriver();
    const written = await testDriver.materialize(
      { name: 'Wilkin', role: 'dev', directives: 'ship it' },
      dir,
      { siteUrl: 'https://acme.atlassian.net', jiraProjectKeys: ['ACME'] },
    );
    assert.deepEqual(written.sort(), ['.mcp.json', 'CLAUDE.md']);
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers.atlassian.env.JIRA_URL, 'https://acme.atlassian.net');
    assert.equal(mcp.mcpServers.atlassian.env.JIRA_API_TOKEN, '${SMITH_ATLASSIAN_TOKEN}');
    assert.doesNotMatch(JSON.stringify(mcp), /secret|tok-[a-z0-9]+/); // no literal credential ever lands here
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
