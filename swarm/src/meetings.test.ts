import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingOrchestrator } from './meetings.js';
import type { ComposedAgent } from './agents.js';

const AGENTS: ComposedAgent[] = [
  { id: 'manuel', name: 'Manuel', role: 'Architect', directives: 'x', engine: { cli: 'claude', model: 'm' } },
  { id: 'octavio', name: 'Octavio', role: 'Auditor', directives: 'y', engine: { cli: 'claude', model: 'm' } },
];

function makeOrchestrator() {
  const created: string[] = [];
  const deleted: string[] = [];
  const roomService = {
    async createRoom(opts: { name: string }) { created.push(opts.name); return {}; },
    async deleteRoom(name: string) { deleted.push(name); },
  };
  const mintToken = async (identity: string, room: string, _agentIds: string[]) => `token:${identity}:${room}`;
  const orch = new MeetingOrchestrator(
    { url: 'ws://x', apiKey: 'k', apiSecret: 's' },
    AGENTS,
    { roomService, mintToken },
  );
  return { orch, created, deleted };
}

test('open(solo) creates a room and returns a human join token', async () => {
  const { orch, created } = makeOrchestrator();
  const join = await orch.open({ agent: 'Manuel' });
  assert.equal(created.length, 1);
  assert.equal(join.roomName, created[0]);
  assert.match(join.participantToken, /^token:human:/);
  const m = orch.get(join.meetingId)!;
  assert.equal(m.mode, 'solo');
  assert.deepEqual(m.agentIds, ['manuel']);
  assert.equal(m.status, 'open');
});

test('open(all) is a council of every agent', async () => {
  const { orch } = makeOrchestrator();
  const join = await orch.open({ all: true });
  const m = orch.get(join.meetingId)!;
  assert.equal(m.mode, 'council');
  assert.deepEqual(m.agentIds.sort(), ['manuel', 'octavio']);
});

test('open with an unknown agent rejects', async () => {
  const { orch } = makeOrchestrator();
  await assert.rejects(() => orch.open({ agent: 'nobody' }), /unknown agent/i);
});

test('close deletes the room and marks the meeting closed', async () => {
  const { orch, deleted } = makeOrchestrator();
  const join = await orch.open({ agent: 'manuel' });
  await orch.close(join.meetingId);
  assert.equal(deleted[0], join.roomName);
  assert.equal(orch.get(join.meetingId)!.status, 'closed');
});
