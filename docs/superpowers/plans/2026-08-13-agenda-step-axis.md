# Agenda Pull Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each card a single-holder step axis orthogonal to its team column, and surface unheld work from Maintain/React/Deliver in a shared queue people pull from.

**Architecture:** One optional field on `WorkCard` — `agenda: {by, state, since}` — shaped after the existing `flag` axis. The shared queue is **derived, never stored**: a card is in the pool when it needs a human and nobody holds it. Advancing a card between columns clears the holder, because the step it described has ended.

**Tech Stack:** swarm = TypeScript + Fastify, tested with the node built-in test runner (`node --import tsx --test`) and `node:assert/strict`. control-plane = React + TanStack Query + dnd-kit, tested with vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-13-agenda-step-axis-design.md`

## Global Constraints

- **pnpm, never npm.** One workspace at the repo root; node >= 24; TypeScript ~6.0.0.
- **Biome 2.5.3 runs on `control-plane/` only** — swarm has no biome config. Control-plane lint baseline is **zero diagnostics**.
- **Swarm helpers stay pure.** No clock, filesystem, or current-user reads inside `work-items.ts` — the caller passes `now` and `userId`.
- **The shared queue is derived.** Never add a stored "queued" flag or a function that writes one.
- **`StepState` is exactly `"plate" | "today"`.** No `done` — finishing a step means advancing the card.
- **Sources are `maintenance`, `reactive`, `deliver`.** `release/sign-off` is deliberately excluded.
- Run swarm tests from `swarm/`, control-plane tests from `control-plane/`.

---

### Task 1: The step axis and its write helpers

**Files:**
- Modify: `swarm/src/work-items.ts:12-52` (types), `:481-529` (`patchCard`)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Produces: `type StepState = "plate" | "today"`, `WorkCard.agenda?: { by: string; state: StepState; since: string }`, `grabCard(card, userId, now): void`, `releaseCard(card): void`, `setStepState(card, userId, state, now): void`.

- [ ] **Step 1: Write the failing tests**

Add to `swarm/src/work-items.test.ts` (extend the existing import block from `./work-items.js` with `grabCard`, `releaseCard`, `setStepState`, `type StepState`):

```ts
test("grabCard claims an unheld card; grabbing a held one throws", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  assert.deepEqual(c.agenda, { by: "edwin", state: "plate", since: "2026-08-13T10:00:00.000Z" });
  assert.throws(() => grabCard(c, "ana", "2026-08-13T10:00:01.000Z"), /already held/);
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
  setStepState(c, "edwin", "today", "2026-08-13T12:00:00.000Z");
  assert.equal(c.agenda?.since, "2026-08-13T12:00:00.000Z");
  assert.throws(() => setStepState(c, "ana", "today", "2026-08-13T12:00:00.000Z"), /not held by/);
});

test("patchCard clears the holder on a column change, keeps it on a reorder", () => {
  const b = createBoard("deliver", "ws");
  const c = addCard(b, { title: "auth", columnId: "review" });
  addCard(b, { title: "other", columnId: "review" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  patchCard(b, c.id, { order: 1 });
  assert.ok(c.agenda, "a reorder is the same step");
  patchCard(b, c.id, { columnId: "verify", order: 0 });
  assert.equal(c.agenda, undefined, "the step ended");
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
  agenda?: { by: string; state: StepState; since: string };
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
  card.agenda = { by: userId, state: "plate", since: now };
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
 */
export function setStepState(card: WorkCard, userId: string, state: StepState, now: string): void {
  if (!STEP_STATES.includes(state)) throw new Error(`Unknown step state: ${state}`);
  if (!card.agenda) throw new Error("Card is not held — grab it first");
  if (card.agenda.by !== userId) throw new Error(`Card is not held by ${userId}`);
  if (card.agenda.state !== state) card.agenda.since = now;
  card.agenda.state = state;
}
```

- [ ] **Step 5: Clear the holder on a column change**

In `patchCard`, replace the line `if (fromColumn !== toColumn) renumber(board, fromColumn);` with:

```ts
    if (fromColumn !== toColumn) {
      renumber(board, fromColumn);
      // The step this described has ended, so its holder is void. Enforced here
      // rather than at call sites so no route can forget.
      card.agenda = undefined;
    }
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
      if (card.agenda?.by !== userId || card.agenda.state !== "today") continue;
      setStepState(card, userId, "plate", now);
      changed = true;
    }
    if (changed) dirty.push(board);
  }
  return dirty;
}
```

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
        const personal = boards.find((b) => b.type === "personal");
        if (personal && sweepPersonalBoard(personal, today)) {
          await saveBoard(this.workDir(), personal);
          this.app.log.info("Swept Active To-dos leftovers into Queue");
        }
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

### Task 4: Routes

**Files:**
- Modify: `swarm/src/server.ts:2628-2760` (card PATCH)
- Test: `swarm/src/server.test.ts`

**Interfaces:**
- Consumes: `grabCard`, `releaseCard`, `setStepState` from Task 1.
- Produces: `PATCH /work/boards/:id/cards/:cardId` accepts `agenda?: { action: "grab" } | { state: StepState } | null`; `buildCardAgendaPatch(card, userId, patch, now): void`.

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
  patch: { action: "grab" } | { state: StepState } | null,
  now: string,
): void {
  if (patch === null) return releaseCard(card);
  if ("action" in patch) return grabCard(card, userId, now);
  setStepState(card, userId, patch.state, now);
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

- [ ] **Step 5: Run the tests, typecheck, full suite, commit**

```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='buildCardAgendaPatch' src/server.test.ts
pnpm typecheck && pnpm test 2>&1 | tail -20
```

```bash
git add swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(swarm): card PATCH accepts grab, step-state and release

A lost grab race 400s rather than silently overwriting the holder."
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
        agenda: { by: "edwin", state: "plate" as const, since: "2026-08-13T08:00:00.000Z" } },
      { id: "t-new", title: "newer", columnId: "review", order: 2,
        agenda: { by: "edwin", state: "plate" as const, since: "2026-08-13T12:00:00.000Z" } },
      { id: "t-hers", title: "ana's", columnId: "review", order: 3,
        agenda: { by: "ana", state: "plate" as const, since: "2026-08-13T08:00:00.000Z" } },
    ],
  };

  it("pools only unheld cards from source boards", () => {
    expect(sharedQueueCards([personal, deliver]).map((c) => c.id)).toEqual(["pool"]);
  });

  it("puts personal cards first by order, then team cards by since", () => {
    expect(collectAgendaCards([personal, deliver], "edwin", "plate").map((c) => c.id))
      .toEqual(["p0", "p1", "t-old", "t-new"]);
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
  agenda?: { by: string; state: "plate" | "today"; since: string };
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
 */
export function collectAgendaCards(boards: WorkBoardT[], userId: string, laneId: string): AggCard[] {
  const personal: AggCard[] = [];
  const team: Array<{ card: AggCard; since: string }> = [];
  for (const b of boards) {
    for (const c of b.cards) {
      const tagged: AggCard = { ...c, boardId: b.id, workspaceId: b.workspaceId };
      if (b.type === "personal") {
        if (c.columnId === laneId) personal.push(tagged);
        continue;
      }
      if (!STEP_LANES.includes(laneId)) continue;
      if (c.agenda?.by === userId && c.agenda.state === laneId) team.push({ card: tagged, since: c.agenda.since });
    }
  }
  personal.sort((a, b) => a.order - b.order);
  team.sort((a, b) => a.since.localeCompare(b.since));
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

it("dragging a TEAM card between lanes patches the step state only", async () => {
  expect(lastPatchBody()).toEqual({ agenda: { state: "today" } });
  expect(lastPatchBody()).not.toHaveProperty("columnId");
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
      agenda: { action: "grab" } | { state: "plate" | "today" } | null;
    }) => api.patchCard(boardId, cardId, { agenda }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boards }),
  });
}
```

Widen `api.patchCard`'s body type in `api/work.ts` to accept `agenda?: { action: "grab" } | { state: "plate" | "today" } | null`.

- [ ] **Step 5: Render four lanes and branch the drag**

The Agenda tab renders **Shared queue · My plate · Today · Done**. Shared queue is fed by `sharedQueueCards(boards)`; the other three by `collectAgendaCards(boards, me.id, laneId)`. Shared-queue cards are not draggable — each carries a **Grab** button calling `useCardAgenda` with `{ action: "grab" }`.

In `handleDragEnd`:

```ts
    const source = boards.find((b) => b.id === outcome.boardId);
    if (tab?.type === "personal" && source && source.type !== "personal") {
      if (outcome.columnId !== "plate" && outcome.columnId !== "today") return;
      void cardAgendaMutation.mutateAsync({
        boardId: outcome.boardId,
        cardId,
        agenda: { state: outcome.columnId },
      });
      return;
    }
    void applyMove(outcome.boardId, cardId, outcome.columnId, outcome.order);
```

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
```

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
- [ ] Smoke at `http://localhost:1420`: put a card in Deliver/Review, confirm it appears in Agenda's **Shared queue**, press Grab, confirm it moves to **My plate** and vanishes from the shared lane, drag it to **Today**, and confirm the Deliver board still shows it in Review with an "Edwin · today" chip.
- [ ] Release it and confirm it returns to the shared queue.
- [ ] Verify the sweep by hand: set `agendaSweptDay` to yesterday in `swarm/.smith/users/me.json`, restart, confirm `today` reverted to `plate` and nothing was released.
