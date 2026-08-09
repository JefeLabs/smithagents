# HeroUI Phase 1c — Kanban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Claimed by:** unclaimed — claim this header before executing

**BLOCKED.** Same two gates as Phase 1a. **Additionally depends on Phase 1a merged**
(imports `src/molecules/form/`). Independent of Phase 1b.

**Goal:** Migrate `BoardStage`, `BoardColumn`, `BoardCard`, `BoardTabs` and `CardSheet`
(985 LOC) from dnd-kit to HeroUI's kanban, gaining keyboard drag, without moving the
source of truth off the TanStack Query cache.

**Architecture:** HeroUI's `useKanban` owns list state internally via RAC `ListData` and
seeds it from `initialItems`. This app's boards are server state in the Query cache with
optimistic-write-and-rollback on every move. Those two cannot both be authoritative, so
this migration adopts HeroUI's kanban **presentation** (`Kanban.Column`, `Kanban.Card`,
`Kanban.DropIndicator`) while supplying its own `dragAndDropHooks` built directly on RAC
`useDragAndDrop` — which is exactly what `Kanban.CardList` accepts, since it "supports
all RAC GridList props". The Query cache stays the single source of truth and `applyMove`
survives verbatim.

**Tech Stack:** React 19, TypeScript 5.6 (strict), `@heroui-pro/react` 1.0.0-beta.8,
`react-aria-components` 1.20, TanStack Query 5.101, Vitest 4 + jsdom, Testing Library,
Biome, pnpm. Removing (from these files only): `@dnd-kit/core`, `@dnd-kit/sortable`,
`@dnd-kit/utilities`.

**Spec:** `docs/superpowers/specs/2026-08-08-heroui-pro-adoption-design.md` (Phase 1,
"Kanban" row, and the two hazards it names)

## Global Constraints

- Package manager is **pnpm**, run from `control-plane/`. Never `npm`.
- **No change to `queries/`, `stores/`, or `api/`.** `useBoards`, `useMoveCard`,
  `api/work.ts` and the `qk.boards` key are untouched.
- **`applyMove` keeps its exact semantics.** Optimistic `setQueryData` → PATCH →
  full-snapshot rollback on failure. Same-column reorders PATCH `{order}` **only**;
  including `columnId` fires the swarm's Jira push-on-move for a card that never left
  its column. That rule is load-bearing and untested by anything upstream.
- **Capability refs resolve by `cardId`, never `boardId`.** In aggregate scope a tab
  spans several boards, so a card's board is `boardOf(card.id)`, not the tab's.
- **Personal-first drag** stays: dragging only ever changes the user's own status.
  Delegation state renders as badges on cards and is never expressed as movement.
- **`dnd-kit` stays installed.** `AgentRoster` still uses it and is Phase 2 work. Two
  drag systems coexist until then — the spec sanctions this and warns against a third.
  Do not introduce one.
- **`onPress` not `onClick`, `isDisabled` not `disabled`** on every HeroUI component.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green before every commit.
- Branch is `heroui-phase-1c`, created off `main` after Phase 1a merges.
- **Do not touch `components.css`.** Phase 3 deletes it wholesale.

---

## A deliberate deviation from the spec

The spec's Phase 1 table names `useKanban` and `useKanbanColumn` among the components to
adopt. **This plan does not use either**, and that is the central decision in it — see
the next section for the reasoning and Task 1 for the evidence gate. Everything else from
that table (`RAC GridList`, `dragAndDropHooks`, `Kanban.DragHandle`, `dragType`) is used
as written.

If Task 1's spike shows the reasoning is wrong and `useKanban` can be driven from the
Query cache without a second source of truth, prefer the spec: use it, and amend this
plan.

## The problem this phase has to solve first

`useKanban` is documented as:

```tsx
const kanban = useKanban({ initialItems: tasks, getColumn, setColumn });
// returns { list, addItem, removeItem, moveItem, updateItem, getColumn, setColumn, dragType }
```

It seeds an internal RAC `ListData` from `initialItems` and mutates it on drop. Its
public surface exposes **no drop callback** — no `onDrop`, no `onMove`, no
`onDragEnd`. `useKanbanColumn`'s only documented option is `renderDropIndicator`.

That is fine for a board whose state lives in the component. It is wrong here: this
board's state is `useBoards()`, a server query written optimistically and rolled back on
a failed PATCH. Adopting `useKanban` as-is would create a second source of truth that
drifts from the cache on every failed mutation, and would give no hook to fire the PATCH
from in the first place.

**Task 1 is a spike that resolves this before any migration work.** The expected answer
is Approach B below, but it must be *demonstrated*, not assumed — the whole phase is
built on it.

| | Approach | Verdict |
|---|---|---|
| **A** | Use `useKanban`, seed `initialItems` from the query cache, observe `kanban.list.items` for changes and diff to derive the PATCH. | Two sources of truth; the diff has to reconstruct intent (same-column vs cross-column) that the drop event already knew. Reject unless B fails. |
| **B** | Use `Kanban.*` presentation + **own** `dragAndDropHooks` from RAC `useDragAndDrop`. `onReorder`/`onInsert` fire `applyMove` directly. Cache stays authoritative. | Expected answer. `Kanban.CardList` accepts all RAC GridList props, and `dragAndDropHooks` is RAC's own prop. |
| **C** | Keep dnd-kit for the board; migrate only the card/column *chrome* to `Kanban.*` visuals. | Fallback if B cannot deliver keyboard drag. Loses the phase's stated capability gain; needs Edwin's sign-off. |

## File Structure

| Path | Responsibility |
|---|---|
| `docs/superpowers/notes/2026-08-09-kanban-dnd-spike.md` | Task 1 output. Which approach, with evidence. |
| `src/organisms/BoardStage.tsx` | Modified — drag system swapped, `applyMove` untouched. |
| `src/molecules/BoardColumn.tsx` | Modified — `Kanban.Column` + `Kanban.CardList`. |
| `src/molecules/BoardCard.tsx` | Modified — `Kanban.Card`. |
| `src/molecules/BoardTabs.tsx` | Modified — `Tabs`. |
| `src/organisms/CardSheet.tsx` | Modified — `Sheet` + Phase 1a form adapters. |

---

### Task 1: Spike — where does the PATCH fire from?

**Files:**
- Create: `docs/superpowers/notes/2026-08-09-kanban-dnd-spike.md`
- Create (throwaway): `src/organisms/KanbanSpike.tsx`, `src/organisms/KanbanSpike.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a written decision, and a proven `buildBoardDragHooks(...)` signature that
  Task 3 implements for real. **No other task may start until this one is committed.**

- [ ] **Step 1: Read the real RAC drag-and-drop API**

Run `mcp__heroui-pro__get_component_docs(["kanban"])` and follow its link to RAC
`useDragAndDrop`. Write down the actual names of the drop callbacks and the shape of
the drop event (`target.key`, `target.dropPosition`, `items` / `keys`). Everything below
uses placeholder-free code, but it is written against the documented *shape*; correct
the names to what you read rather than forcing the code to compile.

- [ ] **Step 2: Write the spike's failing test**

Create `src/organisms/KanbanSpike.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KanbanSpike } from "./KanbanSpike";

describe("kanban drag spike", () => {
  // The whole question: can a drop fire an arbitrary callback with enough
  // information to build the PATCH body, without useKanban owning the list?
  it("reports the moved card, its destination column and its new order", async () => {
    const onMove = vi.fn();
    render(<KanbanSpike onMove={onMove} />);

    // Keyboard drag — the capability this phase exists to gain, and the only
    // drag jsdom can actually perform.
    await userEvent.tab();
    await userEvent.keyboard("{Enter}"); // pick up
    await userEvent.keyboard("{ArrowRight}"); // to the next column
    await userEvent.keyboard("{Enter}"); // drop

    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "c1", columnId: "done", order: 0 }),
    );
  });
});
```

- [ ] **Step 3: Build the smallest spike that could answer it**

Create `src/organisms/KanbanSpike.tsx`. Two fixed columns, two cards, state held in a
plain `useState` **outside** any HeroUI hook — standing in for the Query cache:

```tsx
import { Kanban } from "@heroui-pro/react";
import { useState } from "react";
import { useDragAndDrop } from "react-aria-components";

interface SpikeCard {
  id: string;
  title: string;
  columnId: string;
}

const SEED: SpikeCard[] = [
  { id: "c1", columnId: "todo", title: "first" },
  { id: "c2", columnId: "todo", title: "second" },
];

const COLUMNS = ["todo", "done"];

export interface MoveReport {
  cardId: string;
  columnId: string;
  order: number;
}

/**
 * Throwaway. Answers one question: can a drop reach an arbitrary callback with
 * {cardId, columnId, order}, while the card list stays owned by state outside
 * HeroUI's useKanban? If yes, BoardStage keeps the Query cache as its single
 * source of truth and applyMove survives untouched.
 */
export function KanbanSpike({ onMove }: { onMove: (m: MoveReport) => void }) {
  const [cards] = useState(SEED);

  return (
    <Kanban>
      {COLUMNS.map((col) => (
        <SpikeColumn key={col} column={col} cards={cards} onMove={onMove} />
      ))}
    </Kanban>
  );
}

function SpikeColumn({
  column,
  cards,
  onMove,
}: {
  column: string;
  cards: SpikeCard[];
  onMove: (m: MoveReport) => void;
}) {
  const items = cards.filter((c) => c.columnId === column);

  const { dragAndDropHooks } = useDragAndDrop({
    getItems: (keys) => [...keys].map((key) => ({ "text/plain": String(key) })),
    acceptedDragTypes: ["text/plain"],
    onInsert: (e) => {
      const cardId = String(e.keys ? [...e.keys][0] : "");
      const index = items.findIndex((c) => c.id === String(e.target.key));
      onMove({
        cardId,
        columnId: column,
        order: e.target.dropPosition === "after" ? index + 1 : Math.max(index, 0),
      });
    },
    onRootDrop: (e) => {
      const cardId = String(e.keys ? [...e.keys][0] : "");
      onMove({ cardId, columnId: column, order: 0 });
    },
  });

  return (
    <Kanban.Column>
      <Kanban.ColumnHeader>
        <Kanban.ColumnTitle>{column}</Kanban.ColumnTitle>
        <Kanban.ColumnCount>{items.length}</Kanban.ColumnCount>
      </Kanban.ColumnHeader>
      <Kanban.ColumnBody>
        <Kanban.CardList
          aria-label={column}
          items={items}
          dragAndDropHooks={dragAndDropHooks}
          renderEmptyState={() => "No cards."}
        >
          {(card: SpikeCard) => (
            <Kanban.Card id={card.id} textValue={card.title}>
              <Kanban.DragHandle />
              {card.title}
            </Kanban.Card>
          )}
        </Kanban.CardList>
      </Kanban.ColumnBody>
    </Kanban.Column>
  );
}
```

- [ ] **Step 4: Run the spike test and iterate until it passes or is proven impossible**

Run: `pnpm vitest run src/organisms/KanbanSpike.test.tsx`

Timebox this to **one working session**. Correct the callback names and event shape
against what Step 1 turned up. Two specific things to determine and write down:

1. Which callback fires for a **same-column reorder** (likely `onReorder`) versus a
   **cross-column move** (likely `onInsert`/`onRootDrop`). `applyMove` needs to tell
   them apart, because a same-column PATCH must omit `columnId`.
2. Whether keyboard drag works in jsdom at all. If it does not, the keyboard test the
   spec requires has to be a real-browser check instead, and that must be recorded.

- [ ] **Step 5: Write the decision note**

Create `docs/superpowers/notes/2026-08-09-kanban-dnd-spike.md` recording: which approach
(A, B or C), the exact callback names and event shape, which callback distinguishes
same-column from cross-column, whether keyboard drag runs in jsdom, and the verbatim
`buildBoardDragHooks` signature Task 3 will implement.

**If Approach B failed**, stop here and report to Edwin with the note as evidence. Do not
proceed into A or C unilaterally — C abandons this phase's stated capability gain, and
that is a decision above the implementer's pay grade.

- [ ] **Step 6: Delete the spike, commit the note**

```bash
git rm src/organisms/KanbanSpike.tsx src/organisms/KanbanSpike.test.tsx
git add docs/superpowers/notes/2026-08-09-kanban-dnd-spike.md
git commit -m "docs: kanban drag spike — where the PATCH fires from"
```

---

### Task 2: De-couple the board tests from markup

**Files:**
- Modify: `src/organisms/BoardStage.test.tsx` (809 LOC — the largest test file in the repo)

**Interfaces:**
- Consumes: nothing.
- Produces: a test suite that survives the markup swap, and a `fireDrop` seam whose
  signature is unchanged.

- [ ] **Step 1: Find the class-coupled queries**

Run:
```bash
grep -n "querySelector\|selector:\|board-column__\|board-card__\|className" src/organisms/BoardStage.test.tsx src/molecules/BoardCard.test.tsx src/molecules/BoardTabs.test.tsx src/organisms/CardSheet.test.tsx
```

The spec names `.board-column__cluster-name` specifically. Convert every hit to a
role/label/text query. Give elements an `aria-label` where no accessible name exists yet
— a one-line markup addition in **this** commit, so the query has something to bind to.

- [ ] **Step 2: Confirm `fireDrop` still works and keeps its signature**

`BoardStage.tsx:150` exports a module-level `fireDrop(boardId, cardId, columnId, order)`
test seam because jsdom cannot perform a real pointer drag. It is set from `applyMove`
in an effect.

**This seam survives the migration unchanged.** Every existing drag test calls it, and
it tests `applyMove` — the optimistic write, the PATCH body, and the rollback — which is
precisely the logic this phase must not alter. The drag *system* changes; what a drop
does with the result does not.

Add a comment above it saying so, so a future reader does not delete it as dnd-kit
residue:

```tsx
/**
 * Test seam. jsdom cannot perform a pointer drag, so tests call this directly to
 * exercise applyMove — the optimistic write, the PATCH body, and the rollback.
 *
 * Deliberately survived the dnd-kit → HeroUI migration (Phase 1c): what changed
 * is how a drop is DETECTED, not what a drop DOES. Keyboard drag is covered
 * separately in BoardStage.test.tsx; this seam covers the mutation semantics.
 */
```

- [ ] **Step 3: Run the suite**

Run: `pnpm vitest run src/organisms/BoardStage.test.tsx`
Expected: PASS, same count as before. Behaviour unchanged — only queries moved.

- [ ] **Step 4: Commit**

```bash
git add src/organisms/BoardStage.tsx src/organisms/BoardStage.test.tsx src/molecules/BoardCard.test.tsx src/molecules/BoardTabs.test.tsx src/organisms/CardSheet.test.tsx
git commit -m "test: query board surfaces by role, not class, ahead of the migration"
```

---

### Task 3: Swap the drag system

**Files:**
- Create: `src/lib/board-drag.ts`, `src/lib/board-drag.test.ts`
- Modify: `src/molecules/BoardColumn.tsx`, `src/organisms/BoardStage.tsx`

**Interfaces:**
- Consumes: the signature recorded in Task 1's note.
- Produces: `buildBoardDragHooks(args: { columnId: string; items: BoardCardT[];
  onMove: (m: { cardId: string; columnId: string; order: number }) => void })` returning
  `{ dragAndDropHooks }`, plus the pure `dropOrder(...)` helper it uses.

The order arithmetic is the part most likely to be wrong and the easiest to test
without a DOM, so it comes out as a pure function first — the same shape as
`board-aggregate.ts` and `workspace-color.ts` already use in this codebase.

- [ ] **Step 1: Write the failing test for the pure part**

Create `src/lib/board-drag.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dropOrder } from "./board-drag";

const ITEMS = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("dropOrder", () => {
  it("dropping before the first card is order 0", () => {
    expect(dropOrder(ITEMS, "a", "before")).toBe(0);
  });

  it("dropping after the first card is order 1", () => {
    expect(dropOrder(ITEMS, "a", "after")).toBe(1);
  });

  it("dropping after the last card appends", () => {
    expect(dropOrder(ITEMS, "c", "after")).toBe(3);
  });

  // A drop onto an empty column reports no target key at all.
  it("an absent target is order 0, not -1", () => {
    expect(dropOrder([], undefined, "before")).toBe(0);
  });

  // Guards the arithmetic against a target that has since been removed by a
  // refetch landing mid-drag — findIndex returns -1 and would otherwise
  // produce order -1, which the broker rejects.
  it("an unknown target is order 0, not -1", () => {
    expect(dropOrder(ITEMS, "gone", "after")).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/lib/board-drag.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the pure helper plus the hook builder**

Create `src/lib/board-drag.ts`:

```ts
/**
 * The order arithmetic for a card drop, kept pure and DOM-free so it can be
 * tested without a drag — same reasoning as board-aggregate.ts.
 *
 * `order` is the card's index in its destination column AFTER the drop, which is
 * what PATCH /work/boards/:id/cards/:cardId expects.
 */
export function dropOrder(
  items: Array<{ id: string }>,
  targetId: string | undefined,
  position: "before" | "after",
): number {
  if (targetId === undefined) return 0;
  const index = items.findIndex((c) => c.id === targetId);
  // A refetch can drop the target out from under an in-flight drag. Falling back
  // to 0 puts the card at the top rather than sending the broker order -1.
  if (index < 0) return 0;
  return position === "after" ? index + 1 : index;
}
```

Then add `buildBoardDragHooks` to the same file, implementing **exactly** the signature
Task 1's note recorded. It wraps `useDragAndDrop` and calls `onMove({cardId, columnId,
order})` from both the reorder and the insert callbacks, using `dropOrder` for the
arithmetic. Keep it a thin translation layer: no state, no fetch, no Query access.

- [ ] **Step 4: Run the pure test**

Run: `pnpm vitest run src/lib/board-drag.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Rewrite `BoardColumn`**

Replace the dnd-kit `SortableContext` / `useSortable` markup with `Kanban.Column`,
`Kanban.ColumnHeader`, `Kanban.ColumnBody`, `Kanban.CardList` and `Kanban.Card`, passing
`dragAndDropHooks` from `buildBoardDragHooks`. Add `<Kanban.DragHandle />` inside each
card — it is screen-reader-only until focused and is what makes keyboard drag reachable.

Preserve the cluster-name element and give it an `aria-label`; Task 2 pointed a test at
it.

- [ ] **Step 6: Wire `BoardStage`'s `onMove` to the existing `applyMove`**

In `BoardStage.tsx`, the drop handler passed down is `applyMove`, **unchanged**. Only
its call site moves — from dnd-kit's `onDragEnd` to `buildBoardDragHooks`'s `onMove`:

```tsx
const onMove = useCallback(
  ({ cardId, columnId, order }: { cardId: string; columnId: string; order: number }) => {
    // Cards go to the board they came from, never the tab — in aggregate scope a
    // tab spans several boards. Resolve by cardId, never by the tab's boardId.
    const board = boards.find((b) => b.cards.some((c) => c.id === cardId));
    if (!board) return;
    void applyMove(board.id, cardId, columnId, order);
  },
  [boards, applyMove],
);
```

Delete the `useSensors`/`PointerSensor` lines and the `DndContext` wrapper. Do **not**
remove `@dnd-kit/*` from `package.json` — `AgentRoster` still imports it.

- [ ] **Step 7: Add the keyboard-drag test the spec requires**

Only if Task 1 Step 4 established that keyboard drag runs in jsdom. Append to
`src/organisms/BoardStage.test.tsx`:

```tsx
it("keyboard drag moves a card and fires the PATCH", async () => {
  const { patchCalls } = renderBoardStageWithStubs();
  await userEvent.tab();
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{ArrowRight}");
  await userEvent.keyboard("{Enter}");

  expect(patchCalls).toHaveLength(1);
  expect(patchCalls[0].body).toEqual({ columnId: "doing", order: 0 });
});
```

Reuse the suite's existing stub helper rather than writing a new one — read the top of
`BoardStage.test.tsx` for its actual name and shape. If keyboard drag does **not** work
in jsdom, record that in the spike note and cover it in Task 5's manual smoke instead;
do not delete the requirement silently.

- [ ] **Step 8: Run the board suite**

Run: `pnpm vitest run src/organisms/BoardStage.test.tsx`
Expected: PASS. Every pre-existing `fireDrop` test must pass **unedited** — they test
`applyMove`, which did not change.

- [ ] **Step 9: Verify the same-column rule survived**

Run: `grep -n "sameColumn" src/organisms/BoardStage.tsx`
Expected: the existing logic, unchanged — a same-column move still PATCHes `{order}`
only. There should be an existing test asserting this; run it by name and confirm.

- [ ] **Step 10: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/lib/board-drag.ts src/lib/board-drag.test.ts src/molecules/BoardColumn.tsx src/organisms/BoardStage.tsx src/organisms/BoardStage.test.tsx
git commit -m "refactor: board drag onto react-aria, applyMove untouched"
```

---

### Task 4: `BoardCard`, `BoardTabs`, `CardSheet`

**Files:**
- Modify: `src/molecules/BoardCard.tsx`, `src/molecules/BoardTabs.tsx`,
  `src/organisms/CardSheet.tsx`

**Interfaces:**
- Consumes: `Kanban.Card`, `Tabs`, `Sheet`; `FormTextField` from `../molecules/form`.
- Produces: all three with props unchanged.

- [ ] **Step 1: `BoardCard` content into `Kanban.Card`**

`Kanban.Card` owns the outer wrapper (focus ring, drag opacity, layout animation), so
`BoardCard` becomes the *content* rendered inside it — badges, workspace tint, avatar.

Two things to preserve exactly:

- **`--card-tint` must stay a `color-mix()`, never the raw workspace colour.** Assigning
  the raw hex makes cards unreadable in light themes. Copy the existing expression from
  the current file rather than rewriting it.
- **`const BASE = "127.0.0.1:7790"` at `BoardCard.tsx:5`** is only used to build the
  avatar image URL. While you are in this file, replace it with an import of
  `BROKER_BASE` from `../api/broker` — it is a one-line fix to a duplicated constant the
  react-state-stack plan explicitly forbade, and this is the only phase that touches
  this file.

- [ ] **Step 2: `BoardTabs` onto `Tabs`**

Keep the scope-keyed reset effect. It clears the add-card menu when the workspace scope
changes, and its sibling in `BoardStage` clears `addingCard`/`cardTitle`/`open` — both
are needed, for the reason the comment at `BoardStage.tsx:213-219` gives.

- [ ] **Step 3: `CardSheet` onto `Sheet` + the Phase 1a adapters**

`CardSheet` is a 301-line detail panel with 10 inputs and its own `useForm`. Its outer
panel becomes `Sheet` (same `isOpen`/`onOpenChange` wiring as Phase 1b Task 5); its
inputs become `FormTextField`.

Preserve `key={openCard.id}` at its render site in `BoardStage`. That is what reseeds the
form when a different card is opened — the comment at `BoardStage.tsx:216` states the
rule: *"use `key=` when the state is SEEDED from the identity that changed."* Replacing
it with a reset effect would reintroduce the bug it was written to prevent.

- [ ] **Step 4: Run all three suites**

Run: `pnpm vitest run src/molecules/BoardCard.test.tsx src/molecules/BoardTabs.test.tsx src/organisms/CardSheet.test.tsx`
Expected: PASS, unedited (Task 2 already de-coupled them).

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/molecules/BoardCard.tsx src/molecules/BoardTabs.tsx src/organisms/CardSheet.tsx
git commit -m "refactor: board card, tabs and sheet onto heroui"
```

---

### Task 5: Close the phase

- [ ] **Step 1: Confirm the drag rules survived**

Run:
```bash
git diff main -- src/organisms/BoardStage.tsx | grep -E "^[-+].*(sameColumn|columnId|rollback|previous)"
```
Read every hit. `applyMove`'s body should show **no** semantic changes — only its call
site moved. If the optimistic write, the PATCH body construction, or the full-snapshot
rollback changed, revert that hunk.

- [ ] **Step 2: Confirm dnd-kit is still installed and still used by AgentRoster**

Run: `grep -rln "@dnd-kit" src`
Expected: `src/organisms/AgentRoster.tsx` and `src/molecules/BoardColumn.tsx` is **gone**
from the list. If `@dnd-kit` disappeared from `package.json`, restore it — `AgentRoster`
is Phase 2.

- [ ] **Step 3: Confirm no third drag pattern appeared**

Run: `grep -rn "useDragAndDrop\|DndContext\|useSortable\|draggable=" src | grep -v node_modules`
Expected: exactly two systems — RAC `useDragAndDrop` (in `src/lib/board-drag.ts` only)
and dnd-kit (in `AgentRoster.tsx` only). Anything else is the third pattern the spec's
Risk 3 warns against.

- [ ] **Step 4: Confirm the state layer was not touched**

Run: `git diff --stat main -- src/api src/queries src/stores`
Expected: no output.

- [ ] **Step 5: Screenshots**

```bash
mkdir -p .screenshots/phase1c
```
Capture the board in all four themes, in both personal and aggregate scope, with at
least one delegated card so the badges show. Structural gate.

**Check the stage-mode rail clearance specifically.** Board stages need `inset 0 72px`
to clear the rails; a layout regression there is invisible in a narrow screenshot and
obvious on a real window.

- [ ] **Step 6: UI smoke against a live broker**

Start the broker (tmux `smith-broker`, port 7790) and `pnpm dev`. Then:

1. Drag a card within a column. Confirm it reorders and, in the network tab, that the
   PATCH body is `{order}` **without** `columnId`.
2. Drag a card to another column. Confirm the PATCH body carries both.
3. Stop the broker and drag a card. Confirm it snaps back and the "Move failed —
   restored the previous order" message appears.
4. **Keyboard drag**: Tab to a card, Enter to pick up, arrows to move, Enter to drop.
   Confirm the same PATCH fires. This is the phase's headline capability and was
   impossible before — `KeyboardSensor` count in the repo was 0.
5. Switch to aggregate scope, drag a card from a board that is not the tab's first.
   Confirm it lands on **its own** board, not the tab's.
6. Open a card sheet, edit it, open a different card. Confirm the form reseeds.

- [ ] **Step 7: Record the bundle cost and commit**

Run: `pnpm build`. Record `dist/assets/index-*.js` against Phase 1a and 1b.

```bash
git add -A
git commit -m "chore: close heroui phase 1c"
```

---

## What Phase 2 inherits from here

- `src/lib/board-drag.ts` is the drag precedent. `AgentRoster`'s dnd-kit retirement in
  Phase 2 should reuse `buildBoardDragHooks`'s shape rather than inventing a second
  translation layer.
- Once `AgentRoster` migrates, `@dnd-kit/core`, `@dnd-kit/sortable` and
  `@dnd-kit/utilities` can all be removed from `package.json`. Not before.
- `BoardCard.tsx`'s duplicated `BASE` constant was fixed here. Three remain:
  `AgentAvatar.tsx:7`, `useSurfacePolicy.ts:6`, `AddAgentModal.tsx:8`. `AgentAvatar` and
  `AddAgentModal` are both Phase 2 files — fix them there, the same one-line way.
</content>
