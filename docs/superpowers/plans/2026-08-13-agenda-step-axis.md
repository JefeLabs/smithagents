# Agenda Pull Queue — Implementation Plan

> **CLAIMED 2026-08-13 — in execution.** Owner: session `5de6efcf`, worktree `.worktrees/agenda-step-axis`, branch `agenda-step-axis`. Ledger: `.superpowers/sdd/2026-08-13-agenda-step-axis/progress.md`. Do not start a second executor against this plan — check the ledger for which tasks are already complete, and coordinate before touching the branch.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each card a single-holder step axis orthogonal to its team column, and surface unheld work from Maintain/React/Deliver in a shared queue people pull from.

**Architecture:** One optional field on `WorkCard` — `agenda: {by, state, since, grabbedAt}` — shaped after the existing `flag` axis, plus an append-only `intents[]` narrative. The shared queue is **derived, never stored**: a card is in the pool when it needs a human and nobody holds it. Advancing a card between columns clears the holder, because the step it described has ended.

**Tech Stack:** swarm = TypeScript + Fastify, tested with the node built-in test runner (`node --import tsx --test`) and `node:assert/strict`. control-plane = React + TanStack Query + dnd-kit, tested with vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-13-agenda-step-axis-design.md`

## Global Constraints

- **pnpm, never npm.** One workspace at the repo root; node >= 24; TypeScript ~6.0.0.
- **Biome 2.5.3 runs on BOTH packages.** `swarm/package.json` defines `lint: biome check .` — an earlier draft of this plan wrongly said swarm had none. Control-plane's baseline is **zero diagnostics**. Swarm is **not** at zero: it carries 8 errors + 1 warning at this branch's base (375a9e8). Leave that pre-existing debt alone and fix only what your own change introduces — verify by running `pnpm exec biome check .` from the package and confirming you land back at its baseline, not at zero.
- **Swarm helpers stay pure.** No clock, filesystem, or current-user reads inside `work-items.ts` — the caller passes `now` and `userId`.
- **The shared queue is derived.** Never add a stored "queued" flag or a function that writes one.
- **`StepState` is exactly `"plate" | "today"`.** No `done` — finishing a step means advancing the card.
- **Entering `today` requires a non-empty intent**, enforced in the domain helper so no route or script can bypass it. `plate` never requires one.
- **Closing requires one too**, enforced in `patchCard`: a **held** card changing column, or a **personal** card entering `done`. An unheld team card moves freely. Every such check runs *before* any mutation — a rejected move must leave the card untouched.
- **`card.intents` is append-only.** Nothing rewrites or truncates it — not the sweep, not a column change, not a release.
- **Sources are `maintenance`, `reactive`, `deliver`.** `release/sign-off` is deliberately excluded.
- Run swarm tests from `swarm/`, control-plane tests from `control-plane/`.

---

### Task 1: The step axis and its write helpers

**Files:**
- Modify: `swarm/src/work-items.ts:12-52` (types), `:481-529` (`patchCard`)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Produces: `type StepState = "plate" | "today"`, `WorkCard.agenda?: { by: string; state: StepState; since: string }`, `WorkCard.intents?: Array<{ at: string; by: string; text: string }>`, `grabCard(card, userId, now): void`, `releaseCard(card): void`, `setStepState(card, userId, state, now, intent?): void`.

- [ ] **Step 1: Write the failing tests**

Add to `swarm/src/work-items.test.ts` (extend the existing import block from `./work-items.js` with `grabCard`, `releaseCard`, `setStepState`, `type StepState`):

```ts
test("grabCard claims an unheld card; grabbing a held one throws", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  assert.deepEqual(c.agenda, {
    by: "edwin",
    state: "plate",
    since: "2026-08-13T10:00:00.000Z",
    grabbedAt: "2026-08-13T10:00:00.000Z",
  });
  assert.throws(() => grabCard(c, "ana", "2026-08-13T10:00:01.000Z"), /already held/);
});

test("grabbedAt is set once and survives every state flip", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-10T10:00:00.000Z");
  setStepState(c, "edwin", "today", "2026-08-13T09:00:00.000Z", "chasing the flaky suite");
  setStepState(c, "edwin", "plate", "2026-08-14T00:00:00.000Z");
  assert.equal(c.agenda?.grabbedAt, "2026-08-10T10:00:00.000Z", "age is measured from the grab");
  assert.equal(c.agenda?.since, "2026-08-14T00:00:00.000Z", "since tracks the current state");
});

test("releaseCard deletes the field so the card falls back into the shared queue", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  releaseCard(c);
  assert.equal(c.agenda, undefined, "no empty object may linger");
});

test("setStepState flips plate<->today; since resets on change, survives a re-stamp", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  setStepState(c, "edwin", "plate", "2026-08-13T11:00:00.000Z");
  assert.equal(c.agenda?.since, "2026-08-13T10:00:00.000Z", "same state keeps its clock");
  setStepState(c, "edwin", "today", "2026-08-13T12:00:00.000Z", "chasing the flaky suite");
  assert.equal(c.agenda?.since, "2026-08-13T12:00:00.000Z");
  assert.throws(
    () => setStepState(c, "ana", "today", "2026-08-13T12:00:00.000Z", "mine now"),
    /not held by/,
  );
});

test("entering today demands a sentence — the rule lives in the domain, not the UI", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  assert.throws(() => setStepState(c, "edwin", "today", "2026-08-13T11:00:00.000Z"), /intent is required/);
  assert.throws(
    () => setStepState(c, "edwin", "today", "2026-08-13T11:00:00.000Z", "   "),
    /intent is required/,
    "whitespace is not a sentence",
  );
  assert.equal(c.agenda?.state, "plate", "a rejected claim must not half-apply");
  assert.equal(c.intents, undefined);
});

test("each claim appends one intent; a same-state re-stamp does not append twice", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  setStepState(c, "edwin", "today", "2026-08-13T11:00:00.000Z", "chasing the flaky suite");
  setStepState(c, "edwin", "today", "2026-08-13T12:00:00.000Z", "still on it");
  assert.equal(c.intents?.length, 1, "already in today — no new claim was made");
  assert.deepEqual(c.intents?.[0], {
    at: "2026-08-13T11:00:00.000Z",
    by: "edwin",
    kind: "start",
    text: "chasing the flaky suite",
  });
});

test("intents survive the column change that clears the holder", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  setStepState(c, "edwin", "today", "2026-08-13T11:00:00.000Z", "chasing the flaky suite");
  patchCard(b, c.id, { columnId: "verify", order: 0, close: { by: "edwin", text: "it was the 20s ceiling" } });
  assert.equal(c.agenda, undefined, "the step ended");
  assert.deepEqual(
    c.intents?.map((i) => i.kind),
    ["start", "done"],
    "the card's story does not end with the step",
  );
});

test("patchCard clears the holder on a column change, keeps it on a reorder", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  addCard(b, { title: "other", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  patchCard(b, c.id, { order: 1 });
  assert.ok(c.agenda, "a reorder is the same step");
  patchCard(b, c.id, { columnId: "verify", order: 0, close: { by: "edwin", text: "reviewed, looks right" } });
  assert.equal(c.agenda, undefined, "the step ended");
});

test("a held card cannot advance without a closing comment, and a refusal changes nothing", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  assert.throws(() => patchCard(b, c.id, { columnId: "verify", order: 0 }), /closing comment is required/);
  assert.equal(c.columnId, "review", "no half-applied move");
  assert.equal(c.agenda?.by, "edwin", "holder intact");
  assert.equal(c.intents, undefined);
});

test("closing appends a done entry that survives the holder being cleared", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  patchCard(b, c.id, { columnId: "verify", order: 0, close: { by: "edwin", text: "it was the 20s ceiling" } });
  assert.equal(c.agenda, undefined);
  assert.equal(c.intents?.length, 1);
  assert.equal(c.intents?.[0].kind, "done");
  assert.equal(c.intents?.[0].by, "edwin");
  assert.equal(c.intents?.[0].text, "it was the 20s ceiling");
});

test("an UNHELD team card advances freely — the rule is about finishing, not tidying", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  patchCard(b, c.id, { columnId: "verify", order: 0 });
  assert.equal(c.columnId, "verify");
  assert.equal(c.intents, undefined);
});

test("a personal todo needs a comment to reach done, but not to reach doing", () => {
  const b = createBoard("personal");
  const c = addCard(b, { title: "call the bank", columnId: "todo" });
  patchCard(b, c.id, { columnId: "doing", order: 0 });
  assert.equal(c.columnId, "doing");
  assert.throws(() => patchCard(b, c.id, { columnId: "done", order: 0 }), /closing comment is required/);
  patchCard(b, c.id, { columnId: "done", order: 0, close: { by: "edwin", text: "rescheduled the transfer" } });
  assert.equal(c.intents?.[0].kind, "done");
});
```

- [ ] **Step 2: Run them to verify they fail**

From `swarm/`:
```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='grabCard|releaseCard|setStepState|clears the holder' src/work-items.test.ts
```
Expected: FAIL — `grabCard is not a function`.

- [ ] **Step 3: Add the types**

In `swarm/src/work-items.ts`, after the `CardFlag` block (ends line 29 with `const FLAG_KINDS`):

```ts
export type StepState = "plate" | "today";

export const STEP_STATES: StepState[] = ["plate", "today"];
```

Add to `WorkCard`, after `flag?: CardFlag;`:

```ts
  /** Who holds this card's CURRENT step. Orthogonal to columnId, like `flag`; cleared
      when the card changes column. One holder — grabbing is exclusive. An AGENT holding
      work is `delegation`, not this. */
  agenda?: {
    by: string;
    state: StepState;
    /** Entry into the CURRENT state — same contract as CardFlag.since. The sweep re-stamps it. */
    since: string;
    /** When it landed on this plate. Set once at grab, never touched again — the clock
        that answers "how long have I been sitting on this", which `since` cannot. */
    grabbedAt: string;
  };
  /** Append-only: what people said they were doing, and what they said they did. On the
      CARD, not inside `agenda`, so it survives the column change that clears the holder.
      `kind` makes it start/done pairs rather than a flat stream, which is what a summary
      needs. Substrate for Jira comments and AI summaries. */
  intents?: Array<{ at: string; by: string; kind: "start" | "done"; text: string }>;
```

- [ ] **Step 4: Add the three helpers**

In `swarm/src/work-items.ts`, immediately before `export function patchCard`:

```ts
/**
 * Pull a card out of the shared queue. Exclusive by design: two people pulling the
 * same card at the same moment must not silently produce one winner and one confused
 * loser, so a second grab throws rather than overwriting.
 */
export function grabCard(card: WorkCard, userId: string, now: string): void {
  if (card.agenda) throw new Error(`Card already held by ${card.agenda.by}`);
  card.agenda = { by: userId, state: "plate", since: now, grabbedAt: now };
}

/**
 * Hand it back. The shared queue is derived from "nobody holds it", so deleting the
 * field IS the return to the pool — there is no queued state to write.
 */
export function releaseCard(card: WorkCard): void {
  card.agenda = undefined;
}

/**
 * The holder's own daily declaration. `since` measures how long they have been in THIS
 * state, so an unchanged state keeps its stamp — same contract as CardFlag.since.
 *
 * Claiming a card for TODAY demands a sentence, and the rule lives here rather than in
 * the composer so no route, script or import can move a card into today silently. Every
 * validation runs before anything mutates: a rejected claim must not leave the card
 * half-applied.
 */
export function setStepState(
  card: WorkCard,
  userId: string,
  state: StepState,
  now: string,
  intent?: string,
): void {
  if (!STEP_STATES.includes(state)) throw new Error(`Unknown step state: ${state}`);
  if (!card.agenda) throw new Error("Card is not held — grab it first");
  if (card.agenda.by !== userId) throw new Error(`Card is not held by ${userId}`);
  const entering = card.agenda.state !== state;
  const text = intent?.trim();
  if (state === "today" && entering && !text) throw new Error("An intent is required to claim a card for today");
  if (state === "today" && entering && text) {
    card.intents = [...(card.intents ?? []), { at: now, by: userId, kind: "start", text }];
  }
  if (entering) card.agenda.since = now;
  card.agenda.state = state;
}
```

- [ ] **Step 5: Require a closing comment, then clear the holder**

Widen `patchCard`'s patch parameter with one non-card field beside the existing `flag`:

```ts
  > & {
    flag?: { kind: FlagKind; reason?: string } | null;
    /** Required when this move ends a held step, or sends a personal todo to done. */
    close?: { by: string; text: string };
  },
```

Add the guard at the **top** of `patchCard`, beside the existing unknown-column check and before any mutation — a rejected move must leave the card exactly as it was:

```ts
  const toColumn = patch.columnId ?? card.columnId;
  const changingColumn = toColumn !== card.columnId;
  // Finishing costs a sentence, symmetrically with claiming a day. Two gestures end
  // work: advancing a card someone holds (whoever moves it — if Ana advances Edwin's
  // card, Ana writes it), and sending a personal todo to done. An UNHELD team card
  // moves freely: the rule attaches to finishing work someone took, not to tidying.
  const endsHeldStep = changingColumn && Boolean(card.agenda);
  const personalDone = changingColumn && board.type === "personal" && toColumn === "done";
  if ((endsHeldStep || personalDone) && !patch.close?.text.trim()) {
    throw new Error("A closing comment is required to finish this work");
  }
```

Then replace `if (fromColumn !== toColumn) renumber(board, fromColumn);` with:

```ts
    if (fromColumn !== toColumn) {
      renumber(board, fromColumn);
      const closing = patch.close?.text.trim();
      if (closing) {
        card.intents = [
          ...(card.intents ?? []),
          { at: new Date().toISOString(), by: patch.close!.by, kind: "done", text: closing },
        ];
      }
      // The step this described has ended, so its holder is void. Appended FIRST —
      // clearing the holder must not cost us the record of what closed it.
      card.agenda = undefined;
    }
```

`patchCard` already reads the clock for `card.updatedAt`, so this follows the function's existing convention rather than breaking the purity rule the *other* helpers keep. Assert on the entry's `by`/`kind`/`text` in tests, not its `at`.

- [ ] **Step 5b: Clear the holder in `routeCard` too**

`routeCard` does not go through `patchCard` — it builds `moved` by spreading `...card` onto the destination board, which carries `agenda` across with it. Add `agenda: undefined` to that spread:

```ts
  const moved: WorkCard = {
    ...card,
    columnId: exit.toColumn,
    order: dest.cards.filter((c) => c.columnId === exit.toColumn).length,
    updatedAt: now,
    routedFrom: [...(card.routedFrom ?? []), trace],
    // A board change is strictly more than a column change, so the same invariant
    // applies: the step this holder described no longer exists. Routing deliberately
    // does NOT demand a closing comment — it is a board-to-board handoff with its own
    // UI, and gating it here would block a route behind a composer that isn't built.
    agenda: undefined,
  };
```

Test it:

```ts
test("routeCard clears the holder — a routed card must not carry a stale owner", () => {
  const r = createBoard("reactive", "ws");
  const m = createBoard("maintenance", "ws");
  const c = addCard(r, { title: "flaky", columnId: "triage" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  const exit = { from: "triage", toType: "maintenance" as const, toColumn: "triage", label: "To maintenance" };
  const plan = routeCard(r, m, c.id, exit, "2026-08-13T11:00:00.000Z");
  assert.equal(plan.card.agenda, undefined);
});
```

- [ ] **Step 6: Run the tests, then the whole suite**

```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='grabCard|releaseCard|setStepState|clears the holder' src/work-items.test.ts
pnpm test 2>&1 | tail -20
```
Expected: 4 new tests PASS; suite `fail 0`. `patchCard` is used everywhere — the full run is not optional.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/work-items.ts swarm/src/work-items.test.ts
git commit -m "feat(swarm): single-holder step axis on cards

agenda records who holds a card's CURRENT step, orthogonal to columnId
like flag. Grab is exclusive; advancing a column clears it."
```

---

### Task 2: Human-gated columns and the derived shared queue

**Files:**
- Modify: `swarm/src/work-items.ts:12-17` (`WorkColumn`), `:107-159` (`BOARD_TEMPLATES`), `:210-228` (`BOARD_ROUTES`)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: `WorkCard.agenda` from Task 1.
- Produces: `WorkColumn.gatesHuman?: boolean`, `AGENDA_SOURCE_TYPES: BoardType[]`, `needsHuman(board, card): boolean`, `sharedQueue(boards): Array<{ board: WorkBoard; card: WorkCard }>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("templates gate exactly the four columns that wait on a person", () => {
  const gated = (t: BoardType, id: string) => Boolean(BOARD_TEMPLATES[t].find((c) => c.id === id)?.gatesHuman);
  assert.equal(gated("deliver", "review"), true);
  assert.equal(gated("deliver", "verify"), true);
  assert.equal(gated("reactive", "triage"), true);
  assert.equal(gated("maintenance", "triage"), true);
  assert.equal(gated("release", "sign-off"), false, "Release is not a source — Edwin named three boards");
  assert.equal(gated("deliver", "in-progress"), false);
});

test("sharedQueue pools unheld work from Maintain, React and Deliver only", () => {
  const d = createBoard("deliver", "ws");
  const p = createBoard("plan", "ws");
  const inPool = addCard(d, { title: "review me", columnId: "review" });
  addCard(p, { title: "spec", columnId: "spec" });
  const pooled = sharedQueue([d, p]);
  assert.deepEqual(pooled.map((x) => x.card.id), [inPool.id]);
});

test("sharedQueue excludes held cards and cards an agent is mid-flight on", () => {
  const d = createBoard("deliver", "ws");
  const held = addCard(d, { title: "held", columnId: "review" });
  grabCard(held, "edwin", "2026-08-13T10:00:00.000Z");
  const working = addCard(d, { title: "agent has it", columnId: "review" });
  working.delegation = { agentId: "a1", taskId: "t1", state: "working" };
  assert.deepEqual(sharedQueue([d]), []);
});

test("sharedQueue includes a failed delegation, a flag, and a jira error even in an ungated column", () => {
  const d = createBoard("deliver", "ws");
  const failed = addCard(d, { title: "agent failed", columnId: "in-progress" });
  failed.delegation = { agentId: "a1", taskId: "t1", state: "failed" };
  const flagged = addCard(d, { title: "blocked", columnId: "in-progress" });
  flagged.flag = { kind: "blocked", since: "2026-08-13T10:00:00.000Z" };
  const broken = addCard(d, { title: "push broke", columnId: "in-progress" });
  broken.jira = { key: "P-1", url: "http://x", lastPushError: "boom" };
  assert.deepEqual(
    sharedQueue([d]).map((x) => x.card.id).sort(),
    [failed.id, flagged.id, broken.id].sort(),
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='sharedQueue|gate exactly' src/work-items.test.ts
```
Expected: FAIL — `sharedQueue is not a function`.

- [ ] **Step 3: Add the column field and seed the templates**

Add to `WorkColumn` after `jiraStatus?: string;`:

```ts
  /** This column structurally waits on a human — its unheld cards surface in the shared queue. */
  gatesHuman?: boolean;
```

In `BOARD_TEMPLATES`, add `gatesHuman: true` to exactly four column literals — `deliver`'s `review` and `verify`, and the `triage` entry in **both** `reactive` and `maintenance`:

```ts
    { id: "review", name: "Review", gatesHuman: true },
    { id: "verify", name: "Verify", gatesHuman: true },
```
```ts
    { id: "triage", name: "Triage", gatesHuman: true },
```

Leave `release/sign-off` alone.

- [ ] **Step 4: Add the derivation**

After `releaseCard` in `swarm/src/work-items.ts`:

```ts
/** The boards whose work reaches a person's Agenda. Edwin named these three, twice. */
export const AGENDA_SOURCE_TYPES: BoardType[] = ["maintenance", "reactive", "deliver"];

/** Does this card want a human right now? Independent of whether one has taken it. */
export function needsHuman(board: WorkBoard, card: WorkCard): boolean {
  const gated = board.columns.find((c) => c.id === card.columnId)?.gatesHuman === true;
  const handedBack = card.delegation?.state === "completed" || card.delegation?.state === "failed";
  return gated || handedBack || Boolean(card.flag) || Boolean(card.jira?.lastPushError);
}

/**
 * The shared queue — DERIVED, never stored. A card is in the pool when it needs a human
 * and nobody has it. Because the pool IS "nobody holds it", releasing a card returns it
 * here by deletion alone: there is no queued flag to write, and nothing can re-offer a
 * card that was deliberately handed back.
 *
 * A card an agent is actively working belongs to the agent, not the pool — that
 * distinction is the reason the axis exists.
 */
export function sharedQueue(boards: WorkBoard[]): Array<{ board: WorkBoard; card: WorkCard }> {
  const out: Array<{ board: WorkBoard; card: WorkCard }> = [];
  for (const board of boards) {
    if (!AGENDA_SOURCE_TYPES.includes(board.type)) continue;
    for (const card of board.cards) {
      if (card.agenda) continue;
      if (card.delegation?.state === "working") continue;
      if (needsHuman(board, card)) out.push({ board, card });
    }
  }
  return out;
}
```

- [ ] **Step 4b: Migrate the personal board to the new lane vocabulary**

The Agenda's lanes and the personal board's columns must share one vocabulary, or every existing personal card matches no lane. Change `BOARD_TEMPLATES.personal` to:

```ts
  personal: [
    { id: "plate", name: "My plate" },
    { id: "today", name: "Today" },
    { id: "done", name: "Done" },
    { id: "not-doing", name: "Not Doing" },
  ],
```

There is no `queue` column any more — the shared queue is derived, not a lane the board owns. So also **remove `"personal"` from `QUEUE_TYPES`** (work-items.ts:342), or `normalizeBoard` re-adds a `queue` column on every single load and quietly undoes this.

Then migrate persisted boards in `normalizeBoard`, following the precedent already in that function (its `queued` → `queue` rewrite):

```ts
  if (board.type === "personal") {
    const RENAMED: Record<string, string> = { queue: "plate", todo: "plate", doing: "today" };
    if (board.columns.some((c) => RENAMED[c.id])) {
      for (const card of board.cards) {
        const to = RENAMED[card.columnId];
        if (to) card.columnId = to;
      }
      // queue and todo both fold into plate, so rebuild the column list from the
      // template rather than renaming in place — two columns collapsing into one
      // cannot be expressed as a rename.
      board.columns = BOARD_TEMPLATES.personal.map((c) => ({ ...c }));
      renumberAll(board);
    }
  }
```

`renumberAll(board)` re-runs the existing per-column `renumber` for every column id on the board — two columns merging into `plate` leaves duplicate `order` values otherwise. Add it beside `renumber` if it does not exist.

Test it:

```ts
test("normalizeBoard folds a legacy personal board into plate/today/done", () => {
  const b = createBoard("personal");
  b.columns = [
    { id: "queue", name: "Queue" }, { id: "todo", name: "Todo" },
    { id: "doing", name: "Doing" }, { id: "done", name: "Done" },
    { id: "not-doing", name: "Not Doing" },
  ];
  b.cards = [
    { id: "a", title: "q", columnId: "queue", order: 0, createdAt: "x", updatedAt: "x" },
    { id: "b", title: "t", columnId: "todo", order: 0, createdAt: "x", updatedAt: "x" },
    { id: "c", title: "d", columnId: "doing", order: 0, createdAt: "x", updatedAt: "x" },
  ];
  normalizeBoard(b);
  assert.deepEqual(b.columns.map((c) => c.id), ["plate", "today", "done", "not-doing"]);
  assert.deepEqual(b.cards.map((c) => c.columnId), ["plate", "plate", "today"]);
  assert.deepEqual(b.cards.filter((c) => c.columnId === "plate").map((c) => c.order).sort(), [0, 1]);
});

test("normalizeBoard no longer forces a queue column onto the personal board", () => {
  const b = createBoard("personal");
  normalizeBoard(b);
  assert.equal(b.columns.some((c) => c.id === "queue"), false);
});
```

- [ ] **Step 5: Retire the Escalate-to-Agenda routes**

In `BOARD_ROUTES`, delete the `{ from: "triage", toType: "personal", toColumn: "queue", label: "Escalate to Agenda" }` entry from **both** `reactive` and `maintenance`. Those routes *move* a card onto the personal board, hiding it from the team; a triage card is now already in the shared queue, and escalating is just grabbing it. Update any test asserting those exits.

- [ ] **Step 6: Run the tests, then the whole suite**

```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='sharedQueue|gate exactly' src/work-items.test.ts
pnpm test 2>&1 | tail -20
```
Expected: 4 new PASS; suite `fail 0`. Route-exit tests will need updating from Step 5 — read them before editing.

- [ ] **Step 7: Commit**

```bash
git add swarm/src/work-items.ts swarm/src/work-items.test.ts
git commit -m "feat(swarm): derived shared queue from Maintain/React/Deliver

The pool is a query, not a state: needs a human and nobody holds it.
Retires the Escalate-to-Agenda routes, which hid work from the team."
```

---

### Task 3: The morning sweep

**Files:**
- Modify: `swarm/src/work-items.ts` (new helper), `swarm/src/users.ts` (`User`), `swarm/src/server.ts:517-532`
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: `setStepState` from Task 1.
- Produces: `User.agendaSweptDay?: string`, `sweepUserAgenda(boards, userId, now): WorkBoard[]`.

- [ ] **Step 1: Write the failing tests**

```ts
test("sweepUserAgenda reverts today to plate without releasing the card", () => {
  const d = createBoard("deliver", "ws");
  const r = createBoard("reactive", "ws");
  const mine = addCard(d, { title: "mine", columnId: "review" });
  const alsoMine = addCard(r, { title: "also mine", columnId: "triage" });
  const hers = addCard(d, { title: "hers", columnId: "review" });
  grabCard(mine, "edwin", "2026-08-12T09:00:00.000Z");
  setStepState(mine, "edwin", "today", "2026-08-12T09:00:00.000Z");
  grabCard(alsoMine, "edwin", "2026-08-12T09:00:00.000Z");
  grabCard(hers, "ana", "2026-08-12T09:00:00.000Z");
  setStepState(hers, "ana", "today", "2026-08-12T09:00:00.000Z");

  const dirty = sweepUserAgenda([d, r], "edwin", "2026-08-13T00:00:00.000Z");

  assert.deepEqual(dirty.map((b) => b.id), [d.id]);
  assert.equal(mine.agenda?.state, "plate");
  assert.equal(mine.agenda?.by, "edwin", "grabbing outlives the day");
  assert.equal(mine.agenda?.since, "2026-08-13T00:00:00.000Z");
  assert.equal(
    mine.agenda?.grabbedAt,
    "2026-08-12T09:00:00.000Z",
    "age survives the sweep — a card worked yesterday must not look brand new today",
  );
  assert.equal(alsoMine.agenda?.since, "2026-08-12T09:00:00.000Z", "already plate, untouched");
  assert.equal(hers.agenda?.state, "today", "another user's day is not swept");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='sweepUserAgenda' src/work-items.test.ts
```
Expected: FAIL — `sweepUserAgenda is not a function`.

- [ ] **Step 3: Add the helper**

After `sweepPersonalBoard` in `swarm/src/work-items.ts`:

```ts
/**
 * Day rollover for the step axis: everything this user claimed for today reverts to
 * their plate, so each morning starts from one honest list and they re-declare what
 * they are actually working on.
 *
 * It never RELEASES: grabbing is a commitment that outlives the day, picking something
 * for today is not. Pure — the caller owns load, save, the clock, and the
 * agendaSweptDay stamp, which lives on the user because the sweep is per-user.
 * Returns the boards that changed.
 */
export function sweepUserAgenda(boards: WorkBoard[], userId: string, now: string): WorkBoard[] {
  const dirty: WorkBoard[] = [];
  for (const board of boards) {
    let changed = false;
    for (const card of board.cards) {
      // Personal todos have no holder — their columnId IS their lane, so the same
      // daily reset applies by column. This is what sweepPersonalBoard used to do,
      // in the new vocabulary; keeping two sweeps would mean two vocabularies.
      if (board.type === "personal") {
        if (card.columnId !== "today") continue;
        card.columnId = "plate";
        card.updatedAt = now;
        changed = true;
        continue;
      }
      if (card.agenda?.by !== userId || card.agenda.state !== "today") continue;
      setStepState(card, userId, "plate", now);
      changed = true;
    }
    if (changed) {
      if (board.type === "personal") renumber(board, "plate");
      dirty.push(board);
    }
  }
  return dirty;
}
```

**Retire `sweepPersonalBoard`.** Delete the function, its export, and its tests. It rolls `todo`/`doing` into `queue` — three columns the personal board no longer has after Task 2's migration — so leaving it in place is dead code that would silently corrupt lanes if ever called. Remove its import and call from `server.ts`'s `scheduleMidnightSweep` (Step 6 below already rewrites that block). `WorkBoard.sweptDay` stays on the type for older board files but is no longer written; note that in its doc comment.

- [ ] **Step 4: Add the per-user stamp**

In `swarm/src/users.ts`, add to `User`:

```ts
  /** Local YYYY-MM-DD of this user's last agenda sweep. Per-user because the sweep is
      per-user; WorkBoard.sweptDay still governs the personal board's own cards. */
  agendaSweptDay?: string;
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='sweepUserAgenda' src/work-items.test.ts
```
Expected: PASS.

- [ ] **Step 6: Wire it into the existing midnight timer**

In `swarm/src/server.ts`, extend `scheduleMidnightSweep`'s `try` block so both sweeps fire in one firing. Add `sweepUserAgenda`, `loadUsersFromDir`, `resolveCurrentUser`, and `saveUser` to the imports as needed:

```ts
      try {
        const today = localDayStamp(new Date());
        const now = new Date().toISOString();
        const { boards } = await loadBoards(this.workDir());
        const dir = resolve(process.cwd(), ".smith/users");
        const user = resolveCurrentUser(await loadUsersFromDir(dir));
        if (user && user.agendaSweptDay !== today) {
          for (const board of sweepUserAgenda(boards, user.id, now)) {
            await saveBoard(this.workDir(), board);
          }
          await saveUser(dir, { ...user, agendaSweptDay: today });
          this.app.log.info(`Swept agenda for ${user.id}`);
        }
      } catch (err) {
```

- [ ] **Step 7: Typecheck, suite, commit**

```bash
pnpm typecheck && pnpm test 2>&1 | tail -20
```
Expected: clean; `fail 0`. Typecheck is the only thing that catches a missing `server.ts` import, since no unit test boots the server.

```bash
git add swarm/src/work-items.ts swarm/src/work-items.test.ts swarm/src/users.ts swarm/src/server.ts
git commit -m "feat(swarm): morning sweep returns today to plate

Grabbing outlives the day; claiming it for today does not. Cron-only,
per the 2026-08-11 ruling."
```

---

### Task 4: Routes and the Jira comment push

**Files:**
- Modify: `swarm/src/jira-sync.ts` (new `commentIssue`), `swarm/src/server.ts:2628-2760` (card PATCH)
- Test: `swarm/src/server.test.ts`, `swarm/src/jira-sync.test.ts`

**Interfaces:**
- Consumes: `grabCard`, `releaseCard`, `setStepState` from Task 1.
- Produces: `commentIssue(siteUrl, email, apiToken, key, text, fetchImpl?): Promise<void>`; `PATCH /work/boards/:id/cards/:cardId` accepts `agenda?: { action: "grab" } | { state: StepState; intent?: string } | null`; `buildCardAgendaPatch(card, userId, patch, now): void`.

- [ ] **Step 1: Write the failing tests**

Add to `swarm/src/server.test.ts`, following that file's existing style for the other exported `build*` helpers:

```ts
test("buildCardAgendaPatch: grab claims, state flips, null releases", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  buildCardAgendaPatch(c, "edwin", { action: "grab" }, "2026-08-13T10:00:00.000Z");
  assert.equal(c.agenda?.by, "edwin");
  buildCardAgendaPatch(c, "edwin", { state: "today" }, "2026-08-13T11:00:00.000Z");
  assert.equal(c.agenda?.state, "today");
  buildCardAgendaPatch(c, "edwin", null, "2026-08-13T12:00:00.000Z");
  assert.equal(c.agenda, undefined);
});

test("buildCardAgendaPatch refuses to flip a card held by someone else", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  buildCardAgendaPatch(c, "ana", { action: "grab" }, "2026-08-13T10:00:00.000Z");
  assert.throws(
    () => buildCardAgendaPatch(c, "edwin", { state: "today" }, "2026-08-13T11:00:00.000Z"),
    /not held by/,
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='buildCardAgendaPatch' src/server.test.ts
```
Expected: FAIL — `buildCardAgendaPatch is not a function`.

- [ ] **Step 3: Add the helper**

In `swarm/src/server.ts`, beside `buildVoiceUpdate` / `buildUserUpdate`:

```ts
/**
 * The step-axis half of the card PATCH. Kept out of patchCard because patchCard is pure
 * over the board and knows nothing about who is asking — the current user is a
 * request-scoped fact. `null` releases; the errors thrown by the helpers below become
 * 400s so a lost grab race surfaces instead of silently overwriting.
 */
export function buildCardAgendaPatch(
  card: WorkCard,
  userId: string,
  patch: { action: "grab" } | { state: StepState; intent?: string } | null,
  now: string,
): void {
  if (patch === null) return releaseCard(card);
  if ("action" in patch) return grabCard(card, userId, now);
  setStepState(card, userId, patch.state, now, patch.intent);
}
```

- [ ] **Step 4: Wire it into the route**

After the existing `const card = patchCard(board, req.params.cardId, ...)` call in the card PATCH handler:

```ts
      const body = req.body as { agenda?: { action: "grab" } | { state: StepState } | null };
      if (body.agenda !== undefined) {
        const user = resolveCurrentUser(await loadUsersFromDir(resolve(process.cwd(), ".smith/users")));
        if (user) {
          try {
            buildCardAgendaPatch(card, user.id, body.agenda, new Date().toISOString());
          } catch (err) {
            return reply.status(400).send({ error: (err as Error).message });
          }
        }
      }
```

Do **not** add `agenda` to `patchCard`'s `Pick<>` — a column move and a step-state write must never land in one call, or invariant 1 breaks.

- [ ] **Step 5: Add `commentIssue` to jira-sync**

Write the failing test first, in `swarm/src/jira-sync.test.ts`, following that file's existing `fetchImpl` stub style:

```ts
test("commentIssue posts an ADF document, not a bare string", async () => {
  let sent: { url: string; body: unknown } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent = { url: String(url), body: JSON.parse(String(init.body)) };
    return { ok: true, status: 201, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;

  await commentIssue("https://x.atlassian.net", "e@x.com", "tok", "P-1", "chasing the flaky suite", fetchImpl);

  assert.equal(sent!.url, "https://x.atlassian.net/rest/api/3/issue/P-1/comment");
  assert.deepEqual(sent!.body, {
    body: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "chasing the flaky suite" }] }],
    },
  });
});

test("commentIssue throws on a non-ok response", async () => {
  const fetchImpl = (async () => ({ ok: false, status: 403 }) as Response) as unknown as typeof fetch;
  await assert.rejects(
    () => commentIssue("https://x.atlassian.net", "e@x.com", "tok", "P-1", "hi", fetchImpl),
    /Jira comment failed: 403/,
  );
});
```

Run it (expect FAIL, `commentIssue is not a function`), then implement in `swarm/src/jira-sync.ts` beside `transitionIssue`:

```ts
/**
 * Post a plain-text comment. Jira v3 comment bodies are ADF documents, not strings —
 * sending a string is accepted by the type system and rejected by the API, so the text
 * is wrapped in the minimal doc → paragraph → text shape here rather than at call sites.
 */
export async function commentIssue(
  siteUrl: string,
  email: string,
  apiToken: string,
  key: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = siteUrl.replace(/\/$/, "");
  const res = await fetchImpl(`${base}/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
    method: "POST",
    headers: { authorization: auth(email, apiToken), "content-type": "application/json" },
    body: JSON.stringify({
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    }),
  });
  if (!res.ok) throw new Error(`Jira comment failed: ${res.status}`);
}
```

- [ ] **Step 6: Push the intent as a comment**

In the card PATCH handler, after `buildCardAgendaPatch` succeeds, mirror the existing push-on-move block (`server.ts:2684`) — read it first and follow its credential resolution and error handling exactly:

```ts
        const appended = card.intents?.at(-1);
        if (appended && appended.at === /* the `now` passed above */ stampedNow && card.jira && board.jira) {
          try {
            await commentIssue(
              board.jira.siteUrl,
              /* email + token resolved exactly as the transition push does */,
              card.jira.key,
              `${user.name} · ${appended.kind === "done" ? "done" : "started"}: ${appended.text}`,
            );
            card.jira.lastPushError = undefined;
          } catch (err) {
            // Best-effort, same contract as the transition push: a Jira outage must
            // never cost the operator their local claim.
            card.jira.lastPushError = String((err as Error).message);
          }
        }
```

Capture `now` in a local (`stampedNow`) when calling `buildCardAgendaPatch` so this block can tell a freshly appended intent from an older one — comparing against `new Date()` again would be a different instant.

The same push must also fire for a **closing** comment, which arrives through the ordinary card PATCH rather than the agenda one. Since both paths end by appending to `card.intents`, hoist this into one helper called after either write — comparing the last entry's identity rather than duplicating the block. The route resolves `close.by` from the current user; a client-supplied `by` must never be trusted.

- [ ] **Step 7: Run the tests, typecheck, full suite, commit**

```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='buildCardAgendaPatch' src/server.test.ts
pnpm typecheck && pnpm test 2>&1 | tail -20
```

```bash
git add swarm/src/server.ts swarm/src/server.test.ts swarm/src/jira-sync.ts swarm/src/jira-sync.test.ts
git commit -m "feat(swarm): grab, step-state, release + intent comments to Jira

A lost grab race 400s rather than silently overwriting the holder.
Claiming a card for today posts the stated intent as a Jira comment,
best-effort like the existing push-on-move."
```

---

### Task 5: Control-plane types, the pool, and the lanes

**Files:**
- Modify: `control-plane/src/organisms/BoardStage.tsx:32-55`, `control-plane/src/lib/board-aggregate.ts:104-123`
- Test: `control-plane/src/lib/board-aggregate.test.ts`

**Interfaces:**
- Produces: `WorkCardT.agenda`, `WorkColumn.gatesHuman`, `StepStateT`, `sharedQueueCards(boards): AggCard[]`, `collectAgendaCards(boards, userId, laneId): AggCard[]`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("agenda lanes", () => {
  const personal = {
    id: "personal", name: "Agenda", type: "personal" as const,
    columns: [{ id: "plate", name: "My plate" }],
    cards: [
      { id: "p1", title: "call bank", columnId: "plate", order: 1 },
      { id: "p0", title: "pay invoice", columnId: "plate", order: 0 },
    ],
  };
  const deliver = {
    id: "ws-deliver", name: "Deliver", type: "deliver" as const, workspaceId: "ws",
    columns: [{ id: "review", name: "Review", gatesHuman: true }],
    cards: [
      { id: "pool", title: "unheld", columnId: "review", order: 0 },
      { id: "t-old", title: "older", columnId: "review", order: 1,
        agenda: { by: "edwin", state: "plate" as const, since: "2026-08-13T08:00:00.000Z",
                  grabbedAt: "2026-08-13T08:00:00.000Z" } },
      { id: "t-new", title: "newer", columnId: "review", order: 2,
        agenda: { by: "edwin", state: "plate" as const, since: "2026-08-13T12:00:00.000Z",
                  grabbedAt: "2026-08-13T12:00:00.000Z" } },
      { id: "t-hers", title: "ana's", columnId: "review", order: 3,
        agenda: { by: "ana", state: "plate" as const, since: "2026-08-13T08:00:00.000Z",
                  grabbedAt: "2026-08-13T08:00:00.000Z" } },
    ],
  };

  it("pools only unheld cards from source boards", () => {
    expect(sharedQueueCards([personal, deliver]).map((c) => c.id)).toEqual(["pool"]);
  });

  it("puts personal cards first by order, then team cards by grabbedAt", () => {
    expect(collectAgendaCards([personal, deliver], "edwin", "plate").map((c) => c.id))
      .toEqual(["p0", "p1", "t-old", "t-new"]);
  });

  it("orders by grabbedAt, not since — a swept card must not jump to the front", () => {
    const swept = {
      ...deliver,
      cards: [
        { id: "held-longest", title: "held longest", columnId: "review", order: 0,
          agenda: { by: "edwin", state: "plate" as const,
                    since: "2026-08-14T00:00:00.000Z",   // re-stamped by this morning's sweep
                    grabbedAt: "2026-08-01T09:00:00.000Z" } },
        { id: "grabbed-today", title: "grabbed today", columnId: "review", order: 1,
          agenda: { by: "edwin", state: "plate" as const,
                    since: "2026-08-13T09:00:00.000Z",
                    grabbedAt: "2026-08-13T09:00:00.000Z" } },
      ],
    };
    expect(collectAgendaCards([swept], "edwin", "plate").map((c) => c.id))
      .toEqual(["held-longest", "grabbed-today"]);
  });

  it("excludes other holders", () => {
    expect(collectAgendaCards([personal, deliver], "edwin", "plate").map((c) => c.id))
      .not.toContain("t-hers");
  });

  it("never matches team cards in a lane that is not a step state", () => {
    const withDone = { ...personal, cards: [{ id: "p-done", title: "done", columnId: "done", order: 0 }] };
    expect(collectAgendaCards([withDone, deliver], "edwin", "done").map((c) => c.id)).toEqual(["p-done"]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

From `control-plane/`:
```bash
pnpm vitest run src/lib/board-aggregate.test.ts
```
Expected: FAIL — `sharedQueueCards is not a function`.

- [ ] **Step 3: Extend the types**

In `BoardStage.tsx`, add `gatesHuman?: boolean;` to `WorkColumn`, and to `WorkCardT` after `flag?`:

```ts
  /** Who holds this card's current step — orthogonal to columnId. */
  agenda?: { by: string; state: "plate" | "today"; since: string; grabbedAt: string };
  intents?: Array<{ at: string; by: string; text: string }>;
```

- [ ] **Step 4: Add the two collectors**

After `collectCards` in `board-aggregate.ts`:

```ts
export type StepStateT = "plate" | "today";

const STEP_LANES: string[] = ["plate", "today"];
const SOURCE_TYPES: BoardTypeT[] = ["maintenance", "reactive", "deliver"];

/** Mirrors the swarm's `sharedQueue`: needs a human, nobody holds it, no agent mid-flight. */
export function sharedQueueCards(boards: WorkBoardT[]): AggCard[] {
  const out: AggCard[] = [];
  for (const b of boards) {
    if (!SOURCE_TYPES.includes(b.type)) continue;
    for (const c of b.cards) {
      if (c.agenda || c.delegation?.state === "working") continue;
      const gated = b.columns.find((col) => col.id === c.columnId)?.gatesHuman === true;
      const handedBack = c.delegation?.state === "completed" || c.delegation?.state === "failed";
      if (gated || handedBack || c.flag || c.jira?.lastPushError) {
        out.push({ ...c, boardId: b.id, workspaceId: b.workspaceId });
      }
    }
  }
  return out.sort((a, b) => (a.flag?.since ?? a.updatedAt ?? "").localeCompare(b.flag?.since ?? b.updatedAt ?? ""));
}

/**
 * One Agenda lane. Two card kinds share it and order differently, deliberately:
 * personal cards have no workflow axis, so their columnId IS the lane and their drag
 * `order` still means something — they come first. Team cards are matched on the
 * holder's step state and ordered by `since`, oldest first, because `order` is
 * per-column-per-board and cannot order a lane that spans boards.
 *
 * Team cards order by `grabbedAt`, NOT `since`: the morning sweep re-stamps `since` on
 * everything it reverts, so sorting by it would reshuffle the lane every midnight and
 * make the work you touched yesterday look newest. `grabbedAt` is the stable age.
 */
export function collectAgendaCards(boards: WorkBoardT[], userId: string, laneId: string): AggCard[] {
  const personal: AggCard[] = [];
  const team: Array<{ card: AggCard; grabbedAt: string }> = [];
  for (const b of boards) {
    for (const c of b.cards) {
      const tagged: AggCard = { ...c, boardId: b.id, workspaceId: b.workspaceId };
      if (b.type === "personal") {
        if (c.columnId === laneId) personal.push(tagged);
        continue;
      }
      if (!STEP_LANES.includes(laneId)) continue;
      if (c.agenda?.by === userId && c.agenda.state === laneId) {
        team.push({ card: tagged, grabbedAt: c.agenda.grabbedAt });
      }
    }
  }
  personal.sort((a, b) => a.order - b.order);
  team.sort((a, b) => a.grabbedAt.localeCompare(b.grabbedAt));
  return [...personal, ...team.map((t) => t.card)];
}
```

- [ ] **Step 5: Run, lint, commit**

```bash
pnpm vitest run src/lib/board-aggregate.test.ts
pnpm biome check src/lib/board-aggregate.ts src/organisms/BoardStage.tsx
```
Expected: PASS; zero diagnostics.

```bash
git add control-plane/src/lib/board-aggregate.ts control-plane/src/lib/board-aggregate.test.ts control-plane/src/organisms/BoardStage.tsx
git commit -m "feat(cp): derived shared queue + per-user agenda lanes"
```

---

### Task 6: The Agenda tab — four lanes, grab, and the drag branch

**Files:**
- Modify: `control-plane/src/lib/board-aggregate.ts:68-95` (`tabsFor`), `control-plane/src/organisms/BoardStage.tsx:284-333`, `control-plane/src/queries/work.ts`, `control-plane/src/api/work.ts`
- Test: `control-plane/src/lib/board-aggregate.test.ts`, `control-plane/src/organisms/BoardStage.test.tsx`

**Interfaces:**
- Consumes: Task 5's collectors, Task 4's route.
- Produces: `useCardAgenda()` mutation; the Agenda tab rendering four lanes.

- [ ] **Step 1: Write the failing tests**

```ts
it("the Agenda tab spans every board — holders live on their home boards", () => {
  const boards = [
    { id: "personal", name: "Agenda", type: "personal" as const, columns: [], cards: [] },
    { id: "ws-deliver", name: "Deliver", type: "deliver" as const, workspaceId: "ws", columns: [], cards: [] },
  ];
  expect(tabsFor(boards, new Set(["ws"])).find((t) => t.type === "personal")?.boardIds)
    .toEqual(["personal", "ws-deliver"]);
});
```

In `BoardStage.test.tsx`, following the file's existing render/stub helpers:

```ts
it("grab sends the grab action and no columnId", async () => {
  // render Agenda, press Grab on a shared-queue card
  expect(lastPatchBody()).toEqual({ agenda: { action: "grab" } });
});

it("dragging a TEAM card to plate patches the step state only", async () => {
  expect(lastPatchBody()).toEqual({ agenda: { state: "plate" } });
  expect(lastPatchBody()).not.toHaveProperty("columnId");
});

it("dropping into Today asks what you are doing before writing anything", async () => {
  // drag a card from My plate onto Today
  expect(await screen.findByLabelText(/what are you doing/i)).toBeDefined();
  expect(patchCalls()).toHaveLength(0);
});

it("cancelling the intent composer leaves the card where it was", async () => {
  // drag onto Today, then press Cancel
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
  expect(patchCalls()).toHaveLength(0);
});

it("submitting the intent sends it with the state", async () => {
  fireEvent.change(screen.getByLabelText(/what are you doing/i), {
    target: { value: "chasing the flaky suite" },
  });
  fireEvent.click(screen.getByRole("button", { name: /start/i }));
  await waitFor(() =>
    expect(lastPatchBody()).toEqual({ agenda: { state: "today", intent: "chasing the flaky suite" } }),
  );
});

it("advancing a HELD card on the team board asks what you did before moving it", async () => {
  // on the Deliver tab, drag a held card from Review to Verify
  expect(await screen.findByLabelText(/what did you do/i)).toBeDefined();
  expect(patchCalls()).toHaveLength(0);
});

it("advancing an UNHELD card on the team board moves it straight away", async () => {
  await waitFor(() => expect(lastPatchBody()).toEqual({ columnId: "verify", order: 0 }));
  expect(screen.queryByLabelText(/what did you do/i)).toBeNull();
});

it("submitting the close sends the move and the comment in one body", async () => {
  fireEvent.change(screen.getByLabelText(/what did you do/i), {
    target: { value: "it was the 20s ceiling" },
  });
  fireEvent.click(screen.getByRole("button", { name: /done/i }));
  await waitFor(() =>
    expect(lastPatchBody()).toEqual({
      columnId: "verify",
      order: 0,
      close: { text: "it was the 20s ceiling" },
    }),
  );
});

it("dragging a PERSONAL card patches columnId only", async () => {
  expect(lastPatchBody()).toHaveProperty("columnId");
  expect(lastPatchBody()).not.toHaveProperty("agenda");
});
```

Both drag directions are required — with only one, the branch can collapse to a single path and still pass.

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm vitest run src/lib/board-aggregate.test.ts src/organisms/BoardStage.test.tsx
```

- [ ] **Step 3: Widen the Agenda tab**

In `tabsFor`, replace `boardIds: [personal.id]` and correct the stale comment above it:

```ts
      // Holders live on the cards' HOME boards, so Agenda reads from all of them. It
      // stays context-invariant — your plate is your plate regardless of the workspace
      // filter — which is why this ignores `scope`.
      boardIds: boards.map((b) => b.id),
```

- [ ] **Step 4: Add the mutation**

In `queries/work.ts`, after `useMoveCard`:

```ts
/** Grab / release / flip the caller's step state. Never sends columnId — see invariant 1. */
export function useCardAgenda() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      boardId, cardId, agenda,
    }: {
      boardId: string;
      cardId: string;
      agenda: { action: "grab" } | { state: "plate" | "today"; intent?: string } | null;
    }) => api.patchCard(boardId, cardId, { agenda }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boards }),
  });
}
```

Widen `api.patchCard`'s body type in `api/work.ts` to accept **both** new fields at once — the step-axis write and the closing comment:

```ts
  agenda?: { action: "grab" } | { state: "plate" | "today"; intent?: string } | null;
  close?: { text: string };
```

`intent` must be on that union member or the mutation above cannot send it. `close` rides on the ordinary card PATCH (with `columnId`/`order`), not on `agenda` — see the closing-composer step below. The route fills in `close.by` from the current user; the client never sends it.

- [ ] **Step 5: Render four lanes and branch the drag**

The Agenda tab renders **five** lanes: **Shared queue · My plate · Today · Done · Not Doing**. Shared queue is fed by `sharedQueueCards(boards)`; the other four by `collectAgendaCards(boards, me.id, laneId)`. Team cards can only ever occupy Shared queue, My plate and Today — `Done` and `Not Doing` are personal-only, because a team card's "done" is advancing it on its own board. Shared-queue cards are not draggable — each carries a **Grab** button calling `useCardAgenda` with `{ action: "grab" }`.

In `handleDragEnd`:

```ts
    const source = boards.find((b) => b.id === outcome.boardId);
    if (tab?.type === "personal" && source && source.type !== "personal") {
      if (outcome.columnId !== "plate" && outcome.columnId !== "today") return;
      if (outcome.columnId === "today") {
        // Claiming a day needs a sentence. Nothing is written until it is submitted —
        // no optimistic move, no PATCH — so cancelling leaves the card exactly where it
        // was. This is the one drop in the app that a drag alone cannot complete.
        setPendingIntent({ boardId: outcome.boardId, cardId });
        return;
      }
      void cardAgendaMutation.mutateAsync({
        boardId: outcome.boardId,
        cardId,
        agenda: { state: "plate" },
      });
      return;
    }
    void applyMove(outcome.boardId, cardId, outcome.columnId, outcome.order);
```

`pendingIntent` is `useState<{ boardId: string; cardId: string } | null>(null)`. While set, the target card renders the composer instead of its normal face. Submitting fires:

```ts
    void cardAgendaMutation
      .mutateAsync({ boardId, cardId, agenda: { state: "today", intent: text } })
      .then(() => setPendingIntent(null));
```

Cancelling just calls `setPendingIntent(null)` — no network call at all.

**The closing composer.** The same gate guards finishing, and it fires on the *team board* too, not only on Agenda. Before `applyMove`, intercept:

```ts
    const moving = source?.cards.find((c) => c.id === cardId);
    const changingColumn = moving && moving.columnId !== outcome.columnId;
    const endsHeldStep = changingColumn && Boolean(moving?.agenda);
    const personalDone = changingColumn && source?.type === "personal" && outcome.columnId === "done";
    if (endsHeldStep || personalDone) {
      // Mirrors the server guard in patchCard. Asking here is a courtesy — the
      // server refuses the move regardless, which is what makes the rule real.
      setPendingClose({ boardId: outcome.boardId, cardId, columnId: outcome.columnId, order: outcome.order });
      return;
    }
    void applyMove(outcome.boardId, cardId, outcome.columnId, outcome.order);
```

Submitting sends the ordinary card PATCH with the move *and* the comment in one body — `{ columnId, order, close: { text } }` — so the server applies both atomically or neither. `applyMove`'s optimistic write must not run until that resolves, since a rejected close would otherwise leave the UI showing a move the server refused.

Widen `api.patchCard`'s body type with `close?: { text: string }`. The route fills in `by` from the current user; the client never sends it.

- [ ] **Step 6: Run, lint, commit**

```bash
pnpm vitest run src/lib/board-aggregate.test.ts src/organisms/BoardStage.test.tsx
pnpm biome check src/lib/board-aggregate.ts src/organisms/BoardStage.tsx src/queries/work.ts src/api/work.ts
```

```bash
git add control-plane/src/lib/board-aggregate.ts control-plane/src/lib/board-aggregate.test.ts control-plane/src/organisms/BoardStage.tsx control-plane/src/organisms/BoardStage.test.tsx control-plane/src/queries/work.ts control-plane/src/api/work.ts
git commit -m "feat(cp): Agenda pull queue — shared lane, grab, drag branch"
```

---

### Task 7: Holder chips and provenance badges

**Files:**
- Modify: `control-plane/src/molecules/BoardCard.tsx:15-60`, `control-plane/src/molecules/BoardColumn.tsx:85-95`, `control-plane/src/styles/components.css`
- Test: `control-plane/src/molecules/BoardCard.test.tsx`

**Interfaces:**
- Consumes: `WorkCardT.agenda`; `useMe()` from `queries/http.ts`, returning `MeRecord { id, name, connectors }`.
- Produces: `BoardCard` props `holder?: { name: string; state: "plate" | "today" }`, `provenance?: string`, `onGrab?: () => void`.

- [ ] **Step 1: Write the failing tests**

```ts
it("renders the holder chip with their step state", () => {
  render(<BoardCard card={{ id: "c1", title: "auth", columnId: "review", order: 0 }}
    holder={{ name: "Edwin", state: "today" }} onOpen={() => {}} />);
  expect(screen.getByText("Edwin · today")).toBeDefined();
});

it("renders no holder chrome when nobody holds it", () => {
  const { container } = render(
    <BoardCard card={{ id: "c1", title: "auth", columnId: "review", order: 0 }} onOpen={() => {}} />);
  expect(container.querySelector(".board-card__holder")).toBeNull();
});

it("shows Grab only when onGrab is given", () => {
  const onGrab = vi.fn();
  const { rerender } = render(
    <BoardCard card={{ id: "c1", title: "auth", columnId: "review", order: 0 }} onGrab={onGrab} onOpen={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /grab/i }));
  expect(onGrab).toHaveBeenCalled();
  rerender(<BoardCard card={{ id: "c1", title: "auth", columnId: "review", order: 0 }} onOpen={() => {}} />);
  expect(screen.queryByRole("button", { name: /grab/i })).toBeNull();
});

it("renders the provenance badge when given", () => {
  render(<BoardCard card={{ id: "c1", title: "auth", columnId: "review", order: 0 }}
    provenance="Deliver · review" onOpen={() => {}} />);
  expect(screen.getByText("Deliver · review")).toBeDefined();
});

it("shows the stated intent under the title, and nothing when there is none", () => {
  const card = { id: "c1", title: "auth", columnId: "review", order: 0 };
  const { rerender, container } = render(
    <BoardCard card={card} intent="chasing the flaky suite" onOpen={() => {}} />);
  expect(screen.getByText("chasing the flaky suite")).toBeDefined();
  rerender(<BoardCard card={card} onOpen={() => {}} />);
  expect(container.querySelector(".board-card__intent")).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm vitest run src/molecules/BoardCard.test.tsx
```

- [ ] **Step 3: Add the props**

Extend `BoardCardProps`:

```ts
  /** Who holds this card's current step. Rendered on team boards. */
  holder?: { name: string; state: "plate" | "today" };
  /** "Deliver · review" — the workflow axis, shown when this card appears on Agenda. */
  provenance?: string;
  /** Present only for shared-queue cards; renders the Grab control. */
  onGrab?: () => void;
  /** The holder's latest stated intent. Shown under the title in the Today lane, so the
      lane reads as a list of commitments rather than a list of titles. */
  intent?: string;
  /** How long this has been on the holder's plate, pre-formatted ("5d"). Derived from
      `agenda.grabbedAt` — never from `since`, which the morning sweep re-stamps. */
  age?: string;
```

Reuse the existing `flagAge(since, now)` helper at `BoardCard.tsx:10` for the formatting rather than writing a second duration formatter — it already produces the "2d" shape the flag chip uses.

Render beside the existing `card.flag` chip, following its markup shape:

```tsx
        {provenance && <span className="board-card__provenance">{provenance}</span>}
        {holder && <span className={`board-card__holder is-${holder.state}`}>{holder.name} · {holder.state}</span>}
        {onGrab && (
          <button type="button" className="board-card__grab" onClick={(e) => { e.stopPropagation(); onGrab(); }}>
            Grab
          </button>
        )}
```

`stopPropagation` matters — `BoardCard` is itself a button that opens the card sheet.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm vitest run src/molecules/BoardCard.test.tsx
```

- [ ] **Step 5: Feed the props from BoardColumn**

`BoardColumn` already passes `agent={agentFor(card.delegation?.agentId)}` per card. Add `holder={holderFor(card)}`, `provenance={provenanceFor(card)}` and `onGrab={onGrabFor(card)}`, all resolved in `BoardStage`, which owns the board list and `useMe()`. `holderFor` maps `card.agenda` to `{ name, state }`, resolving `by` as `me.id === by ? me.name : by` — v1 has one user, so an unknown id falls back to the raw id rather than inventing a directory. `provenanceFor` returns undefined unless the active tab is Agenda and the card's board is not personal. `onGrabFor` is defined only for cards in the shared-queue lane.

- [ ] **Step 6: Styles**

In `components.css`, beside `.board-card__flag`, add `.board-card__provenance`, `.board-card__holder` with `.is-plate` / `.is-today` variants, and `.board-card__grab`. Use existing tokens — no raw colors, and `--card-tint` must be mixed, never raw.

- [ ] **Step 7: Full suite three times, lint, commit**

```bash
for i in 1 2 3; do pnpm vitest run 2>&1 | tail -3; done
pnpm biome check src/molecules/BoardCard.tsx src/molecules/BoardColumn.tsx src/organisms/BoardStage.tsx src/styles/components.css
```
Expected: three green runs. The suite was stabilized at `c90d43e`; a new intermittent failure is real and must be investigated, not re-run away.

```bash
git add control-plane/src/molecules/BoardCard.tsx control-plane/src/molecules/BoardCard.test.tsx control-plane/src/molecules/BoardColumn.tsx control-plane/src/organisms/BoardStage.tsx control-plane/src/styles/components.css
git commit -m "feat(cp): holder chips, provenance badges, grab control"
```

---

## Final verification

- [ ] Restart the swarm — a stale `tsx` process serves its boot-time module graph and will silently drop `agenda`:
  ```bash
  tmux send-keys -t smith-swarm C-c && tmux send-keys -t smith-swarm "pnpm serve" Enter
  curl -s --retry 20 --retry-connrefused http://127.0.0.1:7777/work/boards | head -c 200
  ```
- [ ] Smoke at `http://localhost:1420`: put a card in Deliver/Review, confirm it appears in Agenda's **Shared queue**, press Grab, confirm it moves to **My plate** and vanishes from the shared lane, drag it to **Today**, confirm the composer appears and that **cancelling writes nothing**, then submit an intent and confirm the Deliver board still shows it in Review with an "Edwin · today" chip and the intent under the title.
- [ ] On the **Deliver** board, drag that held card from Review to Verify: confirm the closing composer appears, that cancelling writes nothing, and that submitting moves the card and clears the holder chip in one step. Then repeat with an **unheld** card and confirm it moves with no prompt at all.
- [ ] Drop a personal todo into **Done** and confirm it asks what you did; confirm moving that same todo between other lanes does not.
- [ ] Release a card and confirm it returns to the shared queue.
- [ ] On a Jira-linked card, submit an intent and confirm the comment lands on the issue. If the push fails, confirm the local claim still succeeded and `lastPushError` is set — a Jira outage must never cost the operator their claim.
- [ ] Verify the sweep by hand: set `agendaSweptDay` to yesterday in `swarm/.smith/users/me.json`, restart, confirm `today` reverted to `plate` and nothing was released.
