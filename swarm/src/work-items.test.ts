import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addCard, BOARD_TEMPLATES, BOARD_TYPE_ORDER, boardIdFor, type BoardType, createBoard,
  deleteBoardFile, loadBoards, patchCard, removeCard, saveBoard, WORKSPACE_BOARD_TYPES,
} from './work-items.js';

test('templates: seven typed column sets, ids unique and slug-shaped', () => {
  assert.deepEqual(BOARD_TEMPLATES.personal.map((c) => c.name), ['Todo', 'Doing', 'Done', 'Not Doing']);
  assert.deepEqual(BOARD_TEMPLATES.ideation.map((c) => c.name), ['Intake', 'Scoping', 'Confirm', 'Killed']);
  assert.deepEqual(BOARD_TEMPLATES.plan.map((c) => c.name), ['Spec', 'Tech design', 'Decomposed', 'Ready']);
  assert.deepEqual(BOARD_TEMPLATES.deliver.map((c) => c.name), ['Ready', 'In progress', 'Review', 'Verify', 'Merged']);
  assert.deepEqual(BOARD_TEMPLATES.release.map((c) => c.name), ['Cut', 'Regression', 'Sign-off', 'Ship', 'Rollback']);
  assert.deepEqual(BOARD_TEMPLATES.reactive.map((c) => c.name), ['Triage', 'Diagnose', 'Fix', 'Verify', 'Closed']);
  assert.deepEqual(BOARD_TEMPLATES.maintenance.map((c) => c.name), ['Triage', 'Queued', 'Doing', 'Done', "Won't do"]);
  assert.equal(Object.keys(BOARD_TEMPLATES).length, 7);
  for (const cols of Object.values(BOARD_TEMPLATES)) {
    assert.equal(new Set(cols.map((c) => c.id)).size, cols.length);
    for (const c of cols) assert.match(c.id, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test('type order puts personal last and WORKSPACE_BOARD_TYPES excludes it', () => {
  assert.deepEqual(BOARD_TYPE_ORDER, ['ideation', 'plan', 'deliver', 'release', 'reactive', 'maintenance', 'personal']);
  assert.equal(WORKSPACE_BOARD_TYPES.includes('personal' as BoardType), false);
  assert.equal(WORKSPACE_BOARD_TYPES.length, 6);
});

test('createBoard derives id from workspace+type, seeds the label, copies columns', () => {
  const b = createBoard('deliver', 'Skool Scout');
  assert.equal(b.id, 'skool-scout-deliver');
  assert.equal(b.name, 'Deliver');
  assert.equal(b.type, 'deliver');
  assert.equal(b.workspaceId, 'Skool Scout');
  assert.deepEqual(b.cards, []);
  assert.notEqual(b.columns, BOARD_TEMPLATES.deliver); // copy, not shared reference
  assert.equal(boardIdFor('Skool Scout', 'deliver'), 'skool-scout-deliver');
});

test('createBoard: personal is workspace-less with a fixed id; mismatches throw', () => {
  const p = createBoard('personal');
  assert.equal(p.id, 'personal');
  assert.equal(p.name, 'Personal');
  assert.equal(p.workspaceId, undefined);
  assert.throws(() => createBoard('personal', 'acme'), /workspace/i);
  assert.throws(() => createBoard('deliver'), /workspace/i);
  assert.throws(() => createBoard('deliver', '!!!'), /workspace/i);
});

test('assertBoard rejects a file with a missing or unknown type', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await writeFile(join(dir, 'untyped.json'), JSON.stringify({ id: 'untyped', name: 'U', columns: [], cards: [] }));
  await writeFile(join(dir, 'bogus.json'), JSON.stringify({ id: 'bogus', name: 'B', type: 'nope', columns: [], cards: [] }));
  const { boards, errors } = await loadBoards(dir);
  assert.deepEqual(boards, []);
  assert.equal(errors.length, 2);
  for (const e of errors) assert.match(e.error, /type/i);
});

test('addCard appends to the leftmost column by default and orders sequentially', () => {
  const b = createBoard('personal');
  const a = addCard(b, { title: 'first' });
  const c = addCard(b, { title: 'second' });
  assert.equal(a.columnId, b.columns[0].id);
  assert.deepEqual([a.order, c.order], [0, 1]);
  assert.ok(a.id !== c.id && a.createdAt && a.updatedAt);
  assert.throws(() => addCard(b, { title: '  ' }), /title/i);
  assert.throws(() => addCard(b, { title: 'x', columnId: 'nope' }), /column/i);
});

test('patchCard moves between columns at a target index and renumbers both columns', () => {
  const b = createBoard('personal');
  const [ready, inProgress] = [b.columns[1].id, b.columns[2].id];
  const c1 = addCard(b, { title: 'one', columnId: ready });
  const c2 = addCard(b, { title: 'two', columnId: ready });
  const c3 = addCard(b, { title: 'three', columnId: inProgress });
  patchCard(b, c1.id, { columnId: inProgress, order: 0 });
  const inCol = (col: string) => b.cards.filter((c) => c.columnId === col).sort((x, y) => x.order - y.order).map((c) => c.title);
  assert.deepEqual(inCol(inProgress), ['one', 'three']);
  assert.deepEqual(inCol(ready), ['two']);
  assert.deepEqual(b.cards.filter((c) => c.columnId === ready).map((c) => c.order), [0]);
  assert.equal(b.cards.find((c) => c.id === c3.id)?.order, 1);
  assert.ok(patchCard(b, c2.id, { title: 'renamed' }).updatedAt >= c2.createdAt);
  assert.throws(() => patchCard(b, 'ghost', { title: 'x' }), /card/i);
  assert.throws(() => patchCard(b, c2.id, { columnId: 'nope' }), /column/i);
});

test('same-column reorder via order only', () => {
  const b = createBoard('personal');
  const col = b.columns[0].id;
  const c1 = addCard(b, { title: 'a' });
  const c2 = addCard(b, { title: 'b' });
  const c3 = addCard(b, { title: 'c' });
  patchCard(b, c3.id, { order: 0 });
  const titles = b.cards.filter((c) => c.columnId === col).sort((x, y) => x.order - y.order).map((c) => c.title);
  assert.deepEqual(titles, ['c', 'a', 'b']);
  assert.deepEqual([c1, c2, c3].map(() => 1).length, 3);
});

test('stories: replaced wholesale via patchCard, cleared with null-ish, round-trips', () => {
  const b = createBoard('personal');
  const c = addCard(b, { title: 'cap' });
  patchCard(b, c.id, { stories: [{ id: 's1', text: 'user can log in', done: false }] });
  assert.equal(b.cards[0].stories?.length, 1);
  patchCard(b, c.id, { stories: [
    { id: 's1', text: 'user can log in', done: true, verifiedBy: 'manual 2026-08-07' },
    { id: 's2', text: 'session survives reload', done: false },
  ] });
  assert.deepEqual(b.cards[0].stories?.map((s) => [s.done, s.verifiedBy]), [[true, 'manual 2026-08-07'], [false, undefined]]);
});

test('save/load round-trip; malformed files land in errors without sinking the rest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  const b = createBoard('plan', 'alpha');
  addCard(b, { title: 'card' });
  await saveBoard(dir, b);
  await writeFile(join(dir, 'broken.json'), '{not json');
  await writeFile(join(dir, 'shapeless.json'), '{"id":"shapeless"}');
  const { boards, errors } = await loadBoards(dir);
  assert.deepEqual(boards.map((x) => x.id), ['alpha-plan']);
  assert.equal(boards[0].cards[0].title, 'card');
  assert.equal(errors.length, 2);
  assert.deepEqual((await readFile(join(dir, 'alpha-plan.json'), 'utf8')).endsWith('\n'), true);
  await deleteBoardFile(dir, 'alpha-plan');
  assert.deepEqual((await loadBoards(dir)).boards, []);
  await assert.rejects(saveBoard(dir, { ...b, id: '../evil' }), /id/i);
});

test('removeCard deletes and renumbers its column', () => {
  const b = createBoard('personal');
  const c1 = addCard(b, { title: 'a' });
  const c2 = addCard(b, { title: 'b' });
  removeCard(b, c1.id);
  assert.deepEqual(b.cards.map((c) => [c.title, c.order]), [['b', 0]]);
  assert.ok(c2);
  assert.throws(() => removeCard(b, 'ghost'), /card/i);
});
