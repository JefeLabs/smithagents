import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTerminalEffects } from "./terminal-effects.js";
import { addCard, createBoard } from "./work-items.js";

function deps(overrides: Partial<Parameters<typeof applyTerminalEffects>[3]> = {}) {
  return {
    createIssue: async () => ({ key: "PROJ-9", url: "https://a/browse/PROJ-9" }),
    newId: () => "copy-1",
    now: () => "2026-08-13T12:00:00Z",
    ...overrides,
  };
}

test("publish-jira stamps card.jira and never re-publishes an already-linked card", async () => {
  const board = createBoard("ideation", "acme");
  board.terminal = {
    columnId: board.columns[board.columns.length - 1].id,
    effects: [{ kind: "publish-jira", connectorId: "atl-1", projectKey: "PROJ" }],
  };
  const card = addCard(board, { title: "Great idea" });
  const first = await applyTerminalEffects(board, card, [board], deps());
  assert.deepEqual(card.jira, { key: "PROJ-9", url: "https://a/browse/PROJ-9" });
  assert.deepEqual(
    first.changed.map((b) => b.id),
    [board.id],
  );
  let called = 0;
  await applyTerminalEffects(
    board,
    card,
    [board],
    deps({
      createIssue: async () => {
        called++;
        return { key: "X-1", url: "u" };
      },
    }),
  );
  assert.equal(called, 0); // card.jira presence is the idempotency guard
});

test("publish-jira failure lands in errors + lastPushError and changes nothing else", async () => {
  const board = createBoard("ideation", "acme");
  board.terminal = {
    columnId: board.columns[board.columns.length - 1].id,
    effects: [{ kind: "publish-jira", connectorId: "atl-1", projectKey: "PROJ" }],
  };
  const card = addCard(board, { title: "t" });
  const res = await applyTerminalEffects(
    board,
    card,
    [board],
    deps({
      createIssue: async () => {
        throw new Error("403");
      },
    }),
  );
  assert.equal(res.errors.length, 1);
  assert.match(card.jira?.lastPushError ?? "", /403/);
  assert.equal(card.jira?.key, ""); // errored placeholder, no phantom link
});

test("route copies the card into the target board's configured column with a fresh id, routedFrom, and a terminal sourceRef; re-entry does not duplicate", async () => {
  const plan = createBoard("plan", "acme");
  const deliver = createBoard("deliver", "acme");
  plan.terminal = {
    columnId: plan.columns[plan.columns.length - 1].id,
    effects: [{ kind: "route", toType: "deliver", toColumn: "queue" }],
  };
  const card = addCard(plan, { title: "ship me" });
  const res = await applyTerminalEffects(plan, card, [plan, deliver], deps());
  const copy = deliver.cards.find((c) => c.id === "copy-1");
  assert.ok(copy);
  assert.equal(copy.columnId, "queue");
  assert.equal(copy.title, "ship me");
  assert.deepEqual(copy.sourceRef, { sourceId: `terminal:${plan.id}`, itemKey: card.id });
  assert.equal(copy.routedFrom?.[0]?.boardId, plan.id);
  assert.deepEqual(res.changed.map((b) => b.id).sort(), [deliver.id].sort()); // plan itself unchanged by route
  // original stays where it completed
  assert.ok(plan.cards.some((c) => c.id === card.id));
  const again = await applyTerminalEffects(plan, card, [plan, deliver], deps({ newId: () => "copy-2" }));
  assert.equal(deliver.cards.filter((c) => c.sourceRef?.itemKey === card.id).length, 1);
  assert.equal(again.changed.length, 0);
});

test("a route effect with no matching board is an error entry, never a throw", async () => {
  const plan = createBoard("plan", "acme");
  plan.terminal = {
    columnId: plan.columns[plan.columns.length - 1].id,
    effects: [{ kind: "route", toType: "release", toColumn: "queue" }],
  };
  const card = addCard(plan, { title: "t" });
  const res = await applyTerminalEffects(plan, card, [plan], deps());
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /no release board/i);
});
