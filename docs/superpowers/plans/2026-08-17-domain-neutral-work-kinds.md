# Domain-Neutral Work Kinds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the board vocabulary and source presets domain-neutral — neutral column ids everywhere, then per-work-kind **labels** supplied as data, so a marketing, sales, consulting, content, creator or trading team sees its own words without a code change.

**Architecture:** Column ids become domain-neutral and are migrated in one pass (columns, cards, and both copies of the route table). A new `work-kinds.ts` holds work kinds as **data keyed by id** — never a TypeScript union — each supplying column labels and source presets. `createBoard` consults the work kind at **seed time only**, so nothing persisted changes shape and no live board is ever retitled. `Workspace.workKind` carries the choice, because boards are seeded per workspace.

**Tech Stack:** TypeScript ~6.0.0 (ESM, `.js` import specifiers), Node >= 24, `node:test` + `node:assert/strict` (swarm), vitest + Testing Library (control-plane), biome 2.5.3.

**Spec:** `docs/superpowers/specs/2026-08-15-domain-neutral-boards-design.md`. Companion: `docs/superpowers/specs/2026-08-15-welcome-wizard-design.md` (contributes the one optional question that sets `workKind`; the wizard itself is a separate plan).

## Design decisions this plan encodes

**1. `workKind` lives on the Workspace** (Edwin, 2026-08-17). `Workspace.workKind?: string`, optional; absent means product/software, so an install that never answers the question behaves exactly as today. Boards are seeded per workspace, so a consultant with a marketing client and a product client gets the right words in each. The wizard writes it onto the workspace it creates.

**2. The migration renames ids only — never names.** The spec's rule is "vocabulary changes never rewrite existing boards". An existing board keeps the title it displays (`Tech design`), and only its `id` moves (`tech-design` → `design`). That is also *correct*, not merely safe: `Tech design` **is** the product/software vocabulary's label for `design`.

**3. Presets are validated against the union of every work kind's presets, plus `custom`.** Not "any string": the type calls `preset` UI sugar, but a derived-from-data set still catches a typo, and adding a kind adds its presets for free. This is the "data, not a union" fix applied one layer down.

## Global Constraints

- Node >= 24; TypeScript ~6.0.0; ESM with `.js` import specifiers on every relative import.
- **Work kinds must be data, not a TypeScript union** — the list went 3 → 7 domains in one conversation. Precedent: `AgentEngine.stereotype` is an open `string`, personas load as config.
- **An unknown work kind falls back to product/software, never to an empty board.**
- **A vocabulary missing a label falls back to the default label for that id**, per column, so a partial file degrades one cell rather than breaking a board.
- **Vocabulary changes never rewrite existing boards.** Labels are chosen at seed time.
- swarm tests use `node:test` + `node:assert/strict`; every test writes to `mkdtempSync(tmpdir())`. **No test may touch the real state root at `~/.smithagents`**, and no test may reach the network.
- **Nothing reachable from boot may throw uncaught.** `loadBoards` already wraps each file in try/catch and collects `errors[]`, so a board that fails migration is surfaced per-file rather than killing boot — that is the only sanctioned throw.
- Baselines, measured 2026-08-17 on `main` @ `9418fa4`:
  - swarm: **594 tests passing, 0 failing**; `tsc` **12 errors** (pre-existing, in `agent-sessions.ts` ×10, `jira-sync.test.ts`, `server.ts`).
  - control-plane: **924 passing, 2 FAILING** — `HomePage.test.tsx > picking another session backs out of an explicitly-opened composer` and `MapStage.test.tsx > offers a pan-mode toggle in the zoom controls cluster`. Both reproduce deterministically in isolation, both are unrelated to boards. **They are the baseline, not your regression.** Do not fix them here; do not let them mask a real one.
  - control-plane `tsc --noEmit`: **10 pre-existing errors**, in `organisms/map/nodes.test.tsx`, `organisms/NewContextModal.test.tsx` and `organisms/WorkspaceManagerModal.test.tsx` (measured during Task 1 and confirmed by stashing). An earlier draft of this plan said the control-plane typecheck was clean — it is not, and never was. Confirm your touched files carry no errors; do not chase these ten.
- Measurement traps:
  - Typecheck swarm with `cd swarm && ./node_modules/.bin/tsc --noEmit`. **Never `npx tsc` from the repo root** — decoy placeholder package.
  - tsc ANSI-colorizes. Strip first: `sed 's/\x1b\[[0-9;]*m//g'`. **Count with `grep -c 'error TS'`, NOT `grep -oE 'Found [0-9]+ error'`** — that summary line only exists in `--pretty` mode and returns empty here. A blank count means your measurement broke; cross-check `tsc`'s exit code.
  - `node:test` summary lines start with `ℹ`, not `#`.
  - A `cd` to a path **outside the project** is silently dropped inside a compound Bash command. Use absolute paths and `git -C`.

## Context: what exists today, and where

- **`BOARD_TEMPLATES`** — `swarm/src/work-items.ts:132-183`. The six ids to rename live at `:147-149` (plan), `:158` (deliver), `:162-163` (release).
- **`BOARD_ROUTES`** — `swarm/src/work-items.ts:234-251`. Matches on column ids (`e.from === columnId`). Three entries reference renamed ids: `tech-design` at `:236` and `:239`, `regression` at `:241`.
- **`BOARD_ROUTES_UI`** — `control-plane/src/lib/board-aggregate.ts:197-210`. **A hand-synced duplicate of `BOARD_ROUTES`**, with a comment saying so. Same three entries. Drift does not corrupt data — the server re-validates — but it offers a pill that 400s on click.
- **`normalizeBoard`** — `swarm/src/work-items.ts:384-423`. The migration home and the precedent: it already rewrites `queued` → `queue` (`:387-395`) and a personal board's `queue`/`todo` → `plate` (`:400-413`), each rewriting `card.columnId` alongside the column. Called from `loadBoards` at `:486`, inside a per-file try/catch.
- **`gatesHuman` backfill** — `swarm/src/work-items.ts:414-421`, driven off `BOARD_TEMPLATES` by column id. Only `review`, `verify` and `triage` gate, and **none of them is being renamed**, so the backfill is unaffected. Do not restructure it.
- **`createBoard`** — `swarm/src/work-items.ts:202-217`. Two production callers: `ensureWorkspaceBoards` (`swarm/src/capabilities.ts:362-371`, seeds ideation/plan/deliver) and `POST /work/boards` (`swarm/src/server.ts:2902`). Many test callers use the 2-arg form.
- **`SOURCE_PRESETS`** — `swarm/src/workspaces.ts:41`, a closed `Set`, enforced by `validSources` at `:56`.
- **Preset duplicates in control-plane:** a TS union at `control-plane/src/api/types.ts:232`, and a hardcoded option list plus per-preset default cadence at `control-plane/src/organisms/QueueSourcesSheet.tsx:17-38`.

### The `"spec"` trap — read before touching anything

`"spec"` is a plan-board column id **and**, separately, a **document section / blueprint id**. These are different namespaces that happen to share a word. Renaming the wrong one breaks the document editor.

**Rename only** the `{ id: "spec", name: "Spec" }` entry in `BOARD_TEMPLATES.plan` (`work-items.ts:147`).

**Leave alone — all document sections, not columns:**
- `broker/src/blueprints.ts:32` and `:112`
- `broker/src/brain.ts:157` (`required: ["spec"]`)
- `broker/src/doc-edit.ts:43` (`SPEC SCHEMA` prompt text)
- `control-plane/src/router.tsx:140` (`patchDocSection(doc.id, "spec", …)`)
- `control-plane/src/organisms/DashboardDocStage.tsx:40`
- `control-plane/src/organisms/map/edges.ts:32`, `map/layout.ts:189` (`ArtifactKind`)

## Scope

**In:** the six id renames and their migration; work kinds as data supplying column labels; `Workspace.workKind`; source presets as data, in swarm validation and in the control-plane sheet.

**Out, deliberately:** column CRUD for users; retitling existing boards when a vocabulary changes; per-card vocabulary overrides; any new source *executor* (presets are presentation over the existing origin/transform mechanism); and the welcome wizard itself, which consumes this and is its own plan.

---

### Task 1: Neutral column ids, migrated in one pass

The urgent half — the reference install holds **zero cards** (verified 2026-08-17), so the id migration is free right now and will not be again.

**Files:**
- Modify: `swarm/src/work-items.ts` (`BOARD_TEMPLATES` `:145-167`, `BOARD_ROUTES` `:234-251`, `normalizeBoard` `:384`)
- Test: `swarm/src/work-items.test.ts`
- Modify: `control-plane/src/lib/board-aggregate.ts:197-210`
- Test: `control-plane/src/lib/board-aggregate.test.ts`

**Interfaces:**
- Produces: `NEUTRAL_COLUMN_IDS: Partial<Record<BoardType, Record<string, string>>>` (exported from `work-items.ts`, so the test can assert the table rather than restate it).
- `normalizeBoard` gains the id migration; its signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/work-items.test.ts`. Note the **positive control** in the first test — it asserts the pre-migration board really is in the old shape, so the test cannot pass against a no-op migration:

```ts
test("normalizeBoard migrates software column ids to neutral ones, with a positive control", () => {
  const legacy = {
    id: "acme-plan",
    name: "Plan",
    type: "plan" as const,
    workspaceId: "acme",
    columns: [
      { id: "queue", name: "Queue" },
      { id: "spec", name: "Spec" },
      { id: "tech-design", name: "Tech design" },
      { id: "decomposed", name: "Decomposed" },
      { id: "ready", name: "Ready" },
    ],
    cards: [
      { id: "c1", title: "one", columnId: "spec", order: 0 },
      { id: "c2", title: "two", columnId: "tech-design", order: 1 },
      { id: "c3", title: "three", columnId: "decomposed", order: 2 },
    ],
  } as unknown as WorkBoard;

  // POSITIVE CONTROL: the fixture really is pre-migration. If this ever passes
  // trivially, the assertions below prove nothing.
  assert.ok(
    legacy.columns.some((c) => c.id === "tech-design"),
    "fixture must start on the OLD ids",
  );
  assert.ok(!legacy.columns.some((c) => c.id === "design"), "fixture must not already be migrated");

  normalizeBoard(legacy);

  assert.deepEqual(
    legacy.columns.map((c) => c.id),
    ["queue", "define", "design", "breakdown", "ready"],
    "column ids are neutral",
  );
  assert.deepEqual(
    legacy.cards.map((c) => c.columnId),
    ["define", "design", "breakdown"],
    "every card followed its column",
  );
});

test("normalizeBoard keeps a column's displayed name when migrating its id", () => {
  const legacy = {
    id: "acme-deliver",
    name: "Deliver",
    type: "deliver" as const,
    workspaceId: "acme",
    columns: [
      { id: "queue", name: "Queue" },
      { id: "merged", name: "Merged" },
    ],
    cards: [],
  } as unknown as WorkBoard;

  normalizeBoard(legacy);

  const complete = legacy.columns.find((c) => c.id === "complete");
  assert.ok(complete, "merged became complete");
  // Labels are chosen at seed time; a live board is never retitled. "Merged" IS
  // the product/software label for `complete`, so keeping it is correct, not lazy.
  assert.equal(complete.name, "Merged", "the displayed name is untouched");
});

test("normalizeBoard migrates release ids too", () => {
  const legacy = {
    id: "acme-release",
    name: "Release",
    type: "release" as const,
    workspaceId: "acme",
    // `queue` is present deliberately: release is in QUEUE_TYPES, and
    // normalizeBoard's queue-prepend runs BEFORE the rename step, so a fixture
    // without it would gain one and fail this assertion on an axis that has
    // nothing to do with the rename.
    columns: [
      { id: "queue", name: "Queue" },
      { id: "cut", name: "Cut" },
      { id: "regression", name: "Regression" },
    ],
    cards: [{ id: "c1", title: "one", columnId: "regression", order: 0 }],
  } as unknown as WorkBoard;

  normalizeBoard(legacy);

  assert.deepEqual(legacy.columns.map((c) => c.id), ["queue", "prepare", "validate"]);
  assert.equal(legacy.cards[0].columnId, "validate");
});

test("normalizeBoard is idempotent on already-migrated ids", () => {
  const current = {
    id: "acme-plan",
    name: "Plan",
    type: "plan" as const,
    workspaceId: "acme",
    columns: [
      { id: "queue", name: "Queue" },
      { id: "define", name: "Brief" },
      { id: "ready", name: "Ready" },
    ],
    cards: [{ id: "c1", title: "one", columnId: "define", order: 0 }],
  } as unknown as WorkBoard;

  normalizeBoard(current);
  normalizeBoard(current);

  assert.deepEqual(current.columns.map((c) => c.id), ["queue", "define", "ready"]);
  assert.equal(current.columns[1].name, "Brief", "a custom label survives");
  assert.equal(current.cards[0].columnId, "define");
});

test("normalizeBoard refuses to leave an orphaned card behind", () => {
  const broken = {
    id: "acme-plan",
    name: "Plan",
    type: "plan" as const,
    workspaceId: "acme",
    columns: [
      { id: "queue", name: "Queue" },
      { id: "tech-design", name: "Tech design" },
    ],
    // References a column that does not exist even before migration.
    cards: [{ id: "c1", title: "one", columnId: "nowhere", order: 0 }],
  } as unknown as WorkBoard;

  assert.throws(() => normalizeBoard(broken), /nowhere/, "an orphan is a defect, not a tolerable state");
});

test("BOARD_ROUTES only ever names columns that exist on both boards", () => {
  for (const [type, exits] of Object.entries(BOARD_ROUTES)) {
    const fromIds = new Set(BOARD_TEMPLATES[type as BoardType].map((c) => c.id));
    for (const exit of exits) {
      assert.ok(fromIds.has(exit.from), `${type}: route leaves from unknown column "${exit.from}"`);
      const toIds = new Set(BOARD_TEMPLATES[exit.toType].map((c) => c.id));
      assert.ok(toIds.has(exit.toColumn), `${type}: route lands in unknown column "${exit.toColumn}"`);
    }
  }
});
```

Add `BOARD_ROUTES` and `BOARD_TEMPLATES` to the existing import from `./work-items.js` if they are not already imported, and `WorkBoard` / `BoardType` as types.

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/work-items.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -12
```

Expected: FAIL — ids stay `spec`/`tech-design`/`decomposed`, and the orphan test does not throw.

- [ ] **Step 3: Rename the ids in `BOARD_TEMPLATES`**

In `swarm/src/work-items.ts`, exactly six edits. **Only these.** Names stay as they are — they are the product/software vocabulary, which Task 2 makes selectable.

```ts
  plan: [
    { id: "queue", name: "Queue" },
    { id: "define", name: "Spec" },
    { id: "design", name: "Tech design" },
    { id: "breakdown", name: "Decomposed" },
    { id: "ready", name: "Ready" },
  ],
  deliver: [
    { id: "queue", name: "Queue" },
    { id: "ready", name: "Ready" },
    { id: "in-progress", name: "In progress" },
    { id: "review", name: "Review", gatesHuman: true },
    { id: "verify", name: "Verify", gatesHuman: true },
    { id: "complete", name: "Merged" },
  ],
  release: [
    { id: "queue", name: "Queue" },
    { id: "prepare", name: "Cut" },
    { id: "validate", name: "Regression" },
    { id: "sign-off", name: "Sign-off" },
    { id: "ship", name: "Ship" },
    { id: "rollback", name: "Rollback" },
  ],
```

- [ ] **Step 4: Update `BOARD_ROUTES`**

Three `from`/`toColumn` values move:

```ts
export const BOARD_ROUTES: Record<BoardType, RouteExit[]> = {
  plan: [
    { from: "design", toType: "ideation", toColumn: "scoping", label: "Back to ideation" },
    { from: "ready", toType: "deliver", toColumn: "ready", label: "Send to deliver" },
  ],
  deliver: [{ from: "in-progress", toType: "plan", toColumn: "design", label: "Back to plan" }],
  release: [
    { from: "validate", toType: "deliver", toColumn: "in-progress", label: "Drop change to deliver" },
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
```

- [ ] **Step 5: Add the migration to `normalizeBoard`**

Add the table next to `BOARD_TEMPLATES`, exported so the test asserts the real thing:

```ts
/**
 * 2026-08-17: six product-development column ids became domain-neutral, so the
 * same board reads correctly for marketing, sales, consulting, content,
 * creators and trading. Ids are the contract — BOARD_ROUTES matches on them and
 * every card stores one — so a rename must rewrite columns and cards together.
 *
 * Ids only. A column's displayed NAME is deliberately left alone: labels are
 * chosen at seed time and a live board is never retitled, and "Merged" is in any
 * case the correct product/software label for `complete`.
 */
export const NEUTRAL_COLUMN_IDS: Partial<Record<BoardType, Record<string, string>>> = {
  plan: { spec: "define", "tech-design": "design", decomposed: "breakdown" },
  deliver: { merged: "complete" },
  release: { cut: "prepare", regression: "validate" },
};
```

Then, inside `normalizeBoard`, **after** the personal-board block at `:400-413` and **before** the `gatesHuman` backfill at `:414`:

```ts
  const renames = NEUTRAL_COLUMN_IDS[board.type];
  if (renames) {
    for (const column of board.columns) {
      const to = renames[column.id];
      if (to) column.id = to;
    }
    for (const card of board.cards) {
      const to = renames[card.columnId];
      if (to) card.columnId = to;
    }
  }
  // A card pointing at no column would vanish from every lane while still
  // occupying the file — a defect, not a tolerable orphan. loadBoards wraps this
  // per file, so the board is reported rather than the boot being killed.
  const ids = new Set(board.columns.map((c) => c.id));
  const orphan = board.cards.find((c) => !ids.has(c.columnId));
  if (orphan) {
    throw new Error(
      `Board "${board.id}": card "${orphan.id}" is in column "${orphan.columnId}", which does not exist on this board`,
    );
  }
```

- [ ] **Step 6: Run the file, then the whole swarm suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/work-items.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "^ℹ (tests|pass|fail)"
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t1-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: **600 pass / 0 fail** (594 + 6). Any *other* failure is a test that hardcoded an old id — fix it to the new id and report which, since that is a layer this plan's survey may have missed.

- [ ] **Step 7: Mirror the rename in the control-plane's duplicate**

`control-plane/src/lib/board-aggregate.ts:197-210`. Its own comment says it is hand-synced; this is that hand. Change the same three values:

```ts
export const BOARD_ROUTES_UI: Record<BoardTypeT, RouteExitT[]> = {
  plan: [
    { from: "design", toType: "ideation", toColumn: "scoping", label: "Back to ideation" },
    { from: "ready", toType: "deliver", toColumn: "ready", label: "Send to deliver" },
  ],
  deliver: [{ from: "in-progress", toType: "plan", toColumn: "design", label: "Back to plan" }],
  release: [
    { from: "validate", toType: "deliver", toColumn: "in-progress", label: "Drop change to deliver" },
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
```

- [ ] **Step 8: Pin the duplicate with a test**

Append to `control-plane/src/lib/board-aggregate.test.ts`. The two copies cannot import from each other (separate packages, no shared module), so this test states the contract in the one place a reviewer will look:

```ts
test("BOARD_ROUTES_UI uses the neutral column ids the swarm migrated to", () => {
  // Hand-synced with swarm/src/work-items.ts BOARD_ROUTES. Drift does not corrupt
  // data — the server re-validates — it offers a pill that 400s on click.
  const froms = Object.values(BOARD_ROUTES_UI).flatMap((exits) => exits.map((e) => e.from));
  const tos = Object.values(BOARD_ROUTES_UI).flatMap((exits) => exits.map((e) => e.toColumn));
  for (const dead of ["spec", "tech-design", "decomposed", "merged", "cut", "regression"]) {
    assert.ok(!froms.includes(dead), `route still leaves from retired id "${dead}"`);
    assert.ok(!tos.includes(dead), `route still lands in retired id "${dead}"`);
  }
  expect(froms).toContain("design");
  expect(froms).toContain("validate");
});
```

Match the file's existing import style — if it uses vitest's `expect` rather than `node:assert`, write the whole test with `expect` (`expect(froms).not.toContain(dead)`), and import `BOARD_ROUTES_UI` from `./board-aggregate`.

- [ ] **Step 9: Run the control-plane suite**

```bash
cd control-plane && npx vitest run > /tmp/t1-cp.txt 2>&1; echo "exit=$?"
grep -E "Test Files|Tests " /tmp/t1-cp.txt | tail -3
```

Expected: **925 passing, 2 failing** (924 + 1 new test, minus nothing). Those 2 failures are the recorded baseline — `HomePage` composer and `MapStage` pan toggle. **If a third appears, it is yours.**

- [ ] **Step 10: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t1-tsc.txt 2>&1; echo "tsc-exit=$?"
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t1-tsc.txt | grep -c 'error TS')"
cd control-plane && npx tsc --noEmit 2>&1 | tail -3
npx biome check swarm/src/work-items.ts swarm/src/work-items.test.ts \
  control-plane/src/lib/board-aggregate.ts control-plane/src/lib/board-aggregate.test.ts
git add swarm/src/work-items.ts swarm/src/work-items.test.ts \
  control-plane/src/lib/board-aggregate.ts control-plane/src/lib/board-aggregate.test.ts
git commit -m "feat(boards): domain-neutral column ids

spec/tech-design/decomposed/merged/cut/regression become
define/design/breakdown/complete/prepare/validate. Ids are the contract, so
the migration rewrites columns and cards in one pass and asserts no card is
left orphaned. Displayed names are untouched: labels are a seed-time choice."
```

Expected: swarm `errors=12`; control-plane typecheck clean; biome clean.

---

### Task 2: Work kinds as data, supplying labels at seed time

**Files:**
- Create: `swarm/src/work-kinds.ts`
- Create: `swarm/src/work-kinds.test.ts`
- Modify: `swarm/src/work-items.ts` (`createBoard` `:202`)
- Modify: `swarm/src/workspaces.ts` (`Workspace`, `assertContext` `:120-142`)
- Modify: `swarm/src/capabilities.ts` (`ensureWorkspaceBoards` `:362`)
- Modify: `swarm/src/server.ts` (`POST /work/boards` `:2902`)
- Test: `swarm/src/work-items.test.ts`, `swarm/src/workspaces.test.ts`

**Interfaces:**
- Produces:
  - `interface WorkKindPreset { id: string; label: string; cadence: "hourly" | "6h" | "nightly" }`
  - `interface WorkKind { id: string; label: string; columns: Record<string, string>; presets: WorkKindPreset[] }`
  - `const DEFAULT_WORK_KIND = "product"`
  - `WORK_KINDS: Record<string, WorkKind>`
  - `workKindFor(id?: string): WorkKind` — never throws, never returns undefined
  - `columnLabel(kind: WorkKind, column: WorkColumn): string`
  - `allPresetIds(): Set<string>` — consumed by Task 3
- Consumes: `WorkColumn` (type-only) from `./work-items.js`.
- Changes: `createBoard(type, workspaceId?, workKind?)` — third parameter is **optional**, so every existing 2-arg call site (including ~12 in tests) keeps working unchanged.
- Adds: `Workspace.workKind?: string`.

- [ ] **Step 1: Write the failing tests**

Create `swarm/src/work-kinds.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { allPresetIds, columnLabel, DEFAULT_WORK_KIND, WORK_KINDS, workKindFor } from "./work-kinds.js";

test("work kinds are data keyed by id, not a union", () => {
  // Seven domains today, and the list grew from three in one conversation. A new
  // kind must be a data edit, never a code change.
  for (const id of ["product", "marketing", "sales", "consulting", "content", "creator", "trading"]) {
    assert.ok(WORK_KINDS[id], `${id} is a work kind`);
    assert.equal(WORK_KINDS[id].id, id, "the record key and the id agree");
    assert.ok(WORK_KINDS[id].label.length > 0, `${id} has a human label`);
  }
});

test("workKindFor: an unknown kind falls back to product, never to nothing", () => {
  assert.equal(workKindFor("no-such-kind").id, DEFAULT_WORK_KIND);
  assert.equal(workKindFor(undefined).id, DEFAULT_WORK_KIND);
  assert.equal(workKindFor("").id, DEFAULT_WORK_KIND);
});

test("workKindFor: a known kind is returned as itself", () => {
  assert.equal(workKindFor("marketing").id, "marketing");
});

test("columnLabel: each kind renames the four software columns", () => {
  const cases: Array<[string, string, string]> = [
    ["product", "complete", "Merged"],
    ["marketing", "define", "Brief"],
    ["marketing", "complete", "Live"],
    ["sales", "define", "Discovery"],
    ["sales", "complete", "Closed-won"],
    ["consulting", "breakdown", "Work packages"],
    ["content", "design", "Outline"],
    ["creator", "define", "Hook"],
    ["trading", "define", "Thesis"],
  ];
  for (const [kindId, columnId, expected] of cases) {
    const label = columnLabel(workKindFor(kindId), { id: columnId, name: "FALLBACK" });
    assert.equal(label, expected, `${kindId}.${columnId}`);
  }
});

test("columnLabel: a missing label degrades ONE cell, not the board", () => {
  const partial = { id: "partial", label: "Partial", columns: { define: "Brief" }, presets: [] };
  assert.equal(columnLabel(partial, { id: "define", name: "Spec" }), "Brief");
  // No entry for `design` — fall back to the template's own name rather than
  // rendering an empty column header.
  assert.equal(columnLabel(partial, { id: "design", name: "Tech design" }), "Tech design");
  assert.equal(columnLabel(partial, { id: "queue", name: "Queue" }), "Queue");
});

test("allPresetIds: the union of every kind's presets, plus custom", () => {
  const ids = allPresetIds();
  assert.ok(ids.has("custom"), "custom is always available");
  assert.ok(ids.has("jira"), "from product");
  assert.ok(ids.has("tickers"), "from trading");
  assert.ok(ids.has("tiktok"), "from creator");
  assert.ok(!ids.has("definitely-not-a-preset"));
});
```

Append to `swarm/src/work-items.test.ts`:

```ts
test("createBoard: a work kind supplies column labels at seed time", () => {
  const board = createBoard("plan", "acme", "marketing");

  assert.deepEqual(
    board.columns.map((c) => c.id),
    ["queue", "define", "design", "breakdown", "ready"],
    "ids never vary by work kind — they are the contract",
  );
  assert.deepEqual(
    board.columns.map((c) => c.name),
    ["Queue", "Brief", "Concept", "Assets", "Ready"],
    "only the words change",
  );
});

test("createBoard: no work kind reproduces today's product vocabulary exactly", () => {
  const implicit = createBoard("deliver", "acme");
  const explicit = createBoard("deliver", "acme", "product");

  assert.deepEqual(implicit.columns, explicit.columns);
  assert.equal(implicit.columns.find((c) => c.id === "complete")?.name, "Merged");
});

test("createBoard: an unknown work kind falls back to product, never an empty board", () => {
  const board = createBoard("plan", "acme", "astrology");

  assert.equal(board.columns.length, 5);
  assert.equal(board.columns.find((c) => c.id === "define")?.name, "Spec");
});

test("createBoard: gatesHuman survives a work kind's relabelling", () => {
  const board = createBoard("deliver", "acme", "sales");

  // review/verify are not renamed by any vocabulary, and the shared queue depends
  // on their gate flag surviving the label pass.
  assert.equal(board.columns.find((c) => c.id === "review")?.gatesHuman, true);
  assert.equal(board.columns.find((c) => c.id === "verify")?.gatesHuman, true);
});
```

Append to `swarm/src/workspaces.test.ts`:

```ts
test("assertContext: workKind is optional and passes through", () => {
  const ws = assertContext("w.json", {
    name: "acme",
    repos: [{ name: "app", path: "/tmp/app" }],
    workKind: "marketing",
  });
  assert.equal(ws.workKind, "marketing");
});

test("assertContext: a workspace with no workKind is still valid", () => {
  const ws = assertContext("w.json", { name: "acme", repos: [{ name: "app", path: "/tmp/app" }] });
  assert.equal(ws.workKind, undefined);
});

test("assertContext: a non-string workKind is refused", () => {
  assert.throws(
    () => assertContext("w.json", { name: "acme", repos: [{ name: "app", path: "/tmp/app" }], workKind: 7 }),
    /workKind/i,
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/work-kinds.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -12
```

Expected: FAIL — cannot find module `./work-kinds.js`.

- [ ] **Step 3: Create `swarm/src/work-kinds.ts`**

```ts
// Work kinds are DATA, keyed by id — never a TypeScript union.
//
// This list went from three domains to seven in the course of one conversation
// and was still growing when it was written down; a union would make every new
// domain a release. The codebase settled this question elsewhere:
// AgentEngine.stereotype is an open string, and personas load as config rather
// than being enumerated in code. Keeping vocabularies here makes "bring your own
// words" a product capability rather than a code change — which matters most for
// teams whose words are their differentiator.
//
// A kind supplies LABELS ONLY. Column ids never vary, because ids are the
// contract: BOARD_ROUTES matches on them, the agenda axis stores one per card,
// and the shared queue keys off them.
import type { WorkColumn } from "./work-items.js";

/** A source preset a work kind offers. Presentational — executors read origin/transform. */
export interface WorkKindPreset {
  id: string;
  label: string;
  cadence: "hourly" | "6h" | "nightly";
}

export interface WorkKind {
  id: string;
  label: string;
  /** Column label by column id. A missing id falls back to the template's own name. */
  columns: Record<string, string>;
  presets: WorkKindPreset[];
}

/** Skipping the question reproduces today's behaviour exactly. */
export const DEFAULT_WORK_KIND = "product";

export const WORK_KINDS: Record<string, WorkKind> = {
  product: {
    id: "product",
    label: "Product / software",
    columns: { define: "Spec", design: "Tech design", breakdown: "Decomposed", complete: "Merged" },
    presets: [
      { id: "jira", label: "Jira", cadence: "nightly" },
      { id: "releases", label: "Releases", cadence: "nightly" },
      { id: "observability", label: "Observability", cadence: "hourly" },
      { id: "support", label: "Support", cadence: "6h" },
    ],
  },
  marketing: {
    id: "marketing",
    label: "Marketing",
    columns: { define: "Brief", design: "Concept", breakdown: "Assets", complete: "Live" },
    presets: [
      { id: "campaign-metrics", label: "Campaign metrics", cadence: "hourly" },
      { id: "brand-mentions", label: "Brand mentions", cadence: "6h" },
      { id: "competitor", label: "Competitor", cadence: "nightly" },
    ],
  },
  sales: {
    id: "sales",
    label: "Sales",
    columns: { define: "Discovery", design: "Proposal", breakdown: "Terms", complete: "Closed-won" },
    presets: [
      { id: "crm", label: "CRM", cadence: "hourly" },
      { id: "inbound", label: "Inbound", cadence: "hourly" },
      { id: "pipeline", label: "Pipeline", cadence: "nightly" },
    ],
  },
  consulting: {
    id: "consulting",
    label: "Consulting",
    columns: { define: "Scope", design: "Approach", breakdown: "Work packages", complete: "Delivered" },
    presets: [{ id: "topic", label: "Topic", cadence: "nightly" }],
  },
  content: {
    id: "content",
    label: "Content",
    columns: { define: "Brief", design: "Outline", breakdown: "Sections", complete: "Published" },
    presets: [
      { id: "topic", label: "Topic", cadence: "nightly" },
      { id: "keyword", label: "Keyword", cadence: "nightly" },
      { id: "publication", label: "Publication", cadence: "6h" },
    ],
  },
  // Deliberately separate from `content`: the board words are similar, the
  // sources are not. Content is long-form through one channel; a creator runs
  // many channels at once and repurposes one idea across them.
  creator: {
    id: "creator",
    label: "Influencer / creator",
    columns: { define: "Hook", design: "Concept", breakdown: "Shot list", complete: "Posted" },
    presets: [
      { id: "youtube", label: "YouTube", cadence: "6h" },
      { id: "tiktok", label: "TikTok", cadence: "hourly" },
      { id: "instagram", label: "Instagram", cadence: "6h" },
      { id: "x", label: "X", cadence: "hourly" },
      { id: "comments", label: "Comments", cadence: "hourly" },
      { id: "trends", label: "Trends", cadence: "hourly" },
    ],
  },
  trading: {
    id: "trading",
    label: "Trading",
    columns: { define: "Thesis", design: "Sizing", breakdown: "Orders", complete: "Closed" },
    presets: [
      { id: "tickers", label: "Tickers", cadence: "hourly" },
      { id: "filings", label: "Filings", cadence: "nightly" },
      { id: "news", label: "News", cadence: "hourly" },
    ],
  },
};

/**
 * The work kind for an id, falling back to product/software.
 *
 * Never throws and never returns undefined: a vocabulary is user-editable data
 * and will eventually name a kind that no longer exists. Falling back to the
 * default is always better than seeding an empty board.
 */
export function workKindFor(id?: string): WorkKind {
  return (id && WORK_KINDS[id]) || (WORK_KINDS[DEFAULT_WORK_KIND] as WorkKind);
}

/**
 * A column's label under this work kind, falling back to the template's own name.
 *
 * Per column, so a partial vocabulary degrades exactly one cell instead of
 * breaking a board — and so columns no vocabulary renames (queue, ready, review,
 * verify, triage …) need no entry anywhere.
 */
export function columnLabel(kind: WorkKind, column: Pick<WorkColumn, "id" | "name">): string {
  return kind.columns[column.id] ?? column.name;
}

/**
 * Every preset id any work kind offers, plus `custom`.
 *
 * Derived rather than hardcoded so adding a kind adds its presets for free —
 * and still a closed set, so a typo in a stored source is caught.
 */
export function allPresetIds(): Set<string> {
  const ids = new Set<string>(["custom"]);
  for (const kind of Object.values(WORK_KINDS)) {
    for (const preset of kind.presets) ids.add(preset.id);
  }
  return ids;
}
```

- [ ] **Step 4: Teach `createBoard` the work kind**

In `swarm/src/work-items.ts`, add the import and widen the signature. `import type` for `WorkColumn` in `work-kinds.ts` is erased at compile time, so this pair of modules does not form a runtime cycle:

```ts
import { columnLabel, workKindFor } from "./work-kinds.js";
```

```ts
/**
 * Mint a board from its type. The id comes from the type, never the name, so a
 * later rename via PATCH never has to move a file.
 *
 * `workKind` is consulted HERE AND NOWHERE ELSE — labels are a seed-time choice,
 * and `board.columns` is persisted per board, so changing a vocabulary later
 * never rewrites a live board. Omitting it reproduces the product/software
 * vocabulary exactly.
 */
export function createBoard(type: BoardType, workspaceId?: string, workKind?: string): WorkBoard {
  if (!BOARD_TEMPLATES[type]) throw new Error(`Unknown board type: ${type}`);
  if (type === "personal" && workspaceId) throw new Error("The personal board belongs to no workspace");
  if (type !== "personal" && !workspaceId) throw new Error(`Board type "${type}" requires a workspace`);
  const id = type === "personal" ? "personal" : boardIdFor(workspaceId as string, type);
  if (!BOARD_ID_RE.test(id)) throw new Error(`Workspace "${workspaceId}" does not reduce to a usable board id`);
  const kind = workKindFor(workKind);
  const board: WorkBoard = {
    id,
    name: BOARD_TYPE_LABELS[type],
    type,
    columns: BOARD_TEMPLATES[type].map((c) => ({ ...c, name: columnLabel(kind, c) })),
    cards: [],
  };
  if (workspaceId) board.workspaceId = workspaceId;
  return board;
}
```

- [ ] **Step 5: Add `Workspace.workKind` and validate it**

In `swarm/src/workspaces.ts`, add the field to the `Workspace` interface:

```ts
  /**
   * Which vocabulary this workspace's boards are seeded with (see work-kinds.ts).
   * Absent means product/software, so an install that never answered the
   * wizard's optional question behaves exactly as it always has. Read at board
   * seed time only.
   */
  workKind?: string;
```

Then in `assertContext` (`:132-141`), extend the workspace branch. Keep the group branch untouched:

```ts
  const ok =
    o &&
    typeof o.name === "string" &&
    Array.isArray(o.repos) &&
    o.repos.length > 0 &&
    (o.workKind === undefined || typeof o.workKind === "string") &&
    o.repos.every((r) => r && typeof r.name === "string" && typeof r.path === "string" && isAbsolute(r.path));
  if (!ok) {
    throw new Error(
      `Invalid workspace file ${file}: requires name and repos[]{name, absolute path}, and workKind must be a string when present`,
    );
  }
```

- [ ] **Step 6: Thread it through the two production seed paths**

`swarm/src/capabilities.ts:362` — `ensureWorkspaceBoards` gains an optional parameter and passes it down:

```ts
export async function ensureWorkspaceBoards(
  dirs: string[],
  resolveDir: (board: WorkBoard) => string,
  workspaceId: string,
  workKind?: string,
): Promise<void> {
  const { boards } = await loadAllBoards(dirs);
  for (const type of ["ideation", "plan", "deliver"] as BoardType[]) {
    const board = createBoard(type, workspaceId, workKind);
    if (!boards.some((b) => b.id === board.id)) await saveBoard(resolveDir(board), board);
  }
}
```

Find every caller of `ensureWorkspaceBoards` (`grep -rn "ensureWorkspaceBoards(" swarm/src --include='*.ts'`) and pass the workspace's `workKind` where the `Workspace` record is already in hand. Where it is not, leave the call as-is — the parameter is optional and omitting it is the documented product/software default. **Report which call sites you changed and which you left.**

`swarm/src/server.ts:2902` — `POST /work/boards` resolves the workspace it is seeding for:

```ts
        const all = await loadWorkspaces(this.paths);
        const ws = all.find((w) => w.name === b.workspaceId?.trim());
        const board = createBoard(type, b.workspaceId?.trim(), ws?.workKind);
```

Place this so it does not disturb the existing 409 check that follows. If `loadWorkspaces` is already called nearby in this handler, reuse that result rather than loading twice.

- [ ] **Step 7: Run the suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t2-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: **613 pass / 0 fail** — 600 from Task 1, plus 6 in `work-kinds.test.ts`, 4 appended to `work-items.test.ts`, and 3 appended to `workspaces.test.ts`.

If the count differs, count the tests you actually added rather than assuming — the arithmetic here is a guide, the `fail 0` is the gate.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t2-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t2-tsc.txt | grep -c 'error TS')"
npx biome check src/work-kinds.ts src/work-kinds.test.ts src/work-items.ts src/workspaces.ts \
  src/capabilities.ts src/server.ts
git add swarm/src/work-kinds.ts swarm/src/work-kinds.test.ts swarm/src/work-items.ts \
  swarm/src/work-items.test.ts swarm/src/workspaces.ts swarm/src/workspaces.test.ts \
  swarm/src/capabilities.ts swarm/src/server.ts
git commit -m "feat(boards): work kinds supply column labels, as data

Seven vocabularies keyed by id, not a union — the list grew from three to
seven in one conversation, and a union makes every new domain a release.
Consulted at seed time only, so no stored board changes and no live board is
retitled. Workspace.workKind carries the choice; absent means product."
```

Expected: `errors=12`; biome clean.

---

### Task 3: Source presets as data

`ContextSource.preset` is a closed `Set` of software words — the same problem one layer down, with the same cheap fix. The type already comments `preset` as *"UI sugar — executors read origin/transform"*, so nothing executable changes.

**Files:**
- Modify: `swarm/src/workspaces.ts:41` (`SOURCE_PRESETS`)
- Test: `swarm/src/workspaces.test.ts`

**Interfaces:**
- Consumes: `allPresetIds()` from `./work-kinds.js` (Task 2).

- [ ] **Step 1: Write the failing tests**

Append to `swarm/src/workspaces.test.ts`:

```ts
test("validSources: a preset from a non-software work kind is accepted", () => {
  const source = {
    id: "s1",
    name: "TikTok",
    preset: "tiktok",
    origin: { url: "https://example.test" },
    cadence: "hourly",
    transform: { mode: "map" },
    enabled: true,
  };
  assert.equal(validSources([source]), true, "a creator preset is as valid as a software one");
});

test("validSources: custom is always accepted", () => {
  const source = {
    id: "s2",
    name: "Anything",
    preset: "custom",
    origin: { url: "https://example.test", query: "q" },
    cadence: "nightly",
    transform: { mode: "analyze", prompt: "summarise" },
    enabled: true,
  };
  assert.equal(validSources([source]), true);
});

test("validSources: a preset no work kind declares is still refused", () => {
  const source = {
    id: "s3",
    name: "Typo",
    preset: "tikTok",
    origin: { url: "https://example.test" },
    cadence: "hourly",
    transform: { mode: "map" },
    enabled: true,
  };
  assert.equal(validSources([source]), false, "presets are data, but still a closed set — a typo is caught");
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'validSources' 'src/workspaces.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -10
```

Expected: FAIL — `tiktok` is not in the hardcoded set.

- [ ] **Step 3: Derive the set from the work kinds**

In `swarm/src/workspaces.ts`, replace line 41:

```ts
import { allPresetIds } from "./work-kinds.js";

/**
 * Presets are DATA, derived from the work kinds rather than hardcoded: every
 * entry in the old closed set except `topic` and `custom` was a software word,
 * which is the board-vocabulary problem one layer down.
 *
 * Still a closed set, deliberately. `preset` is UI sugar — executors read
 * origin/transform, so a new preset needs no executor change — but validating
 * against the union of what the kinds actually declare still catches a typo in a
 * stored source, which accepting any string would not.
 */
const SOURCE_PRESETS = allPresetIds();
```

Leave `validSources`' use of it at `:56` exactly as it is.

- [ ] **Step 4: Run the suite**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t3-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-suite.txt | grep -E "^ℹ (tests|pass|fail)"
```

Expected: **616 pass / 0 fail** (613 + 3). A pre-existing test asserting that `observability` or `jira` is valid must still pass — those are product presets and remain in the union. **If one now fails, the union is missing a preset the old set had: add it to the product kind rather than special-casing the validator.**

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t3-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t3-tsc.txt | grep -c 'error TS')"
npx biome check src/workspaces.ts src/workspaces.test.ts
git add swarm/src/workspaces.ts swarm/src/workspaces.test.ts
git commit -m "feat(sources): presets come from the work kinds, not a hardcoded set

Every entry but topic and custom was a software word. Derived from the work
kinds so adding a kind adds its presets, and still a closed set so a typo in a
stored source is caught."
```

---

### Task 4: The control-plane offers the presets its workspace actually uses

**Files:**
- Modify: `swarm/src/server.ts` (new `GET /work-kinds` route)
- Test: `swarm/src/server.test.ts`
- Modify: `control-plane/src/api/types.ts:232`
- Modify: `control-plane/src/organisms/QueueSourcesSheet.tsx:17-38`
- Test: `control-plane/src/organisms/QueueSourcesSheet.test.tsx`

**Interfaces:**
- Produces: `GET /work-kinds` → `{ kinds: Array<{ id: string; label: string; columns: Record<string,string>; presets: Array<{id,label,cadence}> }> }`.
- Changes: `ContextSource["preset"]` in the control-plane from a union to `string`.

- [ ] **Step 1: Write the failing swarm test**

Append to `swarm/src/server.test.ts`. This file tests exported helpers rather than booting the server, so export a shaper and test that:

```ts
test("workKindsPayload: every kind ships its labels and presets", () => {
  const payload = workKindsPayload();

  const ids = payload.kinds.map((k) => k.id);
  assert.ok(ids.includes("product"), "product is offered");
  assert.ok(ids.includes("creator"), "so is a non-software kind");

  const creator = payload.kinds.find((k) => k.id === "creator");
  assert.equal(creator?.columns.complete, "Posted");
  assert.ok(
    creator?.presets.some((p) => p.id === "tiktok" && p.cadence === "hourly"),
    "presets carry their default cadence, which the sheet needs",
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  --test-name-pattern 'workKindsPayload' 'src/server.test.ts' 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | head -8
```

Expected: FAIL — `workKindsPayload is not a function`.

- [ ] **Step 3: Add the shaper and the route**

In `swarm/src/server.ts`, beside the other exported helpers:

```ts
import { WORK_KINDS } from "./work-kinds.js";

/**
 * The work-kind catalog, for the wizard's one question and the sources sheet.
 *
 * Exported and pure so it is testable without booting the server, matching every
 * other route helper in this file.
 */
export function workKindsPayload(): { kinds: Array<(typeof WORK_KINDS)[string]> } {
  return { kinds: Object.values(WORK_KINDS) };
}
```

And register the route beside the other catalog routes:

```ts
    this.app.get("/work-kinds", async () => workKindsPayload());
```

- [ ] **Step 4: Open up the control-plane's preset type**

`control-plane/src/api/types.ts:232` — the union is a third copy of a list that is now data:

```ts
  /** UI sugar over origin/transform. Open by design: the work kinds supply these, so a new kind needs no client change. */
  preset: string;
```

- [ ] **Step 5: Drive the sheet's options from the API**

`control-plane/src/organisms/QueueSourcesSheet.tsx` — replace the hardcoded `:17-22` list and `:33-38` cadence map with the fetched kinds, keeping the current product list as the offline fallback so the sheet never renders an empty select:

```tsx
// The product presets, used only until /work-kinds answers (and if it never
// does). Without a fallback a failed fetch would render an empty select, which
// reads as "this workspace has no sources" rather than "the server is down".
const FALLBACK_PRESETS: Array<{ id: string; label: string; cadence: string }> = [
  { id: "jira", label: "Jira", cadence: "nightly" },
  { id: "releases", label: "Releases", cadence: "nightly" },
  { id: "observability", label: "Observability", cadence: "hourly" },
  { id: "support", label: "Support", cadence: "6h" },
  { id: "custom", label: "Custom", cadence: "nightly" },
];
```

Then inside the component, fetch once and flatten every kind's presets, de-duplicated by id (several kinds share `topic`), always appending `custom`:

```tsx
const [presets, setPresets] = useState(FALLBACK_PRESETS);

useEffect(() => {
  let live = true;
  api
    .getWorkKinds()
    .then((r) => {
      if (!live) return;
      const byId = new Map<string, { id: string; label: string; cadence: string }>();
      for (const kind of r.kinds) for (const p of kind.presets) byId.set(p.id, p);
      byId.set("custom", { id: "custom", label: "Custom", cadence: "nightly" });
      setPresets([...byId.values()]);
    })
    .catch(() => {
      /* keep the fallback — an unreachable server must not empty the select */
    });
  return () => {
    live = false;
  };
}, []);
```

Replace the `DEFAULT_CADENCE[preset]` lookup with `presets.find((p) => p.id === preset)?.cadence ?? "nightly"`. Add `getWorkKinds` to the api module beside its siblings, following that file's existing fetch/`brokerFetch` convention exactly.

- [ ] **Step 6: Update the sheet's test**

`control-plane/src/organisms/QueueSourcesSheet.test.tsx` already stubs `fetch`; extend the stub to answer `/work-kinds`, and add:

```tsx
it("offers presets from every work kind, not just the software ones", async () => {
  render(<QueueSourcesSheet {...props} />);

  const select = await screen.findByLabelText(/preset/i);
  await waitFor(() => {
    expect(within(select).getByRole("option", { name: /tiktok/i })).toBeInTheDocument();
  });
  expect(within(select).getByRole("option", { name: /custom/i })).toBeInTheDocument();
});

it("falls back to the product presets when /work-kinds cannot be reached", async () => {
  // An unreachable server must leave a usable select, not an empty one.
  render(<QueueSourcesSheet {...props} />);

  const select = await screen.findByLabelText(/preset/i);
  expect(within(select).getByRole("option", { name: /jira/i })).toBeInTheDocument();
});
```

Match the file's existing stubbing style — if it uses `vi.stubGlobal("fetch", …)`, extend that stub rather than introducing a second mechanism, and make the second test's stub reject or 500 for `/work-kinds`.

- [ ] **Step 7: Verify both suites**

```bash
cd swarm && SMITH_STATE_ROOT=$(mktemp -d) node --import tsx --test --test-timeout 60000 \
  'src/*.test.ts' 'src/**/*.test.ts' > /tmp/t4-suite.txt 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-suite.txt | grep -E "^ℹ (tests|pass|fail)"
cd swarm && ./node_modules/.bin/tsc --noEmit > /tmp/t4-tsc.txt 2>&1
echo "errors=$(sed 's/\x1b\[[0-9;]*m//g' /tmp/t4-tsc.txt | grep -c 'error TS')"
cd control-plane && npx vitest run > /tmp/t4-cp.txt 2>&1; echo "exit=$?"
grep -E "Test Files|Tests " /tmp/t4-cp.txt | tail -3
cd control-plane && npx tsc --noEmit 2>&1 | tail -3
```

Expected: swarm **617 pass / 0 fail** (616 + 1), `errors=12`; control-plane **927 passing, 2 failing** — and those 2 are still only `HomePage` and `MapStage`. Confirm by name, not by count.

- [ ] **Step 8: Commit**

```bash
npx biome check swarm/src/server.ts swarm/src/server.test.ts \
  control-plane/src/api/types.ts control-plane/src/organisms/QueueSourcesSheet.tsx \
  control-plane/src/organisms/QueueSourcesSheet.test.tsx
git add swarm/src/server.ts swarm/src/server.test.ts control-plane/src/api/types.ts \
  control-plane/src/organisms/QueueSourcesSheet.tsx control-plane/src/organisms/QueueSourcesSheet.test.tsx
git commit -m "feat(sources): the sheet offers every work kind's presets

GET /work-kinds serves the catalog; the client's preset union becomes an open
string, since a new kind must not need a client change. The product presets
remain as an offline fallback so an unreachable server never empties the select."
```

---

### Task 5: Verify against the live install

**Files:** none. **No commit.**

The reference install holds **zero cards**, which is why the id migration is free today. This task confirms that seeding still works and that the migration is a no-op on an install that has nothing to migrate — then proves the migration on a board that *does* carry old ids.

- [ ] **Step 1: Back up**

```bash
B=$(mktemp -d)/smithagents-preworkkinds
mkdir -p "$B" && cp -a ~/.smithagents/workspaces "$B/workspaces"
echo "backup at $B"
```

- [ ] **Step 2: Restart the swarm on the new code**

```bash
PID=$(lsof -nP -iTCP:7777 -sTCP:LISTEN -t | head -1); kill "$PID"
until ! lsof -nP -iTCP:7777 -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done
cd swarm && nohup node --env-file=../.env --import tsx src/server.ts > /tmp/swarm-wk.log 2>&1 &
until curl -s -m 3 http://127.0.0.1:7777/health > /dev/null; do sleep 1; done
curl -s -m 5 http://127.0.0.1:7777/work-kinds | python3 -c "
import sys,json
for k in json.load(sys.stdin)['kinds']:
    print(f\"  {k['id']:12} complete={k['columns'].get('complete','-'):12} presets={[p['id'] for p in k['presets']]}\")"
```

Expected: seven kinds, `product` ending at `Merged` and `creator` at `Posted`.

- [ ] **Step 3: Confirm the existing boards survived the migration**

```bash
for f in ~/.smithagents/workspaces/proving-ground/config/boards/*.json; do
  python3 -c "
import json,sys
b=json.load(open('$f'))
ids=[c['id'] for c in b['columns']]
dead=[i for i in ids if i in ('spec','tech-design','decomposed','merged','cut','regression')]
orph=[c['id'] for c in b.get('cards',[]) if c['columnId'] not in ids]
print(f\"  {b['id']:34} {ids}\")
print(f\"     retired ids: {dead or 'none'}   orphaned cards: {orph or 'none'}\")"
done
```

Expected: no retired ids and no orphans on any board. **A board still carrying `tech-design` means `normalizeBoard` ran but did not save — boards are normalized on load, so confirm whether anything persists them back; report either way.**

- [ ] **Step 4: Prove the migration on a board that actually needs it**

The install has nothing to migrate, so a passing Step 3 proves little on its own — this is the positive control for the live check:

```bash
cd swarm && node --import tsx -e "
import { normalizeBoard } from './src/work-items.js';
const legacy = { id: 'probe-plan', name: 'Plan', type: 'plan', workspaceId: 'probe',
  columns: [{id:'queue',name:'Queue'},{id:'spec',name:'Spec'},{id:'tech-design',name:'Tech design'}],
  cards: [{id:'c1',title:'t',columnId:'tech-design',order:0}] };
console.log('before:', legacy.columns.map(c=>c.id).join(','), '| card:', legacy.cards[0].columnId);
normalizeBoard(legacy);
console.log('after: ', legacy.columns.map(c=>c.id).join(','), '| card:', legacy.cards[0].columnId);
"
```

Expected: `before: queue,spec,tech-design | card: tech-design` then `after: queue,define,design | card: design`.

- [ ] **Step 5: Seed a non-software workspace end to end**

```bash
curl -s -m 20 -X POST http://127.0.0.1:7777/work/boards \
  -H 'content-type: application/json' \
  -d '{"type":"plan","workspaceId":"proving-ground"}' | python3 -c "
import sys,json; b=json.load(sys.stdin)
print('  columns:', [(c['id'], c['name']) for c in b.get('columns',[])])" || echo "  (409 if the board already exists — expected)"
```

Expected: a 409 if proving-ground already has a plan board. To see a marketing vocabulary, set `workKind` on a scratch workspace record and seed there — **do not edit proving-ground's record**, since Step 3 is the evidence its boards are unharmed.

- [ ] **Step 6: No commit**

If Step 3 shows a retired id or an orphan on a real board, the branch does not merge.

---

## Self-review

**Spec coverage.** §1 neutral ids → Task 1, including both copies of the route table and the migration with the spec's required positive control. §2 vocabularies as data → Task 2, keyed by id with the spec's exact seven kinds and four columns, consulted at seed time only. §3 presets as data → Task 3 (validation) and Task 4 (the surface that offers them). The spec's four error-handling rules each have a test: unknown kind → product (Task 2 Step 1), missing label → per-column fallback (Task 2 Step 1), never rewrite a live board (Task 1's "keeps a column's displayed name" and the seed-time-only comment on `createBoard`), and no orphaned cards (Task 1 Step 1). "A note on fit" is commentary, not a requirement. Out-of-scope items are restated in Scope and no task touches them.

**Placeholders.** None. Three steps deliberately defer to the file's existing conventions rather than inventing one — Task 1 Step 8 (assert vs expect), Task 4 Step 5 (`api` module's fetch convention) and Step 6 (the test file's stubbing mechanism) — each naming the exact file to match and what to match about it. Task 2 Step 6 asks the implementer to enumerate `ensureWorkspaceBoards` callers with the grep to run and to report what they found, because the caller set is small but I did not enumerate it and will not guess it.

**Type consistency.** `WorkKind`, `WorkKindPreset`, `workKindFor`, `columnLabel`, `allPresetIds`, `DEFAULT_WORK_KIND`, `WORK_KINDS`, `NEUTRAL_COLUMN_IDS` and `workKindsPayload` are spelled identically throughout. `createBoard(type, workspaceId?, workKind?)` — the third parameter is optional in every task that mentions it, which is what keeps ~12 existing 2-arg test call sites compiling. `columnLabel` takes `Pick<WorkColumn, "id" | "name">` so the Task 2 test can pass a bare object literal without constructing a full column. The six renames are written identically in `BOARD_TEMPLATES` (Task 1 Step 3), `NEUTRAL_COLUMN_IDS` (Step 5), the control-plane test's dead-id list (Step 8) and the live check (Task 5 Step 3).

**Known risks, stated plainly.**
1. **The control-plane suite is not green on `main`** — 2 deterministic pre-existing failures, recorded by name in Global Constraints. They are unrelated to boards, but they mean "the suite is red" is the normal state here, which is exactly the condition under which a real regression hides. Every control-plane step therefore says to confirm the failures **by name**, not by count.
2. **`BOARD_ROUTES` is duplicated across two packages by design.** Task 1 changes both and adds a test pinning the client copy, but nothing structurally prevents the next drift. Unifying them needs a shared module that does not exist; that is a real follow-up, not this plan's job.
3. **Whether a normalized board is ever written back is unverified.** `normalizeBoard` runs on load, so the migration is correct in memory regardless; but if nothing persists the result, every load re-migrates. Harmless, and Task 5 Step 3 surfaces it deliberately rather than leaving it to be discovered.
4. **`"spec"` is two different ids.** The trap is called out in Context with all seven document-section sites listed, because a global find-and-replace on `"spec"` would break the document editor and the blueprint schema while every board test still passed.
