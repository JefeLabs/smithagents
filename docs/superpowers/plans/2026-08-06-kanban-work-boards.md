# Kanban Work Boards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal kanban task manager in the control-plane — multiple boards with data-driven columns, drag = the user's status change only, optional explicit agent delegation per card, optional Jira link/import/push via the existing Atlassian connector.

**Architecture:** The swarm owns persistence (`.smith/work/<boardId>.json`, one file per board) and all Jira calls (beside the connector registry); it also patches a card's delegation state itself when a task carrying `workCardRef` completes, so board memory is restart-proof. The broker proxies `/work/*`, owns the one dispatch route (`POST /work/delegate`, reusing the meeting delegation path via a `dispatchWork` refactor), and relays a `board-updated` WS frame when an enriched task event names a board. The board is a third stage mode beside VoiceStage/WorkStage, reusing AgentRoster's dnd-kit patterns.

**Tech Stack:** Fastify (swarm), raw node http (broker text channel), React 19 + @dnd-kit (control-plane), node:test via `node --import tsx --test` (swarm/broker), Vitest + Testing Library (control-plane).

**Spec:** `docs/superpowers/specs/2026-08-06-kanban-work-boards-design.md`

**Spec deltas (deliberate, decided at plan time):**
1. `WorkBoard.jira` gains `siteUrl: string` — the Jira base URL was implicit in the spec (workspaces carry it, boards didn't); import/push need it on the board.
2. Spec §2 said the **broker** patches a completed card. Instead the **swarm** patches its own store at task completion (it holds the manifest's `workCardRef` and the store) and adds `workCardRef` to the broadcast `task:completed|failed` events; the broker only relays the `board-updated` frame. Same user-visible behavior, restart-proof, no broker-side taskId→card map.

**Spec addendum (stories, added to the spec 2026-08-06 after this plan's first commit):** cards carry an acceptance-criteria checklist `stories?: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>` — authored by hand in v1, replaced wholesale via the card PATCH (same convention as columns), edited in the card sheet as a checklist (add/edit/remove/toggle-done with optional `verifiedBy`). Stories are NEVER a column. Tasks 1, 5, and 7 carry the stories steps.

## Global Constraints

- Swarm tests NEVER construct `OrchestratorServer` or use Fastify `.inject` — extract logic into exported, unit-tested helpers; route bodies stay thin.
- Broker route tests use the `channelWith(...)` harness in `broker/src/text-channel.test.ts`.
- Import suffixes: swarm `.js`, broker `.ts`, control-plane extensionless.
- NO biome on swarm/broker files (no config there — it reformats whole files); hand-match 2-space/single-quote house style. Control-plane biome IS run (`npx biome check --write src/`).
- Test commands: `cd swarm && npm test` (known baseline: `src/agent-sessions.test.ts` turn_timeout flakes may appear — 2 failures there are environment noise, anything else is real), `cd broker && npm test` (no known failures), `cd control-plane && npx tsc --noEmit && npm test`.
- Board ids match `/^[a-z0-9][a-z0-9-]{0,63}$/`; card ids are `crypto.randomUUID()`.
- Drag NEVER dispatches; execution state NEVER moves a card between columns.
- Jira push is best-effort: failure sets `jira.lastPushError`, never fails the PATCH.
- The control-plane hardcodes `const BASE = "127.0.0.1:7790"` per file (precedent: AddAgentModal.tsx).
- Commit messages: conventional commits with package scope.
- Never stage `.smith/*` runtime files or `control-plane/package-lock.json`.

## File Structure

| File | Responsibility |
|---|---|
| `swarm/src/work-items.ts` (create) | Board/card types, templates, load/save/validate, CRUD + move helpers |
| `swarm/src/work-items.test.ts` (create) | Unit tests for the above |
| `swarm/src/jira-sync.ts` (create) | Jira search/transition HTTP client (injectable fetch) + pure import/push helpers |
| `swarm/src/jira-sync.test.ts` (create) | Unit tests with mocked fetch |
| `swarm/src/server.ts` (modify) | `/work/*` routes, reset archival, completion-hook patch + event enrichment |
| `broker/src/swarm-client.ts` (modify) | Generic `work()` passthrough + `SwarmEvent` gains `workCardRef` |
| `broker/src/broker.ts` (modify) | Extract `dispatchWork()` from the delegate executor |
| `broker/src/broker.test.ts` (modify) | dispatchWork tests |
| `broker/src/text-channel.ts` (modify) | `/work/*` proxy + `POST /work/delegate` + `board-updated` frame type |
| `broker/src/text-channel.test.ts` (modify) | Route tests |
| `broker/src/main.ts` (modify) | Wire work handlers; relay `board-updated` on enriched events |
| `control-plane/src/hooks/useBrokerChat.ts` (modify) | `board-updated` frame → `lastBoardUpdate` state |
| `control-plane/src/organisms/BoardStage.tsx` (create) | Stage: switcher, columns, dnd, data fetching |
| `control-plane/src/molecules/BoardCard.tsx` (create) | Card face (title, Jira chip, delegation badge) |
| `control-plane/src/organisms/CardSheet.tsx` (create) | Card detail: edit, Jira link, delegate picker, delete |
| `control-plane/src/organisms/BoardStage.test.tsx` (create) | Board tests |
| `control-plane/src/organisms/ToolRail.tsx` (modify) | Third tool: Board |
| `control-plane/src/pages/HomePage.tsx` (modify) | `boardOpen` stage wiring |
| `control-plane/src/styles/components.css` (modify) | `.board*`, `.board-card*`, `.card-sheet*` |

---

### Task 1: Swarm work-items module

**Files:**
- Create: `swarm/src/work-items.ts`
- Create: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: `node:fs/promises`, `node:path`, `node:crypto` only.
- Produces (used by Tasks 2, 3):
  - Types `WorkBoard`, `WorkCard`, `WorkColumn` exactly as below
  - `BOARD_TEMPLATES: Record<'personal' | 'capability', WorkColumn[]>`
  - `loadBoards(dir): Promise<{ boards: WorkBoard[]; errors: Array<{ file: string; error: string }> }>`
  - `saveBoard(dir, board): Promise<void>` (validates board id)
  - `createBoard(name: string, template: 'personal' | 'capability'): WorkBoard` (id slugged from name; throws on empty slug)
  - `addCard(board, input: { title: string; notes?: string; columnId?: string }): WorkCard` (mutates board, appends to leftmost column when columnId absent; throws on unknown columnId or empty title)
  - `patchCard(board, cardId, patch: Partial<Pick<WorkCard, 'title' | 'notes' | 'columnId' | 'order' | 'jira' | 'delegation' | 'stories'>>): WorkCard` (mutates; moves renumber affected columns 0..n-1; `order` is the target index; bumps `updatedAt`; throws on unknown card/column)
  - `removeCard(board, cardId): void` (throws on unknown card)
  - `deleteBoardFile(dir, id): Promise<void>`

- [ ] **Step 1: Write the failing tests** — create `swarm/src/work-items.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addCard, BOARD_TEMPLATES, createBoard, deleteBoardFile, loadBoards, patchCard, removeCard, saveBoard,
} from './work-items.js';

test('templates: personal has 5 columns, capability has 6, ids unique and slug-shaped', () => {
  assert.deepEqual(BOARD_TEMPLATES.personal.map((c) => c.name), ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done']);
  assert.deepEqual(BOARD_TEMPLATES.capability.map((c) => c.name), ['Capability', 'Spec', 'Implementation PRD', 'User Stories', 'In Progress', 'Completed']);
  for (const cols of Object.values(BOARD_TEMPLATES)) {
    assert.equal(new Set(cols.map((c) => c.id)).size, cols.length);
    for (const c of cols) assert.match(c.id, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test('createBoard slugs the name and copies template columns; bad names throw', () => {
  const b = createBoard('Q3 Roadmap!', 'personal');
  assert.equal(b.id, 'q3-roadmap');
  assert.equal(b.name, 'Q3 Roadmap!');
  assert.equal(b.columns.length, 5);
  assert.notEqual(b.columns, BOARD_TEMPLATES.personal); // copy, not shared reference
  assert.deepEqual(b.cards, []);
  assert.throws(() => createBoard('!!!', 'personal'), /name/i);
});

test('addCard appends to the leftmost column by default and orders sequentially', () => {
  const b = createBoard('t', 'personal');
  const a = addCard(b, { title: 'first' });
  const c = addCard(b, { title: 'second' });
  assert.equal(a.columnId, b.columns[0].id);
  assert.deepEqual([a.order, c.order], [0, 1]);
  assert.ok(a.id !== c.id && a.createdAt && a.updatedAt);
  assert.throws(() => addCard(b, { title: '  ' }), /title/i);
  assert.throws(() => addCard(b, { title: 'x', columnId: 'nope' }), /column/i);
});

test('patchCard moves between columns at a target index and renumbers both columns', () => {
  const b = createBoard('t', 'personal');
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
  const b = createBoard('t', 'personal');
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
  const b = createBoard('t', 'personal');
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
  const b = createBoard('Alpha', 'capability');
  addCard(b, { title: 'card' });
  await saveBoard(dir, b);
  await writeFile(join(dir, 'broken.json'), '{not json');
  await writeFile(join(dir, 'shapeless.json'), '{"id":"shapeless"}');
  const { boards, errors } = await loadBoards(dir);
  assert.deepEqual(boards.map((x) => x.id), ['alpha']);
  assert.equal(boards[0].cards[0].title, 'card');
  assert.equal(errors.length, 2);
  assert.deepEqual((await readFile(join(dir, 'alpha.json'), 'utf8')).endsWith('\n'), true);
  await deleteBoardFile(dir, 'alpha');
  assert.deepEqual((await loadBoards(dir)).boards, []);
  await assert.rejects(saveBoard(dir, { ...b, id: '../evil' }), /id/i);
});

test('removeCard deletes and renumbers its column', () => {
  const b = createBoard('t', 'personal');
  const c1 = addCard(b, { title: 'a' });
  const c2 = addCard(b, { title: 'b' });
  removeCard(b, c1.id);
  assert.deepEqual(b.cards.map((c) => [c.title, c.order]), [['b', 0]]);
  assert.ok(c2);
  assert.throws(() => removeCard(b, 'ghost'), /card/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd swarm && node --import tsx --test src/work-items.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — create `swarm/src/work-items.ts`:

```ts
// Kanban work boards — the user's personal planning store, one JSON file per
// board under .smith/work/. Boards are data (columns included), never code:
// two shipped templates seed them, and every mutation goes through the
// helpers here so routes stay thin and unit tests never boot the server.
// Cards may LINK to a Jira issue or a delegated agent task; neither linkage
// is required, and execution state never moves a card — columns belong to
// the human.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkColumn {
  id: string;
  name: string;
  /** Jira status to transition a linked card to when it lands here; absent = no push. */
  jiraStatus?: string;
}

export interface WorkCard {
  id: string;
  title: string;
  notes?: string;
  columnId: string;
  /** Position within its column, always renumbered 0..n-1 by the helpers. */
  order: number;
  createdAt: string;
  updatedAt: string;
  jira?: { key: string; url: string; lastPushError?: string };
  delegation?: { agentId: string; taskId: string; state: 'working' | 'completed' | 'failed'; prUrl?: string };
  /** Acceptance-criteria checklist — authored by hand in v1, replaced wholesale on PATCH. Never a column. */
  stories?: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>;
}

export interface WorkBoard {
  id: string;
  name: string;
  columns: WorkColumn[];
  cards: WorkCard[];
  jira?: { connectorId: string; siteUrl: string; projectKey: string; jql?: string };
}

const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const BOARD_TEMPLATES: Record<'personal' | 'capability', WorkColumn[]> = {
  personal: [
    { id: 'backlog', name: 'Backlog' },
    { id: 'ready', name: 'Ready' },
    { id: 'in-progress', name: 'In Progress' },
    { id: 'in-review', name: 'In Review' },
    { id: 'done', name: 'Done' },
  ],
  capability: [
    { id: 'capability', name: 'Capability' },
    { id: 'spec', name: 'Spec' },
    { id: 'implementation-prd', name: 'Implementation PRD' },
    { id: 'user-stories', name: 'User Stories' },
    { id: 'in-progress', name: 'In Progress' },
    { id: 'completed', name: 'Completed' },
  ],
};

export function createBoard(name: string, template: 'personal' | 'capability'): WorkBoard {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!BOARD_ID_RE.test(id)) throw new Error(`Board name "${name}" does not reduce to a usable id`);
  return { id, name: name.trim(), columns: BOARD_TEMPLATES[template].map((c) => ({ ...c })), cards: [] };
}

function assertBoard(file: string, v: unknown): WorkBoard {
  const o = v as WorkBoard;
  const ok =
    o && typeof o.id === 'string' && typeof o.name === 'string' &&
    Array.isArray(o.columns) && o.columns.every((c) => typeof c?.id === 'string' && typeof c?.name === 'string') &&
    Array.isArray(o.cards);
  if (!ok) throw new Error(`Invalid work-board file ${file}: requires id, name, columns[], cards[]`);
  return o;
}

export async function loadBoards(dir: string): Promise<{ boards: WorkBoard[]; errors: Array<{ file: string; error: string }> }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { boards: [], errors: [] };
  }
  const boards: WorkBoard[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    try {
      boards.push(assertBoard(file, JSON.parse(await readFile(join(dir, file), 'utf8'))));
    } catch (err) {
      errors.push({ file, error: String((err as Error).message) });
    }
  }
  return { boards, errors };
}

export async function saveBoard(dir: string, board: WorkBoard): Promise<void> {
  if (!BOARD_ID_RE.test(board.id)) throw new Error(`Invalid board id "${board.id}"`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${board.id}.json`), `${JSON.stringify(board, null, 2)}\n`);
}

export async function deleteBoardFile(dir: string, id: string): Promise<void> {
  if (!BOARD_ID_RE.test(id)) throw new Error(`Invalid board id "${id}"`);
  await rm(join(dir, `${id}.json`));
}

function renumber(board: WorkBoard, columnId: string): void {
  board.cards
    .filter((c) => c.columnId === columnId)
    .sort((a, b) => a.order - b.order)
    .forEach((c, i) => {
      c.order = i;
    });
}

export function addCard(board: WorkBoard, input: { title: string; notes?: string; columnId?: string }): WorkCard {
  const title = input.title?.trim();
  if (!title) throw new Error('Card title is required');
  const columnId = input.columnId ?? board.columns[0]?.id;
  if (!board.columns.some((c) => c.id === columnId)) throw new Error(`Unknown column: ${input.columnId}`);
  const now = new Date().toISOString();
  const card: WorkCard = {
    id: randomUUID(),
    title,
    notes: input.notes?.trim() || undefined,
    columnId,
    order: board.cards.filter((c) => c.columnId === columnId).length,
    createdAt: now,
    updatedAt: now,
  };
  board.cards.push(card);
  return card;
}

export function patchCard(
  board: WorkBoard,
  cardId: string,
  patch: Partial<Pick<WorkCard, 'title' | 'notes' | 'columnId' | 'order' | 'jira' | 'delegation' | 'stories'>>,
): WorkCard {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Unknown card: ${cardId}`);
  if (patch.columnId !== undefined && !board.columns.some((c) => c.id === patch.columnId)) {
    throw new Error(`Unknown column: ${patch.columnId}`);
  }
  const fromColumn = card.columnId;
  if (patch.title !== undefined) card.title = patch.title.trim() || card.title;
  if (patch.notes !== undefined) card.notes = patch.notes.trim() || undefined;
  if (patch.jira !== undefined) card.jira = patch.jira ?? undefined;
  if (patch.delegation !== undefined) card.delegation = patch.delegation ?? undefined;
  if (patch.stories !== undefined) card.stories = patch.stories ?? undefined;
  if (patch.columnId !== undefined || patch.order !== undefined) {
    const toColumn = patch.columnId ?? card.columnId;
    const siblings = board.cards.filter((c) => c.columnId === toColumn && c.id !== card.id).sort((a, b) => a.order - b.order);
    const at = Math.max(0, Math.min(patch.order ?? siblings.length, siblings.length));
    card.columnId = toColumn;
    siblings.splice(at, 0, card);
    siblings.forEach((c, i) => {
      c.order = i;
    });
    if (fromColumn !== toColumn) renumber(board, fromColumn);
  }
  card.updatedAt = new Date().toISOString();
  return card;
}

export function removeCard(board: WorkBoard, cardId: string): void {
  const i = board.cards.findIndex((c) => c.id === cardId);
  if (i < 0) throw new Error(`Unknown card: ${cardId}`);
  const columnId = board.cards[i].columnId;
  board.cards.splice(i, 1);
  renumber(board, columnId);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd swarm && node --import tsx --test src/work-items.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full swarm suite**

Run: `cd swarm && npm test` — green apart from the known agent-sessions baseline.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/work-items.ts swarm/src/work-items.test.ts
git commit -m "feat(swarm): work-board store (boards as data, cards, move/reorder helpers)"
```

---

### Task 2: Swarm `/work` routes + reset archival + completion hook

**Files:**
- Modify: `swarm/src/server.ts`

**Interfaces:**
- Consumes: every Task 1 export.
- Produces (proxied verbatim by the broker in Task 4):
  - `GET /work/boards` → `{ boards, errors }`
  - `POST /work/boards` `{name, template}` → 201 board | 400
  - `PATCH /work/boards/:id` `{name?, columns?, jira?}` → board | 404/400 (columns replace wholesale when present; jira replaces; name trims)
  - `DELETE /work/boards/:id` → `{ok:true}` | 404
  - `POST /work/boards/:id/cards` `{title, notes?, columnId?}` → 201 card | 404/400
  - `PATCH /work/boards/:id/cards/:cardId` (Task 1 patch fields) → card | 404/400
  - `DELETE /work/boards/:id/cards/:cardId` → `{ok:true}` | 404
  - Task-completion behavior: when a finishing task's `manifest.metadata.workCardRef = {boardId, cardId}` exists, the swarm patches that card's `delegation.state` (+`prUrl`) and the broadcast `task:completed|task:failed` event carries `workCardRef`.

- [ ] **Step 1: Register routes** — in `swarm/src/server.ts`, add to imports (`.js` suffix): `import { addCard, createBoard, deleteBoardFile, loadBoards, patchCard, removeCard, saveBoard, type WorkBoard } from './work-items.js';` and a helper + routes next to the agent-registry section:

```ts
    // ── Work boards — the user's kanban store ──────────────────────────
    const workDir = () => resolve(process.cwd(), '.smith/work');
    const boardOr404 = async (id: string, reply: { status: (n: number) => { send: (b: unknown) => unknown } }): Promise<WorkBoard | null> => {
      const { boards } = await loadBoards(workDir());
      const board = boards.find((b) => b.id === id) ?? null;
      if (!board) reply.status(404).send({ error: `Unknown board: ${id}` });
      return board;
    };

    this.app.get('/work/boards', async () => loadBoards(workDir()));

    this.app.post('/work/boards', async (req, reply) => {
      const b = req.body as { name?: string; template?: 'personal' | 'capability' };
      if (!b?.name?.trim()) return reply.status(400).send({ error: 'Missing required field: name' });
      const template = b.template ?? 'personal';
      if (template !== 'personal' && template !== 'capability') {
        return reply.status(400).send({ error: `Unknown template: ${String(b.template)}` });
      }
      try {
        const board = createBoard(b.name, template);
        const { boards } = await loadBoards(workDir());
        if (boards.some((x) => x.id === board.id)) return reply.status(409).send({ error: `Board "${board.id}" already exists` });
        await saveBoard(workDir(), board);
        return reply.status(201).send(board);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.patch<{ Params: { id: string } }>('/work/boards/:id', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      const b = req.body as Partial<Pick<WorkBoard, 'name' | 'columns' | 'jira'>>;
      if (b.name?.trim()) board.name = b.name.trim();
      if (b.columns) {
        if (!Array.isArray(b.columns) || b.columns.some((c) => !c?.id || !c?.name)) {
          return reply.status(400).send({ error: 'columns must be [{id, name, jiraStatus?}]' });
        }
        const ids = new Set(b.columns.map((c) => c.id));
        if (board.cards.some((c) => !ids.has(c.columnId))) {
          return reply.status(400).send({ error: 'columns update would orphan cards — move them first' });
        }
        board.columns = b.columns;
      }
      if (b.jira !== undefined) board.jira = b.jira ?? undefined;
      await saveBoard(workDir(), board);
      return board;
    });

    this.app.delete<{ Params: { id: string } }>('/work/boards/:id', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      await deleteBoardFile(workDir(), board.id);
      return { ok: true };
    });

    this.app.post<{ Params: { id: string } }>('/work/boards/:id/cards', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      try {
        const card = addCard(board, req.body as { title: string; notes?: string; columnId?: string });
        await saveBoard(workDir(), board);
        return reply.status(201).send(card);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.patch<{ Params: { id: string; cardId: string } }>('/work/boards/:id/cards/:cardId', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      try {
        const card = patchCard(board, req.params.cardId, req.body as Parameters<typeof patchCard>[2]);
        await saveBoard(workDir(), board);
        return card;
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.delete<{ Params: { id: string; cardId: string } }>('/work/boards/:id/cards/:cardId', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      try {
        removeCard(board, req.params.cardId);
        await saveBoard(workDir(), board);
        return { ok: true };
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });
```

(Jira push-on-move and the import route are Task 3 — do not add them here.)

- [ ] **Step 2: Reset archival** — in the `/reset` route's `if (scope.agents)` block, beside the `.smith/avatars` rename (same `stamp`):

```ts
        await rename(
          resolve(process.cwd(), '.smith/work'),
          resolve(process.cwd(), `.smith/work-archived-${stamp}`),
        ).catch(() => {});
```

- [ ] **Step 3: Completion hook + event enrichment** — in `server.ts`, find the task-completion path (the `.then`/`.catch` around dispatch that deletes from `activeTasks`, releases the name, writes `completedTasks`, and broadcasts `task:completed` / `task:failed`). Add a helper near the work routes and call it (fire-and-forget with `.catch`) from BOTH outcome branches, and include `workCardRef` in the broadcast payloads when present:

```ts
    // A finishing task that was dispatched from a board card writes its
    // outcome back onto the card — state only, never the column; columns
    // belong to the human. Best-effort: a store hiccup must not disturb
    // task bookkeeping.
    const patchWorkCard = async (
      ref: { boardId: string; cardId: string },
      state: 'completed' | 'failed',
      prUrl?: string,
    ): Promise<void> => {
      const { boards } = await loadBoards(workDir());
      const board = boards.find((b) => b.id === ref.boardId);
      const card = board?.cards.find((c) => c.id === ref.cardId);
      if (!board || !card || !card.delegation) return;
      patchCard(board, card.id, { delegation: { ...card.delegation, state, prUrl: prUrl ?? card.delegation.prUrl } });
      await saveBoard(workDir(), board);
    };
```

At each broadcast site, derive `const workCardRef = manifest.metadata?.workCardRef as { boardId: string; cardId: string } | undefined;` (the manifest is in scope there), call `if (workCardRef) void patchWorkCard(workCardRef, 'completed', result?.pullRequestUrl).catch(() => {});` (or `'failed'` in the failure branch), and spread `...(workCardRef ? { workCardRef } : {})` into the broadcast event object.

- [ ] **Step 4: Run the swarm suite**

Run: `cd swarm && npm test`
Expected: green apart from baseline. Route glue is thin calls into Task 1's unit-tested helpers; the completion hook's `patchWorkCard` logic is exercised through `patchCard` tests — verified by inspection per swarm convention (no server-boot harness), and end-to-end in Task 8.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/server.ts
git commit -m "feat(swarm): /work board routes, reset archival, card patch on task completion"
```

---

### Task 3: Swarm Jira sync (search, import, transition push)

**Files:**
- Create: `swarm/src/jira-sync.ts`
- Create: `swarm/src/jira-sync.test.ts`
- Modify: `swarm/src/server.ts` (import route + push-on-move inside the card PATCH route)

**Interfaces:**
- Consumes: `WorkBoard`/`WorkCard`/`patchCard`/`saveBoard`/`loadBoards` (Task 1); existing `resolveAtlassianConnector`, `loadUsersFromDir`, `resolveCurrentUser` (already used by the ticket-lookup route — mirror that route's credential resolution exactly); auth style from `swarm/src/atlassian-client.ts` (Basic email:apiToken, injectable fetch).
- Produces:
  - `searchIssues(siteUrl, email, apiToken, jql, fetchImpl?): Promise<Array<{ key: string; summary: string; url: string }>>` (throws with Jira status text on non-ok)
  - `importIssues(board: WorkBoard, issues: Array<{key; summary; url}>): { created: number; updated: number }` — pure: unseen keys become cards in the leftmost column (title = `summary`), known keys update `title` only; idempotent by `jira.key`
  - `transitionIssue(siteUrl, email, apiToken, key, targetStatusName, fetchImpl?): Promise<void>` — GET transitions, match `t.to.name` case-insensitively, POST it; throws `no transition to "<name>"` when absent
  - Swarm route `POST /work/boards/:id/jira/import` → `{created, updated}` | 400 (no board.jira / connector error) | 404
  - Push-on-move: card PATCH that changes `columnId` onto a column with `jiraStatus`, for a Jira-linked card → attempt transition; success clears `jira.lastPushError`, failure sets it; the PATCH response reflects the final card and is always 200.

- [ ] **Step 1: Failing tests** — create `swarm/src/jira-sync.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addCard, createBoard } from './work-items.js';
import { importIssues, searchIssues, transitionIssue } from './jira-sync.js';

const fetchStub = (routes: Array<{ match: RegExp; status?: number; body: unknown; capture?: (url: string, init?: RequestInit) => void }>) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const r = routes.find((x) => x.match.test(u));
    if (!r) throw new Error(`unexpected fetch: ${u}`);
    r.capture?.(u, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, statusText: 'x', json: async () => r.body } as Response;
  }) as typeof fetch;

test('searchIssues: jql query, basic auth, maps key/summary/url; non-ok throws', async () => {
  let seenAuth = '';
  const f = fetchStub([{
    match: /\/rest\/api\/3\/search/,
    body: { issues: [{ key: 'PROJ-1', fields: { summary: 'Fix login' } }, { key: 'PROJ-2', fields: { summary: 'Add SSO' } }] },
    capture: (u, init) => { seenAuth = String((init?.headers as Record<string, string>)?.authorization); assert.match(u, /jql=project%20%3D%20PROJ/); },
  }]);
  const issues = await searchIssues('https://acme.atlassian.net/', 'e@x.com', 'tok', 'project = PROJ', f);
  assert.deepEqual(issues, [
    { key: 'PROJ-1', summary: 'Fix login', url: 'https://acme.atlassian.net/browse/PROJ-1' },
    { key: 'PROJ-2', summary: 'Add SSO', url: 'https://acme.atlassian.net/browse/PROJ-2' },
  ]);
  assert.match(seenAuth, /^Basic /);
  const bad = fetchStub([{ match: /search/, status: 401, body: { message: 'nope' } }]);
  await assert.rejects(searchIssues('https://a.net', 'e', 't', 'x', bad), /401/);
});

test('importIssues: creates unseen keys in the leftmost column, updates titles of known keys, idempotent', () => {
  const b = createBoard('t', 'personal');
  const existing = addCard(b, { title: 'old title', columnId: b.columns[3].id });
  existing.jira = { key: 'PROJ-1', url: 'https://a/browse/PROJ-1' };
  const issues = [
    { key: 'PROJ-1', summary: 'new title', url: 'https://a/browse/PROJ-1' },
    { key: 'PROJ-9', summary: 'brand new', url: 'https://a/browse/PROJ-9' },
  ];
  const r1 = importIssues(b, issues);
  assert.deepEqual(r1, { created: 1, updated: 1 });
  assert.equal(b.cards.find((c) => c.jira?.key === 'PROJ-1')?.title, 'new title');
  const created = b.cards.find((c) => c.jira?.key === 'PROJ-9');
  assert.equal(created?.columnId, b.columns[0].id);
  const r2 = importIssues(b, issues);
  assert.deepEqual(r2, { created: 0, updated: 2 });
  assert.equal(b.cards.filter((c) => c.jira?.key === 'PROJ-9').length, 1);
  assert.equal(b.cards.find((c) => c.jira?.key === 'PROJ-1')?.columnId, b.columns[3].id); // import never moves
});

test('transitionIssue: finds the transition by target status name (case-insensitive) and POSTs it; missing → throws', async () => {
  let posted = '';
  const f = fetchStub([
    { match: /\/transitions$/, body: { transitions: [{ id: '31', to: { name: 'In Review' } }, { id: '41', to: { name: 'Done' } }] },
      capture: (u, init) => { if (init?.method === 'POST') posted = String(init.body); } },
  ]);
  await transitionIssue('https://a.net', 'e', 't', 'PROJ-1', 'in review', f);
  assert.match(posted, /"id":"31"/);
  await assert.rejects(transitionIssue('https://a.net', 'e', 't', 'PROJ-1', 'Blocked', f), /no transition to "Blocked"/i);
});
```

- [ ] **Step 2: Run to verify failure** — `cd swarm && node --import tsx --test src/jira-sync.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `swarm/src/jira-sync.ts`:

```ts
// Jira sync for work boards — three verbs only (search, import-merge,
// transition), matching the spec's v1 scope. Pure injectable-fetch HTTP
// client in the style of atlassian-client.ts: no storage access here;
// routes resolve credentials via the connector registry and hand in plain
// values. Push is best-effort by design — a failed transition marks the
// card, never blocks the human's move.
import { addCard, type WorkBoard } from './work-items.js';

const auth = (email: string, apiToken: string) => `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;

export async function searchIssues(
  siteUrl: string,
  email: string,
  apiToken: string,
  jql: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ key: string; summary: string; url: string }>> {
  const base = siteUrl.replace(/\/$/, '');
  const res = await fetchImpl(`${base}/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=100`, {
    headers: { authorization: auth(email, apiToken) },
  });
  if (!res.ok) throw new Error(`Jira search failed: ${res.status}`);
  const body = (await res.json()) as { issues?: Array<{ key: string; fields?: { summary?: string } }> };
  return (body.issues ?? []).map((i) => ({ key: i.key, summary: i.fields?.summary ?? i.key, url: `${base}/browse/${i.key}` }));
}

/** Merge issues into the board: unseen keys become leftmost-column cards, known keys refresh title only. Never moves a card. */
export function importIssues(
  board: WorkBoard,
  issues: Array<{ key: string; summary: string; url: string }>,
): { created: number; updated: number } {
  let created = 0;
  let updated = 0;
  for (const issue of issues) {
    const existing = board.cards.find((c) => c.jira?.key === issue.key);
    if (existing) {
      existing.title = issue.summary;
      existing.updatedAt = new Date().toISOString();
      updated += 1;
    } else {
      const card = addCard(board, { title: issue.summary });
      card.jira = { key: issue.key, url: issue.url };
      created += 1;
    }
  }
  return { created, updated };
}

export async function transitionIssue(
  siteUrl: string,
  email: string,
  apiToken: string,
  key: string,
  targetStatusName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = siteUrl.replace(/\/$/, '');
  const headers = { authorization: auth(email, apiToken), 'content-type': 'application/json' };
  const listRes = await fetchImpl(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { headers });
  if (!listRes.ok) throw new Error(`Jira transitions fetch failed: ${listRes.status}`);
  const body = (await listRes.json()) as { transitions?: Array<{ id: string; to?: { name?: string } }> };
  const hit = (body.transitions ?? []).find((t) => t.to?.name?.toLowerCase() === targetStatusName.toLowerCase());
  if (!hit) throw new Error(`no transition to "${targetStatusName}" available on ${key}`);
  const postRes = await fetchImpl(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ transition: { id: hit.id } }),
  });
  if (!postRes.ok) throw new Error(`Jira transition failed: ${postRes.status}`);
}
```

- [ ] **Step 4: Run to verify pass** — `cd swarm && node --import tsx --test src/jira-sync.test.ts` → PASS (3 tests).

- [ ] **Step 5: Wire the import route and push-on-move** — in `server.ts`:
  - Import: `import { importIssues, searchIssues, transitionIssue } from './jira-sync.js';`
  - Add beside the other work routes (credential resolution mirrors the `/workspaces/:name/atlassian/lookup-ticket` route — same `loadUsersFromDir` + `resolveCurrentUser` + `resolveAtlassianConnector` trio):

```ts
    this.app.post<{ Params: { id: string } }>('/work/boards/:id/jira/import', async (req, reply) => {
      const board = await boardOr404(req.params.id, reply);
      if (!board) return;
      if (!board.jira) return reply.status(400).send({ error: `Board "${board.id}" has no Jira link configured` });
      const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
      const user = resolveCurrentUser(users);
      const resolved = resolveAtlassianConnector(board.jira.connectorId, user, { name: 'jql', value: board.jira.jql ?? 'x' });
      if ('error' in resolved) return reply.status(400).send({ error: resolved.error });
      const jql = board.jira.jql?.trim() || `project = ${board.jira.projectKey} ORDER BY updated DESC`;
      try {
        const issues = await searchIssues(
          board.jira.siteUrl,
          resolved.instance.fields.email ?? '',
          resolved.instance.fields.apiToken ?? '',
          jql,
        );
        const summary = importIssues(board, issues);
        await saveBoard(workDir(), board);
        return summary;
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });
```

  - In the card PATCH route (Task 2), after `patchCard` succeeds and BEFORE `saveBoard`, add the push:

```ts
        // Push-on-move: a Jira-linked card landing on a mapped column tries
        // the matching transition. Best-effort — the human's move always
        // sticks; only the amber badge reports a failed push.
        const movedTo = (req.body as { columnId?: string }).columnId;
        const target = movedTo ? board.columns.find((c) => c.id === movedTo) : undefined;
        if (card.jira && target?.jiraStatus && board.jira) {
          const users = await loadUsersFromDir(resolve(process.cwd(), '.smith/users'));
          const resolved = resolveAtlassianConnector(board.jira.connectorId, resolveCurrentUser(users), { name: 'key', value: card.jira.key });
          if (!('error' in resolved)) {
            try {
              await transitionIssue(
                board.jira.siteUrl,
                resolved.instance.fields.email ?? '',
                resolved.instance.fields.apiToken ?? '',
                card.jira.key,
                target.jiraStatus,
              );
              card.jira = { key: card.jira.key, url: card.jira.url };
            } catch (err) {
              card.jira.lastPushError = String((err as Error).message);
            }
          } else {
            card.jira.lastPushError = resolved.error;
          }
        }
```

- [ ] **Step 6: Full swarm suite** — `cd swarm && npm test` → green apart from baseline.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/jira-sync.ts swarm/src/jira-sync.test.ts swarm/src/server.ts
git commit -m "feat(swarm): jira sync for boards — jql import, best-effort transition push"
```

---

### Task 4: Broker — proxy, dispatchWork refactor, delegate route, board-updated frame

**Files:**
- Modify: `broker/src/swarm-client.ts` (generic work passthrough; `SwarmEvent` gains `workCardRef`)
- Modify: `broker/src/broker.ts` (extract `dispatchWork` from the delegate executor)
- Modify: `broker/src/broker.test.ts` (dispatchWork tests — follow the file's existing fixture style)
- Modify: `broker/src/text-channel.ts` (work handler interface + routes + `board-updated` frame type)
- Modify: `broker/src/text-channel.test.ts` (extend stub + route tests)
- Modify: `broker/src/main.ts` (wire handlers; relay frame on enriched events)

**Interfaces:**
- Consumes: swarm `/work/*` routes (Task 2/3); existing `Broker.executors.delegate` internals; the existing swarm-event subscription in `Broker.onSwarmEvent` / `main.ts`.
- Produces (consumed by the UI, Tasks 5-7):
  - Broker HTTP: every `/work/*` path proxied verbatim (status + JSON body preserved), plus `POST /work/delegate` `{boardId, cardId, agentId, workspace?, repo?, prompt}` → 200 `{taskId}` | 409 `{error}` (busy/unknown agent) | 500
  - WS frame `{ type: 'board-updated'; boardId: string }`
  - `Broker.dispatchWork(input: { agent: string; task: string; workspace?: string; repo?: string; metadata?: Record<string, unknown> }): Promise<{ taskId: string; agentName: string | null } | { error: string }>` — busy check + directives-prefixed prompt + bindTask + notifyRoster, exactly the old executor behavior

- [ ] **Step 1: Extract `dispatchWork`** — in `broker/src/broker.ts`, refactor the `delegate` executor (in `readonly executors = {...}`) so both paths share one method. Add to the class:

```ts
  /**
   * The one dispatch path for real work — the meeting's delegate tool and
   * the board's Send-to-agent both land here, so busy-refusal, the
   * directives-prefixed prompt, task binding, and roster refresh can never
   * drift apart.
   */
  async dispatchWork(input: {
    agent: string;
    task: string;
    workspace?: string;
    repo?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ taskId: string; agentName: string | null; agentDisplayName: string } | { error: string }> {
    const agent = this.deps.directory.resolve(input.agent);
    if (!agent) return { error: `There is no agent named "${input.agent}".` };
    const busy = this.deps.directory.snapshot().find((p) => p.agent.id === agent.id && p.status === 'busy');
    if (busy) return { error: `${agent.name} is busy with: ${busy.taskSummary ?? busy.taskId}.` };
    const { taskId, agentName } = await this.deps.swarm.submitTask({
      prompt: `${agent.directives}\n\n---\nTask from the live meeting:\n${input.task}`,
      agent: agent.engine.cli,
      repository: this.repository,
      workspace: input.workspace,
      repo: input.repo,
      metadata: { composedAgentId: agent.id, ...input.metadata },
    });
    this.deps.directory.bindTask(agent.id, { taskId, summary: input.task.slice(0, 80), swarmName: agentName ?? undefined });
    this.deps.onTaskDispatched?.({ taskId, agent: agent.name, task: input.task });
    this.notifyRoster();
    return { taskId, agentName, agentDisplayName: agent.name };
  }
```

and rewrite the `delegate` executor as a thin wrapper preserving its exact return strings:

```ts
    delegate: async (input: { agent: string; task: string; workspace?: string; repo?: string; ticketKey?: string }): Promise<string> => {
      const r = await this.dispatchWork({
        agent: input.agent,
        task: input.task,
        workspace: input.workspace,
        repo: input.repo,
        metadata: { source: 'broker-meeting', ticketKey: input.ticketKey },
      });
      if ('error' in r) {
        return r.error.startsWith('There is no agent')
          ? `${r.error} Offer one from the roster.`
          : `${r.error} Offer an idle agent instead.`;
      }
      return `Delegated to ${r.agentDisplayName}: task ${r.taskId} queued. They will work asynchronously; you will be notified on completion.`;
    },
```

Note the ordering change in metadata: `composedAgentId` now comes from `dispatchWork` and callers add `source`/`ticketKey`/`workCardRef` — assert in the test that the merged metadata still carries all keys.

- [ ] **Step 2: dispatchWork tests** — in `broker/src/broker.test.ts`, add tests using the file's existing broker-construction fixtures (a stub `swarm.submitTask` capturing its argument, a directory with one idle and one busy agent):

```ts
test('dispatchWork: refuses unknown and busy agents with {error}', async () => { /* resolve fails; busy presence -> error mentions the summary */ });
test('dispatchWork: submits directives-prefixed prompt with merged metadata and binds the task', async () => {
  // capture submitTask arg: prompt starts with agent.directives; metadata has
  // composedAgentId AND caller-supplied workCardRef/source; bindTask called;
  // returns { taskId, agentDisplayName }.
});
test('delegate executor keeps its exact success/refusal strings', async () => { /* string-compare against the pre-refactor copy */ });
```

Write these as real tests against the file's existing fixture helpers (the file already constructs Brokers with stub deps — mirror the nearest existing test's setup verbatim; if `broker.test.ts` has no delegate-executor fixture, build the minimal `deps` object the constructor needs, as the neighboring tests do).

- [ ] **Step 3: Run broker tests** — `cd broker && node --import tsx --test src/broker.test.ts` → new tests PASS, all pre-existing PASS.

- [ ] **Step 4: swarm-client passthrough** — in `broker/src/swarm-client.ts`:
  - Add to `SwarmEvent`'s task-completion members (find the union at ~line 150): `workCardRef?: { boardId: string; cardId: string }`.
  - Add a generic method following `http()`'s auth pattern exactly:

```ts
  /** Verbatim passthrough for the work-board routes — the broker adds no logic. */
  async work(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, payload: await res.json().catch(() => ({})) };
  }
```

(Mirror the real private member names — `this.token`/`this.baseUrl`/`this.fetchImpl` were verified in the avatar work; re-check against `http()` before writing.)

- [ ] **Step 5: text-channel routes** — in `broker/src/text-channel.ts`:
  - Frame union (`ChannelFrame`): add `| { type: 'board-updated'; boardId: string }`.
  - New optional constructor param (append after the existing trailing params, updating `channelWith` accordingly):

```ts
    /** Work boards: verbatim proxy to the swarm + the one dispatch route. */
    private readonly work?: {
      proxy(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }>;
      delegate(body: Record<string, unknown>): Promise<{ taskId: string } | { error: string }>;
    },
```

  - Routes inside the request handler (place with the other JSON routes; `/work/delegate` MUST be matched before the generic proxy):

```ts
      if (this.work) {
        const url2 = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'POST' && url2.pathname === '/work/delegate') {
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(body || '{}') as Record<string, unknown>;
            } catch {
              return res.writeHead(400, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: 'body must be JSON' }));
            }
            void this.work!.delegate(parsed).then(
              (r) => res.writeHead('error' in r ? 409 : 200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(r)),
              (err: unknown) => res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message ?? err) })),
            );
          });
          return;
        }
        if (url2.pathname.startsWith('/work/')) {
          let body = '';
          req.on('data', (c) => {
            body += c;
          });
          req.on('end', () => {
            let parsed: unknown;
            if (body) {
              try {
                parsed = JSON.parse(body);
              } catch {
                return res.writeHead(400, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: 'body must be JSON' }));
              }
            }
            void this.work!.proxy(req.method ?? 'GET', url2.pathname, parsed).then(
              (r) => res.writeHead(r.status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(r.payload)),
              (err: unknown) => res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message ?? err) })),
            );
          });
          return;
        }
      }
```

(Adapt to the handler's actual local helpers — if a `json(status, payload)` helper is in scope at the insertion point, use it instead of raw `writeHead`; keep the behavior identical.)

- [ ] **Step 6: Route tests** — in `broker/src/text-channel.test.ts`, extend the harness (`channelWith` gains a `work` option in the constructor position you added) and add:

```ts
test('/work/* proxies method, path, body, and status verbatim', async () => {
  const calls: Array<[string, string, unknown]> = [];
  const channel = channelWith({ work: {
    proxy: async (m, p, b) => { calls.push([m, p, b]); return { status: 418, payload: { hello: 'board' } }; },
    delegate: async () => ({ taskId: 't' }),
  }});
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/work/boards/alpha/cards`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    });
    assert.equal(res.status, 418);
    assert.deepEqual(await res.json(), { hello: 'board' });
    assert.deepEqual(calls, [['POST', '/work/boards/alpha/cards', { title: 'x' }]]);
  } finally {
    await channel.stop();
  }
});

test('POST /work/delegate maps handler result: taskId -> 200, error -> 409', async () => {
  const channel = channelWith({ work: {
    proxy: async () => ({ status: 200, payload: {} }),
    delegate: async (b) => (b.agentId === 'minerva' ? { taskId: 'task-1' } : { error: 'busy' }),
  }});
  const port = await channel.start(0);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/work/delegate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentId: 'minerva' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { taskId: 'task-1' });
    const refused = await fetch(`http://127.0.0.1:${port}/work/delegate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(refused.status, 409);
  } finally {
    await channel.stop();
  }
});
```

(Match the file's real start/stop idiom.)

- [ ] **Step 7: main.ts wiring** — in `broker/src/main.ts`:
  - Pass the new constructor arg where `TextChannel` is built:

```ts
    {
      proxy: (method, path, body) => swarm.work(method, path, body),
      delegate: async (body) => {
        const b = body as { boardId?: string; cardId?: string; agentId?: string; workspace?: string; repo?: string; prompt?: string };
        if (!b.boardId || !b.cardId || !b.agentId || !b.prompt?.trim()) {
          return { error: 'body must be {boardId, cardId, agentId, prompt, workspace?, repo?}' };
        }
        const r = await broker.dispatchWork({
          agent: b.agentId,
          task: b.prompt,
          workspace: b.workspace,
          repo: b.repo,
          metadata: { source: 'work-board', workCardRef: { boardId: b.boardId, cardId: b.cardId } },
        });
        if ('error' in r) return r;
        // Bind the card before answering so the board's next fetch shows the working badge.
        await swarm.work('PATCH', `/work/boards/${encodeURIComponent(b.boardId)}/cards/${encodeURIComponent(b.cardId)}`, {
          delegation: { agentId: b.agentId, taskId: r.taskId, state: 'working' },
        });
        return { taskId: r.taskId };
      },
    },
```

  - In the swarm-event subscription path (where `broker.onSwarmEvent`/the event fan-out lives in main.ts — the same place other frames are broadcast), relay board updates:

```ts
      if ((e.type === 'task:completed' || e.type === 'task:failed') && e.workCardRef) {
        textChannel.broadcast({ type: 'board-updated', boardId: e.workCardRef.boardId });
      }
```

(Use the actual broadcast mechanism main.ts already uses for roster frames — same call shape, new frame type.)

- [ ] **Step 8: Full broker suite** — `cd broker && npm test` → all green.

- [ ] **Step 9: Commit**

```bash
git add broker/src/broker.ts broker/src/broker.test.ts broker/src/swarm-client.ts broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts
git commit -m "feat(broker): work-board proxy, dispatchWork refactor + delegate route, board-updated frame"
```

---

### Task 5: Control-plane — stage scaffolding, board CRUD, frame plumbing

**Files:**
- Create: `control-plane/src/organisms/BoardStage.tsx`
- Create: `control-plane/src/molecules/BoardCard.tsx`
- Create: `control-plane/src/organisms/BoardStage.test.tsx`
- Modify: `control-plane/src/organisms/ToolRail.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx`
- Modify: `control-plane/src/hooks/useBrokerChat.ts`
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Consumes: broker `/work/*` proxy + `board-updated` frame (Task 4); `RosterAgent` (for later tasks' badges).
- Produces (Tasks 6-7 build on these exact shapes):
  - Types in `BoardStage.tsx`, exported: `WorkColumn { id; name; jiraStatus? }`, `WorkCardT { id; title; notes?; columnId; order; jira?: { key; url; lastPushError? }; delegation?: { agentId; taskId; state: "working" | "completed" | "failed"; prUrl? }; stories?: Array<{ id; text; done; verifiedBy? }> }`, `WorkBoardT { id; name; columns: WorkColumn[]; cards: WorkCardT[]; jira?: { connectorId; siteUrl; projectKey; jql? } }`
  - `BoardStage` props: `{ open: boolean; roster: RosterAgent[]; lastBoardUpdate: { boardId: string; seq: number } | null; onClose: () => void }`
  - `BoardCard` props: `{ card: WorkCardT; agent?: RosterAgent; onOpen: () => void }`
  - `useBrokerChat` returns `lastBoardUpdate: { boardId: string; seq: number } | null`

- [ ] **Step 1: Frame plumbing** — in `useBrokerChat.ts`: add `| { type: "board-updated"; boardId: string }` to the WS frame union; add state `const [lastBoardUpdate, setLastBoardUpdate] = useState<{ boardId: string; seq: number } | null>(null);` and a `const boardSeq = useRef(0);`; in `onmessage`, before the utterance fallthrough:

```ts
        if (frame.type === "board-updated") {
          setLastBoardUpdate({ boardId: frame.boardId, seq: ++boardSeq.current });
          return;
        }
```

Export `lastBoardUpdate` from the hook's return object.

- [ ] **Step 2: Failing tests** — create `control-plane/src/organisms/BoardStage.test.tsx`:

```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardStage } from "./BoardStage";

const BOARD = {
  id: "alpha", name: "Alpha", columns: [
    { id: "backlog", name: "Backlog" }, { id: "ready", name: "Ready" },
    { id: "in-progress", name: "In Progress" }, { id: "in-review", name: "In Review" }, { id: "done", name: "Done" },
  ],
  cards: [
    { id: "c1", title: "Write the spec", columnId: "backlog", order: 0 },
    { id: "c2", title: "Fix login", columnId: "ready", order: 0, jira: { key: "PROJ-1", url: "https://a/browse/PROJ-1" } },
    { id: "c3", title: "Ship avatars", columnId: "in-progress", order: 0, delegation: { agentId: "minerva", taskId: "t1", state: "working" } },
  ],
};
const ROSTER = [{ id: "minerva", name: "Minerva", role: "Security", ring: "#5fd0b0", avatar: "minerva.png" }];

function stubFetch(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as Response;
    if (url.endsWith("/work/boards") && method === "GET") return respond(overrides.boards ?? { boards: [BOARD], errors: [] });
    if (url.endsWith("/work/boards") && method === "POST") return respond(overrides.created ?? { ...BOARD, id: "beta", name: "Beta", cards: [] }, 201);
    if (url.includes("/cards") && method === "POST") return respond({ id: "new", title: "New card", columnId: "backlog", order: 1 }, 201);
    if (method === "PATCH") return respond(overrides.patched ?? {});
    return respond({});
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

describe("BoardStage", () => {
  beforeEach(() => stubFetch());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders columns and cards of the first board", async () => {
    stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    expect(await screen.findByText("Backlog")).toBeTruthy();
    expect(screen.getByText("Write the spec")).toBeTruthy();
    expect(screen.getByText("PROJ-1")).toBeTruthy();
  });

  it("shows the delegated card's agent badge from the roster", async () => {
    stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Ship avatars");
    expect(screen.getByLabelText(/minerva is working on this card/i)).toBeTruthy();
  });

  it("adds a card through the composer", async () => {
    const { calls } = stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.click(screen.getByRole("button", { name: /add card/i }));
    await userEvent.type(screen.getByPlaceholderText(/card title/i), "New card");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.includes("/work/boards/alpha/cards"))).toBe(true));
  });

  it("creates a board from a template via the switcher", async () => {
    const { calls } = stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.click(screen.getByRole("button", { name: /new board/i }));
    await userEvent.type(screen.getByPlaceholderText(/board name/i), "Beta");
    await userEvent.selectOptions(screen.getByLabelText(/template/i), "capability");
    await userEvent.click(screen.getByRole("button", { name: /create board/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/work/boards") && (c.body as { template?: string })?.template === "capability")).toBe(true));
  });

  it("refetches when lastBoardUpdate names the open board", async () => {
    const { calls } = stubFetch();
    const { rerender } = render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    const before = calls.filter((c) => c.url.endsWith("/work/boards")).length;
    rerender(<BoardStage open roster={ROSTER} lastBoardUpdate={{ boardId: "alpha", seq: 1 }} onClose={vi.fn()} />);
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/work/boards")).length).toBeGreaterThan(before));
  });
});
```

- [ ] **Step 3: Run to verify failure** — `cd control-plane && npx vitest run src/organisms/BoardStage.test.tsx` → FAIL (component missing).

- [ ] **Step 4: Implement `BoardCard.tsx`**:

```tsx
import type { RosterAgent } from "../hooks/useBrokerChat";
import { Avatar } from "../atoms/Avatar";
import type { WorkCardT } from "../organisms/BoardStage";

const BASE = "127.0.0.1:7790";

interface BoardCardProps {
  card: WorkCardT;
  /** Roster entry for the delegated agent, when the card is delegated. */
  agent?: RosterAgent;
  onOpen: () => void;
}

/** One kanban card face: title, Jira chip, delegation badge. Pure display — drag wiring wraps it. */
export function BoardCard({ card, agent, onOpen }: BoardCardProps) {
  const d = card.delegation;
  return (
    <button type="button" className="board-card" onClick={onOpen}>
      <span className="board-card__title">{card.title}</span>
      <span className="board-card__meta">
        {card.jira && (
          <a
            className={`board-card__jira${card.jira.lastPushError ? " has-error" : ""}`}
            href={card.jira.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={card.jira.lastPushError ? `Jira push failed: ${card.jira.lastPushError}` : card.jira.key}
          >
            {card.jira.key}
          </a>
        )}
        {d && (
          <span
            className={`board-card__delegation is-${d.state}`}
            aria-label={`${agent?.name ?? d.agentId} ${d.state === "working" ? "is working on this card" : d.state === "completed" ? "finished this card's task" : "failed this card's task"}`}
          >
            <Avatar
              initial={(agent?.name ?? d.agentId)[0]?.toUpperCase() ?? "?"}
              label={agent?.name ?? d.agentId}
              ring={agent?.ring}
              image={agent?.avatar ? `http://${BASE}/avatars/${agent.avatar}` : undefined}
              state={d.state === "working" ? "working" : undefined}
            />
            {d.prUrl && (
              <a className="board-card__pr" href={d.prUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                PR
              </a>
            )}
          </span>
        )}
      </span>
    </button>
  );
}
```

- [ ] **Step 5: Implement `BoardStage.tsx`** (static version — dnd arrives in Task 6, the card sheet in Task 7; leave a plain `onOpen` no-op wiring point):

```tsx
import { Plus, SquareKanban, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RosterAgent } from "../hooks/useBrokerChat";
import { BoardCard } from "../molecules/BoardCard";

const BASE = "127.0.0.1:7790";

export interface WorkColumn { id: string; name: string; jiraStatus?: string }
export interface WorkCardT {
  id: string; title: string; notes?: string; columnId: string; order: number;
  jira?: { key: string; url: string; lastPushError?: string };
  delegation?: { agentId: string; taskId: string; state: "working" | "completed" | "failed"; prUrl?: string };
  stories?: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>;
}
export interface WorkBoardT {
  id: string; name: string; columns: WorkColumn[]; cards: WorkCardT[];
  jira?: { connectorId: string; siteUrl: string; projectKey: string; jql?: string };
}

interface BoardStageProps {
  open: boolean;
  roster: RosterAgent[];
  lastBoardUpdate: { boardId: string; seq: number } | null;
  onClose: () => void;
}

/**
 * The kanban stage — the user's boards. Drag (Task 6) only ever changes the
 * user's own status; delegation state is badges on cards, never movement.
 */
export function BoardStage({ open, roster, lastBoardUpdate, onClose }: BoardStageProps) {
  const [boards, setBoards] = useState<WorkBoardT[]>([]);
  const [boardErrors, setBoardErrors] = useState<Array<{ file: string; error: string }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingCard, setAddingCard] = useState(false);
  const [cardTitle, setCardTitle] = useState("");
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [template, setTemplate] = useState<"personal" | "capability">("personal");

  const refetch = useCallback(async () => {
    try {
      const res = (await fetch(`http://${BASE}/work/boards`).then((r) => r.json())) as {
        boards?: WorkBoardT[]; errors?: Array<{ file: string; error: string }>; error?: string;
      };
      if (res.error) throw new Error(res.error);
      setBoards(res.boards ?? []);
      setBoardErrors(res.errors ?? []);
      setError(null);
      setActiveId((id) => id ?? res.boards?.[0]?.id ?? null);
    } catch {
      setError("Could not load boards — is the broker running?");
    }
  }, []);

  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);

  useEffect(() => {
    if (open && lastBoardUpdate && lastBoardUpdate.boardId === activeId) void refetch();
  }, [open, lastBoardUpdate, activeId, refetch]);

  if (!open) return null;
  const board = boards.find((b) => b.id === activeId) ?? null;
  const agentFor = (id?: string) => (id ? roster.find((a) => a.id === id) : undefined);

  const addCard = async () => {
    if (!board || !cardTitle.trim()) return;
    await fetch(`http://${BASE}/work/boards/${encodeURIComponent(board.id)}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: cardTitle.trim() }),
    }).catch(() => setError("Could not add the card"));
    setCardTitle("");
    setAddingCard(false);
    void refetch();
  };

  const createBoard = async () => {
    if (!boardName.trim()) return;
    const res = (await fetch(`http://${BASE}/work/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: boardName.trim(), template }),
    }).then((r) => r.json()).catch(() => ({ error: "unreachable" }))) as WorkBoardT & { error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    setCreatingBoard(false);
    setBoardName("");
    setActiveId(res.id);
    void refetch();
  };

  return (
    <section className="board-stage" aria-label="Work boards">
      <header className="board-stage__bar">
        <SquareKanban size={14} strokeWidth={2} />
        <select aria-label="Board" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)}>
          {boards.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <button type="button" className="settings-btn" onClick={() => setCreatingBoard((v) => !v)}>
          new board
        </button>
        <button type="button" className="settings-btn" onClick={() => setAddingCard((v) => !v)} disabled={!board}>
          <Plus size={12} strokeWidth={2} /> add card
        </button>
        <span className="spacer" />
        <button type="button" className="settings-btn" onClick={onClose} aria-label="Close board">
          <X size={12} strokeWidth={2} />
        </button>
      </header>
      {creatingBoard && (
        <div className="board-stage__composer">
          <input placeholder="Board name" value={boardName} onChange={(e) => setBoardName(e.target.value)} />
          <label>
            Template
            <select aria-label="Template" value={template} onChange={(e) => setTemplate(e.target.value as "personal" | "capability")}>
              <option value="personal">Personal</option>
              <option value="capability">Capability Pipeline</option>
            </select>
          </label>
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void createBoard()}>
            create board
          </button>
        </div>
      )}
      {addingCard && board && (
        <div className="board-stage__composer">
          <input
            placeholder="Card title"
            value={cardTitle}
            onChange={(e) => setCardTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addCard();
            }}
          />
        </div>
      )}
      {error && <p className="wizard__error">{error}</p>}
      {boardErrors.length > 0 && <p className="wizard__hint">Some board files failed to load: {boardErrors.map((e) => e.file).join(", ")}</p>}
      {board && (
        <div className="board-stage__columns">
          {board.columns.map((col) => (
            <div key={col.id} className="board-column">
              <h3 className="board-column__name">{col.name}</h3>
              <div className="board-column__cards">
                {board.cards
                  .filter((c) => c.columnId === col.id)
                  .sort((a, b) => a.order - b.order)
                  .map((card) => (
                    <BoardCard key={card.id} card={card} agent={agentFor(card.delegation?.agentId)} onOpen={() => {}} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6: CSS** — append to `components.css`:

```css
.board-stage {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: 14px;
}
.board-stage__bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.board-stage__bar .spacer {
  flex: 1;
}
.board-stage__composer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.board-stage__columns {
  display: flex;
  gap: 10px;
  flex: 1;
  min-height: 0;
  overflow-x: auto;
}
.board-column {
  flex: 0 0 220px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--pill-br);
  border-radius: 12px;
  padding: 10px;
  background: rgba(255, 255, 255, 0.02);
}
.board-column__name {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
  margin: 0;
}
.board-column__cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  min-height: 24px;
}
.board-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid var(--pill-br);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.board-card__title {
  font-size: 12.5px;
  line-height: 1.35;
}
.board-card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.board-card__jira {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--pill-br);
  color: var(--text-2);
  text-decoration: none;
}
.board-card__jira.has-error {
  border-color: #e0a15a;
  color: #e0a15a;
}
.board-card__delegation {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.board-card__delegation .avatar {
  width: 22px;
  height: 22px;
  font-size: 10px;
}
.board-card__delegation.is-completed .avatar {
  --ring: #5fd0b0;
}
.board-card__delegation.is-failed .avatar {
  --ring: #f2778f;
}
.board-card__pr {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--accent);
  color: var(--accent);
  text-decoration: none;
}
```

- [ ] **Step 7: ToolRail + HomePage** —
  - `ToolRail.tsx`: import `SquareKanban`; `TOOLS` gains `{ icon: SquareKanban, label: "Board" }`; props gain `onBoard?: () => void;` and the click dispatch gains `if (tool.label === "Board") onBoard?.();`.
  - `HomePage.tsx`: add `const [boardOpen, setBoardOpen] = useState(false);`; pass `onBoard={() => setBoardOpen((v) => !v)}` to `ToolRail`; change the `stage` slot expression so the board wins: `boardOpen ? <BoardStage open roster={roster} lastBoardUpdate={lastBoardUpdate} onClose={() => setBoardOpen(false)} /> : inspecting ? <WorkStage .../> : <VoiceStage .../>` (match the actual existing ternary; `roster` and `lastBoardUpdate` come from the existing `useBrokerChat` destructuring — add `lastBoardUpdate` to it).

- [ ] **Step 8: Run tests, full suite, biome**

Run: `cd control-plane && npx vitest run src/organisms/BoardStage.test.tsx` → PASS (5 tests); then `npx tsc --noEmit && npm test && npx biome check --write src/` → all green (baseline 101 + 5).

- [ ] **Step 9: Commit**

```bash
git add control-plane/src/organisms/BoardStage.tsx control-plane/src/molecules/BoardCard.tsx control-plane/src/organisms/BoardStage.test.tsx control-plane/src/organisms/ToolRail.tsx control-plane/src/pages/HomePage.tsx control-plane/src/hooks/useBrokerChat.ts control-plane/src/styles/components.css
git commit -m "feat(control-plane): kanban board stage — boards, columns, cards, live refetch"
```

---

### Task 6: Control-plane — drag & drop with optimistic moves

**Files:**
- Modify: `control-plane/src/organisms/BoardStage.tsx`
- Modify: `control-plane/src/organisms/BoardStage.test.tsx`
- Modify: `control-plane/src/styles/components.css` (drag affordance styles)

**Interfaces:**
- Consumes: Task 5's `BoardStage` internals; `PATCH /work/boards/:id/cards/:cardId` `{columnId?, order}` (Task 2). dnd-kit patterns from `AgentRoster.tsx` (PointerSensor distance 6, `pointerWithin`, `SortableContext`/`useSortable`, `CSS.Transform.toString`).
- Produces: `moveCard(board, cardId, columnId, order)` exported from `BoardStage.tsx` — pure optimistic-state computer, unit-testable: returns a NEW `WorkBoardT` with the card moved and both columns renumbered (mirror of the swarm's `patchCard` semantics).

- [ ] **Step 1: Failing tests** — append to `BoardStage.test.tsx`:

```tsx
import { moveCard } from "./BoardStage";

describe("moveCard (optimistic mirror of the server move)", () => {
  const board = () => ({
    ...BOARD,
    cards: [
      { id: "a", title: "a", columnId: "ready", order: 0 },
      { id: "b", title: "b", columnId: "ready", order: 1 },
      { id: "c", title: "c", columnId: "done", order: 0 },
    ],
  });

  it("moves across columns at the target index and renumbers both", () => {
    const next = moveCard(board(), "a", "done", 0);
    const inCol = (col: string) => next.cards.filter((c) => c.columnId === col).sort((x, y) => x.order - y.order).map((c) => c.id);
    expect(inCol("done")).toEqual(["a", "c"]);
    expect(inCol("ready")).toEqual(["b"]);
    expect(next.cards.find((c) => c.id === "b")?.order).toBe(0);
  });

  it("reorders within a column", () => {
    const next = moveCard(board(), "b", "ready", 0);
    expect(next.cards.filter((c) => c.columnId === "ready").sort((x, y) => x.order - y.order).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("returns a new object and never mutates the input", () => {
    const b = board();
    const snapshot = JSON.stringify(b);
    moveCard(b, "a", "done", 1);
    expect(JSON.stringify(b)).toBe(snapshot);
  });
});

describe("BoardStage drag wiring", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a drop PATCHes the moved card with columnId and order and applies optimistically", async () => {
    const { calls } = stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    // Drag simulation via dnd-kit is brittle in jsdom — call the exported
    // handler contract instead: the component wires handleCardDrop(cardId,
    // columnId, index) into DndContext. Assert through the module seam.
    const stage = screen.getByLabelText("Work boards");
    expect(stage).toBeTruthy();
    // The drop handler is exercised through moveCard tests above + the PATCH
    // assertion here via the exposed test hook:
    const { fireDrop } = await import("./BoardStage");
    await fireDrop("c1", "ready", 0);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/cards/c1") && (c.body as { columnId?: string })?.columnId === "ready")).toBe(true),
    );
  });
});
```

**Note to implementer:** the `fireDrop` seam above is a deliberate testing affordance — export a module-level function that the mounted component registers its drop handler into (set in a `useEffect`, cleared on unmount), exactly like the test uses it. Document it with a comment: `// Test seam: jsdom cannot synthesize dnd-kit pointer sequences; the drop handler is registered here so tests can invoke the exact code path a real drop takes.` If you find a cleaner established pattern in the repo for testing dnd, use it and adapt the test — the requirement is that the REAL drop handler (not a copy) is exercised.

- [ ] **Step 2: Run to verify failure** — `cd control-plane && npx vitest run src/organisms/BoardStage.test.tsx` → new tests FAIL.

- [ ] **Step 3: Implement** — in `BoardStage.tsx`:
  - Export the pure move:

```tsx
/** Optimistic mirror of the server's move: new board object, both columns renumbered. */
export function moveCard(board: WorkBoardT, cardId: string, columnId: string, order: number): WorkBoardT {
  const cards = board.cards.map((c) => ({ ...c }));
  const card = cards.find((c) => c.id === cardId);
  if (!card) return board;
  const from = card.columnId;
  const siblings = cards.filter((c) => c.columnId === columnId && c.id !== cardId).sort((a, b) => a.order - b.order);
  const at = Math.max(0, Math.min(order, siblings.length));
  card.columnId = columnId;
  siblings.splice(at, 0, card);
  siblings.forEach((c, i) => {
    c.order = i;
  });
  if (from !== columnId) {
    cards.filter((c) => c.columnId === from).sort((a, b) => a.order - b.order).forEach((c, i) => {
      c.order = i;
    });
  }
  return { ...board, cards };
}
```

  - Wrap the column area in `DndContext` (sensors: `useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))`, `collisionDetection: pointerWithin`); each column's card list is a `SortableContext` (`items` = that column's sorted card ids, `verticalListSortingStrategy`); each card wrapper uses `useSortable({ id: card.id })` with `CSS.Transform.toString`; each column body also registers `useDroppable({ id: `column:${col.id}` })` so drops on empty columns resolve.
  - `handleDragEnd`: resolve the target column + index — if `over` is a card id, target column = that card's `columnId`, index = that card's current index within the sorted column (dropping below when the active card came from above, mirroring `arrayMove` semantics); if `over` is `column:<id>`, target index = end of that column. Then:

```tsx
  const applyMove = async (cardId: string, columnId: string, order: number) => {
    if (!board) return;
    const previous = board;
    const next = moveCard(board, cardId, columnId, order);
    setBoards((all) => all.map((b) => (b.id === next.id ? next : b)));
    const res = await fetch(`http://${BASE}/work/boards/${encodeURIComponent(board.id)}/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ columnId, order }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setBoards((all) => all.map((b) => (b.id === previous.id ? previous : b)));
      setError("Move failed — restored the previous order");
      return;
    }
    void refetch(); // pick up server-side effects (renumber, jira lastPushError)
  };
```

  - Register the test seam:

```tsx
// Test seam: jsdom cannot synthesize dnd-kit pointer sequences; the drop
// handler is registered here so tests can invoke the exact code path a real
// drop takes.
let dropHandler: ((cardId: string, columnId: string, order: number) => Promise<void>) | null = null;
export async function fireDrop(cardId: string, columnId: string, order: number): Promise<void> {
  if (!dropHandler) throw new Error("BoardStage is not mounted");
  await dropHandler(cardId, columnId, order);
}
```

  with `useEffect(() => { dropHandler = applyMove; return () => { dropHandler = null; }; })` inside the component, and `handleDragEnd` delegating to `applyMove`.

- [ ] **Step 4: Drag affordance CSS** — append:

```css
.board-card.is-dragging {
  opacity: 0.4;
}
.board-column.is-over {
  border-color: var(--accent);
}
```

(Wire `is-dragging` from `useSortable().isDragging` and `is-over` from `useDroppable().isOver`.)

- [ ] **Step 5: Run tests + full suite + biome** — `cd control-plane && npx vitest run src/organisms/BoardStage.test.tsx` → PASS; `npx tsc --noEmit && npm test && npx biome check --write src/` → green.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/organisms/BoardStage.tsx control-plane/src/organisms/BoardStage.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): board drag-and-drop with optimistic moves and rollback"
```

---

### Task 7: Control-plane — card sheet (edit, Jira link/import, delegate)

**Files:**
- Create: `control-plane/src/organisms/CardSheet.tsx`
- Modify: `control-plane/src/organisms/BoardStage.tsx` (open sheet on card click; Import-from-Jira button in the bar)
- Modify: `control-plane/src/organisms/BoardStage.test.tsx`
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Consumes: `PATCH`/`DELETE` card routes, `POST /work/boards/:id/jira/import` (Task 3), `POST /work/delegate` (Task 4), `RosterAgent` (`status`, `engineWarning` fields as present on the roster type — disable busy agents with the reason, mirroring the AddAgentChooser convention).
- Produces: `CardSheet` props `{ board: WorkBoardT; card: WorkCardT; roster: RosterAgent[]; workspaces: string[]; onClose: () => void; onChanged: () => void }`. BoardStage passes `workspaces` from a `GET http://${BASE}/workspaces` fetch on open (the broker route exists; response `{workspaces: [{name, ...}]}` — map to names).

- [ ] **Step 1: Failing tests** — append to `BoardStage.test.tsx` (extend `stubFetch` with `/work/delegate`, `/jira/import`, `/workspaces` routes in the same URL-suffix style; capture bodies):

```tsx
describe("CardSheet", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function openSheet(cardTitle: string) {
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText(cardTitle));
  }

  it("edits title and notes via PATCH", async () => {
    const { calls } = stubFetch();
    await openSheet("Write the spec");
    const title = screen.getByLabelText(/^title$/i);
    await userEvent.clear(title);
    await userEvent.type(title, "Write the better spec");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/cards/c1") && (c.body as { title?: string })?.title === "Write the better spec")).toBe(true));
  });

  it("stories: add + toggle are sent wholesale on save, toggle stamps verifiedBy", async () => {
    const { calls } = stubFetch();
    await openSheet("Write the spec");
    await userEvent.type(screen.getByPlaceholderText(/add a story/i), "user can log in{Enter}");
    await userEvent.type(screen.getByPlaceholderText(/add a story/i), "reload keeps session{Enter}");
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/c1"));
      const stories = (call?.body as { stories?: Array<{ text: string; done: boolean; verifiedBy?: string }> })?.stories;
      expect(stories?.map((s) => [s.text, s.done])).toEqual([["user can log in", true], ["reload keeps session", false]]);
      expect(stories?.[0].verifiedBy).toMatch(/^manual /);
    });
  });

  it("delegates through POST /work/delegate with the card prompt and binds", async () => {
    const { calls } = stubFetch();
    await openSheet("Write the spec");
    await userEvent.click(screen.getByRole("button", { name: /send to agent/i }));
    await userEvent.selectOptions(screen.getByLabelText(/agent/i), "minerva");
    await userEvent.selectOptions(screen.getByLabelText(/workspace/i), "acme");
    await userEvent.click(screen.getByRole("button", { name: /^delegate$/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.endsWith("/work/delegate"));
      expect(call).toBeTruthy();
      expect(call?.body).toMatchObject({ boardId: "alpha", cardId: "c1", agentId: "minerva", workspace: "acme" });
      expect(String((call?.body as { prompt?: string })?.prompt)).toContain("Write the spec");
    });
  });

  it("busy agents are disabled in the picker with the reason", async () => {
    stubFetch();
    const busyRoster = [{ ...ROSTER[0], status: "busy" as const }];
    render(<BoardStage open roster={busyRoster} lastBoardUpdate={null} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByText("Write the spec"));
    await userEvent.click(screen.getByRole("button", { name: /send to agent/i }));
    const option = screen.getByRole("option", { name: /minerva.*busy/i }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it("links a Jira key and shows the import button only on jira-linked boards", async () => {
    const { calls } = stubFetch({ boards: { boards: [{ ...BOARD, jira: { connectorId: "atl-1", siteUrl: "https://a.net", projectKey: "PROJ" } }], errors: [] } });
    await openSheet("Write the spec");
    await userEvent.type(screen.getByPlaceholderText(/proj-123/i), "PROJ-7");
    await userEvent.click(screen.getByRole("button", { name: /link jira/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && (c.body as { jira?: { key?: string } })?.jira?.key === "PROJ-7")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: /close card/i }));
    expect(screen.getByRole("button", { name: /import from jira/i })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /import from jira/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/jira/import"))).toBe(true));
  });

  it("deletes a card", async () => {
    const { calls } = stubFetch();
    await openSheet("Write the spec");
    await userEvent.click(screen.getByRole("button", { name: /delete card/i }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/cards/c1"))).toBe(true));
  });
});
```

- [ ] **Step 2: Run to verify failure** — new tests FAIL (no sheet).

- [ ] **Step 3: Implement `CardSheet.tsx`**:

```tsx
import { Send, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { RosterAgent } from "../hooks/useBrokerChat";
import type { WorkBoardT, WorkCardT } from "./BoardStage";

const BASE = "127.0.0.1:7790";

interface CardSheetProps {
  board: WorkBoardT;
  card: WorkCardT;
  roster: RosterAgent[];
  workspaces: string[];
  onClose: () => void;
  /** Fired after any successful mutation so the stage refetches. */
  onChanged: () => void;
}

/** Card detail: edit, Jira link/unlink, explicit Send-to-agent, delete. */
export function CardSheet({ board, card, roster, workspaces, onClose, onChanged }: CardSheetProps) {
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes ?? "");
  const [jiraKey, setJiraKey] = useState("");
  const [stories, setStories] = useState(card.stories ?? []);
  const [storyText, setStoryText] = useState("");
  const [delegating, setDelegating] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [workspace, setWorkspace] = useState(workspaces[0] ?? "");
  const [prompt, setPrompt] = useState(`${card.title}${card.notes ? `\n\n${card.notes}` : ""}`);
  const [error, setError] = useState<string | null>(null);

  const cardUrl = `http://${BASE}/work/boards/${encodeURIComponent(board.id)}/cards/${encodeURIComponent(card.id)}`;
  const patch = async (body: unknown) => {
    const res = await fetch(cardUrl, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!res?.ok) {
      setError("Update failed");
      return false;
    }
    onChanged();
    return true;
  };

  const save = async () => {
    // Stories are replaced wholesale — the whole checklist rides the single PATCH.
    if (await patch({ title, notes, stories })) onClose();
  };

  const linkJira = async () => {
    const key = jiraKey.trim().toUpperCase();
    if (!key || !board.jira) return;
    await patch({ jira: { key, url: `${board.jira.siteUrl.replace(/\/$/, "")}/browse/${key}` } });
    setJiraKey("");
  };

  const unlinkJira = async () => patch({ jira: null });

  const remove = async () => {
    const res = await fetch(cardUrl, { method: "DELETE" }).catch(() => null);
    if (res?.ok) {
      onChanged();
      onClose();
    } else setError("Delete failed");
  };

  const delegate = async () => {
    const res = (await fetch(`http://${BASE}/work/delegate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ boardId: board.id, cardId: card.id, agentId, workspace: workspace || undefined, prompt }),
    })
      .then((r) => r.json())
      .catch(() => ({ error: "Broker unreachable" }))) as { taskId?: string; error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    onChanged();
    onClose();
  };

  return (
    <div className="card-sheet" role="dialog" aria-label={`Card: ${card.title}`}>
      <header className="card-sheet__head">
        <b>{card.title}</b>
        <button type="button" className="settings-btn" onClick={onClose} aria-label="Close card">
          <X size={12} strokeWidth={2} />
        </button>
      </header>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Notes
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="card-sheet__stories">
        <span className="card-sheet__stories-head">Stories</span>
        {stories.map((s) => (
          <label key={s.id} className="card-sheet__story" title={s.verifiedBy ? `verified: ${s.verifiedBy}` : undefined}>
            <input
              type="checkbox"
              checked={s.done}
              onChange={(e) =>
                setStories((list) =>
                  list.map((x) =>
                    x.id === s.id
                      ? {
                          ...x,
                          done: e.target.checked,
                          verifiedBy: e.target.checked ? (x.verifiedBy ?? `manual ${new Date().toISOString().slice(0, 10)}`) : undefined,
                        }
                      : x,
                  ),
                )
              }
            />
            <span className={s.done ? "is-done" : ""}>{s.text}</span>
            <button
              type="button"
              className="card-sheet__story-remove"
              aria-label={`Remove story: ${s.text}`}
              onClick={() => setStories((list) => list.filter((x) => x.id !== s.id))}
            >
              <X size={10} strokeWidth={2} />
            </button>
          </label>
        ))}
        <input
          placeholder="Add a story…"
          value={storyText}
          onChange={(e) => setStoryText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && storyText.trim()) {
              setStories((list) => [...list, { id: crypto.randomUUID(), text: storyText.trim(), done: false }]);
              setStoryText("");
            }
          }}
        />
      </div>
      {board.jira &&
        (card.jira ? (
          <div className="card-sheet__row">
            <a href={card.jira.url} target="_blank" rel="noreferrer">{card.jira.key}</a>
            {card.jira.lastPushError && <span className="wizard__error">push failed: {card.jira.lastPushError}</span>}
            <button type="button" className="settings-btn" onClick={() => void unlinkJira()}>
              unlink jira
            </button>
          </div>
        ) : (
          <div className="card-sheet__row">
            <input placeholder="PROJ-123" value={jiraKey} onChange={(e) => setJiraKey(e.target.value)} />
            <button type="button" className="settings-btn" onClick={() => void linkJira()}>
              link jira
            </button>
          </div>
        ))}
      {!card.delegation && (
        <button type="button" className="settings-btn" onClick={() => setDelegating((v) => !v)}>
          <Send size={12} strokeWidth={2} /> send to agent
        </button>
      )}
      {delegating && (
        <div className="card-sheet__delegate">
          <label>
            Agent
            <select aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">— pick an agent —</option>
              {roster
                .filter((a) => !a.members)
                .map((a) => (
                  <option key={a.id} value={a.id} disabled={a.status === "busy"}>
                    {a.name}
                    {a.status === "busy" ? " — busy" : ""}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Workspace
            <select aria-label="Workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w} value={w}>{w}</option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <button type="button" className="settings-btn settings-btn--primary" disabled={!agentId || !prompt.trim()} onClick={() => void delegate()}>
            delegate
          </button>
        </div>
      )}
      {error && <p className="wizard__error">{error}</p>}
      <footer className="card-sheet__foot">
        <button type="button" className="settings-btn" onClick={() => void remove()}>
          <Trash2 size={12} strokeWidth={2} /> delete card
        </button>
        <button type="button" className="settings-btn settings-btn--primary" onClick={() => void save()}>
          save
        </button>
      </footer>
    </div>
  );
}
```

- [ ] **Step 4: Wire into BoardStage** — `const [openCardId, setOpenCardId] = useState<string | null>(null);`; card `onOpen={() => setOpenCardId(card.id)}`; render the sheet as an overlay inside the stage when the open card exists (`board.cards.find(...)`), with `onChanged={() => void refetch()}`; fetch workspaces once when the stage opens (`GET http://${BASE}/workspaces` → `setWorkspaces((res.workspaces ?? []).map((w) => w.name))` — verify the actual response field names against `useBrokerChat`'s existing workspace handling and reuse its shape); add the bar button `{board?.jira && <button ... onClick={importFromJira}>import from jira</button>}` where `importFromJira` POSTs `/work/boards/:id/jira/import`, surfaces `{error}` via `setError`, then refetches.

- [ ] **Step 5: CSS** — append:

```css
.card-sheet {
  position: absolute;
  right: 16px;
  top: 52px;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--pill-br);
  background: var(--panel, rgba(20, 20, 24, 0.97));
  z-index: 30;
}
.card-sheet__head,
.card-sheet__row,
.card-sheet__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: space-between;
}
.card-sheet__delegate,
.card-sheet__stories {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.card-sheet__stories-head {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-dim);
}
.card-sheet__story {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.card-sheet__story .is-done {
  text-decoration: line-through;
  color: var(--text-dim);
}
.card-sheet__story-remove {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
}
```

(`.board-stage` needs `position: relative;` — add it to the Task 5 rule.)

- [ ] **Step 6: Run tests + full suite + biome** — `cd control-plane && npx vitest run src/organisms/BoardStage.test.tsx` → PASS (14 tests); `npx tsc --noEmit && npm test && npx biome check --write src/` → green.

- [ ] **Step 7: Commit**

```bash
git add control-plane/src/organisms/CardSheet.tsx control-plane/src/organisms/BoardStage.tsx control-plane/src/organisms/BoardStage.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): card sheet — edit, jira link/import, explicit send-to-agent"
```

---

### Task 8: Live smoke test

**Needs the running stack** (swarm + broker + UI from the current checkout, restarted to pick up the new code).

- [ ] **Step 1:** Restart `smith-swarm` and `smith-broker` tmux sessions (Ctrl-C + `npm run serve` inside each — never unscoped pkill), reload the UI.
- [ ] **Step 2:** Open the Board tool → create a board from each template → add cards → drag across columns and reorder → reload the app → confirm order and columns survived (files under `swarm/.smith/work/`).
- [ ] **Step 3:** Open a card → Send to agent → pick an idle agent + workspace → delegate → card shows the working badge; when the task completes, the badge flips (green/PR or red) WITHOUT the card changing column, and the board refreshes via the `board-updated` frame.
- [ ] **Step 4:** If a Jira-linked workspace connector is available: link the board (PATCH its `jira` config via the UI-less route for now is out of scope — configure by editing the board file), import, move a linked card onto a column with `jiraStatus` set, verify the transition (or the amber badge on failure).
- [ ] **Step 5:** Delete the smoke-test board(s) via the API (`DELETE /work/boards/:id`) or leave them if useful. Report findings; fix small breakages inline with tests.

---

## Self-Review (run after writing, fixed inline)

- **Spec coverage:** stories checklist field + wholesale PATCH + sheet UI with verifiedBy stamping ✓(T1/T5/T7 addendum steps) · boards-as-data + two templates ✓(T1) · one-file-per-board persistence + malformed isolation ✓(T1) · CRUD routes ✓(T2) · reset archival ✓(T2) · completion patches delegation state, never column ✓(T2 hook + spec-delta note) · `workCardRef` event enrichment ✓(T2) · Jira search/import/transition + best-effort push ✓(T3) · broker proxy ✓(T4) · `dispatchWork` refactor + `POST /work/delegate` + card binding ✓(T4) · `board-updated` frame ✓(T4 + T5 plumbing) · stage mode + ToolRail button ✓(T5) · switcher/templates/add-card ✓(T5) · drag with optimistic move + rollback ✓(T6) · card sheet edit/Jira link/delegate picker (busy disabled)/delete ✓(T7) · degraded modes (broker down banner, board file errors, delegate refusal inline) ✓(T5/T7) · testing per package ✓(T1-T7) · live smoke ✓(T8).
- **Spec gaps deliberately narrowed:** configuring a board's `jira` link has API support (`PATCH /work/boards/:id`) but no dedicated settings UI in v1 (smoke test edits the file / uses the API; the sheet links individual cards). Board rename/delete likewise API-only. Both noted for a fast-follow.
- **Placeholder scan:** none; Task 4 Step 2's test sketches name exact behaviors and instruct mirroring existing fixtures — the assertions are specified. Task 6's `fireDrop` seam is fully specified with rationale.
- **Type consistency:** `WorkBoard`/`WorkCard` (swarm) match `WorkBoardT`/`WorkCardT` (UI) field-for-field incl. the `siteUrl` delta; `patchCard` patch fields = PATCH route body = UI PATCH bodies; `dispatchWork` input/output shapes consistent between broker.ts, main.ts wiring, and route tests; `board-updated` frame shape identical in text-channel, main.ts, and useBrokerChat.
