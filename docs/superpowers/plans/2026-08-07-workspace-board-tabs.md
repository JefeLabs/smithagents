# Workspace Board Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-template board registry with `personal` + six typed workflow boards, let a workspace hold one board per type navigated by tabs, add a workspace dropdown with a cross-workspace aggregate view, cross-board route pills, and in-place card flags.

**Architecture:** `WorkBoard` gains a persisted `type` — the identity that tabs, one-per-type cardinality, and cross-board routing all key off. Two static data tables in the swarm (`BOARD_TEMPLATES`, `BOARD_ROUTES`) define the whole workflow; routes stay thin and every mutation goes through pure helpers in `work-items.ts` that unit tests exercise without booting a server. The control plane gains a pure aggregation module so the tab/cluster logic is testable without React.

**Tech Stack:** TypeScript. Swarm: Fastify, `node:test` + `node:assert/strict`, tsx. Control plane: React 19, dnd-kit, vitest + @testing-library/react, biome.

## Global Constraints

- **`swarm` and `control-plane` are both pnpm packages** (`pnpm-lock.yaml` tracked in each). `broker` and `voice` are still npm — do not touch them in this plan. Never run `npm install` anywhere.
- Do not run a bare `pnpm install`. Dependencies are installed and working. `swarm/pnpm-workspace.yaml` carries `allowBuilds: esbuild: true`; without it every pnpm script in swarm aborts on `[ERR_PNPM_IGNORED_BUILDS]` before running. If you ever hit that error, the fix is `pnpm --dir swarm approve-builds --all`, not switching tools.
- The four commands, all verified working from the repo root and safe to chain with `&&`:
  - Swarm tests — `pnpm --dir swarm test`
  - Swarm typecheck — `pnpm --dir swarm typecheck`
  - Control-plane tests — `pnpm --dir control-plane test`
  - Control-plane typecheck — `pnpm --dir control-plane typecheck`
- Green baseline: swarm 253 tests passing, control-plane 234 tests across 33 files, both typechecks clean, biome clean bar 5 pre-existing warnings. Any of these going red is your regression.
- Swarm has **no biome**. Control plane does — run `pnpm --dir control-plane exec biome check --write src` before committing control-plane changes.
- Swarm imports use the `.js` extension (`from './work-items.js'`) even for `.ts` sources.
- **tsc 6.0.3 narrowing trap in swarm tests:** `assert.equal(<expr>, undefined)` narrows `<expr>` to `never` for every later use of that same expression, so a subsequent `<expr>?.prop` fails to compile ("Property does not exist on type 'never'") — the optional chain does not save you. Capture into a local first: `const cleared = b.cards[0].flag; assert.equal(cleared, undefined);`. Only bites when the same expression is reused after the assert.
- Swarm test files use `node:test` + `node:assert/strict`; no vitest in the swarm. The suite spans `src/*.test.ts` **and** `src/**/*.test.ts` — `src/drivers/` holds 19 of the 253 tests, so never run only the top-level glob.
- Board files live at `.smith/work/<id>.json`, resolved from the swarm's cwd via `server.workDir()`.
- `BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/` — board ids are filenames; never relax this.
- Work on branch `workspace-board-tabs`, which already carries the spec at `docs/superpowers/specs/2026-08-07-workspace-board-tabs-design.md`.
- Never run an unscoped `pkill -f`. The live broker runs in tmux session `smith-broker` on port 7790 from the main checkout.
- Typecheck both packages before every commit: `pnpm --dir swarm typecheck` and `pnpm --dir control-plane typecheck`.

## File Structure

**Swarm (`swarm/src/`)**
- `work-items.ts` — board/card data model, the two registries, and every pure mutation helper. Grows by ~120 lines; stays one file because templates, routes, and the helpers that read them change together.
- `work-items.test.ts` — unit tests for all of the above.
- `capabilities.ts` — provisioning (`ensureWorkspaceBoards`) retargets; `workspaceBoardId` is replaced by `boardIdFor` imported from `work-items.ts`.
- `workspaces.ts` — optional `color` on `Workspace`.
- `server.ts` — board routes: create, route-a-card, personal ensure, flag patch, slice-send remap.

**Control plane (`control-plane/src/`)**
- `lib/board-aggregate.ts` — **new.** Pure: tab derivation, addable types, card collection, workspace clustering. No React, no fetch.
- `lib/workspace-color.ts` — **new.** Pure: the eight-hue palette, name hash, and resolution of an explicit colour over the derived default.
- `molecules/BoardTabs.tsx` — **new.** The workspace dropdown plus the tab row and its `+ add` control.
- `molecules/BoardColumn.tsx` — **new.** Extracted from `BoardStage`; renders clusters instead of a flat list.
- `molecules/BoardCard.tsx` — flag chip, flag left edge, workspace tint.
- `organisms/BoardStage.tsx` — orchestration only: fetch, scope/tab state, drag wiring.
- `organisms/CardSheet.tsx` — flag control and route pills.
- `organisms/NewWorkspaceModal.tsx`, `organisms/WorkspaceManagerModal.tsx` — colour swatch row.
- `styles/components.css` — tabs, clusters, flags, tint.

Tasks 1–5 are swarm-only and land a complete, tested API. Task 6 is the destructive wipe. Tasks 7–12 build the UI on top.

---

### Task 1: BoardType and the seven templates

Replaces the five-template registry. `type` becomes a required, persisted field and `createBoard` stops deriving ids from names. Call sites are updated in this task so both packages typecheck at the end of it.

**Files:**
- Modify: `swarm/src/work-items.ts:12-94`
- Modify: `swarm/src/capabilities.ts:181-197`
- Modify: `swarm/src/server.ts:2037-2054` (create route), `swarm/src/server.ts:118` (import)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BoardType`, `BOARD_TEMPLATES`, `BOARD_TYPE_LABELS`, `BOARD_TYPE_ORDER`, `WORKSPACE_BOARD_TYPES`, `boardIdFor(workspaceId, type)`, `createBoard(type, workspaceId?)`, and `WorkBoard.type`.

- [ ] **Step 1: Write the failing test**

Add to `swarm/src/work-items.test.ts`, and **delete the existing `templates: five column sets…` test at lines 10-20** plus the two `createBoard` tests at lines 22-43 which assert the old signature:

```ts
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
```

Update the import at the top of the file to pull in the new names:

```ts
import {
  addCard, BOARD_TEMPLATES, BOARD_TYPE_ORDER, boardIdFor, type BoardType, createBoard,
  deleteBoardFile, loadBoards, patchCard, removeCard, saveBoard, WORKSPACE_BOARD_TYPES,
} from './work-items.js';
```

Three surviving tests construct boards with the old signature. Change them:
- line 46, 57, 74, 86, 114 area: `createBoard('t', 'personal')` becomes `createBoard('personal')`.
- line 99: `createBoard('Alpha', 'capabilities')` becomes `createBoard('plan', 'alpha')`, and the assertion `boards.map((x) => x.id)` expects `['alpha-plan']`, the readFile path becomes `alpha-plan.json`, and `deleteBoardFile(dir, 'alpha')` becomes `deleteBoardFile(dir, 'alpha-plan')`.
- The `patchCard moves between columns` test at line 57 indexes `b.columns[1]` and `b.columns[2]`; personal now has 4 columns so those indices still resolve — no change needed beyond the constructor.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swarm && node --import tsx --test src/work-items.test.ts`
Expected: FAIL — `BOARD_TYPE_ORDER is not exported`, and `createBoard` arity assertions fail.

- [ ] **Step 3: Rewrite the registry and creation in `work-items.ts`**

Replace lines 36-94 (the `WorkBoard` interface through the end of `createBoard`) with:

```ts
export interface WorkBoard {
  id: string;
  name: string;
  /** Persisted board identity — drives tabs, one-per-type cardinality, and routing. */
  type: BoardType;
  columns: WorkColumn[];
  cards: WorkCard[];
  jira?: { connectorId: string; siteUrl: string; projectKey: string; jql?: string };
  /** Present on every workspace board; absent only on the single personal board. */
  workspaceId?: string;
}

const BOARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type BoardType =
  | 'personal' | 'ideation' | 'plan' | 'deliver'
  | 'release'  | 'reactive' | 'maintenance';

/** Tab order. personal is always last; the other six are the workspace types. */
export const BOARD_TYPE_ORDER: BoardType[] = [
  'ideation', 'plan', 'deliver', 'release', 'reactive', 'maintenance', 'personal',
];

export const WORKSPACE_BOARD_TYPES: BoardType[] = BOARD_TYPE_ORDER.filter((t) => t !== 'personal');

export const BOARD_TYPE_LABELS: Record<BoardType, string> = {
  personal: 'Personal',
  ideation: 'Ideation',
  plan: 'Plan',
  deliver: 'Deliver',
  release: 'Release',
  reactive: 'Reactive',
  maintenance: 'Maintenance',
};

// Boards that own an outcome get a terminal column (Killed / Won't do / Not
// Doing); boards that hand work onward get an exit in BOARD_ROUTES instead,
// which is why plan and deliver have neither.
export const BOARD_TEMPLATES: Record<BoardType, WorkColumn[]> = {
  personal: [
    { id: 'todo', name: 'Todo' },
    { id: 'doing', name: 'Doing' },
    { id: 'done', name: 'Done' },
    { id: 'not-doing', name: 'Not Doing' },
  ],
  ideation: [
    { id: 'intake', name: 'Intake' },
    { id: 'scoping', name: 'Scoping' },
    { id: 'confirm', name: 'Confirm' },
    { id: 'killed', name: 'Killed' },
  ],
  plan: [
    { id: 'spec', name: 'Spec' },
    { id: 'tech-design', name: 'Tech design' },
    { id: 'decomposed', name: 'Decomposed' },
    { id: 'ready', name: 'Ready' },
  ],
  deliver: [
    { id: 'ready', name: 'Ready' },
    { id: 'in-progress', name: 'In progress' },
    { id: 'review', name: 'Review' },
    { id: 'verify', name: 'Verify' },
    { id: 'merged', name: 'Merged' },
  ],
  release: [
    { id: 'cut', name: 'Cut' },
    { id: 'regression', name: 'Regression' },
    { id: 'sign-off', name: 'Sign-off' },
    { id: 'ship', name: 'Ship' },
    { id: 'rollback', name: 'Rollback' },
  ],
  reactive: [
    { id: 'triage', name: 'Triage' },
    { id: 'diagnose', name: 'Diagnose' },
    { id: 'fix', name: 'Fix' },
    { id: 'verify', name: 'Verify' },
    { id: 'closed', name: 'Closed' },
  ],
  maintenance: [
    { id: 'triage', name: 'Triage' },
    { id: 'queued', name: 'Queued' },
    { id: 'doing', name: 'Doing' },
    { id: 'done', name: 'Done' },
    { id: 'wont-do', name: "Won't do" },
  ],
};

function slug(v: string): string {
  return v.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** The on-disk id (and filename) of a workspace's board of a given type. */
export function boardIdFor(workspaceId: string, type: BoardType): string {
  return `${slug(workspaceId)}-${type}`;
}

/**
 * Mint a board from its type. The id comes from the type, never the name, so a
 * later rename via PATCH never has to move a file.
 */
export function createBoard(type: BoardType, workspaceId?: string): WorkBoard {
  if (!BOARD_TEMPLATES[type]) throw new Error(`Unknown board type: ${type}`);
  if (type === 'personal' && workspaceId) throw new Error('The personal board belongs to no workspace');
  if (type !== 'personal' && !workspaceId) throw new Error(`Board type "${type}" requires a workspace`);
  const id = type === 'personal' ? 'personal' : boardIdFor(workspaceId as string, type);
  if (!BOARD_ID_RE.test(id)) throw new Error(`Workspace "${workspaceId}" does not reduce to a usable board id`);
  const board: WorkBoard = {
    id,
    name: BOARD_TYPE_LABELS[type],
    type,
    columns: BOARD_TEMPLATES[type].map((c) => ({ ...c })),
    cards: [],
  };
  if (workspaceId) board.workspaceId = workspaceId;
  return board;
}
```

Delete the now-duplicated `const BOARD_ID_RE` that sat at old line 46 and the old `export type BoardTemplate` line — the block above declares both once.

Then tighten `assertBoard` (old lines 96-104) so a missing type is a load error:

```ts
function assertBoard(file: string, v: unknown): WorkBoard {
  const o = v as WorkBoard;
  const ok =
    o && typeof o.id === 'string' && typeof o.name === 'string' &&
    typeof o.type === 'string' && Boolean(BOARD_TEMPLATES[o.type]) &&
    Array.isArray(o.columns) && o.columns.every((c) => typeof c?.id === 'string' && typeof c?.name === 'string') &&
    Array.isArray(o.cards);
  if (!ok) throw new Error(`Invalid work-board file ${file}: requires id, name, a known type, columns[], cards[]`);
  return o;
}
```

- [ ] **Step 4: Update the two call sites so both packages typecheck**

In `swarm/src/capabilities.ts`, delete `workspaceBoardId` (lines 181-183) and rewrite `ensureWorkspaceBoards` (lines 186-197):

```ts
/** Create the workspace's standing boards iff missing. Ideation + Plan + Deliver; the rest are on-demand. */
export async function ensureWorkspaceBoards(workDir: string, workspaceId: string): Promise<void> {
  const { boards } = await loadBoards(workDir);
  for (const type of ['ideation', 'plan', 'deliver'] as BoardType[]) {
    const board = createBoard(type, workspaceId);
    if (!boards.some((b) => b.id === board.id)) await saveBoard(workDir, board);
  }
}
```

Add `boardIdFor` and `type BoardType` to the `./work-items.js` import at the top of `capabilities.ts`, and drop the local `slugify` import if it becomes unused.

In `swarm/src/server.ts`, change the import on line 118 from `workspaceBoardId` to `boardIdFor`, and replace the two usages:
- line 2341: `boards.find((b) => b.id === boardIdFor(cap.workspaceId, target === 'capabilities' ? 'plan' : 'deliver'))`
- Replace the create-route body at lines 2038-2053 with a temporary shim so it compiles; Task 4 replaces it properly:

```ts
const b = req.body as { type?: string; workspaceId?: string };
try {
  const board = createBoard(b.type as BoardType, b.workspaceId);
  const { boards } = await loadBoards(server.workDir());
  if (boards.some((x) => x.id === board.id)) return reply.status(409).send({ error: `Board "${board.id}" already exists` });
  await saveBoard(server.workDir(), board);
  return reply.status(201).send(board);
} catch (err) {
  return reply.status(400).send({ error: String((err as Error).message) });
}
```

Also update `swarm/src/capabilities.test.ts`: any `workspaceBoardId(...)` call becomes `boardIdFor(...)`, and expected ids ending `-capabilities`/`-delivery` become `-plan`/`-deliver`.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --dir swarm test && pnpm --dir swarm typecheck`
Expected: PASS. If `server.test.ts` asserts on the old create-route body, update those assertions to the new `{type, workspaceId}` shape.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/work-items.ts swarm/src/work-items.test.ts swarm/src/capabilities.ts swarm/src/capabilities.test.ts swarm/src/server.ts
git commit -m "feat(swarm): persist BoardType; seven typed templates replace the five"
```

---

### Task 2: Cross-board routes

The static route table plus the pure helpers that resolve an exit and perform a move. Destination-first write ordering is expressed in the return value so a test can assert it.

**Files:**
- Modify: `swarm/src/work-items.ts` (append after `createBoard`)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: `BoardType`, `WorkBoard`, `WorkCard`, `addCard`, `removeCard` from Task 1.
- Produces: `RouteExit`, `BOARD_ROUTES`, `exitsFor(board, columnId): RouteExit[]`, `resolveExit(board, columnId, toType): RouteExit | undefined`, `RoutePlan`, `routeCard(source, dest, cardId, exit, now): RoutePlan`.

- [ ] **Step 1: Write the failing test**

```ts
test('routes: exits are per-column and the forward plan handoff exists', () => {
  const plan = createBoard('plan', 'acme');
  assert.deepEqual(exitsFor(plan, 'ready').map((e) => e.label), ['Send to deliver']);
  assert.deepEqual(exitsFor(plan, 'tech-design').map((e) => e.label), ['Back to ideation']);
  assert.deepEqual(exitsFor(plan, 'spec'), []);
  const reactive = createBoard('reactive', 'acme');
  assert.deepEqual(exitsFor(reactive, 'triage').map((e) => e.toType), ['maintenance', 'ideation']);
  assert.deepEqual(exitsFor(createBoard('ideation', 'acme'), 'confirm'), []);
});

test('resolveExit matches on column and destination type', () => {
  const plan = createBoard('plan', 'acme');
  assert.equal(resolveExit(plan, 'ready', 'deliver')?.toColumn, 'ready');
  assert.equal(resolveExit(plan, 'ready', 'ideation'), undefined);   // wrong destination
  assert.equal(resolveExit(plan, 'spec', 'deliver'), undefined);     // wrong column
});

test('every route points at a column that exists on its destination template', () => {
  for (const [type, exits] of Object.entries(BOARD_ROUTES)) {
    for (const e of exits) {
      assert.ok(BOARD_TEMPLATES[type as BoardType].some((c) => c.id === e.from), `${type}.${e.from} is not a column`);
      assert.ok(BOARD_TEMPLATES[e.toType].some((c) => c.id === e.toColumn), `${e.toType}.${e.toColumn} is not a column`);
    }
  }
});

test('routeCard moves the card, preserves identity and payload, and writes destination first', () => {
  const plan = createBoard('plan', 'acme');
  const deliver = createBoard('deliver', 'acme');
  const card = addCard(plan, { title: 'Parser', columnId: 'ready' });
  patchCard(plan, card.id, {
    stories: [{ id: 's1', text: 'parses', done: true }],
    jira: { key: 'P-1', url: 'https://a/browse/P-1' },
    capabilityRef: { capabilityId: 'acme-store', sliceId: 'sl1' },
  });
  const exit = resolveExit(plan, 'ready', 'deliver');
  assert.ok(exit);
  const out = routeCard(plan, deliver, card.id, exit, '2026-08-07T10:00:00.000Z');

  assert.equal(out.writeFirst, deliver);   // destination first — a crash duplicates, never loses
  assert.equal(out.writeSecond, plan);
  assert.equal(plan.cards.length, 0);
  assert.equal(deliver.cards.length, 1);
  assert.equal(out.card.id, card.id);      // same object across the boundary
  assert.equal(out.card.columnId, 'ready');
  assert.equal(out.card.order, 0);
  assert.equal(out.card.jira?.key, 'P-1');
  assert.equal(out.card.stories?.length, 1);
  assert.deepEqual(out.card.capabilityRef, { capabilityId: 'acme-store', sliceId: 'sl1' });
  assert.deepEqual(out.card.routedFrom, [
    { boardId: 'acme-plan', boardType: 'plan', columnId: 'ready', at: '2026-08-07T10:00:00.000Z' },
  ]);
});

test('routeCard appends to routedFrom across successive moves and lands last in the column', () => {
  const deliver = createBoard('deliver', 'acme');
  const plan = createBoard('plan', 'acme');
  addCard(plan, { title: 'sitting there', columnId: 'tech-design' });
  const card = addCard(deliver, { title: 'Validation', columnId: 'in-progress' });
  card.routedFrom = [{ boardId: 'acme-plan', boardType: 'plan', columnId: 'ready', at: '2026-08-06T10:00:00.000Z' }];
  const exit = resolveExit(deliver, 'in-progress', 'plan');
  assert.ok(exit);
  const out = routeCard(deliver, plan, card.id, exit, '2026-08-07T11:00:00.000Z');
  assert.equal(out.card.columnId, 'tech-design');
  assert.equal(out.card.order, 1); // behind the card already there
  assert.equal(out.card.routedFrom?.length, 2);
  assert.equal(out.card.routedFrom?.[1].boardId, 'acme-deliver');
  assert.throws(() => routeCard(deliver, plan, 'ghost', exit, '2026-08-07T11:00:00.000Z'), /card/i);
});
```

Extend the test file's import with `BOARD_ROUTES, exitsFor, resolveExit, routeCard`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swarm && node --import tsx --test src/work-items.test.ts`
Expected: FAIL — `exitsFor is not a function`.

- [ ] **Step 3: Implement in `work-items.ts`**

Add `routedFrom` to the `WorkCard` interface (after `capabilityRef`):

```ts
  /** Appended each time this card is routed to another board. Never rewritten. */
  routedFrom?: Array<{ boardId: string; boardType: BoardType; columnId: string; at: string }>;
```

Then append after `createBoard`:

```ts
export interface RouteExit {
  /** Column id on the source board this exit leaves from. */
  from: string;
  toType: BoardType;
  /** Column id on the destination board the card lands in. */
  toColumn: string;
  label: string;
}

/**
 * Cross-board transitions, static rather than per-board config: there is no UI
 * to edit a per-board table, so configurable-only-by-hand-editing-JSON is the
 * trap this avoids. Ideation's Confirm→Scoping loop is a same-board drag, and
 * Maintenance's scanner intake is descriptive — neither is a route.
 */
export const BOARD_ROUTES: Record<BoardType, RouteExit[]> = {
  plan: [
    { from: 'tech-design', toType: 'ideation', toColumn: 'scoping', label: 'Back to ideation' },
    { from: 'ready', toType: 'deliver', toColumn: 'ready', label: 'Send to deliver' },
  ],
  deliver: [
    { from: 'in-progress', toType: 'plan', toColumn: 'tech-design', label: 'Back to plan' },
  ],
  release: [
    { from: 'regression', toType: 'deliver', toColumn: 'in-progress', label: 'Drop change to deliver' },
    { from: 'rollback', toType: 'maintenance', toColumn: 'triage', label: 'To maintenance' },
  ],
  reactive: [
    { from: 'triage', toType: 'maintenance', toColumn: 'triage', label: 'To maintenance' },
    { from: 'triage', toType: 'ideation', toColumn: 'intake', label: 'To ideation' },
  ],
  ideation: [],
  maintenance: [],
  personal: [],
};

export function exitsFor(board: WorkBoard, columnId: string): RouteExit[] {
  return BOARD_ROUTES[board.type].filter((e) => e.from === columnId);
}

export function resolveExit(board: WorkBoard, columnId: string, toType: BoardType): RouteExit | undefined {
  return BOARD_ROUTES[board.type].find((e) => e.from === columnId && e.toType === toType);
}

/**
 * The two boards a routed card touches, in the order they MUST be persisted.
 * Two file writes cannot be atomic, so the ordering is the failure design:
 * destination-first means a crash between them leaves a visible duplicate,
 * source-first would lose the card outright.
 */
export interface RoutePlan {
  card: WorkCard;
  writeFirst: WorkBoard;
  writeSecond: WorkBoard;
}

export function routeCard(
  source: WorkBoard,
  dest: WorkBoard,
  cardId: string,
  exit: RouteExit,
  now: string,
): RoutePlan {
  const card = source.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Unknown card: ${cardId}`);
  const trace = { boardId: source.id, boardType: source.type, columnId: card.columnId, at: now };
  removeCard(source, cardId);
  const moved: WorkCard = {
    ...card,
    columnId: exit.toColumn,
    order: dest.cards.filter((c) => c.columnId === exit.toColumn).length,
    updatedAt: now,
    routedFrom: [...(card.routedFrom ?? []), trace],
  };
  dest.cards.push(moved);
  return { card: moved, writeFirst: dest, writeSecond: source };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swarm && node --import tsx --test src/work-items.test.ts && pnpm --dir swarm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/work-items.ts swarm/src/work-items.test.ts
git commit -m "feat(swarm): BOARD_ROUTES + routeCard with destination-first write ordering"
```

---

### Task 3: Card flags

`blocked` / `at-risk` / `waiting`, orthogonal to `columnId`. The `since` stamp is the whole point, so its lifecycle is the thing under test.

**Files:**
- Modify: `swarm/src/work-items.ts` (`WorkCard`, `patchCard`)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: `patchCard` from Task 1.
- Produces: `FlagKind`, `CardFlag`, and `patchCard`'s `flag` field accepting `{ kind, reason? } | null`.

- [ ] **Step 1: Write the failing test**

```ts
test('flags: since is stamped on the transition into a flagged state', () => {
  const b = createBoard('personal');
  const c = addCard(b, { title: 'Opt-in UI' });
  patchCard(b, c.id, { flag: { kind: 'blocked', reason: 'waiting on Edwin' } });
  const first = b.cards[0].flag;
  assert.equal(first?.kind, 'blocked');
  assert.equal(first?.reason, 'waiting on Edwin');
  assert.ok(first?.since);
});

test('flags: correcting kind or reason preserves the clock; clear-then-reflag resets it', async () => {
  const b = createBoard('personal');
  const c = addCard(b, { title: 'Parser' });
  patchCard(b, c.id, { flag: { kind: 'at-risk' } });
  const since = b.cards[0].flag?.since as string;

  patchCard(b, c.id, { flag: { kind: 'blocked', reason: 'upstream down' } });
  assert.equal(b.cards[0].flag?.since, since, 'an in-place kind correction must not reset the clock');
  assert.equal(b.cards[0].flag?.kind, 'blocked');

  patchCard(b, c.id, { flag: null });
  // Capture into a local first: asserting the property-access expression
  // itself equals undefined narrows it to `never` for every later use of that
  // same expression, and the `?.since` below then fails to compile.
  const cleared = b.cards[0].flag;
  assert.equal(cleared, undefined);

  await new Promise((r) => setTimeout(r, 2));
  patchCard(b, c.id, { flag: { kind: 'waiting' } });
  assert.notEqual(b.cards[0].flag?.since, since, 'clear-then-reflag must start a fresh clock');
});

test('flags: never move the card, and an unknown kind throws', () => {
  const b = createBoard('deliver', 'acme');
  const c = addCard(b, { title: 'Webhook', columnId: 'review' });
  const before = { columnId: c.columnId, order: c.order };
  patchCard(b, c.id, { flag: { kind: 'waiting' } });
  assert.deepEqual({ columnId: b.cards[0].columnId, order: b.cards[0].order }, before);
  assert.throws(() => patchCard(b, c.id, { flag: { kind: 'nope' } as unknown as CardFlag }), /flag/i);
});
```

Extend the test import with `type CardFlag`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swarm && node --import tsx --test src/work-items.test.ts`
Expected: FAIL — `flag` is not an accepted patch field, so `b.cards[0].flag` is `undefined`.

- [ ] **Step 3: Implement in `work-items.ts`**

Add above the `WorkCard` interface:

```ts
export type FlagKind = 'blocked' | 'at-risk' | 'waiting';

/** Orthogonal to columnId — a flagged card keeps its position. */
export interface CardFlag {
  kind: FlagKind;
  reason?: string;
  /** Stamped on entry into a flagged state; survives kind/reason edits, dropped on clear. */
  since: string;
}

const FLAG_KINDS: FlagKind[] = ['blocked', 'at-risk', 'waiting'];
```

Add to `WorkCard` (after `routedFrom`):

```ts
  flag?: CardFlag;
```

Widen `patchCard`'s signature — the `flag` input carries no `since`, which is server-stamped:

```ts
export function patchCard(
  board: WorkBoard,
  cardId: string,
  patch: Partial<Pick<WorkCard, 'title' | 'notes' | 'columnId' | 'order' | 'jira' | 'delegation' | 'stories' | 'capabilityRef'>>
    & { flag?: { kind: FlagKind; reason?: string } | null },
): WorkCard {
```

And insert this handling just before the existing `if (patch.columnId !== undefined || patch.order !== undefined)` block:

```ts
  if (patch.flag !== undefined) {
    if (patch.flag === null) {
      card.flag = undefined;
    } else {
      if (!FLAG_KINDS.includes(patch.flag.kind)) throw new Error(`Unknown flag kind: ${patch.flag.kind}`);
      // The clock measures how long it has been stuck NOW, so an in-place
      // correction keeps it and only a clear-then-reflag restarts it.
      card.flag = {
        kind: patch.flag.kind,
        reason: patch.flag.reason?.trim() || undefined,
        since: card.flag?.since ?? new Date().toISOString(),
      };
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd swarm && node --import tsx --test src/work-items.test.ts && pnpm --dir swarm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/work-items.ts swarm/src/work-items.test.ts
git commit -m "feat(swarm): card flags (blocked / at-risk / waiting) with a since clock"
```

---

### Task 4: Board API — create, route, personal ensure, flag patch

Wires the pure helpers to HTTP. Routes stay thin: validation and file IO only.

**Files:**
- Modify: `swarm/src/server.ts:2035-2110` (boards section), `swarm/src/server.ts:2334-2346` (slice send)
- Modify: `swarm/src/capabilities.ts` (add `ensurePersonalBoard`)
- Test: `swarm/src/capabilities.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: `ensurePersonalBoard(workDir)`; HTTP `POST /work/boards {type, workspaceId?}`, `POST /work/boards/:id/cards/:cardId/route {toType}`, `PATCH …/cards/:cardId {flag}`.

- [ ] **Step 1: Write the failing test**

Add to `swarm/src/capabilities.test.ts`:

```ts
test('ensureWorkspaceBoards mints ideation+plan+deliver and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensureWorkspaceBoards(dir, 'acme');
  await ensureWorkspaceBoards(dir, 'acme');
  const { boards } = await loadBoards(dir);
  assert.deepEqual(boards.map((b) => b.id).sort(), ['acme-deliver', 'acme-ideation', 'acme-plan']);
  assert.deepEqual(boards.map((b) => b.type).sort(), ['deliver', 'ideation', 'plan']);
  for (const b of boards) assert.equal(b.workspaceId, 'acme');
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
```

Import `ensurePersonalBoard` and `loadBoards` in that test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd swarm && node --import tsx --test src/capabilities.test.ts`
Expected: FAIL — `ensurePersonalBoard is not a function`.

- [ ] **Step 3: Add `ensurePersonalBoard` to `capabilities.ts`**

```ts
/** The single personal board. Workspace-less, so ensureWorkspaceBoards cannot cover it. */
export async function ensurePersonalBoard(workDir: string): Promise<void> {
  const { boards } = await loadBoards(workDir);
  if (boards.some((b) => b.id === 'personal')) return;
  await saveBoard(workDir, createBoard('personal'));
}
```

- [ ] **Step 4: Replace the board routes in `server.ts`**

Replace `this.app.get('/work/boards', …)` (line 2035) with:

```ts
    // Ensuring on read is the only board created as a side effect of a GET:
    // the Personal tab must always have something behind it, and `+ add`
    // deliberately does not offer `personal`.
    this.app.get('/work/boards', async () => {
      await ensurePersonalBoard(server.workDir());
      return loadBoards(server.workDir());
    });
```

Replace the create route body (the shim from Task 1) with full validation:

```ts
    this.app.post('/work/boards', async (req, reply) => {
      const b = req.body as { type?: string; workspaceId?: string };
      const type = b?.type as BoardType;
      if (!type || !BOARD_TEMPLATES[type]) return reply.status(400).send({ error: `Unknown board type: ${String(b?.type)}` });
      if (type === 'personal' && b.workspaceId) return reply.status(400).send({ error: 'The personal board belongs to no workspace' });
      if (type !== 'personal' && !b.workspaceId?.trim()) return reply.status(400).send({ error: `Board type "${type}" requires a workspaceId` });
      try {
        const board = createBoard(type, b.workspaceId?.trim());
        const { boards } = await loadBoards(server.workDir());
        if (boards.some((x) => x.id === board.id)) {
          return reply.status(409).send({
            error: type === 'personal'
              ? 'The personal board already exists'
              : `Workspace "${b.workspaceId}" already has a ${BOARD_TYPE_LABELS[type]} board`,
          });
        }
        await saveBoard(server.workDir(), board);
        return reply.status(201).send(board);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });
```

Add the route endpoint immediately after the card DELETE route (after line 2182's block):

```ts
    this.app.post<{ Params: { id: string; cardId: string } }>(
      '/work/boards/:id/cards/:cardId/route',
      async (req, reply) => {
        const source = await boardOr404(req.params.id, reply);
        if (!source) return;
        const card = source.cards.find((c) => c.id === req.params.cardId);
        if (!card) return reply.status(404).send({ error: `Unknown card: ${req.params.cardId}` });
        const toType = (req.body as { toType?: string })?.toType as BoardType;
        const exit = toType ? resolveExit(source, card.columnId, toType) : undefined;
        if (!exit) {
          return reply.status(400).send({
            error: `No route from ${source.name}/${card.columnId} to "${String(toType)}"`,
          });
        }
        const { boards } = await loadBoards(server.workDir());
        const dest = boards.find((b) => b.type === exit.toType && b.workspaceId === source.workspaceId);
        if (!dest) {
          return reply.status(404).send({
            error: `Workspace "${source.workspaceId}" has no ${BOARD_TYPE_LABELS[exit.toType]} board — add it first`,
          });
        }
        const plan = routeCard(source, dest, card.id, exit, new Date().toISOString());
        // Destination first: a crash between these two writes duplicates the
        // card (recoverable) rather than losing it (not).
        await saveBoard(server.workDir(), plan.writeFirst);
        await saveBoard(server.workDir(), plan.writeSecond);
        return reply.status(200).send({ card: plan.card, boardId: dest.id });
      },
    );
```

**The card PATCH route needs no edit.** It already forwards the whole body with `patchCard(board, req.params.cardId, req.body as Parameters<typeof patchCard>[2])`, so widening `patchCard`'s parameter type in Task 3 was enough — `flag` reaches it, gets its kind validated, and gets `since` stamped. Confirm by reading the call and moving on; do not add a field list.

Update the `server.ts` imports (line ~108-120) to add `BOARD_TEMPLATES`, `BOARD_TYPE_LABELS`, `resolveExit`, `routeCard`, `ensurePersonalBoard`, and `type BoardType`.

Finally, the slice-send remap at line 2341 — already changed in Task 1 to `boardIdFor(cap.workspaceId, target === 'capabilities' ? 'plan' : 'deliver')`. Add a comment above it:

```ts
      // The wire values and the capCardRef/deliveryCardRef keys are persisted
      // on every capability file; only the board types behind them moved.
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --dir swarm test && pnpm --dir swarm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/server.ts swarm/src/capabilities.ts swarm/src/capabilities.test.ts
git commit -m "feat(swarm): board create/route endpoints, personal ensure, flag patch"
```

---

### Task 5: Workspace colour

An optional field with a derived default, plus the shared palette module the UI reads.

**Files:**
- Modify: `swarm/src/workspaces.ts:21-36`, `swarm/src/server.ts:1521-1533`
- Create: `control-plane/src/lib/workspace-color.ts`
- Test: `control-plane/src/lib/workspace-color.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Workspace.color?: string`; `WORKSPACE_PALETTE: string[]`, `derivedColor(name): string`, `workspaceColor(ws): string`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/lib/workspace-color.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { derivedColor, workspaceColor, WORKSPACE_PALETTE } from "./workspace-color";

describe("workspace-color", () => {
  it("derives a palette colour that is stable for a given name", () => {
    expect(derivedColor("acme")).toBe(derivedColor("acme"));
    expect(WORKSPACE_PALETTE).toContain(derivedColor("acme"));
    expect(WORKSPACE_PALETTE).toHaveLength(8);
  });

  it("spreads a handful of names across more than one hue", () => {
    const hues = new Set(["acme", "globex", "initech", "umbrella", "soylent"].map(derivedColor));
    expect(hues.size).toBeGreaterThan(1);
  });

  it("prefers an explicit colour over the derived default", () => {
    expect(workspaceColor({ name: "acme", color: "#ff0000" })).toBe("#ff0000");
    expect(workspaceColor({ name: "acme" })).toBe(derivedColor("acme"));
    expect(workspaceColor({ name: "acme", color: "  " })).toBe(derivedColor("acme"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir control-plane exec vitest run src/lib/workspace-color.test.ts`
Expected: FAIL — cannot resolve `./workspace-color`.

- [ ] **Step 3: Create `control-plane/src/lib/workspace-color.ts`**

```ts
/**
 * Workspace identity colour. Derived from the name by default so colours are
 * stable with zero configuration; an explicit `color` overrides it so a rename
 * does not shift a workspace's hue out from under the user.
 */
export const WORKSPACE_PALETTE = [
  "#5fd0b0", // teal
  "#e0a458", // amber
  "#8b7fd4", // violet
  "#d97a8e", // rose
  "#6fb3e0", // sky
  "#9dc95f", // lime
  "#e08a5f", // orange
  "#7f8bd4", // indigo
];

export function derivedColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return WORKSPACE_PALETTE[h % WORKSPACE_PALETTE.length];
}

export function workspaceColor(ws: { name: string; color?: string }): string {
  return ws.color?.trim() || derivedColor(ws.name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir control-plane exec vitest run src/lib/workspace-color.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the field to the swarm**

In `swarm/src/workspaces.ts`, add to the `Workspace` interface after `links`:

```ts
  /** Optional identity colour; the UI falls back to a hash of `name`. */
  color?: string;
```

`assertWorkspace` needs no change — it validates only `name` and `repos`, and an absent optional field is already tolerated.

In `swarm/src/server.ts`, three edits — both write handlers build a **whitelisted** object rather than spreading the body, so an unlisted field is silently dropped:

1. `/workspaces` GET projection (the `server.workspaces.map(...)` object at line 1524): add `color: w.color,`.
2. `POST /workspaces` (the `const ws: Workspace = {` object at line 1418): add `color: b.color?.trim() || undefined,`.
3. `PUT /workspaces/:name` (the `const merged: Workspace = {` object at line 1448): add `color: b.color !== undefined ? b.color.trim() || undefined : existing.color,` — matching the `description` line's undefined-means-untouched convention immediately above it.

Also add `color?: string;` to the `WorkspaceRecord` type in `control-plane/src/hooks/useBrokerChat.ts`, which is the shape the modals hand to their `save` prop.

- [ ] **Step 6: Run everything**

Run: `pnpm --dir swarm test && pnpm --dir swarm typecheck && pnpm --dir control-plane test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/workspaces.ts swarm/src/server.ts control-plane/src/lib/workspace-color.ts control-plane/src/lib/workspace-color.test.ts
git commit -m "feat: optional workspace colour with a derived eight-hue default"
```

---

### Task 6: Wipe the existing boards

Destructive and deliberate — the spec chose a clean slate over migration. **Re-verify the orphan check before deleting**, because a slice authored since the spec was written would change the answer.

**Files:**
- Delete: `swarm/.smith/work/*.json` (four files; the `capabilities/` subdirectory is untouched)

**Interfaces:**
- Consumes: `ensureWorkspaceBoards`, `ensurePersonalBoard` from Task 4.
- Produces: an empty board directory that reprovisions on next load.

- [ ] **Step 1: Re-verify that no capability slice references a card**

```bash
grep -l "capCardRef\|deliveryCardRef" swarm/.smith/work/capabilities/*.json && echo "STOP — a slice is linked" || echo "clean — no slice references a card"
```

Expected: `clean — no slice references a card`.

**If this prints STOP, halt and report.** Deleting a referenced board orphans the ref, and because a set `capCardRef`/`deliveryCardRef` makes the send route reply 409 "Slice already sent" with no UI to clear it, that slice could never be re-sent.

- [ ] **Step 2: Record what is being destroyed**

```bash
for f in swarm/.smith/work/*.json; do echo "$f: $(python3 -c "import json,sys;print(len(json.load(open('$f'))['cards']))") cards"; done
```

Expected: `jefelabs-capabilities` 0, `jefelabs-delivery` 0, `support` 0, `skoolscout` 2.

- [ ] **Step 3: Delete**

```bash
rm -f swarm/.smith/work/*.json
ls swarm/.smith/work/
```

Expected: only `capabilities/` remains.

- [ ] **Step 4: Confirm reprovisioning**

Restart the swarm, then:

```bash
curl -s localhost:7790/work/boards | python3 -m json.tool | head -30
```

Expected: at minimum a `personal` board (created by the GET), plus `<ws>-ideation`, `<ws>-plan`, `<ws>-deliver` for each workspace once a capability route touches it.

- [ ] **Step 5: Commit**

Board files are gitignored (`swarm/.smith` is whole-dir ignored), so there is nothing to stage. Record the step instead:

```bash
git commit --allow-empty -m "chore: wipe legacy board files ahead of the typed registry"
```

---

### Task 7: Pure aggregation module

Tab derivation and workspace clustering, with no React and no fetch, so the trickiest logic in the UI is unit-tested directly.

**Files:**
- Create: `control-plane/src/lib/board-aggregate.ts`
- Test: `control-plane/src/lib/board-aggregate.test.ts`

**Interfaces:**
- Consumes: `WorkBoardT`, `WorkCardT` types from `organisms/BoardStage`.
- Produces: `ALL_WORKSPACES`, `BoardTypeT`, `BOARD_TYPE_ORDER_UI`, `BOARD_TYPE_LABELS_UI`, `TabDescriptor`, `AggCard`, `Cluster`, `tabsFor(boards, scope)`, `addableTypes(boards, workspaceId)`, `collectCards(boards, columnId)`, `clusterByWorkspace(cards, clustered)`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/lib/board-aggregate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { WorkBoardT } from "../organisms/BoardStage";
import {
  ALL_WORKSPACES, addableTypes, clusterByWorkspace, collectCards, tabsFor,
} from "./board-aggregate";

const board = (id: string, type: string, workspaceId?: string, cards: unknown[] = []): WorkBoardT =>
  ({ id, name: id, type, columns: [], cards, workspaceId }) as unknown as WorkBoardT;

const BOARDS = [
  board("acme-ideation", "ideation", "acme", [{ id: "a1", title: "SMS opt-in", columnId: "intake", order: 0 }]),
  board("acme-plan", "plan", "acme", [{ id: "a2", title: "Parent portal", columnId: "spec", order: 0 }]),
  board("globex-plan", "plan", "globex", [{ id: "g1", title: "Billing", columnId: "spec", order: 0 }]),
  board("personal", "personal", undefined, [{ id: "p1", title: "Read spec", columnId: "todo", order: 0 }]),
];

describe("tabsFor", () => {
  it("in workspace scope lists that workspace's boards in canonical order, personal last", () => {
    const tabs = tabsFor(BOARDS, "acme");
    expect(tabs.map((t) => t.type)).toEqual(["ideation", "plan", "personal"]);
    expect(tabs[0].boardIds).toEqual(["acme-ideation"]);
    expect(tabs[2].boardIds).toEqual(["personal"]);
  });

  it("in all scope collapses to types and unions the board ids", () => {
    const tabs = tabsFor(BOARDS, ALL_WORKSPACES);
    expect(tabs.map((t) => t.type)).toEqual(["ideation", "plan", "personal"]);
    expect(tabs.find((t) => t.type === "plan")?.boardIds).toEqual(["acme-plan", "globex-plan"]);
    expect(tabs.find((t) => t.type === "plan")?.clustered).toBe(true);
    expect(tabs.find((t) => t.type === "personal")?.clustered).toBe(false);
  });

  it("omits the personal tab entirely when no personal board exists", () => {
    expect(tabsFor([BOARDS[0]], "acme").map((t) => t.type)).toEqual(["ideation"]);
  });
});

describe("addableTypes", () => {
  it("offers the six workspace types not yet present, never personal", () => {
    expect(addableTypes(BOARDS, "acme")).toEqual(["deliver", "release", "reactive", "maintenance"]);
    expect(addableTypes(BOARDS, "globex")).toEqual(["ideation", "deliver", "release", "reactive", "maintenance"]);
    expect(addableTypes(BOARDS, "acme")).not.toContain("personal");
  });
});

describe("collectCards + clusterByWorkspace", () => {
  it("tags each card with its source board and workspace", () => {
    const plans = BOARDS.filter((b) => b.type === "plan");
    const cards = collectCards(plans, "spec");
    expect(cards.map((c) => [c.id, c.boardId, c.workspaceId])).toEqual([
      ["a2", "acme-plan", "acme"],
      ["g1", "globex-plan", "globex"],
    ]);
  });

  it("groups into one labelled cluster per workspace when clustered", () => {
    const cards = collectCards(BOARDS.filter((b) => b.type === "plan"), "spec");
    const clusters = clusterByWorkspace(cards, true);
    expect(clusters.map((c) => [c.label, c.cards.length])).toEqual([["acme", 1], ["globex", 1]]);
  });

  it("returns a single unlabelled cluster when not clustered, preserving order", () => {
    const cards = collectCards([BOARDS[1]], "spec");
    const clusters = clusterByWorkspace(cards, false);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].label).toBeNull();
    expect(clusters[0].cards.map((c) => c.id)).toEqual(["a2"]);
  });

  it("sorts within a cluster by order", () => {
    const b = board("acme-plan", "plan", "acme", [
      { id: "x", title: "x", columnId: "spec", order: 2 },
      { id: "y", title: "y", columnId: "spec", order: 0 },
    ]);
    expect(clusterByWorkspace(collectCards([b], "spec"), false)[0].cards.map((c) => c.id)).toEqual(["y", "x"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir control-plane exec vitest run src/lib/board-aggregate.test.ts`
Expected: FAIL — cannot resolve `./board-aggregate`.

- [ ] **Step 3: Create `control-plane/src/lib/board-aggregate.ts`**

```ts
import type { WorkBoardT, WorkCardT } from "../organisms/BoardStage";

/** Sentinel scope: aggregate across every workspace. */
export const ALL_WORKSPACES = "*";

export type BoardTypeT =
  | "personal" | "ideation" | "plan" | "deliver"
  | "release" | "reactive" | "maintenance";

/** Mirrors the swarm's BOARD_TYPE_ORDER — personal always last. */
export const BOARD_TYPE_ORDER_UI: BoardTypeT[] = [
  "ideation", "plan", "deliver", "release", "reactive", "maintenance", "personal",
];

export const BOARD_TYPE_LABELS_UI: Record<BoardTypeT, string> = {
  personal: "Personal",
  ideation: "Ideation",
  plan: "Plan",
  deliver: "Deliver",
  release: "Release",
  reactive: "Reactive",
  maintenance: "Maintenance",
};

export interface TabDescriptor {
  /** Stable selection value and React key. */
  key: string;
  label: string;
  type: BoardTypeT;
  /** One board in workspace scope; the union of a type's boards in all scope. */
  boardIds: string[];
  /** Whether the column body groups by workspace. Never true for personal. */
  clustered: boolean;
}

export interface AggCard extends WorkCardT {
  boardId: string;
  workspaceId?: string;
}

export interface Cluster {
  /** null renders no subheading — workspace scope and the personal tab. */
  label: string | null;
  cards: AggCard[];
}

/**
 * Personal is context-invariant: it is the one tab whose content is not a
 * function of the dropdown, so it is appended explicitly rather than falling
 * out of a `workspaceId === undefined` filter — which is how it would get
 * folded into the aggregate by accident later.
 */
export function tabsFor(boards: WorkBoardT[], scope: string): TabDescriptor[] {
  const all = scope === ALL_WORKSPACES;
  const tabs: TabDescriptor[] = [];
  for (const type of BOARD_TYPE_ORDER_UI) {
    if (type === "personal") continue;
    const matches = boards.filter(
      (b) => b.type === type && (all ? Boolean(b.workspaceId) : b.workspaceId === scope),
    );
    if (matches.length === 0) continue;
    tabs.push({
      key: type,
      label: all ? BOARD_TYPE_LABELS_UI[type] : matches[0].name,
      type,
      boardIds: matches.map((b) => b.id),
      clustered: all,
    });
  }
  const personal = boards.find((b) => b.type === "personal");
  if (personal) {
    tabs.push({
      key: "personal", label: personal.name, type: "personal",
      boardIds: [personal.id], clustered: false,
    });
  }
  return tabs;
}

/** The workspace types this workspace does not yet hold. Never offers personal. */
export function addableTypes(boards: WorkBoardT[], workspaceId: string): BoardTypeT[] {
  const held = new Set(boards.filter((b) => b.workspaceId === workspaceId).map((b) => b.type));
  return BOARD_TYPE_ORDER_UI.filter((t) => t !== "personal" && !held.has(t));
}

/** Every card in `columnId` across `boards`, tagged with where it came from. */
export function collectCards(boards: WorkBoardT[], columnId: string): AggCard[] {
  return boards.flatMap((b) =>
    b.cards
      .filter((c) => c.columnId === columnId)
      .map((c) => ({ ...c, boardId: b.id, workspaceId: b.workspaceId })),
  );
}

export function clusterByWorkspace(cards: AggCard[], clustered: boolean): Cluster[] {
  const byOrder = (a: AggCard, b: AggCard) => a.order - b.order;
  if (!clustered) return [{ label: null, cards: [...cards].sort(byOrder) }];
  const groups = new Map<string, AggCard[]>();
  for (const c of cards) {
    const key = c.workspaceId ?? "";
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, list]) => ({ label, cards: list.sort(byOrder) }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --dir control-plane exec vitest run src/lib/board-aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm --dir control-plane exec biome check --write src/lib
git add control-plane/src/lib/board-aggregate.ts control-plane/src/lib/board-aggregate.test.ts
git commit -m "feat(ui): pure board aggregation — tabs, addable types, workspace clusters"
```

---

### Task 8: BoardCard — flag chip, flag edge, workspace tint

Two encodings on one card, deliberately on separate channels: the flag owns the left edge and a chip, the workspace owns the fill.

**Files:**
- Modify: `control-plane/src/molecules/BoardCard.tsx`
- Modify: `control-plane/src/organisms/BoardStage.tsx` (add `flag` and `routedFrom` to `WorkCardT`, `type` to `WorkBoardT`)
- Modify: `control-plane/src/styles/components.css` (after `.board-card` at line 2372)
- Test: `control-plane/src/molecules/BoardCard.test.tsx`

**Interfaces:**
- Consumes: `workspaceColor` from Task 5.
- Produces: `BoardCard` accepting `tint?: string` and rendering `card.flag`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/molecules/BoardCard.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkCardT } from "../organisms/BoardStage";
import { BoardCard, flagAge } from "./BoardCard";

const card = (over: Partial<WorkCardT> = {}): WorkCardT =>
  ({ id: "c1", title: "Opt-in UI", columnId: "in-progress", order: 0, ...over }) as WorkCardT;

describe("flagAge", () => {
  it("renders whole days, flooring, with 0d on the same day", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    expect(flagAge("2026-08-04T10:00:00.000Z", now)).toBe("3d");
    expect(flagAge("2026-08-07T01:00:00.000Z", now)).toBe("0d");
  });
});

describe("BoardCard", () => {
  it("renders no flag chip when the card is unflagged", () => {
    render(<BoardCard card={card()} onOpen={() => {}} />);
    expect(screen.queryByRole("img", { name: /blocked|at risk|waiting/i })).toBeNull();
    expect(screen.getByRole("button").className).not.toContain("has-flag");
  });

  it("renders a labelled flag chip carrying the age and reason", () => {
    render(
      <BoardCard
        card={card({ flag: { kind: "blocked", reason: "waiting on Edwin", since: "2026-08-04T10:00:00.000Z" } })}
        onOpen={() => {}}
      />,
    );
    const chip = screen.getByLabelText(/blocked/i);
    expect(chip.textContent).toMatch(/\dd/);
    expect(chip.getAttribute("title")).toBe("waiting on Edwin");
    expect(screen.getByRole("button").className).toContain("has-flag");
  });

  it("puts the flag on the left edge and the workspace tint on the fill", () => {
    render(
      <BoardCard
        card={card({ flag: { kind: "at-risk", since: "2026-08-06T10:00:00.000Z" } })}
        tint="#5fd0b0"
        onOpen={() => {}}
      />,
    );
    const el = screen.getByRole("button");
    expect(el.style.getPropertyValue("--card-tint")).toBe("#5fd0b0");
    expect(el.className).toContain("is-at-risk");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir control-plane exec vitest run src/molecules/BoardCard.test.tsx`
Expected: FAIL — `flagAge` is not exported.

- [ ] **Step 3: Extend the shared types in `BoardStage.tsx`**

Add to `WorkCardT` (after `capabilityRef`, line 35):

```ts
  flag?: { kind: "blocked" | "at-risk" | "waiting"; reason?: string; since: string };
  routedFrom?: Array<{ boardId: string; boardType: string; columnId: string; at: string }>;
```

Add to `WorkBoardT` (after `name`, line 39):

```ts
  type: BoardTypeT;
```

and import `type BoardTypeT` from `../lib/board-aggregate`. Delete the now-unused local `type BoardTemplate` alias at line 47.

- [ ] **Step 4: Implement in `BoardCard.tsx`**

Add above the component:

```tsx
const FLAG_LABEL = { blocked: "Blocked", "at-risk": "At risk", waiting: "Waiting" } as const;
const FLAG_GLYPH = { blocked: "⛔", "at-risk": "⚠", waiting: "⏸" } as const;

/** Whole days since `since`, floored — "how long has this been stuck now". */
export function flagAge(since: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000);
  return `${Math.max(0, days)}d`;
}
```

Add `tint` to the props interface:

```tsx
  /** Workspace identity colour; applied to the card fill in the aggregate view only. */
  tint?: string;
```

Change the root button to carry both channels, and render the chip first in `__meta`:

```tsx
    <button
      type="button"
      className={`board-card${card.flag ? ` has-flag is-${card.flag.kind}` : ""}${className ? ` ${className}` : ""}`}
      style={tint ? ({ "--card-tint": tint } as React.CSSProperties) : undefined}
      onClick={onOpen}
    >
      <span className="board-card__title">{card.title}</span>
      <span className="board-card__meta">
        {card.flag && (
          <span
            className="board-card__flag"
            aria-label={`${FLAG_LABEL[card.flag.kind]} for ${flagAge(card.flag.since)}`}
            title={card.flag.reason}
          >
            {FLAG_GLYPH[card.flag.kind]} {flagAge(card.flag.since)}
          </span>
        )}
        {/* …existing stories / cap / jira / delegation chips unchanged… */}
```

Add `import type React from "react";` at the top if the file does not already import it.

- [ ] **Step 5: Add the CSS**

Append after the `.board-card` rule at `control-plane/src/styles/components.css:2384`:

```css
/* Two encodings, two channels: fill = workspace identity (aggregate view
   only), left edge + chip = flag. They must never share one. */
.board-card {
  background: var(--card-tint, rgba(255, 255, 255, 0.04));
  border-left: 3px solid transparent;
}
.board-card.has-flag.is-blocked {
  border-left-color: #d9534f;
}
.board-card.has-flag.is-at-risk {
  border-left-color: #e0a458;
}
.board-card.has-flag.is-waiting {
  border-left-color: #8b94a8;
}
.board-card__flag {
  font-size: 11px;
  opacity: 0.85;
  white-space: nowrap;
}
```

Remove the `background: rgba(255, 255, 255, 0.04);` line from the original `.board-card` block so the token above is the only declaration.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --dir control-plane exec vitest run src/molecules/BoardCard.test.tsx && pnpm --dir control-plane typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm --dir control-plane exec biome check --write src
git add control-plane/src/molecules/BoardCard.tsx control-plane/src/molecules/BoardCard.test.tsx control-plane/src/organisms/BoardStage.tsx control-plane/src/styles/components.css
git commit -m "feat(ui): card flag chip + edge, workspace tint on the fill"
```

---

### Task 9: BoardTabs — workspace dropdown and tab row

**Files:**
- Create: `control-plane/src/molecules/BoardTabs.tsx`
- Modify: `control-plane/src/styles/components.css`
- Test: `control-plane/src/molecules/BoardTabs.test.tsx`

**Interfaces:**
- Consumes: `ALL_WORKSPACES`, `TabDescriptor`, `addableTypes`, `BOARD_TYPE_LABELS_UI`, `BoardTypeT` from Task 7.
- Produces: `BoardTabs` with props `{ scope, workspaces, tabs, activeKey, addable, onScope, onSelect, onAdd }`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/molecules/BoardTabs.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ALL_WORKSPACES } from "../lib/board-aggregate";
import { BoardTabs } from "./BoardTabs";

const TABS = [
  { key: "ideation", label: "Ideation", type: "ideation" as const, boardIds: ["a-ideation"], clustered: false },
  { key: "personal", label: "Personal", type: "personal" as const, boardIds: ["personal"], clustered: false },
];

const base = {
  scope: "acme",
  workspaces: ["acme", "globex"],
  tabs: TABS,
  activeKey: "ideation",
  addable: ["deliver" as const],
  onScope: () => {},
  onSelect: () => {},
  onAdd: () => {},
};

describe("BoardTabs", () => {
  it("lists All workspaces plus each workspace, and never Personal, in the dropdown", () => {
    render(<BoardTabs {...base} />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["All workspaces", "acme", "globex"]);
  });

  it("marks the active tab and reports selection", async () => {
    const onSelect = vi.fn();
    render(<BoardTabs {...base} onSelect={onSelect} />);
    expect(screen.getByRole("tab", { name: "Ideation" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "Personal" }));
    expect(onSelect).toHaveBeenCalledWith("personal");
  });

  it("offers add for the missing types in workspace scope", async () => {
    const onAdd = vi.fn();
    render(<BoardTabs {...base} onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: /add board/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Deliver" }));
    expect(onAdd).toHaveBeenCalledWith("deliver");
  });

  it("hides add entirely in the aggregate scope, since there is no workspace to create into", () => {
    render(<BoardTabs {...base} scope={ALL_WORKSPACES} />);
    expect(screen.queryByRole("button", { name: /add board/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir control-plane exec vitest run src/molecules/BoardTabs.test.tsx`
Expected: FAIL — cannot resolve `./BoardTabs`.

- [ ] **Step 3: Create `control-plane/src/molecules/BoardTabs.tsx`**

```tsx
import { Plus } from "lucide-react";
import { useState } from "react";
import { ALL_WORKSPACES, BOARD_TYPE_LABELS_UI, type BoardTypeT, type TabDescriptor } from "../lib/board-aggregate";

interface BoardTabsProps {
  /** ALL_WORKSPACES or a workspace name. */
  scope: string;
  workspaces: string[];
  tabs: TabDescriptor[];
  activeKey: string | null;
  /** Workspace types not yet present in the scoped workspace. Ignored in aggregate scope. */
  addable: BoardTypeT[];
  onScope: (scope: string) => void;
  onSelect: (key: string) => void;
  onAdd: (type: BoardTypeT) => void;
}

/** Workspace context dropdown above the board tab row. */
export function BoardTabs({
  scope, workspaces, tabs, activeKey, addable, onScope, onSelect, onAdd,
}: BoardTabsProps) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="board-tabs">
      <select
        className="board-tabs__scope"
        aria-label="Workspace"
        value={scope}
        onChange={(e) => onScope(e.target.value)}
      >
        <option value={ALL_WORKSPACES}>All workspaces</option>
        {workspaces.map((w) => (
          <option key={w} value={w}>{w}</option>
        ))}
      </select>
      <div className="board-tabs__row" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === activeKey}
            className={`board-tabs__tab${t.key === activeKey ? " is-active" : ""}`}
            onClick={() => onSelect(t.key)}
          >
            {t.label}
          </button>
        ))}
        {scope !== ALL_WORKSPACES && addable.length > 0 && (
          <div className="board-tabs__add">
            <button
              type="button"
              className="board-tabs__tab"
              aria-label="Add board"
              onClick={() => setAdding((v) => !v)}
            >
              <Plus size={12} strokeWidth={2} />
            </button>
            {adding && (
              <div className="board-tabs__menu" role="menu">
                {addable.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAdding(false);
                      onAdd(t);
                    }}
                  >
                    {BOARD_TYPE_LABELS_UI[t]}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the CSS**

Append to `control-plane/src/styles/components.css`:

```css
.board-tabs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.board-tabs__scope {
  align-self: flex-start;
}
.board-tabs__row {
  display: flex;
  align-items: center;
  gap: 2px;
  border-bottom: 1px solid var(--pill-br);
}
.board-tabs__tab {
  padding: 6px 12px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  cursor: pointer;
  opacity: 0.7;
}
.board-tabs__tab.is-active {
  border-color: var(--pill-br);
  background: rgba(255, 255, 255, 0.05);
  opacity: 1;
}
.board-tabs__add {
  position: relative;
}
.board-tabs__menu {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 140px;
  border: 1px solid var(--pill-br);
  border-radius: 8px;
  background: var(--bg);
  padding: 4px;
}
.board-tabs__menu button {
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.board-tabs__menu button:hover {
  background: rgba(255, 255, 255, 0.06);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --dir control-plane exec vitest run src/molecules/BoardTabs.test.tsx && pnpm --dir control-plane typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm --dir control-plane exec biome check --write src
git add control-plane/src/molecules/BoardTabs.tsx control-plane/src/molecules/BoardTabs.test.tsx control-plane/src/styles/components.css
git commit -m "feat(ui): workspace dropdown + board tab row with add-board menu"
```

---

### Task 10: BoardColumn and BoardStage wiring

Extracts the column into its own file (it now renders clusters), and rewires the stage around scope + tabs. This is the largest task; it is one task because the column and the stage cannot compile independently of each other.

**Files:**
- Create: `control-plane/src/molecules/BoardColumn.tsx`
- Modify: `control-plane/src/organisms/BoardStage.tsx` (remove the local `BoardColumn` at lines 141-172; replace the render and the picker)
- Modify: `control-plane/src/organisms/BoardStage.test.tsx`
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Consumes: everything from Tasks 7-9, plus `workspaceColor` from Task 5.
- Produces: `BoardColumn` with props `{ col, clusters, colorFor, agentFor, onOpenCard }`; `BoardStage` exporting an unchanged `moveCard`, `resolveDrop`, and a `fireDrop(boardId, cardId, columnId, order)` whose signature gains `boardId`.

- [ ] **Step 1: Write the failing test**

In `control-plane/src/organisms/BoardStage.test.tsx`, add `type: "personal"` to the `BOARD` fixture and update its columns to the new personal set. Then add:

```tsx
it("shows the workspace dropdown and a tab per board, personal last", async () => {
  stubFetch({
    boards: {
      boards: [
        { ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" },
        { ...BOARD, id: "personal", name: "Personal", type: "personal", workspaceId: undefined },
      ],
      errors: [],
    },
  });
  render(<BoardStage roster={ROSTER} lastBoardUpdate={null} />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Plan" })).toBeTruthy());
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Plan", "Personal"]);
  expect(screen.getByLabelText("Workspace")).toBeTruthy();
});

it("clusters cards by workspace under a subheading in the aggregate view", async () => {
  stubFetch({
    boards: {
      boards: [
        { ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme",
          columns: [{ id: "spec", name: "Spec" }],
          cards: [{ id: "a1", title: "Parent portal", columnId: "spec", order: 0 }] },
        { ...BOARD, id: "globex-plan", name: "Plan", type: "plan", workspaceId: "globex",
          columns: [{ id: "spec", name: "Spec" }],
          cards: [{ id: "g1", title: "Billing", columnId: "spec", order: 0 }] },
      ],
      errors: [],
    },
  });
  render(<BoardStage roster={ROSTER} lastBoardUpdate={null} />);
  await waitFor(() => expect(screen.getByText("Parent portal")).toBeTruthy());
  await userEvent.selectOptions(screen.getByLabelText("Workspace"), "*");
  await waitFor(() => expect(screen.getByText("acme")).toBeTruthy());
  expect(screen.getByText("globex")).toBeTruthy();
  expect(screen.getByText("Billing")).toBeTruthy();
});

it("creates a board for the scoped workspace from the add menu", async () => {
  const { calls } = stubFetch({
    boards: {
      boards: [{ ...BOARD, id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme" }],
      errors: [],
    },
  });
  render(<BoardStage roster={ROSTER} lastBoardUpdate={null} />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Plan" })).toBeTruthy());
  await userEvent.selectOptions(screen.getByLabelText("Workspace"), "acme");
  await userEvent.click(screen.getByRole("button", { name: /add board/i }));
  await userEvent.click(screen.getByRole("menuitem", { name: "Deliver" }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === "POST" && c.url.endsWith("/work/boards"))?.body).toEqual({
      type: "deliver",
      workspaceId: "acme",
    }),
  );
});
```

Every existing `fireDrop(cardId, columnId, order)` call in the drag-wiring describe block gains the board id as its first argument: `fireDrop("alpha", "c1", "ready", 0)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir control-plane exec vitest run src/organisms/BoardStage.test.tsx`
Expected: FAIL — no element with label "Workspace"; `fireDrop` arity mismatch.

- [ ] **Step 3: Create `control-plane/src/molecules/BoardColumn.tsx`**

```tsx
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { RosterAgent } from "../hooks/useBrokerChat";
import type { AggCard, Cluster } from "../lib/board-aggregate";
import type { WorkColumn } from "../organisms/BoardStage";
import { BoardCard } from "./BoardCard";

/** One sortable card wrapper — BoardCard stays a pure display button. */
function SortableCard({
  card, agent, tint, onOpen,
}: { card: AggCard; agent?: RosterAgent; tint?: string; onOpen: () => void }) {
  const sortable = useSortable({ id: card.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <div ref={sortable.setNodeRef} style={style} {...sortable.attributes} {...sortable.listeners}>
      <BoardCard
        card={card}
        agent={agent}
        tint={tint}
        onOpen={onOpen}
        className={sortable.isDragging ? "is-dragging" : undefined}
      />
    </div>
  );
}

/**
 * A droppable column whose body groups by workspace. SortableContext keeps ONE
 * flat items array while the render nests, so clustering never touches
 * resolveDrop.
 */
export function BoardColumn({
  col, clusters, colorFor, agentFor, onOpenCard,
}: {
  col: WorkColumn;
  clusters: Cluster[];
  colorFor: (workspaceId?: string) => string | undefined;
  agentFor: (id?: string) => RosterAgent | undefined;
  onOpenCard: (boardId: string, cardId: string) => void;
}) {
  const droppable = useDroppable({ id: `column:${col.id}` });
  const flat = clusters.flatMap((g) => g.cards);
  return (
    <div ref={droppable.setNodeRef} className={`board-column${droppable.isOver ? " is-over" : ""}`}>
      <h3 className="board-column__name">{col.name}</h3>
      <SortableContext items={flat.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="board-column__cards">
          {clusters.map((g) => (
            <div key={g.label ?? "_"} className="board-column__cluster">
              {g.label !== null && (
                <span className="board-column__cluster-name" style={{ color: colorFor(g.label ?? undefined) }}>
                  {g.label}
                </span>
              )}
              {g.cards.map((card) => (
                <SortableCard
                  key={card.id}
                  card={card}
                  agent={agentFor(card.delegation?.agentId)}
                  tint={g.label !== null ? colorFor(card.workspaceId) : undefined}
                  onOpen={() => onOpenCard(card.boardId, card.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
```

- [ ] **Step 4: Rewire `BoardStage.tsx`**

Delete the local `SortableCard` (lines 126-139) and `BoardColumn` (lines 141-172) — they now live in the molecule.

Replace the state block (lines 179-189) with:

```tsx
  const [boards, setBoards] = useState<WorkBoardT[]>([]);
  const [boardErrors, setBoardErrors] = useState<Array<{ file: string; error: string }>>([]);
  const [scope, setScope] = useState<string>(ALL_WORKSPACES);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingCard, setAddingCard] = useState(false);
  const [cardTitle, setCardTitle] = useState("");
  const [open, setOpen] = useState<{ boardId: string; cardId: string } | null>(null);
  const [workspaces, setWorkspaces] = useState<Array<{ name: string; color?: string }>>([]);
```

Change the workspaces fetch (lines 212-217) to keep colour:

```tsx
  useEffect(() => {
    fetch(`http://${BASE}/workspaces`)
      .then((r) => r.json())
      .then((res: { workspaces?: Array<{ name: string; color?: string }> }) =>
        setWorkspaces((res.workspaces ?? []).map((w) => ({ name: w.name, color: w.color }))),
      )
      .catch(() => {});
  }, []);
```

Remove the `setActiveId(...)` line from `refetch` and derive the view instead. Add after the sensors:

```tsx
  const tabs = tabsFor(boards, scope);
  const tab = tabs.find((t) => t.key === activeKey) ?? tabs[0] ?? null;
  const tabBoards = tab ? boards.filter((b) => tab.boardIds.includes(b.id)) : [];
  const columns = tabBoards[0]?.columns ?? [];
  // Cards go to the board they came from, never the tab — in aggregate scope a
  // tab spans several boards.
  const boardOf = (id: string) => boards.find((b) => b.id === id) ?? null;
  const colorFor = (workspaceId?: string) => {
    if (!workspaceId) return undefined;
    const ws = workspaces.find((w) => w.name === workspaceId);
    return workspaceColor(ws ?? { name: workspaceId });
  };
```

Replace `applyMove` so it targets the card's own board, and fence cross-workspace drops:

```tsx
  const applyMove = useCallback(
    async (boardId: string, cardId: string, columnId: string, order: number) => {
      const previous = boards.find((b) => b.id === boardId);
      if (!previous) return;
      const movingCard = previous.cards.find((c) => c.id === cardId);
      const sameColumn = movingCard?.columnId === columnId;
      const next = moveCard(previous, cardId, columnId, order);
      setBoards((all) => all.map((b) => (b.id === next.id ? next : b)));
      const body: { columnId?: string; order: number } = sameColumn ? { order } : { columnId, order };
      const res = await fetch(
        `http://${BASE}/work/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      ).catch(() => null);
      if (!res?.ok) {
        setBoards((all) => all.map((b) => (b.id === previous.id ? previous : b)));
        setError("Move failed — restored the previous order");
        return;
      }
      void refetch();
    },
    [boards, refetch],
  );
```

Update `fireDrop` and `dropHandler` to the four-argument signature, and rewrite `handleDragEnd` to resolve within the dragged card's own board:

```tsx
  const handleDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const cardId = String(e.active.id);
    const source = boards.find((b) => b.cards.some((c) => c.id === cardId));
    if (!source) return;
    const overId = String(e.over.id);
    // A card dropped onto another workspace's card has no meaning: the PATCH
    // route addresses a single board. Grouping doubles as the drag fence.
    const overCard = boards.flatMap((b) => b.cards.map((c) => ({ c, b }))).find((x) => x.c.id === overId);
    if (overCard && overCard.b.id !== source.id) {
      setError("Cards can only move within their own workspace");
      return;
    }
    const target = resolveDrop(source, cardId, overId);
    if (!target) return;
    void applyMove(source.id, cardId, target.columnId, target.order);
  };
```

Replace `addCard` and `createBoard` (lines 276-305):

```tsx
  const addCard = async () => {
    const target = tabBoards[0];
    if (!target || !cardTitle.trim()) return;
    await fetch(`http://${BASE}/work/boards/${encodeURIComponent(target.id)}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: cardTitle.trim() }),
    }).catch(() => setError("Could not add the card"));
    setCardTitle("");
    setAddingCard(false);
    void refetch();
  };

  const addBoard = async (type: BoardTypeT) => {
    const res = (await fetch(`http://${BASE}/work/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, workspaceId: scope }),
    })
      .then((r) => r.json())
      .catch(() => ({ error: "unreachable" }))) as WorkBoardT & { error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    setActiveKey(type);
    void refetch();
  };
```

Replace the whole `<header className="board-stage__bar">` block plus the `creatingBoard` composer (lines 323-380) with:

```tsx
      <BoardTabs
        scope={scope}
        workspaces={workspaces.map((w) => w.name)}
        tabs={tabs}
        activeKey={tab?.key ?? null}
        addable={scope === ALL_WORKSPACES ? [] : addableTypes(boards, scope)}
        onScope={(s) => {
          setScope(s);
          setActiveKey(null);
        }}
        onSelect={setActiveKey}
        onAdd={(t) => void addBoard(t)}
      />
      <header className="board-stage__bar">
        <SquareKanban size={14} strokeWidth={2} />
        <button
          type="button"
          className="settings-btn"
          onClick={() => setAddingCard((v) => !v)}
          disabled={tabBoards.length !== 1}
          title={tabBoards.length > 1 ? "Pick a single workspace to add a card" : undefined}
        >
          <Plus size={12} strokeWidth={2} /> add card
        </button>
        {tabBoards.length === 1 && tabBoards[0].jira && (
          <button type="button" className="settings-btn" onClick={() => void importFromJira()}>
            <Download size={12} strokeWidth={2} /> import from jira
          </button>
        )}
      </header>
```

Point `importFromJira` at `tabBoards[0]` instead of `board`. Replace the columns render (lines 397-411):

```tsx
      {tab && (
        <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragEnd={handleDragEnd}>
          <div className="board-stage__columns">
            {columns.map((col) => (
              <BoardColumn
                key={col.id}
                col={col}
                clusters={clusterByWorkspace(collectCards(tabBoards, col.id), tab.clustered)}
                colorFor={colorFor}
                agentFor={agentFor}
                onOpenCard={(boardId, cardId) => setOpen({ boardId, cardId })}
              />
            ))}
          </div>
        </DndContext>
      )}
```

And the sheet render (lines 412-422):

```tsx
      {open && boardOf(open.boardId) && (
        <CardSheet
          key={open.cardId}
          board={boardOf(open.boardId) as WorkBoardT}
          card={boardOf(open.boardId)?.cards.find((c) => c.id === open.cardId) as WorkCardT}
          roster={roster}
          workspaces={workspaces.map((w) => w.name)}
          onClose={() => setOpen(null)}
          onChanged={() => void refetch()}
        />
      )}
```

Finally update the WS-refetch effect (lines 219-221) to fire when the update names any board in the active tab:

```tsx
  useEffect(() => {
    if (lastBoardUpdate && tabBoards.some((b) => b.id === lastBoardUpdate.boardId)) void refetch();
  }, [lastBoardUpdate, tabBoards, refetch]);
```

Add the imports: `BoardTabs`, `BoardColumn`, and `ALL_WORKSPACES, addableTypes, clusterByWorkspace, collectCards, tabsFor, type BoardTypeT` from `../lib/board-aggregate`, plus `workspaceColor` from `../lib/workspace-color`.

- [ ] **Step 5: Add the cluster CSS**

```css
.board-column__cluster {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.board-column__cluster + .board-column__cluster {
  margin-top: 8px;
}
.board-column__cluster-name {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.8;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --dir control-plane test && pnpm --dir control-plane typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm --dir control-plane exec biome check --write src
git add control-plane/src/molecules/BoardColumn.tsx control-plane/src/organisms/BoardStage.tsx control-plane/src/organisms/BoardStage.test.tsx control-plane/src/styles/components.css
git commit -m "feat(ui): board tabs, workspace scope, and clustered aggregate columns"
```

---

### Task 11: CardSheet — flag control and route pills

**Files:**
- Modify: `control-plane/src/organisms/CardSheet.tsx`
- Modify: `control-plane/src/styles/components.css`
- Test: `control-plane/src/organisms/CardSheet.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `WorkBoardT.type`, `WorkCardT.flag` from Task 8; the swarm route endpoint from Task 4.
- Produces: a `BOARD_ROUTES_UI` mirror in `lib/board-aggregate.ts` and the sheet's flag + route controls.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/organisms/CardSheet.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CardSheet } from "./CardSheet";
import type { WorkBoardT, WorkCardT } from "./BoardStage";

const BOARD = {
  id: "acme-reactive", name: "Reactive", type: "reactive", workspaceId: "acme",
  columns: [{ id: "triage", name: "Triage" }], cards: [],
} as unknown as WorkBoardT;

const CARD = { id: "c1", title: "Alert 4412", columnId: "triage", order: 0 } as WorkCardT;

let calls: Array<{ url: string; method: string; body?: unknown }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
});

const props = { board: BOARD, card: CARD, roster: [], workspaces: ["acme"], onClose: () => {}, onChanged: () => {} };

describe("CardSheet routes", () => {
  it("renders a pill per exit available from the card's column", () => {
    render(<CardSheet {...props} />);
    expect(screen.getByRole("button", { name: "To maintenance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "To ideation" })).toBeTruthy();
  });

  it("renders no pills from a column with no exits", () => {
    render(<CardSheet {...props} card={{ ...CARD, columnId: "closed" }} />);
    expect(screen.queryByRole("button", { name: /^To / })).toBeNull();
  });

  it("POSTs the destination type to the route endpoint", async () => {
    render(<CardSheet {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "To maintenance" }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith("/route"))).toMatchObject({
        method: "POST",
        body: { toType: "maintenance" },
      }),
    );
  });
});

describe("CardSheet flags", () => {
  it("PATCHes the chosen flag kind without a since, which the server stamps", async () => {
    render(<CardSheet {...props} />);
    await userEvent.selectOptions(screen.getByLabelText("Flag"), "blocked");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ flag: { kind: "blocked", reason: "" } }),
    );
  });

  it("PATCHes null to clear", async () => {
    render(<CardSheet {...props} card={{ ...CARD, flag: { kind: "blocked", since: "2026-08-01T00:00:00.000Z" } }} />);
    await userEvent.selectOptions(screen.getByLabelText("Flag"), "");
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ flag: null }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir control-plane exec vitest run src/organisms/CardSheet.test.tsx`
Expected: FAIL — no "To maintenance" button, no "Flag" control.

- [ ] **Step 3: Mirror the route table in `lib/board-aggregate.ts`**

Append (the UI needs the labels to render pills; the swarm remains the authority and re-validates every request):

```ts
export interface RouteExitT {
  from: string;
  toType: BoardTypeT;
  toColumn: string;
  label: string;
}

/** Mirrors the swarm's BOARD_ROUTES. The server re-validates every route request. */
export const BOARD_ROUTES_UI: Record<BoardTypeT, RouteExitT[]> = {
  plan: [
    { from: "tech-design", toType: "ideation", toColumn: "scoping", label: "Back to ideation" },
    { from: "ready", toType: "deliver", toColumn: "ready", label: "Send to deliver" },
  ],
  deliver: [{ from: "in-progress", toType: "plan", toColumn: "tech-design", label: "Back to plan" }],
  release: [
    { from: "regression", toType: "deliver", toColumn: "in-progress", label: "Drop change to deliver" },
    { from: "rollback", toType: "maintenance", toColumn: "triage", label: "To maintenance" },
  ],
  reactive: [
    { from: "triage", toType: "maintenance", toColumn: "triage", label: "To maintenance" },
    { from: "triage", toType: "ideation", toColumn: "intake", label: "To ideation" },
  ],
  ideation: [],
  maintenance: [],
  personal: [],
};

export function exitsForUI(type: BoardTypeT, columnId: string): RouteExitT[] {
  return BOARD_ROUTES_UI[type].filter((e) => e.from === columnId);
}
```

- [ ] **Step 4: Add the controls to `CardSheet.tsx`**

Import `exitsForUI` from `../lib/board-aggregate`, and add after the `unlinkJira` definition:

```tsx
  const exits = exitsForUI(board.type, card.columnId);

  const route = async (toType: string) => {
    const res = await fetch(`${cardUrl}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toType }),
    }).catch(() => null);
    if (!res?.ok) {
      const payload = (await res?.json().catch(() => null)) as { error?: string } | null;
      setError(payload?.error ?? "Could not move the card");
      return;
    }
    onChanged();
    onClose();
  };

  const setFlag = async (kind: string) => {
    await patch({ flag: kind ? { kind, reason: flagReason } : null });
  };
```

Add state beside the others: `const [flagReason, setFlagReason] = useState(card.flag?.reason ?? "");`

Render before the footer:

```tsx
      <div className="card-sheet__row">
        <label>
          Flag
          <select aria-label="Flag" value={card.flag?.kind ?? ""} onChange={(e) => void setFlag(e.target.value)}>
            <option value="">— none —</option>
            <option value="blocked">Blocked</option>
            <option value="at-risk">At risk</option>
            <option value="waiting">Waiting</option>
          </select>
        </label>
        {card.flag && (
          <input
            placeholder="Why?"
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
            onBlur={() => void setFlag(card.flag?.kind ?? "")}
          />
        )}
      </div>
      {exits.length > 0 && (
        <div className="card-sheet__routes">
          {exits.map((e) => (
            <button key={e.label} type="button" className="settings-btn" onClick={() => void route(e.toType)}>
              {e.label}
            </button>
          ))}
        </div>
      )}
```

- [ ] **Step 5: Add the CSS**

```css
.card-sheet__routes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --dir control-plane test && pnpm --dir control-plane typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm --dir control-plane exec biome check --write src
git add control-plane/src/organisms/CardSheet.tsx control-plane/src/organisms/CardSheet.test.tsx control-plane/src/lib/board-aggregate.ts control-plane/src/styles/components.css
git commit -m "feat(ui): card sheet flag control and cross-board route pills"
```

---

### Task 12: Workspace colour swatch in the modals

**Files:**
- Modify: `control-plane/src/organisms/NewWorkspaceModal.tsx`
- Modify: `control-plane/src/organisms/WorkspaceManagerModal.tsx`
- Modify: `control-plane/src/styles/components.css`
- Test: `control-plane/src/organisms/NewWorkspaceModal.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `WORKSPACE_PALETTE`, `derivedColor` from Task 5.
- Produces: a `color` field on the workspace create/patch bodies.

- [ ] **Step 1: Write the failing test**

`control-plane/src/organisms/NewWorkspaceModal.test.tsx` already exists. It does **not** stub `fetch` — the modal takes a `save` prop (`save: vi.fn(async () => ({ name: "acme" }))`) and the file provides a `fillOneValidRepo()` helper that fills every required field. Assert on the `save` mock, not on a request. Append inside the existing `describe("NewWorkspaceModal", …)` block:

```tsx
  it("sends the chosen colour with the workspace", async () => {
    const p = props();
    render(<NewWorkspaceModal {...p} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByLabelText("Colour 3"));
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalled());
    expect((p.save as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      color: WORKSPACE_PALETTE[2],
    });
  });

  it("omits colour entirely when no swatch is picked, so the derived default applies", async () => {
    const p = props();
    render(<NewWorkspaceModal {...p} />);
    await fillOneValidRepo();
    await userEvent.click(screen.getByRole("button", { name: /create workspace/i }));
    await waitFor(() => expect(p.save).toHaveBeenCalled());
    expect((p.save as ReturnType<typeof vi.fn>).mock.calls[0][0].color).toBeUndefined();
  });
```

Add `import { WORKSPACE_PALETTE } from "../lib/workspace-color";` to that test file. If the submit button's accessible name is not "create workspace", read the modal's footer and use the actual text.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir control-plane exec vitest run src/organisms/NewWorkspaceModal.test.tsx`
Expected: FAIL — no radio matching "colour 3".

- [ ] **Step 3: Add the swatch row to both modals**

In `NewWorkspaceModal.tsx`, add `const [color, setColor] = useState<string>("");` beside the other state, include `color: color || undefined` in the POST body next to `description`, and render after the Description field:

```tsx
        <fieldset className="swatch-row">
          <legend>Colour</legend>
          {WORKSPACE_PALETTE.map((c, i) => (
            <label key={c} className="swatch">
              <input
                type="radio"
                name="ws-color"
                aria-label={`Colour ${i + 1}`}
                checked={color === c}
                onChange={() => setColor(c)}
              />
              <span style={{ background: c }} />
            </label>
          ))}
        </fieldset>
```

Import `WORKSPACE_PALETTE` from `../lib/workspace-color`.

Apply the same block in `WorkspaceManagerModal.tsx`, seeding state from the workspace being edited (`useState(ws.color ?? "")`) and including `color` in its PATCH body.

- [ ] **Step 4: Add the CSS**

```css
.swatch-row {
  display: flex;
  gap: 6px;
  border: none;
  padding: 0;
}
.swatch input {
  position: absolute;
  opacity: 0;
}
.swatch span {
  display: block;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}
.swatch input:checked + span {
  border-color: var(--text);
}
```

- [ ] **Step 5: Run everything**

Run: `pnpm --dir control-plane test && pnpm --dir control-plane typecheck && pnpm --dir swarm test && pnpm --dir swarm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm --dir control-plane exec biome check --write src
git add control-plane/src/organisms/NewWorkspaceModal.tsx control-plane/src/organisms/WorkspaceManagerModal.tsx control-plane/src/organisms/NewWorkspaceModal.test.tsx control-plane/src/styles/components.css
git commit -m "feat(ui): workspace colour swatch in the create and manage modals"
```

---

## Final verification

Not a task — run this before opening the branch for review.

- [ ] `pnpm --dir swarm test && pnpm --dir swarm typecheck`
- [ ] `pnpm --dir control-plane test && pnpm --dir control-plane typecheck && pnpm --dir control-plane exec biome check src`
- [ ] Restart swarm + broker + UI (broker runs in tmux `smith-broker` on 7790 from the main checkout — never an unscoped `pkill -f`).
- [ ] **UI click-through smoke**, which the last two board cycles both shipped without and both regretted:
  - Dropdown switches between All workspaces and each workspace; tabs change accordingly.
  - `+ add` creates a board, the new tab appears, and adding the same type again surfaces the 409 message.
  - Personal tab shows the same board in every dropdown context.
  - In All workspaces, cards cluster under workspace subheadings and carry workspace tint.
  - A drag inside one cluster persists; a drag across clusters is refused with the error message.
  - A route pill moves a card to the destination board, and the card is gone from the source.
  - Routing to a type the workspace lacks shows the "add it first" 404 message.
  - A flag renders its chip, edge colour, and age; clearing and reflagging resets the age to 0d.
