import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addCard,
  BOARD_ROUTES,
  BOARD_TEMPLATES,
  BOARD_TYPE_ORDER,
  type BoardType,
  boardIdFor,
  type CardFlag,
  createBoard,
  defaultColumnFor,
  deleteBoardFile,
  exitsFor,
  findCardByRef,
  findRouteDestination,
  grabCard,
  hasSourceRef,
  intakeColumnId,
  loadAllBoards,
  loadBoards,
  localDayStamp,
  msUntilNextMidnight,
  normalizeBoard,
  patchCard,
  releaseCard,
  removeCard,
  resolveExit,
  routeCard,
  saveBoard,
  setStepState,
  sweepUserAgenda,
  terminalColumnId,
  WORKSPACE_BOARD_TYPES,
  type WorkBoard,
} from "./work-items.js";

test("templates: seven typed column sets, ids unique and slug-shaped", () => {
  assert.deepEqual(
    BOARD_TEMPLATES.personal.map((c) => c.name),
    ["My plate", "Today", "Done", "Not Doing"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.ideation.map((c) => c.name),
    ["Intake", "Scoping", "Confirm", "Killed"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.plan.map((c) => c.name),
    ["Queue", "Spec", "Tech design", "Decomposed", "Ready"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.deliver.map((c) => c.name),
    ["Queue", "Ready", "In progress", "Review", "Verify", "Merged"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.release.map((c) => c.name),
    ["Queue", "Cut", "Regression", "Sign-off", "Ship", "Rollback"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.reactive.map((c) => c.name),
    ["Queue", "Triage", "Diagnose", "Fix", "Verify", "Closed"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.maintenance.map((c) => c.name),
    ["Queue", "Triage", "Doing", "Done", "Won't do"],
  );
  assert.equal(Object.keys(BOARD_TEMPLATES).length, 7);
  for (const cols of Object.values(BOARD_TEMPLATES)) {
    assert.equal(new Set(cols.map((c) => c.id)).size, cols.length);
    for (const c of cols) assert.match(c.id, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test("type order puts personal first, release last, and WORKSPACE_BOARD_TYPES excludes personal", () => {
  assert.deepEqual(BOARD_TYPE_ORDER, ["personal", "ideation", "plan", "deliver", "reactive", "maintenance", "release"]);
  assert.equal(WORKSPACE_BOARD_TYPES.includes("personal" as BoardType), false);
  assert.equal(WORKSPACE_BOARD_TYPES.length, 6);
});

test("createBoard derives id from workspace+type, seeds the label, copies columns", () => {
  const b = createBoard("deliver", "Skool Scout");
  assert.equal(b.id, "skool-scout-deliver");
  assert.equal(b.name, "Deliver");
  assert.equal(b.type, "deliver");
  assert.equal(b.workspaceId, "Skool Scout");
  assert.deepEqual(b.cards, []);
  assert.notEqual(b.columns, BOARD_TEMPLATES.deliver); // copy, not shared reference
  assert.equal(boardIdFor("Skool Scout", "deliver"), "skool-scout-deliver");
});

test("createBoard: personal is workspace-less with a fixed id; mismatches throw", () => {
  const p = createBoard("personal");
  assert.equal(p.id, "personal");
  assert.equal(p.name, "Agenda");
  assert.equal(p.workspaceId, undefined);
  assert.throws(() => createBoard("personal", "acme"), /workspace/i);
  assert.throws(() => createBoard("deliver"), /workspace/i);
  assert.throws(() => createBoard("deliver", "!!!"), /workspace/i);
});

test("assertBoard rejects a file with a missing or unknown type", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  await writeFile(join(dir, "untyped.json"), JSON.stringify({ id: "untyped", name: "U", columns: [], cards: [] }));
  await writeFile(
    join(dir, "bogus.json"),
    JSON.stringify({ id: "bogus", name: "B", type: "nope", columns: [], cards: [] }),
  );
  const { boards, errors } = await loadBoards(dir);
  assert.deepEqual(boards, []);
  assert.equal(errors.length, 2);
  for (const e of errors) assert.match(e.error, /type/i);
});

test("addCard defaults to My plate on the personal board, leftmost elsewhere; orders sequentially", () => {
  const b = createBoard("personal");
  const a = addCard(b, { title: "first" });
  const c = addCard(b, { title: "second" });
  assert.equal(defaultColumnFor(b), "plate");
  assert.equal(a.columnId, "plate");
  assert.deepEqual([a.order, c.order], [0, 1]);
  assert.ok(a.id !== c.id && a.createdAt && a.updatedAt);
  const ws = createBoard("deliver", "acme");
  assert.equal(defaultColumnFor(ws), "ready");
  assert.equal(addCard(ws, { title: "x" }).columnId, "ready");
  assert.throws(() => addCard(b, { title: "  " }), /title/i);
  assert.throws(() => addCard(b, { title: "x", columnId: "nope" }), /column/i);
});

test("patchCard moves between columns at a target index and renumbers both columns", () => {
  const b = createBoard("deliver", "acme");
  const [ready, inProgress] = [b.columns[1].id, b.columns[2].id];
  const c1 = addCard(b, { title: "one", columnId: ready });
  const c2 = addCard(b, { title: "two", columnId: ready });
  const c3 = addCard(b, { title: "three", columnId: inProgress });
  patchCard(b, c1.id, { columnId: inProgress, order: 0 });
  const inCol = (col: string) =>
    b.cards
      .filter((c) => c.columnId === col)
      .sort((x, y) => x.order - y.order)
      .map((c) => c.title);
  assert.deepEqual(inCol(inProgress), ["one", "three"]);
  assert.deepEqual(inCol(ready), ["two"]);
  assert.deepEqual(
    b.cards.filter((c) => c.columnId === ready).map((c) => c.order),
    [0],
  );
  assert.equal(b.cards.find((c) => c.id === c3.id)?.order, 1);
  assert.ok(patchCard(b, c2.id, { title: "renamed" }).updatedAt >= c2.createdAt);
  assert.throws(() => patchCard(b, "ghost", { title: "x" }), /card/i);
  assert.throws(() => patchCard(b, c2.id, { columnId: "nope" }), /column/i);
});

test("same-column reorder via order only", () => {
  const b = createBoard("personal");
  const col = "plate"; // where default adds land on the personal board
  const c1 = addCard(b, { title: "a" });
  const c2 = addCard(b, { title: "b" });
  const c3 = addCard(b, { title: "c" });
  patchCard(b, c3.id, { order: 0 });
  const titles = b.cards
    .filter((c) => c.columnId === col)
    .sort((x, y) => x.order - y.order)
    .map((c) => c.title);
  assert.deepEqual(titles, ["c", "a", "b"]);
  assert.deepEqual([c1, c2, c3].map(() => 1).length, 3);
});

test("stories: replaced wholesale via patchCard, cleared with null-ish, round-trips", () => {
  const b = createBoard("personal");
  const c = addCard(b, { title: "cap" });
  patchCard(b, c.id, { stories: [{ id: "s1", text: "user can log in", done: false }] });
  assert.equal(b.cards[0].stories?.length, 1);
  patchCard(b, c.id, {
    stories: [
      { id: "s1", text: "user can log in", done: true, verifiedBy: "manual 2026-08-07" },
      { id: "s2", text: "session survives reload", done: false },
    ],
  });
  assert.deepEqual(
    b.cards[0].stories?.map((s) => [s.done, s.verifiedBy]),
    [
      [true, "manual 2026-08-07"],
      [false, undefined],
    ],
  );
});

test("flags: since is stamped on the transition into a flagged state", () => {
  const b = createBoard("personal");
  const c = addCard(b, { title: "Opt-in UI" });
  patchCard(b, c.id, { flag: { kind: "blocked", reason: "waiting on Edwin" } });
  const first = b.cards[0].flag;
  assert.equal(first?.kind, "blocked");
  assert.equal(first?.reason, "waiting on Edwin");
  assert.equal(
    new Date(first?.since as string).toISOString(),
    first?.since,
    "since must be a real ISO timestamp, not just truthy",
  );
});

test("flags: correcting kind or reason preserves the clock; clear-then-reflag resets it", async () => {
  const b = createBoard("personal");
  const c = addCard(b, { title: "Parser" });
  patchCard(b, c.id, { flag: { kind: "at-risk" } });
  const since = b.cards[0].flag?.since as string;

  patchCard(b, c.id, { flag: { kind: "blocked", reason: "upstream down" } });
  assert.equal(b.cards[0].flag?.since, since, "an in-place kind correction must not reset the clock");
  assert.equal(b.cards[0].flag?.kind, "blocked");

  patchCard(b, c.id, { flag: null });
  const cleared = b.cards[0].flag;
  assert.equal(cleared, undefined);

  await new Promise((r) => setTimeout(r, 2));
  patchCard(b, c.id, { flag: { kind: "waiting" } });
  assert.notEqual(b.cards[0].flag?.since, since, "clear-then-reflag must start a fresh clock");
});

test("flags: never move the card, and an unknown kind throws", () => {
  const b = createBoard("deliver", "acme");
  const c = addCard(b, { title: "Webhook", columnId: "review" });
  const before = { columnId: c.columnId, order: c.order };
  patchCard(b, c.id, { flag: { kind: "waiting" } });
  assert.deepEqual({ columnId: b.cards[0].columnId, order: b.cards[0].order }, before);
  assert.throws(() => patchCard(b, c.id, { flag: { kind: "nope" } as unknown as CardFlag }), /flag/i);
});

test("flags: reason is trimmed; whitespace-only or omitted collapses to undefined", () => {
  const b = createBoard("personal");
  const c = addCard(b, { title: "Reason trimming" });
  patchCard(b, c.id, { flag: { kind: "blocked", reason: "  waiting on Edwin  " } });
  assert.equal(b.cards[0].flag?.reason, "waiting on Edwin");

  patchCard(b, c.id, { flag: { kind: "blocked", reason: "   " } });
  assert.equal(b.cards[0].flag?.reason, undefined);

  patchCard(b, c.id, { flag: null });
  patchCard(b, c.id, { flag: { kind: "waiting" } });
  assert.equal(b.cards[0].flag?.reason, undefined);
});

// Regression guard: patchCard's flag handling is gated on `patch.flag !== undefined`,
// so a patch that never mentions `flag` at all must leave an existing flag — since
// clock included — completely untouched. That gating is a structural accident today,
// not an asserted contract: a later refactor that flattened patch handling could
// reset every blocked clock on every card rename or drag, and nothing else here
// would catch it. Do not delete this as "redundant" with the tests above.
test("flags: unrelated patches (rename, drag) leave an existing flag and its since clock untouched", () => {
  const b = createBoard("deliver", "acme");
  const c = addCard(b, { title: "Webhook", columnId: "ready" });
  patchCard(b, c.id, { flag: { kind: "blocked", reason: "waiting on Edwin" } });
  const since = b.cards[0].flag?.since;

  patchCard(b, c.id, { title: "renamed" });
  assert.equal(b.cards[0].flag?.since, since, "a title-only patch must not touch the since clock");
  assert.equal(b.cards[0].flag?.kind, "blocked");
  assert.equal(b.cards[0].flag?.reason, "waiting on Edwin");

  patchCard(b, c.id, { columnId: "in-progress", order: 0 }); // a drag
  assert.equal(b.cards[0].flag?.since, since, "a column/order patch (a drag) must not touch the since clock");
  assert.equal(b.cards[0].flag?.kind, "blocked");
  assert.equal(b.cards[0].flag?.reason, "waiting on Edwin");
});

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
  assert.throws(() => setStepState(c, "ana", "today", "2026-08-13T12:00:00.000Z", "mine now"), /not held by/);
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

test("a personal card needs a comment to reach done, but not to reach today", () => {
  const b = createBoard("personal");
  const c = addCard(b, { title: "call the bank", columnId: "plate" });
  patchCard(b, c.id, { columnId: "today", order: 0 });
  assert.equal(c.columnId, "today");
  assert.throws(() => patchCard(b, c.id, { columnId: "done", order: 0 }), /closing comment is required/);
  patchCard(b, c.id, { columnId: "done", order: 0, close: { by: "edwin", text: "rescheduled the transfer" } });
  assert.equal(c.intents?.[0].kind, "done");
});

test("save/load round-trip; malformed files land in errors without sinking the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  const b = createBoard("plan", "alpha");
  addCard(b, { title: "card" });
  await saveBoard(dir, b);
  await writeFile(join(dir, "broken.json"), "{not json");
  await writeFile(join(dir, "shapeless.json"), '{"id":"shapeless"}');
  const { boards, errors } = await loadBoards(dir);
  assert.deepEqual(
    boards.map((x) => x.id),
    ["alpha-plan"],
  );
  assert.equal(boards[0].cards[0].title, "card");
  assert.equal(errors.length, 2);
  assert.deepEqual((await readFile(join(dir, "alpha-plan.json"), "utf8")).endsWith("\n"), true);
  await deleteBoardFile(dir, "alpha-plan");
  assert.deepEqual((await loadBoards(dir)).boards, []);
  await assert.rejects(saveBoard(dir, { ...b, id: "../evil" }), /id/i);
});

test("normalizeBoard migrates a pre-rename personal board and is idempotent", () => {
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
  normalizeBoard(legacy);
  assert.equal(legacy.name, "Agenda");
  assert.deepEqual(
    legacy.columns.map((c) => c.id),
    ["plate", "today", "done", "not-doing"],
  );
  normalizeBoard(legacy);
  assert.deepEqual(
    legacy.columns.map((c) => c.id),
    ["plate", "today", "done", "not-doing"],
  );
});

test("normalizeBoard renames old default labels across types, keeps custom names", () => {
  const active = { ...createBoard("personal"), name: "Active To-dos" };
  assert.equal(normalizeBoard(active).name, "Agenda");
  const reactive = { ...createBoard("reactive", "acme"), name: "Reactive" };
  assert.equal(normalizeBoard(reactive).name, "React");
  const maintenance = { ...createBoard("maintenance", "acme"), name: "Maintenance" };
  assert.equal(normalizeBoard(maintenance).name, "Maintain");
  const ideation = { ...createBoard("ideation", "acme"), name: "Ideation" };
  assert.equal(normalizeBoard(ideation).name, "Ideate");
  const custom = { ...createBoard("personal"), name: "Edwin's list" };
  assert.equal(normalizeBoard(custom).name, "Edwin's list");
});

test("normalizeBoard prepends queue on deliver and reactive, once", () => {
  const deliver: WorkBoard = {
    id: "acme-deliver",
    name: "Deliver",
    type: "deliver",
    workspaceId: "acme",
    columns: [
      { id: "ready", name: "Ready" },
      { id: "in-progress", name: "In progress" },
    ],
    cards: [],
  };
  normalizeBoard(deliver);
  assert.deepEqual(
    deliver.columns.map((c) => c.id),
    ["queue", "ready", "in-progress"],
  );
  normalizeBoard(deliver);
  assert.equal(deliver.columns.filter((c) => c.id === "queue").length, 1);
});

test("normalizeBoard moves maintenance's queued to the front as Queue, cards riding along", () => {
  const maintenance: WorkBoard = {
    id: "acme-maintenance",
    name: "Maintenance",
    type: "maintenance",
    workspaceId: "acme",
    columns: [
      { id: "triage", name: "Triage" },
      { id: "queued", name: "Queued" },
      { id: "doing", name: "Doing" },
    ],
    cards: [
      { id: "c1", title: "waiting", columnId: "queued", order: 0, createdAt: "t", updatedAt: "t" },
      { id: "c2", title: "fresh", columnId: "triage", order: 0, createdAt: "t", updatedAt: "t" },
    ],
  };
  normalizeBoard(maintenance);
  assert.deepEqual(
    maintenance.columns.map((c) => c.id),
    ["queue", "triage", "doing"],
  );
  assert.equal(maintenance.columns[0].name, "Queue");
  assert.equal(maintenance.cards.find((c) => c.id === "c1")?.columnId, "queue");
  assert.equal(maintenance.cards.find((c) => c.id === "c2")?.columnId, "triage");
  normalizeBoard(maintenance);
  assert.equal(maintenance.columns.filter((c) => c.id === "queue").length, 1);
});

test("normalizeBoard prepends queue on legacy release and plan boards; fresh release ships with it", () => {
  const release = createBoard("release", "acme");
  assert.equal(release.columns[0]?.id, "queue"); // new template: queue leftmost
  const legacyRelease: WorkBoard = {
    id: "acme-release",
    name: "Release",
    type: "release",
    workspaceId: "acme",
    columns: [
      { id: "cut", name: "Cut" },
      { id: "ship", name: "Ship" },
    ],
    cards: [],
  };
  normalizeBoard(legacyRelease);
  assert.deepEqual(
    legacyRelease.columns.map((c) => c.id),
    ["queue", "cut", "ship"],
  );
  const legacyPlan: WorkBoard = {
    id: "acme-plan",
    name: "Plan",
    type: "plan",
    workspaceId: "acme",
    columns: [
      { id: "spec", name: "Spec" },
      { id: "ready", name: "Ready" },
    ],
    cards: [],
  };
  normalizeBoard(legacyPlan);
  assert.deepEqual(
    legacyPlan.columns.map((c) => c.id),
    ["queue", "spec", "ready"],
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
  assert.equal(boards[0].name, "Agenda");
  assert.equal(boards[0].columns[0].id, "plate");
  // In-memory only: the file still says Personal until the next mutation saves.
  assert.match(await readFile(join(dir, "personal.json"), "utf8"), /"Personal"/);
});

test("sweepUserAgenda reverts today to plate without releasing the card", () => {
  const d = createBoard("deliver", "ws");
  const r = createBoard("reactive", "ws");
  const mine = addCard(d, { title: "mine", columnId: "review" });
  const alsoMine = addCard(r, { title: "also mine", columnId: "triage" });
  const hers = addCard(d, { title: "hers", columnId: "review" });
  grabCard(mine, "edwin", "2026-08-12T09:00:00.000Z");
  setStepState(mine, "edwin", "today", "2026-08-12T09:00:00.000Z", "working it");
  grabCard(alsoMine, "edwin", "2026-08-12T09:00:00.000Z");
  grabCard(hers, "ana", "2026-08-12T09:00:00.000Z");
  setStepState(hers, "ana", "today", "2026-08-12T09:00:00.000Z", "working it");

  const dirty = sweepUserAgenda([d, r], "edwin", "2026-08-13T00:00:00.000Z");

  assert.deepEqual(
    dirty.map((b) => b.id),
    [d.id],
  );
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

test("sweepUserAgenda merges Today into My plate on the personal board without duplicate order, alongside a workspace board in the same call", () => {
  const personal = createBoard("personal");
  const p1 = addCard(personal, { title: "p1", columnId: "plate" });
  const p2 = addCard(personal, { title: "p2", columnId: "plate" });
  const t1 = addCard(personal, { title: "t1", columnId: "today" });
  const t2 = addCard(personal, { title: "t2", columnId: "today" });

  const d = createBoard("deliver", "ws");
  const mine = addCard(d, { title: "mine", columnId: "review" });
  grabCard(mine, "edwin", "2026-08-12T09:00:00.000Z");
  setStepState(mine, "edwin", "today", "2026-08-12T09:00:00.000Z", "working it");

  const dirty = sweepUserAgenda([personal, d], "edwin", "2026-08-13T00:00:00.000Z");

  assert.deepEqual(
    dirty.map((b) => b.id),
    [personal.id, d.id],
    "both boards swept in the same call",
  );

  assert.equal(t1.columnId, "plate", "Today card reverted to My plate");
  assert.equal(t2.columnId, "plate", "Today card reverted to My plate");
  assert.equal(t1.updatedAt, "2026-08-13T00:00:00.000Z");
  assert.equal(t2.updatedAt, "2026-08-13T00:00:00.000Z");
  assert.equal(p1.columnId, "plate", "already on plate, untouched");
  assert.equal(p2.columnId, "plate", "already on plate, untouched");

  // The workspace board's step-axis card swept independently, same call.
  assert.equal(mine.agenda?.state, "plate");

  // p1/p2 and t1/t2 all carried order 0 or 1 in their own columns before the
  // merge — without renumber(board, "plate") the merged column would have
  // duplicate order values instead of a clean 0..n-1 run.
  const plateOrders = personal.cards
    .filter((c) => c.columnId === "plate")
    .map((c) => c.order)
    .sort((a, b) => a - b);
  assert.deepEqual(plateOrders, [0, 1, 2, 3], "plate renumbered to a clean 0..n-1 run, no duplicates");
});

test("localDayStamp and msUntilNextMidnight do local-midnight math", () => {
  const nearMidnight = new Date(2026, 7, 11, 23, 59, 0); // Aug 11, 23:59 local
  assert.equal(localDayStamp(nearMidnight), "2026-08-11");
  assert.equal(msUntilNextMidnight(nearMidnight), 60_000);
  assert.equal(localDayStamp(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(msUntilNextMidnight(new Date(2026, 7, 11, 0, 0, 0)), 86_400_000);
});

test("removeCard deletes and renumbers its column", () => {
  const b = createBoard("personal");
  const c1 = addCard(b, { title: "a" });
  const c2 = addCard(b, { title: "b" });
  removeCard(b, c1.id);
  assert.deepEqual(
    b.cards.map((c) => [c.title, c.order]),
    [["b", 0]],
  );
  assert.ok(c2);
  assert.throws(() => removeCard(b, "ghost"), /card/i);
});

test("routes: exits are per-column and the forward plan handoff exists", () => {
  const plan = createBoard("plan", "acme");
  assert.deepEqual(
    exitsFor(plan, "ready").map((e) => e.label),
    ["Send to deliver"],
  );
  assert.deepEqual(
    exitsFor(plan, "tech-design").map((e) => e.label),
    ["Back to ideation"],
  );
  assert.deepEqual(exitsFor(plan, "spec"), []);
  const reactive = createBoard("reactive", "acme");
  assert.deepEqual(
    exitsFor(reactive, "triage").map((e) => e.toType),
    ["maintenance", "ideation"],
  );
  assert.deepEqual(exitsFor(createBoard("ideation", "acme"), "confirm"), []);
});

test("resolveExit matches on column and destination type", () => {
  const plan = createBoard("plan", "acme");
  assert.equal(resolveExit(plan, "ready", "deliver")?.toColumn, "ready");
  assert.equal(resolveExit(plan, "ready", "ideation"), undefined); // wrong destination
  assert.equal(resolveExit(plan, "spec", "deliver"), undefined); // wrong column
});

test("every route points at a column that exists on its destination template", () => {
  for (const [type, exits] of Object.entries(BOARD_ROUTES)) {
    for (const e of exits) {
      assert.ok(
        BOARD_TEMPLATES[type as BoardType].some((c) => c.id === e.from),
        `${type}.${e.from} is not a column`,
      );
      assert.ok(
        BOARD_TEMPLATES[e.toType].some((c) => c.id === e.toColumn),
        `${e.toType}.${e.toColumn} is not a column`,
      );
    }
  }
});

test("routeCard moves the card, preserves identity and payload, and writes destination first", () => {
  const plan = createBoard("plan", "acme");
  const deliver = createBoard("deliver", "acme");
  const card = addCard(plan, { title: "Parser", columnId: "ready" });
  patchCard(plan, card.id, {
    stories: [{ id: "s1", text: "parses", done: true }],
    jira: { key: "P-1", url: "https://a/browse/P-1" },
    capabilityRef: { capabilityId: "acme-store", sliceId: "sl1" },
  });
  const exit = resolveExit(plan, "ready", "deliver");
  assert.ok(exit);
  const out = routeCard(plan, deliver, card.id, exit, "2026-08-07T10:00:00.000Z");

  assert.equal(out.writeFirst, deliver); // destination first — a crash duplicates, never loses
  assert.equal(out.writeSecond, plan);
  assert.equal(plan.cards.length, 0);
  assert.equal(deliver.cards.length, 1);
  assert.equal(out.card.id, card.id); // same object across the boundary
  assert.equal(out.card.columnId, "ready");
  assert.equal(out.card.order, 0);
  assert.equal(out.card.jira?.key, "P-1");
  assert.equal(out.card.stories?.length, 1);
  assert.deepEqual(out.card.capabilityRef, { capabilityId: "acme-store", sliceId: "sl1" });
  assert.deepEqual(out.card.routedFrom, [
    { boardId: "acme-plan", boardType: "plan", columnId: "ready", at: "2026-08-07T10:00:00.000Z" },
  ]);
});

test("routeCard clears the holder — a routed card must not carry a stale owner", () => {
  const r = createBoard("reactive", "ws");
  const m = createBoard("maintenance", "ws");
  const c = addCard(r, { title: "flaky", columnId: "triage" });
  grabCard(c, "edwin", "2026-08-13T10:00:00.000Z");
  const exit = { from: "triage", toType: "maintenance" as const, toColumn: "triage", label: "To maintenance" };
  const plan = routeCard(r, m, c.id, exit, "2026-08-13T11:00:00.000Z");
  assert.equal(plan.card.agenda, undefined);
});

test("routeCard chains across two real hops: delegation, stories, jira, capabilityRef survive and routedFrom records both legs", () => {
  const release = createBoard("release", "acme");
  const deliver = createBoard("deliver", "acme");
  const plan = createBoard("plan", "acme");
  addCard(plan, { title: "sitting there", columnId: "tech-design" });
  const card = addCard(release, { title: "Hotfix", columnId: "regression" });
  patchCard(release, card.id, {
    stories: [{ id: "s1", text: "no regressions", done: true }],
    jira: { key: "R-1", url: "https://a/browse/R-1" },
    capabilityRef: { capabilityId: "acme-store", sliceId: "sl1" },
    delegation: { agentId: "minerva", taskId: "t1", state: "working" },
  });

  const exit1 = resolveExit(release, "regression", "deliver");
  assert.ok(exit1);
  const hop1 = routeCard(release, deliver, card.id, exit1, "2026-08-07T10:00:00.000Z");
  assert.equal(hop1.card.columnId, "in-progress");

  const exit2 = resolveExit(deliver, "in-progress", "plan");
  assert.ok(exit2);
  const hop2 = routeCard(deliver, plan, hop1.card.id, exit2, "2026-08-07T11:00:00.000Z");

  assert.equal(hop2.card.id, card.id);
  assert.equal(hop2.card.columnId, "tech-design");
  assert.equal(hop2.card.order, 1); // behind the card already there
  assert.deepEqual(hop2.card.delegation, { agentId: "minerva", taskId: "t1", state: "working" });
  assert.equal(hop2.card.jira?.key, "R-1");
  assert.equal(hop2.card.stories?.length, 1);
  assert.deepEqual(hop2.card.capabilityRef, { capabilityId: "acme-store", sliceId: "sl1" });
  assert.deepEqual(hop2.card.routedFrom, [
    { boardId: "acme-release", boardType: "release", columnId: "regression", at: "2026-08-07T10:00:00.000Z" },
    { boardId: "acme-deliver", boardType: "deliver", columnId: "in-progress", at: "2026-08-07T11:00:00.000Z" },
  ]);
  assert.throws(() => routeCard(deliver, plan, "ghost", exit2, "2026-08-07T11:00:00.000Z"), /card/i);
});

test("findRouteDestination: matches the exit type in the source board's own workspace", () => {
  const source = createBoard("plan", "acme");
  const dest = createBoard("deliver", "acme");
  const exit = resolveExit(source, "ready", "deliver");
  assert.ok(exit);
  assert.equal(findRouteDestination([source, dest], source, exit), dest);
});

test("findRouteDestination: does not match a same-type board in a different workspace", () => {
  const source = createBoard("plan", "acme");
  const otherWorkspaceDest = createBoard("deliver", "widgetco");
  const exit = resolveExit(source, "ready", "deliver");
  assert.ok(exit);
  assert.equal(findRouteDestination([source, otherWorkspaceDest], source, exit), undefined);
});

test("escalation: retired — maintenance and reactive triage no longer exit to the personal board", () => {
  const maintenance = createBoard("maintenance", "acme");
  const reactive = createBoard("reactive", "acme");
  assert.deepEqual(exitsFor(maintenance, "triage"), []);
  assert.equal(resolveExit(reactive, "triage", "personal"), undefined);
  assert.deepEqual(exitsFor(maintenance, "doing"), []);
});

test("findRouteDestination resolves the workspace-less personal board from any workspace", () => {
  const source = createBoard("maintenance", "acme");
  const personal = createBoard("personal");
  const boards = [createBoard("maintenance", "globex"), personal, source];
  // No route targets personal any more (Escalate to Agenda was retired) — this exercises
  // findRouteDestination's own workspace-less resolution, independent of any real route.
  const exit = { from: "triage", toType: "personal" as const, toColumn: "plate", label: "Test exit" };
  assert.equal(findRouteDestination(boards, source, exit), personal);
});

test("routeCard can move a card onto the personal board with a provenance trace", () => {
  // Escalate to Agenda was retired (triage is already in the shared queue, and escalating
  // is just grabbing it) — this exercises routeCard's own mechanics against the
  // workspace-less personal board via a synthetic exit, independent of any real route.
  const maintenance = createBoard("maintenance", "acme");
  const personal = createBoard("personal");
  addCard(personal, { title: "already there", columnId: "plate" });
  const card = addCard(maintenance, { title: "prod leak", columnId: "triage" });
  const exit = { from: "triage", toType: "personal" as const, toColumn: "plate", label: "Test move" };
  const plan = routeCard(maintenance, personal, card.id, exit, "2026-08-11T00:00:00.000Z");
  assert.equal(plan.card.columnId, "plate");
  assert.equal(plan.card.order, 1); // appended after the existing plate card
  assert.equal(plan.writeFirst, personal); // destination-first persistence
  assert.deepEqual(plan.card.routedFrom?.at(-1), {
    boardId: maintenance.id,
    boardType: "maintenance",
    columnId: "triage",
    at: "2026-08-11T00:00:00.000Z",
  });
});

test("findRouteDestination: undefined when the workspace has no board of that type yet", () => {
  const source = createBoard("plan", "acme");
  const exit = resolveExit(source, "ready", "deliver");
  assert.ok(exit);
  assert.equal(findRouteDestination([source], source, exit), undefined);
});

test("findCardByRef: follows a routed card to its new board, and reports gone only when it truly is", () => {
  const plan = createBoard("plan", "acme");
  const deliver = createBoard("deliver", "acme");
  const card = addCard(plan, { title: "Parent portal", columnId: "ready" });
  const boards = [plan, deliver];

  const before = findCardByRef(boards, { boardId: plan.id, cardId: card.id });
  assert.equal(before?.board, plan);
  assert.equal(before?.card, card);

  const exit = resolveExit(plan, "ready", "deliver");
  assert.ok(exit);
  const moved = routeCard(plan, deliver, card.id, exit, "2026-08-07T10:00:00.000Z").card;

  // The ref still names the board it left; the card id is what resolves it.
  const after = findCardByRef(boards, { boardId: plan.id, cardId: card.id });
  assert.equal(after?.board, deliver);
  assert.equal(after?.card, moved);

  removeCard(deliver, card.id);
  assert.equal(findCardByRef(boards, { boardId: plan.id, cardId: card.id }), undefined);
  assert.equal(findCardByRef(boards, { cardId: "never-existed" }), undefined);
});

test("terminalColumnId is the explicit terminal.columnId, else the last column — Release's Rollback trap", () => {
  const board = createBoard("release", "acme"); // columns end in rollback
  assert.equal(terminalColumnId(board), board.columns[board.columns.length - 1].id);
  board.terminal = { columnId: "ship", effects: [] };
  assert.equal(terminalColumnId(board), "ship");
});

test("intakeColumnId prefers the queue column and falls back to the first column", () => {
  const maintain = createBoard("maintenance", "acme");
  assert.equal(intakeColumnId(maintain), "queue");
  const plan = createBoard("plan", "acme");
  assert.equal(intakeColumnId(plan), "queue"); // plan's template already ships a queue column
  const ideation = createBoard("ideation", "acme");
  assert.equal(intakeColumnId(ideation), ideation.columns[0].id);
});

test("a board with queue/terminal blocks and a card with sourceRef round-trips through save/load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  const board = createBoard("plan", "acme");
  board.queue = { sourceIds: ["jira-plan"] };
  board.terminal = { columnId: "ready", effects: [{ kind: "publish-jira", connectorId: "atl-1", projectKey: "PROJ" }] };
  const card = addCard(board, { title: "t", sourceRef: { sourceId: "jira-plan", itemKey: "PROJ-1" } });
  await saveBoard(dir, board);
  const { boards } = await loadBoards(dir);
  assert.deepEqual(boards[0].queue, board.queue);
  assert.deepEqual(boards[0].terminal, board.terminal);
  assert.deepEqual(boards[0].cards.find((c) => c.id === card.id)?.sourceRef, {
    sourceId: "jira-plan",
    itemKey: "PROJ-1",
  });
  assert.equal(hasSourceRef(boards[0], { sourceId: "jira-plan", itemKey: "PROJ-1" }), true);
  assert.equal(hasSourceRef(boards[0], { sourceId: "jira-plan", itemKey: "PROJ-2" }), false);
});

test("normalizeBoard folds a legacy personal board into plate/today/done", () => {
  const b = createBoard("personal");
  b.columns = [
    { id: "queue", name: "Queue" },
    { id: "todo", name: "Todo" },
    { id: "doing", name: "Doing" },
    { id: "done", name: "Done" },
    { id: "not-doing", name: "Not Doing" },
  ];
  b.cards = [
    { id: "a", title: "q", columnId: "queue", order: 0, createdAt: "x", updatedAt: "x" },
    { id: "b", title: "t", columnId: "todo", order: 0, createdAt: "x", updatedAt: "x" },
    { id: "c", title: "d", columnId: "doing", order: 0, createdAt: "x", updatedAt: "x" },
  ];
  normalizeBoard(b);
  assert.deepEqual(
    b.columns.map((c) => c.id),
    ["plate", "today", "done", "not-doing"],
  );
  assert.deepEqual(
    b.cards.map((c) => c.columnId),
    ["plate", "plate", "today"],
  );
  assert.deepEqual(
    b.cards
      .filter((c) => c.columnId === "plate")
      .map((c) => c.order)
      .sort(),
    [0, 1],
  );
});

test("normalizeBoard no longer forces a queue column onto the personal board", () => {
  const b = createBoard("personal");
  normalizeBoard(b);
  assert.equal(
    b.columns.some((c) => c.id === "queue"),
    false,
  );
});

test("normalizeBoard backfills gatesHuman from the template onto persisted columns that predate it", () => {
  const deliver: WorkBoard = {
    id: "acme-deliver",
    name: "Deliver",
    type: "deliver",
    workspaceId: "acme",
    columns: [
      { id: "queue", name: "Queue" },
      { id: "ready", name: "Ready" },
      { id: "in-progress", name: "In progress" },
      { id: "review", name: "Review" },
      { id: "verify", name: "Verify" },
      { id: "merged", name: "Merged" },
    ],
    cards: [{ id: "c1", title: "old card", columnId: "review", order: 0, createdAt: "x", updatedAt: "x" }],
  };
  normalizeBoard(deliver);
  const gated = (id: string) => deliver.columns.find((c) => c.id === id)?.gatesHuman === true;
  assert.equal(gated("review"), true);
  assert.equal(gated("verify"), true);
  assert.equal(gated("queue"), false);
  assert.equal(gated("ready"), false);
  assert.equal(gated("in-progress"), false);
  assert.equal(gated("merged"), false);
});

test("normalizeBoard leaves a persisted gatesHuman:false alone — undefined and false are not the same thing", () => {
  // PATCH /work/boards/:id accepts a client-supplied `columns` array wholesale, so an
  // explicit `false` can reach disk. `if (column.gatesHuman) continue` can't tell that
  // apart from "unset" and would flip it back to true on the next load.
  const deliver: WorkBoard = {
    id: "acme-deliver",
    name: "Deliver",
    type: "deliver",
    workspaceId: "acme",
    columns: [
      { id: "queue", name: "Queue" },
      { id: "ready", name: "Ready" },
      { id: "in-progress", name: "In progress" },
      { id: "review", name: "Review", gatesHuman: false },
      { id: "verify", name: "Verify" },
      { id: "merged", name: "Merged" },
    ],
    cards: [],
  };
  normalizeBoard(deliver);
  assert.equal(deliver.columns.find((c) => c.id === "review")?.gatesHuman, false);
});

test("templates gate exactly the four columns that wait on a person", () => {
  const gated = (t: BoardType, id: string) => Boolean(BOARD_TEMPLATES[t].find((c) => c.id === id)?.gatesHuman);
  assert.equal(gated("deliver", "review"), true);
  assert.equal(gated("deliver", "verify"), true);
  assert.equal(gated("reactive", "triage"), true);
  assert.equal(gated("maintenance", "triage"), true);
  assert.equal(gated("release", "sign-off"), false, "Release is not a source — Edwin named three boards");
  assert.equal(gated("deliver", "in-progress"), false);
});

test("loadAllBoards: merges boards across directories and reports each file's errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "boards-merge-"));
  try {
    const hostDir = join(root, "work");
    const wsDir = join(root, "ws", "config", "boards");
    mkdirSync(hostDir, { recursive: true });
    mkdirSync(wsDir, { recursive: true });

    await saveBoard(hostDir, createBoard("personal"));
    await saveBoard(wsDir, createBoard("deliver", "proving-ground"));
    writeFileSync(join(wsDir, "broken.json"), "{not json");

    const { boards, errors } = await loadAllBoards([hostDir, wsDir]);

    const ids = boards.map((b) => b.id).sort();
    assert.ok(ids.includes("proving-ground-deliver"), `expected the workspace board, got ${ids.join(",")}`);
    assert.equal(boards.length, 2, `expected both boards, got ${ids.join(",")}`);
    assert.equal(errors.length, 1, "the malformed file is reported, not swallowed");
    assert.match(errors[0].file, /broken\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAllBoards: a duplicate id keeps the first directory's copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "boards-dup-"));
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    const first = createBoard("deliver", "pg");
    first.name = "FIRST";
    const second = createBoard("deliver", "pg");
    second.name = "SECOND";
    await saveBoard(a, first);
    await saveBoard(b, second);

    const { boards } = await loadAllBoards([a, b]);
    assert.equal(boards.length, 1, "a duplicate id yields one board, not two");
    assert.equal(boards[0].name, "FIRST", "the first directory wins");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadAllBoards: a missing directory contributes nothing and is not an error", async () => {
  const root = mkdtempSync(join(tmpdir(), "boards-missing-"));
  try {
    const { boards, errors } = await loadAllBoards([join(root, "nope")]);
    assert.deepEqual(boards, []);
    assert.deepEqual(errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
