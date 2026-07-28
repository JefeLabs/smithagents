import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentUsage, isBusy, type ActiveTaskRef } from './lifecycle.js';
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
  const refs: ActiveTaskRef[] = [{ profileName: 'Wilkin' }, { profileName: 'Aurelio' }];
  const u = agentUsage(agent, [record('wilkin'), record('other')], [], refs);
  assert.deepEqual(u, { warmSessions: 1, activeTasks: 1 });
});

test('no records, no tasks -> zero usage', () => {
  assert.deepEqual(agentUsage(agent, [], [], []), { warmSessions: 0, activeTasks: 0 });
});

test('busy means a LIVE session or task, not a historical record', () => {
  assert.equal(isBusy([], [], agent), false);
  assert.equal(isBusy(['wilkin'], [], agent), true);
  assert.equal(isBusy([], [{ profileName: 'Wilkin' }], agent), true);
});

test('task matching prefers the stable composed-agent id over the display name', () => {
  // A task dispatched with the id survives a rename: profileName is stale
  // ("Wilkin", captured at dispatch) but composedAgentId still points at
  // this agent's current record.
  const renamed: ComposedAgent = { ...agent, name: 'Wilkin the Second' };
  const refs: ActiveTaskRef[] = [{ composedAgentId: 'wilkin', profileName: 'Wilkin' }];
  assert.equal(isBusy([], refs, renamed), true);
  assert.deepEqual(agentUsage(renamed, [], [], refs), { warmSessions: 0, activeTasks: 1 });
});

test('a composedAgentId that points elsewhere does not match on a coincidental name', () => {
  // Same display name, different agent — id must win so a rename can never
  // borrow another agent's busy-lock or usage count.
  const other: ComposedAgent = { id: 'someone-else', name: 'Wilkin', role: 'r', directives: 'd', engine: { cli: 'claude', model: 'claude-sonnet' } };
  const refs: ActiveTaskRef[] = [{ composedAgentId: 'wilkin', profileName: 'Wilkin' }];
  assert.equal(isBusy([], refs, other), false);
  assert.deepEqual(agentUsage(other, [], [], refs), { warmSessions: 0, activeTasks: 0 });
});

test('a task with no composedAgentId (pre-existing manifest) still matches by name', () => {
  const refs: ActiveTaskRef[] = [{ profileName: 'Wilkin' }];
  assert.equal(isBusy([], refs, agent), true);
  assert.deepEqual(agentUsage(agent, [], [], refs), { warmSessions: 0, activeTasks: 1 });
});
