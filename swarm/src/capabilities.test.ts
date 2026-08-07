import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyStoryToggles, createCapability, deleteCapabilityFile, ensureWorkspaceBoards, loadCapabilities,
  patchCapability, renderSpecSkeleton, saveCapability, sendSliceToBoard, sliceStories, slugify, workspaceBoardId,
} from './capabilities.js';
import { loadBoards } from './work-items.js';

function fixture() {
  const cap = createCapability('School Feature Set', 'skoolscout');
  const [a1s1, a1s2] = ['st-tours', 'st-analyze'];
  cap.activities = [{ id: 'act-tours', name: 'Manage Candidate Tours', order: 0, steps: [
    { id: a1s1, name: 'Define Tour Schedule', order: 0 },
    { id: a1s2, name: 'Analyze Tour Data', order: 1 },
  ] }];
  cap.stories = [
    { id: 's1', stepId: a1s1, order: 0, text: 'create tour time slots', done: false },
    { id: 's2', stepId: a1s1, order: 1, text: 'edit tour time slots', done: false },
    { id: 's3', stepId: a1s2, order: 0, text: 'view tour analytics', done: false },
  ];
  cap.slices = [{ id: 'sl1', name: 'tour scheduling v1', order: 0, storyIds: ['s1', 's2'] }];
  return cap;
}

test('slugify + createCapability shape', () => {
  assert.equal(slugify('School Feature Set!'), 'school-feature-set');
  assert.throws(() => slugify('!!!'), /name/i);
  const cap = createCapability('School Feature Set', 'skoolscout');
  assert.equal(cap.id, 'school-feature-set');
  assert.equal(cap.workspaceId, 'skoolscout');
  assert.deepEqual([cap.activities, cap.stories, cap.slices], [[], [], []]);
  assert.ok(cap.createdAt && cap.updatedAt);
});

test('patchCapability: wholesale replace with validation', () => {
  const cap = fixture();
  const before = cap.updatedAt;
  patchCapability(cap, { name: 'Renamed' });
  assert.equal(cap.name, 'Renamed');
  assert.ok(cap.updatedAt >= before);
  assert.throws(() => patchCapability(cap, { stories: [{ id: 'x', stepId: 'ghost', order: 0, text: 't', done: false }] }), /step/i);
  assert.throws(() => patchCapability(cap, { slices: [
    { id: 'a', name: 'a', order: 0, storyIds: ['s1'] },
    { id: 'b', name: 'b', order: 1, storyIds: ['s1'] },
  ] }), /disjoint/i);
  assert.throws(() => patchCapability(cap, { slices: [{ id: 'a', name: 'a', order: 0, storyIds: ['ghost'] }] }), /story/i);
});

test('applyStoryToggles: toggles apply to the capability; text/count drift throws', () => {
  const cap = fixture();
  const out = applyStoryToggles(cap, 'sl1', [
    { id: 's1', text: 'create tour time slots', done: true, verifiedBy: 'manual 2026-08-07' },
    { id: 's2', text: 'edit tour time slots', done: false },
  ]);
  assert.equal(cap.stories.find((s) => s.id === 's1')?.done, true);
  assert.equal(cap.stories.find((s) => s.id === 's1')?.verifiedBy, 'manual 2026-08-07');
  assert.deepEqual(out.map((s) => s.id), ['s1', 's2']);
  assert.throws(() => applyStoryToggles(cap, 'sl1', [{ id: 's1', text: 'REWRITTEN', done: true }]), /toggle-only|text/i);
  assert.throws(() => applyStoryToggles(cap, 'sl1', [{ id: 's1', text: 'create tour time slots', done: true }]), /count|missing/i);
  assert.throws(() => applyStoryToggles(cap, 'ghost', []), /slice/i);
  assert.throws(() => applyStoryToggles(cap, 'sl1', [
    { id: 's1', text: 'create tour time slots', done: true },
    { id: 's1', text: 'create tour time slots', done: false },
  ]), /duplicate|toggle-only/i);
});

test('renderSpecSkeleton: title, date, draft status, one checkbox per story', () => {
  const cap = fixture();
  const md = renderSpecSkeleton('tour scheduling v1', sliceStories(cap, 'sl1'), '2026-08-06');
  assert.match(md, /^# tour scheduling v1 — design\n/);
  assert.match(md, /\nDate: 2026-08-06\nStatus: draft\n/);
  assert.match(md, /\n## Goal\n/);
  assert.match(md, /\n## Acceptance criteria\n\n- \[ \] create tour time slots\n- \[ \] edit tour time slots\n$/);
});

test('store round-trip + malformed isolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'caps-'));
  const cap = fixture();
  await saveCapability(dir, cap);
  await writeFile(join(dir, 'broken.json'), '{nope');
  const { capabilities, errors } = await loadCapabilities(dir);
  assert.deepEqual(capabilities.map((c) => c.id), ['school-feature-set']);
  assert.equal(errors.length, 1);
  await deleteCapabilityFile(dir, cap.id);
  assert.deepEqual((await loadCapabilities(dir)).capabilities, []);
  await assert.rejects(saveCapability(dir, { ...cap, id: '../evil' }), /id/i);
});

test('workspaceBoardId: generates board ids consistently', () => {
  assert.equal(workspaceBoardId('SkoolScout', 'capabilities'), 'skoolscout-capabilities');
  assert.equal(workspaceBoardId('SkoolScout', 'delivery'), 'skoolscout-delivery');
});

test('ensureWorkspaceBoards: creates the pair once, idempotent, never maintenance/support', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensureWorkspaceBoards(dir, 'skoolscout');
  await ensureWorkspaceBoards(dir, 'skoolscout');
  const { boards } = await loadBoards(dir);
  assert.deepEqual(boards.map((b) => [b.id, b.workspaceId]).sort(), [
    ['skoolscout-capabilities', 'skoolscout'],
    ['skoolscout-delivery', 'skoolscout'],
  ]);
  assert.deepEqual(boards.find((b) => b.id === 'skoolscout-capabilities')?.columns.map((c) => c.id)[0], 'capability');
});

test('sendSliceToBoard: leftmost card, story copies, capabilityRef', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensureWorkspaceBoards(dir, 'skoolscout');
  const { boards } = await loadBoards(dir);
  const board = boards.find((b) => b.id === 'skoolscout-capabilities');
  const cap = fixture();
  const card = sendSliceToBoard(cap, cap.slices[0], board!);
  assert.equal(card.title, 'tour scheduling v1');
  assert.equal(card.columnId, board!.columns[0].id);
  assert.deepEqual(card.capabilityRef, { capabilityId: 'school-feature-set', sliceId: 'sl1' });
  assert.deepEqual(card.stories?.map((s) => s.text), ['create tour time slots', 'edit tour time slots']);
  assert.notEqual(card.stories, cap.stories); // copies, not shared references
});
