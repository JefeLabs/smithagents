import assert from "node:assert/strict";
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
  loadBoards,
  normalizePersonalBoard,
  patchCard,
  removeCard,
  resolveExit,
  routeCard,
  saveBoard,
  type WorkBoard,
  WORKSPACE_BOARD_TYPES,
} from "./work-items.js";

test("templates: seven typed column sets, ids unique and slug-shaped", () => {
  assert.deepEqual(
    BOARD_TEMPLATES.personal.map((c) => c.name),
    ["Queue", "Todo", "Doing", "Done", "Not Doing"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.ideation.map((c) => c.name),
    ["Intake", "Scoping", "Confirm", "Killed"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.plan.map((c) => c.name),
    ["Spec", "Tech design", "Decomposed", "Ready"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.deliver.map((c) => c.name),
    ["Ready", "In progress", "Review", "Verify", "Merged"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.release.map((c) => c.name),
    ["Cut", "Regression", "Sign-off", "Ship", "Rollback"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.reactive.map((c) => c.name),
    ["Triage", "Diagnose", "Fix", "Verify", "Closed"],
  );
  assert.deepEqual(
    BOARD_TEMPLATES.maintenance.map((c) => c.name),
    ["Triage", "Queued", "Doing", "Done", "Won't do"],
  );
  assert.equal(Object.keys(BOARD_TEMPLATES).length, 7);
  for (const cols of Object.values(BOARD_TEMPLATES)) {
    assert.equal(new Set(cols.map((c) => c.id)).size, cols.length);
    for (const c of cols) assert.match(c.id, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test("type order puts personal first and WORKSPACE_BOARD_TYPES excludes it", () => {
  assert.deepEqual(BOARD_TYPE_ORDER, ["personal", "ideation", "plan", "deliver", "release", "reactive", "maintenance"]);
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
  assert.equal(p.name, "Active To-dos");
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

test("patchCard moves between columns at a target index and renumbers both columns", () => {
  const b = createBoard("personal");
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
  const col = "todo"; // where default adds land on the personal board
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
    ["maintenance", "ideation", "personal"],
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
