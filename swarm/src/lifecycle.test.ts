import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentUsage, isBusy } from './lifecycle.js';
import type { ComposedAgent } from './agents.js';
import type { SessionRecord } from './session-store.js';

const agent: ComposedAgent = {
  id: 'wilkin', name: 'Wilkin', role: 'r', directives: 'd',
  engine: { cli: 'claude', model: 'claude-sonnet' },
};
const record = (agentId: string): SessionRecord => ({
  id: 's1', agentId, agentName: 'Wilkin', tool: 'claude', profileHash: 'h',
  cwd: '/tmp', branch: 'main', tmuxSession: 'smith-warm-1', createdAt: 'now', turns: 0,
});

test('usage counts stored warm-session records and matching task profiles', () => {
  const u = agentUsage(agent, [record('wilkin'), record('other')], [], ['Wilkin', 'Aurelio']);
  assert.deepEqual(u, { warmSessions: 1, activeTasks: 1 });
});

test('no records, no tasks -> zero usage', () => {
  assert.deepEqual(agentUsage(agent, [], [], []), { warmSessions: 0, activeTasks: 0 });
});

test('busy means a LIVE session or task, not a historical record', () => {
  assert.equal(isBusy([], [], agent), false);
  assert.equal(isBusy(['wilkin'], [], agent), true);
  assert.equal(isBusy([], ['Wilkin'], agent), true);
});
