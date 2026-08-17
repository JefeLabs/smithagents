import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CapSlice } from "./capabilities.js";
import {
  applyStoryToggles,
  createCapability,
  deleteCapabilityFile,
  ensurePersonalBoard,
  ensureWorkspaceBoards,
  loadCapabilities,
  patchCapability,
  renderSpecSkeleton,
  repointSliceCardRef,
  resyncLinkedCards,
  saveCapability,
  sendSliceToBoard,
  sliceStories,
  slicesWithoutExclusiveStory,
  slugify,
  unlinkCapabilityCards,
  unlinkSliceCard,
} from "./capabilities.js";
import { addCard, boardIdFor, createBoard, loadBoards, resolveExit, routeCard, saveBoard } from "./work-items.js";

const sl = (id: string, storyIds: string[]): CapSlice => ({ id, name: id, order: 0, storyIds });

test("slicesWithoutExclusiveStory: the shared case table", () => {
  const cases: Array<{ name: string; slices: CapSlice[]; invalid: string[] }> = [
    { name: "single slice owns everything", slices: [sl("A", ["s1", "s2", "s3"])], invalid: [] },
    { name: "overlap, each owns one", slices: [sl("A", ["s1", "s2"]), sl("B", ["s2", "s3"])], invalid: [] },
    { name: "identical single story", slices: [sl("A", ["s1"]), sl("B", ["s1"])], invalid: ["A", "B"] },
    { name: "identical sets", slices: [sl("A", ["s1", "s2"]), sl("B", ["s1", "s2"])], invalid: ["A", "B"] },
    { name: "subset", slices: [sl("A", ["s1"]), sl("B", ["s1", "s2"])], invalid: ["A"] },
    { name: "storyless", slices: [sl("A", [])], invalid: ["A"] },
    { name: "no slices at all", slices: [], invalid: [] },
    // FIXTURE REPAIRED, expectation kept. The brief wrote this as A[s1] B[s2]
    // C[s1,s2] expecting ['C'], but in that arrangement A's only story is in C and
    // B's only story is in C, so NO slice owns anything and the honest answer is
    // ['A','B','C'] — verified against the rule directly, not just against the
    // implementation. Answering ['A','B','C'] would have made this row a duplicate
    // of 'identical sets'; the property it is here to prove is that a slice can be
    // invalidated by the COMBINATION of two neighbours that are each healthy, which
    // is what stops anyone rewriting the check as a pairwise containment test. So A
    // and B get a story of their own and the expectation stands.
    {
      name: "covered by two neighbours",
      slices: [sl("A", ["s1", "s3"]), sl("B", ["s2", "s4"]), sl("C", ["s1", "s2"])],
      invalid: ["C"],
    },
  ];
  for (const c of cases) {
    assert.deepEqual(
      slicesWithoutExclusiveStory(c.slices).map((s) => s.id),
      c.invalid,
      c.name,
    );
  }
});

function fixture() {
  const cap = createCapability("School Feature Set", "skoolscout");
  const [a1s1, a1s2] = ["st-tours", "st-analyze"];
  cap.activities = [
    {
      id: "act-tours",
      name: "Manage Candidate Tours",
      order: 0,
      steps: [
        { id: a1s1, name: "Define Tour Schedule", order: 0 },
        { id: a1s2, name: "Analyze Tour Data", order: 1 },
      ],
    },
  ];
  cap.stories = [
    { id: "s1", stepId: a1s1, order: 0, text: "create tour time slots", done: false },
    { id: "s2", stepId: a1s1, order: 1, text: "edit tour time slots", done: false },
    { id: "s3", stepId: a1s2, order: 0, text: "view tour analytics", done: false },
  ];
  cap.slices = [{ id: "sl1", name: "tour scheduling v1", order: 0, storyIds: ["s1", "s2"] }];
  return cap;
}

test("slugify + createCapability shape", () => {
  assert.equal(slugify("School Feature Set!"), "school-feature-set");
  assert.throws(() => slugify("!!!"), /name/i);
  const cap = createCapability("School Feature Set", "skoolscout");
  assert.equal(cap.id, "skoolscout-school-feature-set");
  assert.equal(cap.name, "School Feature Set");
  assert.equal(cap.workspaceId, "skoolscout");
  assert.deepEqual([cap.activities, cap.stories, cap.slices], [[], [], []]);
  assert.ok(cap.createdAt && cap.updatedAt);
});

test("createCapability: id is workspace-namespaced — two workspaces can share a name", () => {
  const a = createCapability("Onboarding", "skoolscout");
  const b = createCapability("Onboarding", "smithagents");
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, "skoolscout-onboarding");
  assert.equal(b.id, "smithagents-onboarding");
  assert.equal(a.name, "Onboarding");
  assert.equal(b.name, "Onboarding");
});

test("capability order: new ones go last in their own workspace, legacy files keep a stable place", async () => {
  // The migration case, which is the one that breaks a running install: every
  // capability file written before `order` existed has none. Loading must place them
  // deterministically rather than reject them or shuffle with the directory read.
  const dir = await mkdtemp(join(tmpdir(), "caps-order-"));
  const legacyA = { ...createCapability("Zeta", "ws"), id: "ws-zeta" } as Record<string, unknown>;
  const legacyB = { ...createCapability("Alpha", "ws"), id: "ws-alpha" } as Record<string, unknown>;
  delete legacyA.order;
  delete legacyB.order;
  await saveCapability(dir, legacyA as unknown as Parameters<typeof saveCapability>[1]);
  await saveCapability(dir, legacyB as unknown as Parameters<typeof saveCapability>[1]);

  const first = await loadCapabilities(dir);
  assert.equal(first.errors.length, 0, "a file without order is not an invalid file");
  assert.deepEqual(
    first.capabilities.map((c) => c.id),
    ["ws-alpha", "ws-zeta"],
    "unordered fall back to id order",
  );

  // An ordered one sorts ahead of both, however late its id is alphabetically.
  const ordered = createCapability("Middle", "ws", 0);
  await saveCapability(dir, ordered);
  const second = await loadCapabilities(dir);
  assert.deepEqual(
    second.capabilities.map((c) => c.id),
    ["ws-middle", "ws-alpha", "ws-zeta"],
  );
});

test("patchCapability: order 0 is writable, which truthiness would drop", () => {
  // The first slot is the commonest value a reorder writes and the one a
  // `if (patch.order)` guard silently ignores.
  const cap = createCapability("A", "ws", 3);
  patchCapability(cap, { order: 0 });
  assert.equal(cap.order, 0);
  // Absent means untouched, rather than reset.
  patchCapability(cap, { name: "B" });
  assert.equal(cap.order, 0);
});

test("patchCapability: overlapping slices are allowed when each owns something", () => {
  const cap = createCapability("jefelabs", "c");
  cap.activities = [{ id: "a1", name: "a", order: 0, steps: [{ id: "st1", name: "s", order: 0 }] }];
  cap.stories = [
    { id: "s1", stepId: "st1", order: 0, text: "one", done: false },
    { id: "s2", stepId: "st1", order: 1, text: "two", done: false },
    { id: "s3", stepId: "st1", order: 2, text: "three", done: false },
  ];
  const patched = patchCapability(cap, {
    slices: [
      { id: "A", name: "A", order: 0, storyIds: ["s1", "s2"] },
      { id: "B", name: "B", order: 1, storyIds: ["s2", "s3"] },
    ],
  });
  assert.equal(patched.slices.length, 2);
});

test("patchCapability: refuses a write that newly invalidates a slice, naming it", () => {
  const cap = createCapability("jefelabs", "c");
  cap.activities = [{ id: "a1", name: "a", order: 0, steps: [{ id: "st1", name: "s", order: 0 }] }];
  cap.stories = [
    { id: "s1", stepId: "st1", order: 0, text: "one", done: false },
    { id: "s2", stepId: "st1", order: 1, text: "two", done: false },
  ];
  cap.slices = [{ id: "A", name: "tour sched v1", order: 0, storyIds: ["s1"] }];
  assert.throws(
    () =>
      patchCapability(cap, {
        slices: [
          { id: "A", name: "tour sched v1", order: 0, storyIds: ["s1"] },
          { id: "B", name: "B", order: 1, storyIds: ["s1", "s2"] },
        ],
      }),
    /tour sched v1/,
  );
});

test("patchCapability: an already-invalid slice is grandfathered", () => {
  const cap = createCapability("jefelabs", "c");
  cap.activities = [{ id: "a1", name: "a", order: 0, steps: [{ id: "st1", name: "s", order: 0 }] }];
  cap.stories = [{ id: "s1", stepId: "st1", order: 0, text: "one", done: false }];
  cap.slices = [{ id: "OLD", name: "slice test 3", order: 0, storyIds: [] }];
  const patched = patchCapability(cap, { name: "renamed" });
  assert.equal(patched.name, "renamed");
  assert.equal(patched.slices[0].storyIds.length, 0);
});

test("patchCapability: refuses a write that repairs one slice while breaking another", () => {
  const cap = createCapability("jefelabs", "c");
  cap.activities = [{ id: "a1", name: "a", order: 0, steps: [{ id: "st1", name: "s", order: 0 }] }];
  cap.stories = [
    { id: "s1", stepId: "st1", order: 0, text: "one", done: false },
    { id: "s2", stepId: "st1", order: 1, text: "two", done: false },
  ];
  // BROKEN owns nothing; HEALTHY owns s2. The write gives BROKEN a story of its
  // own AND takes HEALTHY's only exclusive one: the invalid COUNT stays at 1
  // while the invalid SET flips from {BROKEN} to {HEALTHY}, so a check that
  // compares lengths waves it through.
  //
  // FIXTURE REPAIRED. The brief's write was BROKEN[s1], HEALTHY[s1,s2] — which
  // leaves s2 exclusive to HEALTHY, so HEALTHY stays valid and nothing is
  // broken at all. That version passes against a length comparison too, which is
  // the one thing this test exists to fail. BROKEN has to take s2 for HEALTHY to
  // lose it.
  cap.slices = [
    { id: "BROKEN", name: "broken", order: 0, storyIds: [] },
    { id: "HEALTHY", name: "healthy", order: 1, storyIds: ["s2"] },
  ];
  assert.throws(
    () =>
      patchCapability(cap, {
        slices: [
          { id: "BROKEN", name: "broken", order: 0, storyIds: ["s1", "s2"] },
          { id: "HEALTHY", name: "healthy", order: 1, storyIds: ["s2"] },
        ],
      }),
    /healthy/,
  );
});

test("patchCapability: wholesale replace with validation", () => {
  const cap = fixture();
  const before = cap.updatedAt;
  patchCapability(cap, { name: "Renamed" });
  assert.equal(cap.name, "Renamed");
  assert.ok(cap.updatedAt >= before);
  assert.throws(
    () => patchCapability(cap, { stories: [{ id: "x", stepId: "ghost", order: 0, text: "t", done: false }] }),
    /step/i,
  );
  // Was /disjoint/i. Sharing a story is legal now; what this pair does wrong is
  // share their ONLY story, so neither owns anything and both are refused.
  assert.throws(
    () =>
      patchCapability(cap, {
        slices: [
          { id: "a", name: "a", order: 0, storyIds: ["s1"] },
          { id: "b", name: "b", order: 1, storyIds: ["s1"] },
        ],
      }),
    /own no story that no other slice has/,
  );
  assert.throws(
    () => patchCapability(cap, { slices: [{ id: "a", name: "a", order: 0, storyIds: ["ghost"] }] }),
    /story/i,
  );
});

test("applyStoryToggles: toggles apply to the capability; text/count drift throws", () => {
  const cap = fixture();
  const out = applyStoryToggles(cap, "sl1", [
    { id: "s1", text: "create tour time slots", done: true, verifiedBy: "manual 2026-08-07" },
    { id: "s2", text: "edit tour time slots", done: false },
  ]);
  assert.equal(cap.stories.find((s) => s.id === "s1")?.done, true);
  assert.equal(cap.stories.find((s) => s.id === "s1")?.verifiedBy, "manual 2026-08-07");
  assert.deepEqual(
    out.map((s) => s.id),
    ["s1", "s2"],
  );
  assert.throws(
    () => applyStoryToggles(cap, "sl1", [{ id: "s1", text: "REWRITTEN", done: true }]),
    /toggle-only|text/i,
  );
  assert.throws(
    () => applyStoryToggles(cap, "sl1", [{ id: "s1", text: "create tour time slots", done: true }]),
    /count|missing/i,
  );
  assert.throws(() => applyStoryToggles(cap, "ghost", []), /slice/i);
  assert.throws(
    () =>
      applyStoryToggles(cap, "sl1", [
        { id: "s1", text: "create tour time slots", done: true },
        { id: "s1", text: "create tour time slots", done: false },
      ]),
    /duplicate|toggle-only/i,
  );
});

test("renderSpecSkeleton: title, date, draft status, one checkbox per story", () => {
  const cap = fixture();
  const md = renderSpecSkeleton("tour scheduling v1", sliceStories(cap, "sl1"), "2026-08-06");
  assert.match(md, /^# tour scheduling v1 — design\n/);
  assert.match(md, /\nDate: 2026-08-06\nStatus: draft\n/);
  assert.match(md, /\n## Goal\n/);
  assert.match(md, /\n## Acceptance criteria\n\n- \[ \] create tour time slots\n- \[ \] edit tour time slots\n$/);
});

test("store round-trip + malformed isolation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caps-"));
  const cap = fixture();
  await saveCapability(dir, cap);
  await writeFile(join(dir, "broken.json"), "{nope");
  const { capabilities, errors } = await loadCapabilities(dir);
  assert.deepEqual(
    capabilities.map((c) => c.id),
    ["skoolscout-school-feature-set"],
  );
  assert.equal(errors.length, 1);
  await deleteCapabilityFile(dir, cap.id);
  assert.deepEqual((await loadCapabilities(dir)).capabilities, []);
  await assert.rejects(saveCapability(dir, { ...cap, id: "../evil" }), /id/i);
});

// boards-into-workspaces final fix wave (2026-08-16): production calls both
// functions with `this.boardDirs()` (every workspace dir first, host last —
// loadAllBoards's required order) to READ, and `this.boardDir(board)` to
// resolve WHERE each board it touches actually belongs. A board already
// migrated into its workspace directory must be visible to both — a
// single-directory read (the old signature; still how POST /workspaces'
// creation-time call below reasons about its own one directory) silently
// misses it: resyncLinkedCards finds nothing to update, and
// ensureWorkspaceBoards mints a fresh EMPTY duplicate that shadows the real
// board once it's written to the wrong (host) directory.
test("resyncLinkedCards: finds and updates a linked card whose board lives in a WORKSPACE directory, not the host one", async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "work-host-"));
  const wsDir = await mkdtemp(join(tmpdir(), "work-ws-"));
  const board = createBoard("plan", "skoolscout");
  const cap = fixture();
  const card = sendSliceToBoard(cap, cap.slices[0], board);
  await saveBoard(wsDir, board); // migrated: the board lives ONLY in the workspace directory
  cap.slices[0].capCardRef = { boardId: board.id, cardId: card.id };

  // The edit the map made: drop s2, leaving only s1.
  patchCapability(cap, { slices: [{ ...cap.slices[0], storyIds: ["s1"] }] });
  await resyncLinkedCards([wsDir, hostDir], () => wsDir, cap);

  const { boards: after } = await loadBoards(wsDir);
  const afterCard = after.find((b) => b.id === board.id)!.cards.find((c) => c.id === card.id)!;
  assert.deepEqual(
    afterCard.stories?.map((s) => s.id),
    ["s1"],
    "the checklist should have followed the edit — a host-dir-only read leaves it frozen on the send-time snapshot",
  );
});

test("ensureWorkspaceBoards: does not recreate a duplicate when the board already exists in a WORKSPACE directory", async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "work-host-"));
  const wsDir = await mkdtemp(join(tmpdir(), "work-ws-"));
  const board = createBoard("plan", "acme");
  addCard(board, { title: "real work already in flight" });
  await saveBoard(wsDir, board); // migrated: lives in the workspace directory, not the host one

  await ensureWorkspaceBoards([wsDir, hostDir], () => wsDir, "acme");

  const { boards: hostBoards } = await loadBoards(hostDir);
  assert.deepEqual(hostBoards, [], "nothing should ever be written to the host directory here");

  const { boards: wsBoards } = await loadBoards(wsDir);
  assert.deepEqual(
    wsBoards.map((b) => b.id).sort(),
    ["acme-deliver", "acme-ideation", "acme-plan"],
    "the two missing boards are created, the existing one is not duplicated",
  );
  assert.deepEqual(
    wsBoards.find((b) => b.id === "acme-plan")?.cards.map((c) => c.title),
    ["real work already in flight"],
    "the real board's card must survive untouched — not shadowed by a fresh empty shell",
  );
});

test("ensureWorkspaceBoards: creates the standing three once, idempotent, never release/reactive/maintenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  await ensureWorkspaceBoards([dir], () => dir, "skoolscout");
  await ensureWorkspaceBoards([dir], () => dir, "skoolscout");
  const { boards } = await loadBoards(dir);
  assert.deepEqual(boards.map((b) => [b.id, b.workspaceId]).sort(), [
    ["skoolscout-deliver", "skoolscout"],
    ["skoolscout-ideation", "skoolscout"],
    ["skoolscout-plan", "skoolscout"],
  ]);
  assert.deepEqual(boards.find((b) => b.id === "skoolscout-plan")?.columns.map((c) => c.id)[0], "queue");
});

test("ensureWorkspaceBoards: rejects a name too long to fit a board id — why POST /workspaces provisions best-effort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  // Workspace names are already slugged by the route, so the only reachable
  // failure is length: BOARD_ID_RE caps ids at 64 chars. A workspace that has
  // already saved must not 500 because its boards could not be minted.
  await assert.rejects(
    ensureWorkspaceBoards([dir], () => dir, "a".repeat(60)),
    /board id/i,
  );
  assert.deepEqual((await loadBoards(dir)).boards, []);
});

test("ensurePersonalBoard creates exactly one workspace-less board and is idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  await ensurePersonalBoard(dir);
  await ensurePersonalBoard(dir);
  const { boards } = await loadBoards(dir);
  assert.equal(boards.length, 1);
  assert.equal(boards[0].id, "personal");
  assert.equal(boards[0].workspaceId, undefined);
  assert.deepEqual(
    boards[0].columns.map((c) => c.name),
    ["My plate", "Today", "Done", "Not Doing"],
  );
});

test("sendSliceToBoard: first working column (Queue is system intake), story copies, capabilityRef", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  await ensureWorkspaceBoards([dir], () => dir, "skoolscout");
  const { boards } = await loadBoards(dir);
  const board = boards.find((b) => b.id === boardIdFor("skoolscout", "plan"));
  const cap = fixture();
  const card = sendSliceToBoard(cap, cap.slices[0], board!);
  assert.equal(card.title, "tour scheduling v1");
  // A slice send is the USER's move, so it lands in Spec — the first working
  // column — not the Queue intake lane.
  assert.equal(card.columnId, "define");
  assert.deepEqual(card.capabilityRef, { capabilityId: "skoolscout-school-feature-set", sliceId: "sl1" });
  assert.deepEqual(
    card.stories?.map((s) => s.text),
    ["create tour time slots", "edit tour time slots"],
  );
  assert.notEqual(card.stories, cap.stories); // copies, not shared references
});

test("resyncLinkedCards: editing a slice after sending refreshes both linked cards, not just the map (C1)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  await ensureWorkspaceBoards([dir], () => dir, "skoolscout");
  const { boards } = await loadBoards(dir);
  const capBoard = boards.find((b) => b.id === boardIdFor("skoolscout", "plan"))!;
  const deliveryBoard = boards.find((b) => b.id === boardIdFor("skoolscout", "deliver"))!;
  const cap = fixture();
  const capCard = sendSliceToBoard(cap, cap.slices[0], capBoard);
  await saveBoard(dir, capBoard);
  const deliveryCard = sendSliceToBoard(cap, cap.slices[0], deliveryBoard);
  await saveBoard(dir, deliveryBoard);
  cap.slices[0].capCardRef = { boardId: capBoard.id, cardId: capCard.id };
  cap.slices[0].deliveryCardRef = { boardId: deliveryBoard.id, cardId: deliveryCard.id };

  // Edit the slice in the map: drop s2, leaving only s1 — same edit that
  // used to brick applyStoryToggles on both cards forever.
  patchCapability(cap, { slices: [{ ...cap.slices[0], storyIds: ["s1"] }] });
  await resyncLinkedCards([dir], () => dir, cap);

  const { boards: after } = await loadBoards(dir);
  const afterCapCard = after.find((b) => b.id === capBoard.id)!.cards.find((c) => c.id === capCard.id)!;
  const afterDeliveryCard = after.find((b) => b.id === deliveryBoard.id)!.cards.find((c) => c.id === deliveryCard.id)!;
  assert.deepEqual(
    afterCapCard.stories?.map((s) => s.id),
    ["s1"],
  );
  assert.deepEqual(
    afterDeliveryCard.stories?.map((s) => s.id),
    ["s1"],
  );
  assert.notEqual(afterCapCard.stories, afterDeliveryCard.stories); // independent copies, not shared references
  // What used to 400 forever now succeeds against the refreshed copy.
  assert.doesNotThrow(() => applyStoryToggles(cap, "sl1", [{ id: "s1", text: "create tour time slots", done: true }]));

  // Unassigning every remaining story leaves an empty checklist, not a stale one.
  //
  // Set DIRECTLY rather than through patchCapability, which now refuses to empty a
  // healthy slice — emptying it is precisely what leaves it owning nothing. The
  // state is still reachable in production and this test still matters: the two
  // storyless slices live in jefelabs-school-visits are grandfathered, so resync
  // has to keep handling exactly this shape. patchCapability was only ever the
  // convenient way to reach it, and resyncLinkedCards is the unit under test.
  cap.slices = [{ ...cap.slices[0], storyIds: [] }];
  await resyncLinkedCards([dir], () => dir, cap);
  const { boards: emptied } = await loadBoards(dir);
  const emptiedCard = emptied.find((b) => b.id === capBoard.id)!.cards.find((c) => c.id === capCard.id)!;
  assert.deepEqual(emptiedCard.stories, []);
});

test("unlinkSliceCard: clears only the matching ref (I1); no-op for an unrelated card or slice", () => {
  const cap = fixture();
  cap.slices[0].capCardRef = { boardId: "b1", cardId: "c1" };
  cap.slices[0].deliveryCardRef = { boardId: "b2", cardId: "c2" };
  assert.equal(unlinkSliceCard(cap, "sl1", "c1"), true);
  assert.equal(cap.slices[0].capCardRef, undefined);
  assert.deepEqual(cap.slices[0].deliveryCardRef, { boardId: "b2", cardId: "c2" });
  assert.equal(unlinkSliceCard(cap, "sl1", "ghost-card"), false);
  assert.equal(unlinkSliceCard(cap, "ghost-slice", "c2"), false);
});

test("a ROUTED linked card still resyncs and still unlinks — the ref boardId is a hint, the cardId the key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  await ensureWorkspaceBoards([dir], () => dir, "skoolscout");
  const { boards } = await loadBoards(dir);
  const plan = boards.find((b) => b.id === boardIdFor("skoolscout", "plan"))!;
  const deliver = boards.find((b) => b.id === boardIdFor("skoolscout", "deliver"))!;
  const cap = fixture();
  const card = sendSliceToBoard(cap, cap.slices[0], plan);
  cap.slices[0].capCardRef = { boardId: plan.id, cardId: card.id };

  // The spec's headline flow, not an edge case: drag spec → ready, then
  // "Send to deliver". The card changes board file; the ref does not.
  card.columnId = "ready";
  const routed = routeCard(plan, deliver, card.id, resolveExit(plan, "ready", "deliver")!, new Date().toISOString());
  await saveBoard(dir, deliver);
  await saveBoard(dir, plan);
  assert.deepEqual(routed.card.capabilityRef, { capabilityId: cap.id, sliceId: "sl1" });
  assert.equal(cap.slices[0].capCardRef!.boardId, plan.id, "the stale ref is the precondition under test");

  // A map edit must still reach the card on its new board.
  patchCapability(cap, { slices: [{ ...cap.slices[0], storyIds: ["s1"] }] });
  await resyncLinkedCards([dir], () => dir, cap);
  const { boards: after } = await loadBoards(dir);
  const onDeliver = after.find((b) => b.id === deliver.id)!.cards.find((c) => c.id === card.id)!;
  assert.deepEqual(
    onDeliver.stories?.map((s) => s.id),
    ["s1"],
  );
  assert.equal(after.find((b) => b.id === plan.id)!.cards.length, 0);

  // And deleting the capability must still unlink it: a card left `linked`
  // to a capability that no longer exists is toggle-only forever with no UI
  // to clear it.
  assert.deepEqual(
    unlinkCapabilityCards(after, cap).map((b) => b.id),
    [deliver.id],
  );
  assert.equal(after.find((b) => b.id === deliver.id)!.cards.find((c) => c.id === card.id)!.capabilityRef, undefined);
});

test("repointSliceCardRef: retargets whichever ref holds the card, leaves the sibling and a re-send 409 alone", () => {
  const cap = fixture();
  cap.slices[0].capCardRef = { boardId: "acme-plan", cardId: "c1" };
  cap.slices[0].deliveryCardRef = { boardId: "acme-deliver", cardId: "c2" };

  assert.equal(repointSliceCardRef(cap, "c1", "acme-deliver"), true);
  assert.deepEqual(cap.slices[0].capCardRef, { boardId: "acme-deliver", cardId: "c1" });
  assert.deepEqual(cap.slices[0].deliveryCardRef, { boardId: "acme-deliver", cardId: "c2" });
  // The ref is still SET, so re-sending this slice still 409s rather than
  // minting a duplicate card for it.
  assert.ok(cap.slices[0].capCardRef);

  assert.equal(repointSliceCardRef(cap, "c1", "acme-deliver"), false, "already there — no write, no updatedAt bump");
  assert.equal(repointSliceCardRef(cap, "ghost-card", "acme-plan"), false);
});

test("patchCapability stamps NEW and content-changed stories/slices; untouched ones carry their stamp forward", () => {
  const cap = createCapability("jefelabs", "c");
  cap.activities = [{ id: "a1", name: "a", order: 0, steps: [{ id: "st1", name: "s", order: 0 }] }];
  cap.stories = [
    { id: "s1", stepId: "st1", order: 0, text: "one", done: false, updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "s2", stepId: "st1", order: 1, text: "two", done: false, updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  cap.slices = [{ id: "sl1", name: "old slice", order: 0, storyIds: ["s1"], updatedAt: "2026-01-01T00:00:00.000Z" }];
  const patched = patchCapability(cap, {
    stories: [
      // s1 re-worded (touch), s2 only re-ordered (NOT a touch), s3 new (touch).
      { id: "s1", stepId: "st1", order: 1, text: "one reworded", done: false },
      { id: "s2", stepId: "st1", order: 0, text: "two", done: false },
      { id: "s3", stepId: "st1", order: 2, text: "three", done: false },
    ],
    slices: [
      { id: "sl1", name: "old slice", order: 5, storyIds: ["s1"] }, // order-only move — not a touch
      { id: "sl2", name: "new slice", order: 1, storyIds: ["s3"] },
    ],
  });
  const story = (id: string) => patched.stories.find((s) => s.id === id);
  assert.notEqual(story("s1")?.updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(story("s2")?.updatedAt, "2026-01-01T00:00:00.000Z"); // carried forward despite no round-trip
  assert.ok(story("s3")?.updatedAt);
  assert.equal(patched.slices[0].updatedAt, "2026-01-01T00:00:00.000Z");
  assert.ok(patched.slices[1].updatedAt);
  assert.notEqual(patched.slices[1].updatedAt, "2026-01-01T00:00:00.000Z");
});

test("applyStoryToggles stamps only stories whose state changed, and their containing slices", () => {
  const cap = createCapability("jefelabs", "c");
  cap.activities = [{ id: "a1", name: "a", order: 0, steps: [{ id: "st1", name: "s", order: 0 }] }];
  cap.stories = [
    { id: "s1", stepId: "st1", order: 0, text: "one", done: false, updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "s2", stepId: "st1", order: 1, text: "two", done: true, updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  cap.slices = [
    { id: "sl1", name: "hit", order: 0, storyIds: ["s1"], updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "sl2", name: "missed", order: 1, storyIds: ["s2"], updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  cap.slices[0].storyIds = ["s1", "s2"];
  applyStoryToggles(cap, "sl1", [
    { id: "s1", text: "one", done: true }, // real change
    { id: "s2", text: "two", done: true }, // no-op resend
  ]);
  assert.notEqual(cap.stories[0].updatedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(cap.stories[1].updatedAt, "2026-01-01T00:00:00.000Z");
  assert.notEqual(cap.slices[0].updatedAt, "2026-01-01T00:00:00.000Z"); // contains s1
  assert.equal(cap.slices[1].updatedAt, "2026-01-01T00:00:00.000Z"); // contains only the untouched s2
});

test("patchCapability rejects fractional and negative story points; a points change is a touch", () => {
  const cap = createCapability("jefelabs", "c");
  cap.activities = [{ id: "a1", name: "a", order: 0, steps: [{ id: "st1", name: "s", order: 0 }] }];
  cap.stories = [
    { id: "s1", stepId: "st1", order: 0, text: "one", done: false, updatedAt: "2026-01-01T00:00:00.000Z" },
    { id: "s2", stepId: "st1", order: 1, text: "two", done: false, updatedAt: "2026-01-01T00:00:00.000Z" },
  ];
  assert.throws(
    () => patchCapability(cap, { stories: [{ id: "s1", stepId: "st1", order: 0, text: "one", done: false, points: 1.5 }] }),
    /whole number/,
  );
  assert.throws(
    () => patchCapability(cap, { stories: [{ id: "s1", stepId: "st1", order: 0, text: "one", done: false, points: -1 }] }),
    /whole number/,
  );
  const patched = patchCapability(cap, {
    stories: [
      { id: "s1", stepId: "st1", order: 0, text: "one", done: false, points: 3 },
      { id: "s2", stepId: "st1", order: 1, text: "two", done: false },
    ],
  });
  assert.equal(patched.stories[0].points, 3);
  assert.notEqual(patched.stories[0].updatedAt, "2026-01-01T00:00:00.000Z"); // estimated = touched
  assert.equal(patched.stories[1].updatedAt, "2026-01-01T00:00:00.000Z"); // untouched carries forward
});

test("sendSliceToBoard and resyncLinkedCards copy story points onto the card rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caps-points-"));
  const cap = createCapability("jefelabs", "c");
  cap.activities = [{ id: "a1", name: "a", order: 0, steps: [{ id: "st1", name: "s", order: 0 }] }];
  cap.stories = [{ id: "s1", stepId: "st1", order: 0, text: "one", done: false, points: 5 }];
  cap.slices = [{ id: "sl1", name: "v1", order: 0, storyIds: ["s1"] }];
  const board = { id: "b1", name: "plan", type: "plan" as const, workspaceId: "jefelabs", columns: [{ id: "queue", name: "Queue" }, { id: "spec", name: "Spec" }], cards: [] };
  const card = sendSliceToBoard(cap, cap.slices[0], board);
  assert.equal(card.stories?.[0].points, 5);
  // Re-estimate, then resync: the linked card's copy follows the map.
  cap.stories[0].points = 8;
  cap.slices[0].capCardRef = { boardId: "b1", cardId: card.id };
  await import("node:fs/promises").then((fs) => fs.mkdir(join(dir, "work"), { recursive: true }));
  await writeFile(join(dir, "work", "b1.json"), JSON.stringify(board));
  await resyncLinkedCards([join(dir, "work")], () => join(dir, "work"), cap);
  const saved = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "work", "b1.json"), "utf8")));
  assert.equal(saved.cards[0].stories[0].points, 8);
});
