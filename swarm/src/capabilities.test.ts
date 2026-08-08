import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyStoryToggles, createCapability, deleteCapabilityFile, ensurePersonalBoard, ensureWorkspaceBoards,
  loadCapabilities, patchCapability, renderSpecSkeleton, repointSliceCardRef, resyncLinkedCards, saveCapability,
  sendSliceToBoard, sliceStories, slugify, unlinkCapabilityCards, unlinkSliceCard,
} from './capabilities.js';
import { boardIdFor, loadBoards, resolveExit, routeCard, saveBoard } from './work-items.js';

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
  assert.equal(cap.id, 'skoolscout-school-feature-set');
  assert.equal(cap.name, 'School Feature Set');
  assert.equal(cap.workspaceId, 'skoolscout');
  assert.deepEqual([cap.activities, cap.stories, cap.slices], [[], [], []]);
  assert.ok(cap.createdAt && cap.updatedAt);
});

test('createCapability: id is workspace-namespaced — two workspaces can share a name', () => {
  const a = createCapability('Onboarding', 'skoolscout');
  const b = createCapability('Onboarding', 'smithagents');
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, 'skoolscout-onboarding');
  assert.equal(b.id, 'smithagents-onboarding');
  assert.equal(a.name, 'Onboarding');
  assert.equal(b.name, 'Onboarding');
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
  assert.deepEqual(capabilities.map((c) => c.id), ['skoolscout-school-feature-set']);
  assert.equal(errors.length, 1);
  await deleteCapabilityFile(dir, cap.id);
  assert.deepEqual((await loadCapabilities(dir)).capabilities, []);
  await assert.rejects(saveCapability(dir, { ...cap, id: '../evil' }), /id/i);
});

test('ensureWorkspaceBoards: creates the standing three once, idempotent, never release/reactive/maintenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensureWorkspaceBoards(dir, 'skoolscout');
  await ensureWorkspaceBoards(dir, 'skoolscout');
  const { boards } = await loadBoards(dir);
  assert.deepEqual(boards.map((b) => [b.id, b.workspaceId]).sort(), [
    ['skoolscout-deliver', 'skoolscout'],
    ['skoolscout-ideation', 'skoolscout'],
    ['skoolscout-plan', 'skoolscout'],
  ]);
  assert.deepEqual(boards.find((b) => b.id === 'skoolscout-plan')?.columns.map((c) => c.id)[0], 'spec');
});

test('ensurePersonalBoard creates exactly one workspace-less board and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensurePersonalBoard(dir);
  await ensurePersonalBoard(dir);
  const { boards } = await loadBoards(dir);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].id, 'personal');
  assert.equal(boards[0].workspaceId, undefined);
  assert.deepEqual(boards[0].columns.map((c) => c.name), ['Todo', 'Doing', 'Done', 'Not Doing']);
});

test('sendSliceToBoard: leftmost card, story copies, capabilityRef', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensureWorkspaceBoards(dir, 'skoolscout');
  const { boards } = await loadBoards(dir);
  const board = boards.find((b) => b.id === boardIdFor('skoolscout', 'plan'));
  const cap = fixture();
  const card = sendSliceToBoard(cap, cap.slices[0], board!);
  assert.equal(card.title, 'tour scheduling v1');
  assert.equal(card.columnId, board!.columns[0].id);
  assert.deepEqual(card.capabilityRef, { capabilityId: 'skoolscout-school-feature-set', sliceId: 'sl1' });
  assert.deepEqual(card.stories?.map((s) => s.text), ['create tour time slots', 'edit tour time slots']);
  assert.notEqual(card.stories, cap.stories); // copies, not shared references
});

test('resyncLinkedCards: editing a slice after sending refreshes both linked cards, not just the map (C1)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensureWorkspaceBoards(dir, 'skoolscout');
  const { boards } = await loadBoards(dir);
  const capBoard = boards.find((b) => b.id === boardIdFor('skoolscout', 'plan'))!;
  const deliveryBoard = boards.find((b) => b.id === boardIdFor('skoolscout', 'deliver'))!;
  const cap = fixture();
  const capCard = sendSliceToBoard(cap, cap.slices[0], capBoard);
  await saveBoard(dir, capBoard);
  const deliveryCard = sendSliceToBoard(cap, cap.slices[0], deliveryBoard);
  await saveBoard(dir, deliveryBoard);
  cap.slices[0].capCardRef = { boardId: capBoard.id, cardId: capCard.id };
  cap.slices[0].deliveryCardRef = { boardId: deliveryBoard.id, cardId: deliveryCard.id };

  // Edit the slice in the map: drop s2, leaving only s1 — same edit that
  // used to brick applyStoryToggles on both cards forever.
  patchCapability(cap, { slices: [{ ...cap.slices[0], storyIds: ['s1'] }] });
  await resyncLinkedCards(dir, cap);

  const { boards: after } = await loadBoards(dir);
  const afterCapCard = after.find((b) => b.id === capBoard.id)!.cards.find((c) => c.id === capCard.id)!;
  const afterDeliveryCard = after.find((b) => b.id === deliveryBoard.id)!.cards.find((c) => c.id === deliveryCard.id)!;
  assert.deepEqual(afterCapCard.stories?.map((s) => s.id), ['s1']);
  assert.deepEqual(afterDeliveryCard.stories?.map((s) => s.id), ['s1']);
  assert.notEqual(afterCapCard.stories, afterDeliveryCard.stories); // independent copies, not shared references
  // What used to 400 forever now succeeds against the refreshed copy.
  assert.doesNotThrow(() => applyStoryToggles(cap, 'sl1', [{ id: 's1', text: 'create tour time slots', done: true }]));

  // Unassigning every remaining story leaves an empty checklist, not a stale one.
  patchCapability(cap, { slices: [{ ...cap.slices[0], storyIds: [] }] });
  await resyncLinkedCards(dir, cap);
  const { boards: emptied } = await loadBoards(dir);
  const emptiedCard = emptied.find((b) => b.id === capBoard.id)!.cards.find((c) => c.id === capCard.id)!;
  assert.deepEqual(emptiedCard.stories, []);
});

test('unlinkSliceCard: clears only the matching ref (I1); no-op for an unrelated card or slice', () => {
  const cap = fixture();
  cap.slices[0].capCardRef = { boardId: 'b1', cardId: 'c1' };
  cap.slices[0].deliveryCardRef = { boardId: 'b2', cardId: 'c2' };
  assert.equal(unlinkSliceCard(cap, 'sl1', 'c1'), true);
  assert.equal(cap.slices[0].capCardRef, undefined);
  assert.deepEqual(cap.slices[0].deliveryCardRef, { boardId: 'b2', cardId: 'c2' });
  assert.equal(unlinkSliceCard(cap, 'sl1', 'ghost-card'), false);
  assert.equal(unlinkSliceCard(cap, 'ghost-slice', 'c2'), false);
});

test('a ROUTED linked card still resyncs and still unlinks — the ref boardId is a hint, the cardId the key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensureWorkspaceBoards(dir, 'skoolscout');
  const { boards } = await loadBoards(dir);
  const plan = boards.find((b) => b.id === boardIdFor('skoolscout', 'plan'))!;
  const deliver = boards.find((b) => b.id === boardIdFor('skoolscout', 'deliver'))!;
  const cap = fixture();
  const card = sendSliceToBoard(cap, cap.slices[0], plan);
  cap.slices[0].capCardRef = { boardId: plan.id, cardId: card.id };

  // The spec's headline flow, not an edge case: drag spec → ready, then
  // "Send to deliver". The card changes board file; the ref does not.
  card.columnId = 'ready';
  const routed = routeCard(plan, deliver, card.id, resolveExit(plan, 'ready', 'deliver')!, new Date().toISOString());
  await saveBoard(dir, deliver);
  await saveBoard(dir, plan);
  assert.deepEqual(routed.card.capabilityRef, { capabilityId: cap.id, sliceId: 'sl1' });
  assert.equal(cap.slices[0].capCardRef!.boardId, plan.id, 'the stale ref is the precondition under test');

  // A map edit must still reach the card on its new board.
  patchCapability(cap, { slices: [{ ...cap.slices[0], storyIds: ['s1'] }] });
  await resyncLinkedCards(dir, cap);
  const { boards: after } = await loadBoards(dir);
  const onDeliver = after.find((b) => b.id === deliver.id)!.cards.find((c) => c.id === card.id)!;
  assert.deepEqual(onDeliver.stories?.map((s) => s.id), ['s1']);
  assert.equal(after.find((b) => b.id === plan.id)!.cards.length, 0);

  // And deleting the capability must still unlink it: a card left `linked`
  // to a capability that no longer exists is toggle-only forever with no UI
  // to clear it.
  assert.deepEqual(unlinkCapabilityCards(after, cap).map((b) => b.id), [deliver.id]);
  assert.equal(after.find((b) => b.id === deliver.id)!.cards.find((c) => c.id === card.id)!.capabilityRef, undefined);
});

test('repointSliceCardRef: retargets whichever ref holds the card, leaves the sibling and a re-send 409 alone', () => {
  const cap = fixture();
  cap.slices[0].capCardRef = { boardId: 'acme-plan', cardId: 'c1' };
  cap.slices[0].deliveryCardRef = { boardId: 'acme-deliver', cardId: 'c2' };

  assert.equal(repointSliceCardRef(cap, 'c1', 'acme-deliver'), true);
  assert.deepEqual(cap.slices[0].capCardRef, { boardId: 'acme-deliver', cardId: 'c1' });
  assert.deepEqual(cap.slices[0].deliveryCardRef, { boardId: 'acme-deliver', cardId: 'c2' });
  // The ref is still SET, so re-sending this slice still 409s rather than
  // minting a duplicate card for it.
  assert.ok(cap.slices[0].capCardRef);

  assert.equal(repointSliceCardRef(cap, 'c1', 'acme-deliver'), false, 'already there — no write, no updatedAt bump');
  assert.equal(repointSliceCardRef(cap, 'ghost-card', 'acme-plan'), false);
});
