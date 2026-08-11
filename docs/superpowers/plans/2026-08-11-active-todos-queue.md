# Active To-dos Board + Queue Intake Implementation Plan

> **CLAIMED:** in execution by Claude session d43af92a (inline, main checkout) since 2026-08-11. Do not execute concurrently.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the personal board to "Active To-dos", make it the first tab, and give it a leftmost Queue intake column fed by a midnight carry-over sweep and escalation routes from the Maintenance/Reactive triage columns.

**Architecture:** Boards are data files under `.smith/work/`; all behavior lives in pure helpers in `swarm/src/work-items.ts` (the file's own rule: routes stay thin, unit tests never boot the server). The control plane mirrors the type order, labels, and route table in `control-plane/src/lib/board-aggregate.ts` — every constant change lands in BOTH files. The midnight sweep is a `setTimeout` chain in `swarm/src/server.ts` following the existing `reapTimer` lifecycle; all sweep *behavior* is a pure, tested helper.

**Tech Stack:** TypeScript ~6.0, Node >= 24, pnpm workspace at repo root. Swarm tests: `node:test` + `node:assert/strict` via tsx. Control-plane tests: vitest. Lint: biome 2.5.3 (root `pnpm lint`, ZERO-diagnostic baseline — any new warning is new debt).

**Spec:** `docs/superpowers/specs/2026-08-11-active-todos-queue-design.md`

## Global Constraints

- Every board-constant change (`BOARD_TYPE_ORDER`, labels, templates, routes) must land in BOTH lockstep files: `swarm/src/work-items.ts` and `control-plane/src/lib/board-aggregate.ts` (UI names carry a `_UI` suffix).
- New board name copy is exactly `"Active To-dos"`; new column is `{ id: "queue", name: "Queue" }`, always leftmost on the personal board.
- Escalation route label copy is exactly `"Escalate to Active To-dos"`; routes exist only from `maintenance.triage` and `reactive.triage`, landing in `personal.queue`.
- Sweep is cron-only (Edwin's explicit ruling): no lazy/boot-time catch-up. A server down at 00:00 skips that day.
- The migration renames only a board whose persisted name is exactly `"Personal"`; custom renames are preserved.
- Shared checkout: other sessions edit this worktree. Before every commit run `git status` + `git diff --stat`, stage ONLY the files this plan names via explicit paths, and verify the `[main <hash>]` line + file count in the commit output.
- Commands run from the repo root `/Users/edwincruz/Development/Workspaces/jefelabs/smithagents` unless a `cd` is shown.
- Test suites: `pnpm --dir swarm test` (node:test), `pnpm --dir control-plane test` (vitest). Root `pnpm typecheck` and `pnpm lint` must be clean at the end of every task.

---

### Task 1: Swarm — personal first, "Active To-dos" label, Queue template, quick-add default

**Files:**
- Modify: `swarm/src/work-items.ts:65-99` (order, labels, template), `swarm/src/work-items.ts:332-336` (addCard default)
- Test: `swarm/src/work-items.test.ts`, `swarm/src/capabilities.test.ts:334-346`

**Interfaces:**
- Consumes: existing `WorkBoard`, `createBoard`, `addCard`.
- Produces: `defaultColumnFor(board: WorkBoard): string | undefined` (exported from `work-items.ts`); `BOARD_TEMPLATES.personal` now has 5 columns with `queue` first; `BOARD_TYPE_LABELS.personal === "Active To-dos"`; `BOARD_TYPE_ORDER[0] === "personal"`. Tasks 2–5 rely on all four.

- [ ] **Step 1: Update the four existing tests that pin the old shape, and extend the addCard test**

In `swarm/src/work-items.test.ts`:

1. In `test("templates: seven typed column sets, ids unique and slug-shaped", ...)` change the personal expectation:

```ts
  assert.deepEqual(
    BOARD_TEMPLATES.personal.map((c) => c.name),
    ["Queue", "Todo", "Doing", "Done", "Not Doing"],
  );
```

2. Replace the whole `test("type order puts personal last and WORKSPACE_BOARD_TYPES excludes it", ...)` with:

```ts
test("type order puts personal first and WORKSPACE_BOARD_TYPES excludes it", () => {
  assert.deepEqual(BOARD_TYPE_ORDER, ["personal", "ideation", "plan", "deliver", "release", "reactive", "maintenance"]);
  assert.equal(WORKSPACE_BOARD_TYPES.includes("personal" as BoardType), false);
  assert.equal(WORKSPACE_BOARD_TYPES.length, 6);
});
```

3. In `test("createBoard: personal is workspace-less with a fixed id; mismatches throw", ...)` change the name assertion to:

```ts
  assert.equal(p.name, "Active To-dos");
```

4. Replace the whole `test("addCard appends to the leftmost column by default and orders sequentially", ...)` with:

```ts
test("addCard defaults to Todo on the personal board, leftmost elsewhere; orders sequentially", () => {
  const b = createBoard("personal");
  const a = addCard(b, { title: "first" });
  const c = addCard(b, { title: "second" });
  assert.equal(defaultColumnFor(b), "todo");
  assert.equal(a.columnId, "todo");
  assert.deepEqual([a.order, c.order], [0, 1]);
  assert.ok(a.id !== c.id && a.createdAt && a.updatedAt);
  const ws = createBoard("deliver", "acme");
  assert.equal(defaultColumnFor(ws), "ready");
  assert.equal(addCard(ws, { title: "x" }).columnId, "ready");
  assert.throws(() => addCard(b, { title: "  " }), /title/i);
  assert.throws(() => addCard(b, { title: "x", columnId: "nope" }), /column/i);
});
```

5. Add `defaultColumnFor` to the import block at the top of the file (it is alphabetical: after `createBoard`, before `deleteBoardFile`).

In `swarm/src/capabilities.test.ts`, in `test("ensurePersonalBoard creates exactly one workspace-less board and is idempotent", ...)` change the columns expectation:

```ts
  assert.deepEqual(
    boards[0].columns.map((c) => c.name),
    ["Queue", "Todo", "Doing", "Done", "Not Doing"],
  );
```

- [ ] **Step 2: Run the swarm suite to verify the edited tests fail**

Run: `pnpm --dir swarm test 2>&1 | tail -20`
Expected: FAIL — `defaultColumnFor` is not exported (import error), and if the import is stubbed the four edited assertions fail against the old data.

- [ ] **Step 3: Implement in `swarm/src/work-items.ts`**

1. Replace the order constant and its comment (lines 67-76):

```ts
/** Tab order. personal is always first; the other six are the workspace types. */
export const BOARD_TYPE_ORDER: BoardType[] = [
  "personal",
  "ideation",
  "plan",
  "deliver",
  "release",
  "reactive",
  "maintenance",
];
```

2. In `BOARD_TYPE_LABELS` change the personal entry:

```ts
  personal: "Active To-dos",
```

3. In `BOARD_TEMPLATES` replace the personal column set:

```ts
  personal: [
    { id: "queue", name: "Queue" },
    { id: "todo", name: "Todo" },
    { id: "doing", name: "Doing" },
    { id: "done", name: "Done" },
    { id: "not-doing", name: "Not Doing" },
  ],
```

4. Add the helper directly above `addCard`:

```ts
/**
 * Quick-adds land where the user works, not where the system routes: the
 * personal board's leftmost column is the Queue intake (sweep + escalations
 * only), so fresh cards default to Todo there and to the leftmost column
 * everywhere else.
 */
export function defaultColumnFor(board: WorkBoard): string | undefined {
  return board.type === "personal" ? "todo" : board.columns[0]?.id;
}
```

5. In `addCard` change the default-column line:

```ts
  const columnId = input.columnId ?? defaultColumnFor(board);
```

- [ ] **Step 4: Run the swarm suite to verify it passes**

Run: `pnpm --dir swarm test 2>&1 | tail -5`
Expected: PASS (all tests). If any OTHER test fails on the personal template/name, it hardcodes the old shape — update it the same way as Step 1's edits.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/work-items.ts swarm/src/work-items.test.ts swarm/src/capabilities.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): personal board is Active To-dos, first in order, with a Queue intake column

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Verify the output shows `[main <hash>]` and exactly 3 files changed.

---

### Task 2: Swarm — lazy migration of the persisted personal board

**Files:**
- Modify: `swarm/src/work-items.ts` (new export + one line in `loadBoards`)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: `WorkBoard`, `loadBoards`, `createBoard` (Task 1's template).
- Produces: `normalizePersonalBoard(board: WorkBoard): WorkBoard` (exported); `loadBoards` returns already-normalized personal boards. Task 5's sweep relies on `loadBoards` output always having the `queue` column.

- [ ] **Step 1: Write the failing tests**

Add to `swarm/src/work-items.test.ts` (import `normalizePersonalBoard` and type `WorkBoard` in the import block):

```ts
test("normalizePersonalBoard migrates a pre-rename personal board and is idempotent", () => {
  const legacy: WorkBoard = {
    id: "personal",
    name: "Personal",
    type: "personal",
    columns: [
      { id: "todo", name: "Todo" },
      { id: "doing", name: "Doing" },
      { id: "done", name: "Done" },
      { id: "not-doing", name: "Not Doing" },
    ],
    cards: [],
  };
  normalizePersonalBoard(legacy);
  assert.equal(legacy.name, "Active To-dos");
  assert.deepEqual(
    legacy.columns.map((c) => c.id),
    ["queue", "todo", "doing", "done", "not-doing"],
  );
  normalizePersonalBoard(legacy);
  assert.equal(legacy.columns.filter((c) => c.id === "queue").length, 1);
});

test("normalizePersonalBoard keeps a custom name and never touches workspace boards", () => {
  const renamed = { ...createBoard("personal"), name: "Edwin's list" };
  assert.equal(normalizePersonalBoard(renamed).name, "Edwin's list");
  const ws = createBoard("deliver", "acme");
  const before = ws.columns.map((c) => c.id);
  normalizePersonalBoard(ws);
  assert.deepEqual(
    ws.columns.map((c) => c.id),
    before,
  );
});

test("loadBoards migrates a legacy personal file in memory only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  await writeFile(
    join(dir, "personal.json"),
    JSON.stringify({
      id: "personal",
      name: "Personal",
      type: "personal",
      columns: [{ id: "todo", name: "Todo" }],
      cards: [],
    }),
  );
  const { boards } = await loadBoards(dir);
  assert.equal(boards[0].name, "Active To-dos");
  assert.equal(boards[0].columns[0].id, "queue");
  // In-memory only: the file still says Personal until the next mutation saves.
  assert.match(await readFile(join(dir, "personal.json"), "utf8"), /"Personal"/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --dir swarm test 2>&1 | tail -10`
Expected: FAIL — `normalizePersonalBoard` is not exported.

- [ ] **Step 3: Implement in `swarm/src/work-items.ts`**

Add above `loadBoards`:

```ts
/**
 * Reshape a personal board persisted before the Active To-dos rename: the
 * default name follows the new label and the queue intake column is
 * prepended. A custom rename is preserved. In-memory only — the file is
 * rewritten the next time any mutation saves the board.
 */
export function normalizePersonalBoard(board: WorkBoard): WorkBoard {
  if (board.type !== "personal") return board;
  if (board.name === "Personal") board.name = "Active To-dos";
  if (!board.columns.some((c) => c.id === "queue")) board.columns.unshift({ id: "queue", name: "Queue" });
  return board;
}
```

In `loadBoards`, wrap the push:

```ts
      boards.push(normalizePersonalBoard(assertBoard(file, JSON.parse(await readFile(join(dir, file), "utf8")))));
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --dir swarm test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/work-items.ts swarm/src/work-items.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): loadBoards lazily migrates the legacy Personal board (rename + queue column)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Verify `[main <hash>]`, 2 files.

---

### Task 3: Swarm — escalation routes from maintenance/reactive triage into the personal queue

**Files:**
- Modify: `swarm/src/work-items.ts:191-233` (`BOARD_ROUTES`, `findRouteDestination`)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: `RouteExit`, `resolveExit`, `routeCard`, `exitsFor` (unchanged); Task 1's `queue` column.
- Produces: `BOARD_ROUTES.maintenance` and `.reactive` each contain `{ from: "triage", toType: "personal", toColumn: "queue", label: "Escalate to Active To-dos" }`; `findRouteDestination` resolves `toType: "personal"` to the workspace-less singleton. The server route endpoint (`POST /work/boards/:id/cards/:cardId/route`) picks all of this up with zero endpoint changes.

- [ ] **Step 1: Write/adjust the failing tests**

In `swarm/src/work-items.test.ts`:

1. In `test("routes: exits are per-column and the forward plan handoff exists", ...)` change the reactive expectation:

```ts
  assert.deepEqual(
    exitsFor(reactive, "triage").map((e) => e.toType),
    ["maintenance", "ideation", "personal"],
  );
```

2. Add three new tests after `test("findRouteDestination: does not match a same-type board in a different workspace", ...)`:

```ts
test("escalation: maintenance and reactive triage each exit to the personal queue", () => {
  const maintenance = createBoard("maintenance", "acme");
  const reactive = createBoard("reactive", "acme");
  assert.deepEqual(
    exitsFor(maintenance, "triage").map((e) => e.label),
    ["Escalate to Active To-dos"],
  );
  assert.equal(resolveExit(reactive, "triage", "personal")?.toColumn, "queue");
  assert.deepEqual(exitsFor(maintenance, "doing"), []);
});

test("findRouteDestination resolves the workspace-less personal board from any workspace", () => {
  const source = createBoard("maintenance", "acme");
  const personal = createBoard("personal");
  const boards = [createBoard("maintenance", "globex"), personal, source];
  const exit = resolveExit(source, "triage", "personal");
  assert.ok(exit);
  assert.equal(findRouteDestination(boards, source, exit), personal);
});

test("routeCard escalates a triage card into the personal queue with a provenance trace", () => {
  const maintenance = createBoard("maintenance", "acme");
  const personal = createBoard("personal");
  addCard(personal, { title: "already queued", columnId: "queue" });
  const card = addCard(maintenance, { title: "prod leak", columnId: "triage" });
  const exit = resolveExit(maintenance, "triage", "personal");
  assert.ok(exit);
  const plan = routeCard(maintenance, personal, card.id, exit, "2026-08-11T00:00:00.000Z");
  assert.equal(plan.card.columnId, "queue");
  assert.equal(plan.card.order, 1); // appended after the existing queue card
  assert.equal(plan.writeFirst, personal); // destination-first persistence
  assert.deepEqual(plan.card.routedFrom?.at(-1), {
    boardId: maintenance.id,
    boardType: "maintenance",
    columnId: "triage",
    at: "2026-08-11T00:00:00.000Z",
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --dir swarm test 2>&1 | tail -15`
Expected: FAIL — maintenance has no exits, reactive triage maps to two types, `findRouteDestination` returns `undefined` for personal.

- [ ] **Step 3: Implement in `swarm/src/work-items.ts`**

1. In `BOARD_ROUTES`, replace the `reactive` and `maintenance` entries:

```ts
  reactive: [
    { from: "triage", toType: "maintenance", toColumn: "triage", label: "To maintenance" },
    { from: "triage", toType: "ideation", toColumn: "intake", label: "To ideation" },
    { from: "triage", toType: "personal", toColumn: "queue", label: "Escalate to Active To-dos" },
  ],
  ideation: [],
  maintenance: [{ from: "triage", toType: "personal", toColumn: "queue", label: "Escalate to Active To-dos" }],
  personal: [],
```

2. Replace `findRouteDestination`:

```ts
/**
 * The board a routed card lands on: same workspace as the source, the exit's
 * destination type. The personal board is the workspace-less singleton, so an
 * escalation reaches it from any workspace.
 */
export function findRouteDestination(boards: WorkBoard[], source: WorkBoard, exit: RouteExit): WorkBoard | undefined {
  if (exit.toType === "personal") return boards.find((b) => b.type === "personal");
  return boards.find((b) => b.type === exit.toType && b.workspaceId === source.workspaceId);
}
```

Note: `test("every route points at a column that exists on its destination template", ...)` validates the new entries automatically — `queue` exists on the personal template since Task 1.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --dir swarm test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/work-items.ts swarm/src/work-items.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): maintenance/reactive triage escalate into the Active To-dos queue

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Verify `[main <hash>]`, 2 files.

---

### Task 4: Swarm — sweptDay stamp, pure midnight sweep, midnight math

**Files:**
- Modify: `swarm/src/work-items.ts` (`WorkBoard` field + three new exports)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: `WorkBoard`, `WorkCard`, Task 1's `queue`/`todo`/`doing` column ids.
- Produces (all exported from `work-items.ts`, consumed by Task 5):
  - `WorkBoard.sweptDay?: string` — local `YYYY-MM-DD`, personal board only.
  - `sweepPersonalBoard(board: WorkBoard, today: string): boolean` — returns "board is dirty, save it".
  - `localDayStamp(now: Date): string`
  - `msUntilNextMidnight(now: Date): number`

- [ ] **Step 1: Write the failing tests**

Add to `swarm/src/work-items.test.ts` (import `localDayStamp`, `msUntilNextMidnight`, `sweepPersonalBoard`):

```ts
test("sweepPersonalBoard moves Todo then Doing to the end of Queue, preserving order", () => {
  const b = createBoard("personal");
  const queued = addCard(b, { title: "queued", columnId: "queue" });
  const t1 = addCard(b, { title: "t1", columnId: "todo" });
  const t2 = addCard(b, { title: "t2", columnId: "todo" });
  const d1 = addCard(b, { title: "d1", columnId: "doing" });
  const done = addCard(b, { title: "done", columnId: "done" });
  assert.equal(sweepPersonalBoard(b, "2026-08-11"), true);
  const queue = b.cards.filter((c) => c.columnId === "queue").sort((x, y) => x.order - y.order);
  assert.deepEqual(
    queue.map((c) => c.id),
    [queued.id, t1.id, t2.id, d1.id],
  );
  assert.deepEqual(
    queue.map((c) => c.order),
    [0, 1, 2, 3],
  );
  assert.equal(done.columnId, "done");
  assert.equal(b.sweptDay, "2026-08-11");
});

test("sweepPersonalBoard is idempotent per day; a stamp-only day still reports dirty", () => {
  const b = createBoard("personal");
  assert.equal(sweepPersonalBoard(b, "2026-08-11"), true); // nothing to move, stamp must persist
  assert.equal(sweepPersonalBoard(b, "2026-08-11"), false); // same day: no-op
  assert.equal(sweepPersonalBoard(b, "2026-08-12"), true); // next day stamps again
});

test("sweepPersonalBoard never touches workspace boards", () => {
  const ws = createBoard("deliver", "acme");
  addCard(ws, { title: "x", columnId: "in-progress" });
  assert.equal(sweepPersonalBoard(ws, "2026-08-11"), false);
  assert.equal(ws.sweptDay, undefined);
});

test("localDayStamp and msUntilNextMidnight do local-midnight math", () => {
  const nearMidnight = new Date(2026, 7, 11, 23, 59, 0); // Aug 11, 23:59 local
  assert.equal(localDayStamp(nearMidnight), "2026-08-11");
  assert.equal(msUntilNextMidnight(nearMidnight), 60_000);
  assert.equal(localDayStamp(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(msUntilNextMidnight(new Date(2026, 7, 11, 0, 0, 0)), 86_400_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --dir swarm test 2>&1 | tail -10`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Implement in `swarm/src/work-items.ts`**

1. In the `WorkBoard` interface, after the `workspaceId` member:

```ts
  /** Local YYYY-MM-DD of the last midnight sweep. Personal board only. */
  sweptDay?: string;
```

2. Add below `normalizePersonalBoard`:

```ts
/** Local calendar day, YYYY-MM-DD — the sweptDay idempotence stamp. */
export function localDayStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Milliseconds from `now` to the next local midnight. The Date constructor normalizes the day+1 overflow, which keeps DST days honest. */
export function msUntilNextMidnight(now: Date): number {
  return Math.max(1, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime());
}

/**
 * Day rollover for Active To-dos: everything still in Todo or Doing joins the
 * end of Queue — Todo's cards first, then Doing's, relative order preserved.
 * Guarded by sweptDay so a double-fire is a no-op; a stamp-only change still
 * reports dirty because the stamp must persist. Pure: the caller owns load,
 * save, and the clock.
 */
export function sweepPersonalBoard(board: WorkBoard, today: string): boolean {
  if (board.type !== "personal" || board.sweptDay === today) return false;
  if (!board.columns.some((c) => c.id === "queue")) return false;
  board.sweptDay = today;
  const rank = (c: WorkCard) => (c.columnId === "todo" ? 0 : 1);
  const leftovers = board.cards
    .filter((c) => c.columnId === "todo" || c.columnId === "doing")
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  const now = new Date().toISOString();
  let order = board.cards.filter((c) => c.columnId === "queue").length;
  for (const c of leftovers) {
    c.columnId = "queue";
    c.order = order++;
    c.updatedAt = now;
  }
  return true;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --dir swarm test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/work-items.ts swarm/src/work-items.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): pure midnight sweep — Todo/Doing leftovers roll into the Queue, sweptDay-guarded

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Verify `[main <hash>]`, 2 files.

---

### Task 5: Swarm server — midnight timer wiring

**Files:**
- Modify: `swarm/src/server.ts` (import block ~line 147, timer field ~line 236, `start()` after the reap block ~line 408, `stop()` ~line 443, new private method)

**Interfaces:**
- Consumes: Task 4's `sweepPersonalBoard`, `localDayStamp`, `msUntilNextMidnight`; Task 2's normalization inside `loadBoards`; existing `saveBoard`, `this.workDir()`, `this.app.log`.
- Produces: a self-rescheduling midnight sweep, created in `start()`, cleared in `stop()`. No new endpoints, no WS broadcast (the UI catches up on its next fetch/refocus).

There is deliberately no unit test for the timer wiring — same as `reapTimer`. All sweep behavior was tested in Task 4; this task is verified by typecheck + the full existing suite.

- [ ] **Step 1: Add the imports**

In the `./work-items.js` import block in `swarm/src/server.ts` (alphabetical order), add:

```ts
  localDayStamp,
  msUntilNextMidnight,
  sweepPersonalBoard,
```

- [ ] **Step 2: Add the timer field**

Next to the `reapTimer` declaration (~line 236):

```ts
  /** Midnight sweep of the Active To-dos board — Todo/Doing leftovers roll into Queue. */
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
```

- [ ] **Step 3: Schedule in `start()` and clear in `stop()`**

In `start()`, immediately after the `this.reapTimer = setInterval(...)` block (~line 408):

```ts
    // Day rollover for the Active To-dos board. Cron-only by design (spec:
    // 2026-08-11 ruling) — if the server is down at 00:00 the sweep waits
    // for the next midnight; there is no boot-time catch-up.
    this.scheduleMidnightSweep();
```

In `stop()`, next to the `reapTimer` clear (~line 444):

```ts
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
```

- [ ] **Step 4: Add the private method**

Below `start()` (next to the other private lifecycle helpers):

```ts
  /** setTimeout chain, not setInterval: each firing re-measures the distance to the NEXT local midnight, so drift and DST never accumulate. */
  private scheduleMidnightSweep(): void {
    this.sweepTimer = setTimeout(async () => {
      try {
        const { boards } = await loadBoards(this.workDir());
        const personal = boards.find((b) => b.type === "personal");
        if (personal && sweepPersonalBoard(personal, localDayStamp(new Date()))) {
          await saveBoard(this.workDir(), personal);
          this.app.log.info("Swept Active To-dos leftovers into Queue");
        }
      } catch (err) {
        this.app.log.warn(`Midnight sweep failed: ${(err as Error).message}`);
      } finally {
        this.scheduleMidnightSweep();
      }
    }, msUntilNextMidnight(new Date()));
  }
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck 2>&1 | tail -5` — expected: clean.
Run: `pnpm --dir swarm test 2>&1 | tail -5` — expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add swarm/src/server.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(swarm): midnight sweep timer — reapTimer-style lifecycle, self-rescheduling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Verify `[main <hash>]`, 1 file.

---

### Task 6: Control plane — mirror order, label, tab prepend, escalation routes

**Files:**
- Modify: `control-plane/src/lib/board-aggregate.ts`
- Test: `control-plane/src/lib/board-aggregate.test.ts`

**Interfaces:**
- Consumes: nothing new from other tasks (the mirror is hand-kept lockstep, enforced only by tests).
- Produces: `BOARD_TYPE_ORDER_UI[0] === "personal"`; `BOARD_TYPE_LABELS_UI.personal === "Active To-dos"`; `tabsFor` puts the personal tab FIRST; `BOARD_ROUTES_UI.maintenance`/`.reactive` carry the escalate exit. Task 7's component tests rely on the tab order.

- [ ] **Step 1: Update the failing tests**

In `control-plane/src/lib/board-aggregate.test.ts`:

1. Retitle + reshape the workspace-scope test:

```ts
  it("in workspace scope lists personal first, then that workspace's boards in canonical order", () => {
    const tabs = tabsFor(BOARDS, new Set(["acme"]));
    expect(tabs.map((t) => t.type)).toEqual(["personal", "ideation", "plan"]);
    expect(tabs[0].boardIds).toEqual(["personal"]);
    expect(tabs[1].boardIds).toEqual(["acme-ideation"]);
  });
```

2. In `it("in all scope collapses to types and unions the board ids", ...)` change the order expectation:

```ts
    expect(tabs.map((t) => t.type)).toEqual(["personal", "ideation", "plan"]);
```

3. In `it("a multiselect of two workspaces unions their boards and clusters, same as all scope", ...)` change the order expectation the same way:

```ts
    expect(tabs.map((t) => t.type)).toEqual(["personal", "ideation", "plan"]);
```

4. Replace the ordering-consistency test:

```ts
  it("is the same ordering BOARD_TYPE_ORDER_UI states, with personal first", () => {
    // Two hand-written lists of the same thing. Nothing reads both today, so
    // only this assertion stops a seventh type landing in one and not the other.
    expect(BOARD_TYPE_ORDER_UI).toEqual(["personal", ...WORKSPACE_BOARD_TYPES_UI]);
  });
```

5. Add a routes test (import `exitsForUI` if not already imported):

```ts
describe("exitsForUI", () => {
  it("maintenance and reactive triage offer the escalate exit to the personal queue", () => {
    expect(exitsForUI("maintenance", "triage").map((e) => e.toColumn)).toEqual(["queue"]);
    expect(exitsForUI("reactive", "triage").map((e) => e.toType)).toEqual(["maintenance", "ideation", "personal"]);
    expect(exitsForUI("maintenance", "doing")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --dir control-plane exec vitest run src/lib/board-aggregate.test.ts 2>&1 | tail -15`
Expected: FAIL — order still personal-last, no maintenance exits.

- [ ] **Step 3: Implement in `control-plane/src/lib/board-aggregate.ts`**

1. Replace the order constant and its comment:

```ts
/** Mirrors the swarm's BOARD_TYPE_ORDER — personal always first. */
export const BOARD_TYPE_ORDER_UI: BoardTypeT[] = [
  "personal",
  "ideation",
  "plan",
  "deliver",
  "release",
  "reactive",
  "maintenance",
];
```

2. In `BOARD_TYPE_LABELS_UI`:

```ts
  personal: "Active To-dos",
```

3. In `tabsFor`, move the personal block ABOVE the workspace-types loop and update the doc comment:

```ts
/**
 * Personal is context-invariant: it is the one tab whose content is not a
 * function of the dropdown, so it is prepended explicitly rather than falling
 * out of a `workspaceId === undefined` filter — which is how it would get
 * folded into the aggregate by accident later. It leads the strip: Active
 * To-dos is the first thing the boards stage shows.
 */
export function tabsFor(boards: WorkBoardT[], scope: ReadonlySet<string> | typeof ALL_WORKSPACES): TabDescriptor[] {
  const all = scope === ALL_WORKSPACES;
  const tabs: TabDescriptor[] = [];
  const personal = boards.find((b) => b.type === "personal");
  if (personal) {
    tabs.push({
      key: "personal",
      label: personal.name,
      type: "personal",
      boardIds: [personal.id],
      clustered: false,
    });
  }
  for (const type of WORKSPACE_BOARD_TYPES_UI) {
    const matches = boards.filter(
      (b) => b.type === type && (all ? Boolean(b.workspaceId) : scope.has(b.workspaceId ?? "")),
    );
    if (matches.length === 0) continue;
    tabs.push({
      key: type,
      label: all ? BOARD_TYPE_LABELS_UI[type] : matches[0].name,
      type,
      boardIds: matches.map((b) => b.id),
      clustered: all || scope.size > 1,
    });
  }
  return tabs;
}
```

4. In `BOARD_ROUTES_UI`, replace the `reactive` and `maintenance` entries:

```ts
  reactive: [
    { from: "triage", toType: "maintenance", toColumn: "triage", label: "To maintenance" },
    { from: "triage", toType: "ideation", toColumn: "intake", label: "To ideation" },
    { from: "triage", toType: "personal", toColumn: "queue", label: "Escalate to Active To-dos" },
  ],
  ideation: [],
  maintenance: [{ from: "triage", toType: "personal", toColumn: "queue", label: "Escalate to Active To-dos" }],
  personal: [],
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --dir control-plane exec vitest run src/lib/board-aggregate.test.ts 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/lib/board-aggregate.ts control-plane/src/lib/board-aggregate.test.ts
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(cp): Active To-dos tab leads the boards stage; escalate exits mirrored

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Verify `[main <hash>]`, 2 files.

---

### Task 7: Control plane — component test fixtures, escalate button coverage, full verification

**Files:**
- Test: `control-plane/src/organisms/BoardStage.test.tsx`, `control-plane/src/molecules/BoardTabs.test.tsx`, `control-plane/src/organisms/CardSheet.test.tsx`

**Interfaces:**
- Consumes: Task 6's tab order and `BOARD_ROUTES_UI`. No production code changes in this task — components render tabs/columns/exits from data, so only fixtures and expectations move.

- [ ] **Step 1: Update the fixtures and expectations**

1. `control-plane/src/molecules/BoardTabs.test.tsx`: in the fixture (line ~8) change `label: "Personal"` to `label: "Active To-dos"`, and the click at line ~33 to `screen.getByRole("tab", { name: "Active To-dos" })`. Then `grep -n "Personal" control-plane/src/molecules/BoardTabs.test.tsx` — update any remaining occurrence the same way.

2. `control-plane/src/organisms/BoardStage.test.tsx`: for every fixture line `{ ...BOARD, id: "personal", name: "Personal", type: "personal", workspaceId: undefined }` (lines ~176, ~278, ~309) change `name: "Personal"` to `name: "Active To-dos"`. Retitle the test at line ~171 to `"shows a tab per board, personal first, following the session frame's workspace"` and change its assertion (line ~184) to:

```ts
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Active To-dos", "Plan"]);
```

Change every `getByRole("tab", { name: "Personal" })` (lines ~285-286, ~316-317) to `{ name: "Active To-dos" }`. Then `grep -n "Personal" control-plane/src/organisms/BoardStage.test.tsx` — update any remaining occurrence.

3. `control-plane/src/organisms/CardSheet.test.tsx`: the reactive-triage exit test (~line 46) asserts the "To maintenance"/"To ideation" buttons. Add the new escalate button right after those two assertions:

```ts
    expect(screen.getByRole("button", { name: "Escalate to Active To-dos" })).toBeTruthy();
```

- [ ] **Step 2: Run the two suites**

Run: `pnpm --dir control-plane test 2>&1 | tail -10`
Expected: PASS. If any other test fails on tab order or the "Personal" name, it hardcodes the old shape — update it exactly like Step 1's edits.

Run: `pnpm --dir swarm test 2>&1 | tail -5`
Expected: PASS (unchanged, confirms no cross-package drift).

- [ ] **Step 3: Root-level verification**

Run: `pnpm typecheck 2>&1 | tail -5` — expected: clean.
Run: `pnpm lint > /tmp/lint.out 2>&1; echo "lint-exit=$?"; tail -5 /tmp/lint.out` — expected: `lint-exit=0`, zero diagnostics (the baseline; any new warning is new debt introduced by this work — fix it).

- [ ] **Step 4: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/organisms/BoardStage.test.tsx control-plane/src/molecules/BoardTabs.test.tsx control-plane/src/organisms/CardSheet.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "test(cp): boards fixtures follow Active To-dos-first order; escalate button covered

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
Verify `[main <hash>]`, 3 files.

---

## Post-plan notes (not tasks)

- The live swarm service must be restarted to pick up the new routes, template, and sweep timer (check how it runs before touching anything — see `pkill-safety-shared-worktrees` memory: never unscoped `pkill -f`).
- The on-disk `personal.json` is intentionally NOT rewritten by a migration pass; it converts in memory on every load and persists on the next mutation.
- A UI smoke (open /work, see Active To-dos first with a Queue column, escalate a triage card) is worth doing after the service restart.
