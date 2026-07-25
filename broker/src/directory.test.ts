import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentDirectory } from './directory.ts';
import type { RegistryAgent } from './swarm-client.ts';

const AGENTS: RegistryAgent[] = [
  { id: 'manuel', name: 'Manuel', role: 'research lead', directives: 'd1', engine: { cli: 'claude', model: 'claude-sonnet-5' } },
  { id: 'octavio', name: 'Octavio', role: 'builder', directives: 'd2', engine: { cli: 'claude', model: 'claude-sonnet-5' } },
];

test('seed + resolve by id or name, case-insensitive', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  assert.equal(d.resolve('OCTAVIO')?.id, 'octavio');
  assert.equal(d.resolve('Manuel')?.id, 'manuel');
  assert.equal(d.resolve('nobody'), undefined);
});

test('bindTask + task:dispatched -> busy; task:completed -> idle again', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  d.bindTask('octavio', { taskId: 't-1', summary: 'refactor auth', swarmName: 'bold-falcon' });
  d.onEvent({ type: 'task:dispatched', taskId: 't-1', sessionName: 'task-t-1' });
  assert.equal(d.snapshot().find((p) => p.agent.id === 'octavio')?.status, 'busy');
  assert.equal(d.findByTask('t-1')?.agent.id, 'octavio');
  d.onEvent({ type: 'task:completed', taskId: 't-1', result: {} });
  assert.equal(d.snapshot().find((p) => p.agent.id === 'octavio')?.status, 'idle');
  assert.equal(d.findByTask('t-1'), undefined);
});

test('events for unknown tasks are ignored', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  d.onEvent({ type: 'task:failed', taskId: 'ghost', result: {} });
  assert.ok(d.snapshot().every((p) => p.status === 'idle'));
});

test('setMeeting marks membership; busy survives meeting flag; clearMeeting restores', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  d.bindTask('octavio', { taskId: 't-2' });
  d.onEvent({ type: 'task:dispatched', taskId: 't-2', sessionName: 's' });
  d.setMeeting(['manuel']);
  assert.equal(d.snapshot().find((p) => p.agent.id === 'manuel')?.status, 'in-meeting');
  assert.equal(d.snapshot().find((p) => p.agent.id === 'octavio')?.status, 'busy');
  d.clearMeeting();
  assert.equal(d.snapshot().find((p) => p.agent.id === 'manuel')?.status, 'idle');
});

test('describeForPrompt lists every agent with role and status', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  d.bindTask('octavio', { taskId: 't-3', summary: 'ship feature' });
  d.onEvent({ type: 'task:dispatched', taskId: 't-3', sessionName: 's' });
  const text = d.describeForPrompt();
  assert.match(text, /Manuel \(research lead\) — idle/);
  assert.match(text, /Octavio \(builder\) — busy: ship feature/);
});
