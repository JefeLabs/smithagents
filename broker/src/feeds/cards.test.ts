import assert from "node:assert/strict";
import { test } from "node:test";
import { boardTypeFor, cardForRelease, cardTitle } from "./cards.ts";
import type { FeedItem, ReleaseItem } from "./types.ts";

const rel = (over: Partial<NonNullable<FeedItem["release"]>> = {}): ReleaseItem => ({
  id: "r1",
  sourceId: "s",
  tag: "release",
  title: "spring-boot 4.1.0",
  publishedAt: "2026-08-11T00:00:00Z",
  summary: "Virtual threads by default.",
  release: { name: "spring-boot", version: "4.1.0", bump: "minor", security: false, ...over },
});

const BOARDS = [
  { id: "b-maint", type: "maintenance", workspaceId: "jefelabs" },
  { id: "b-react", type: "reactive", workspaceId: "jefelabs" },
  { id: "b-maint-other", type: "maintenance", workspaceId: "acme" },
];

function deps(sink: unknown[]) {
  return {
    boards: async () => BOARDS,
    addCard: async (boardId: string, card: { title: string; notes: string; columnId: string }) =>
      void sink.push({ boardId, ...card }),
    plan: async () => "1. Read the notes\n2. Bump the version",
    now: () => "2026-08-11T10:00:00Z",
  };
}

test("an ordinary release lands on Maintenance, in Triage", async () => {
  const sink: unknown[] = [];
  const result = await cardForRelease(deps(sink), rel(), { workspace: "jefelabs", currentVersion: "4.0.7" });
  assert.equal(result.carded, true);
  assert.deepEqual(sink, [
    {
      boardId: "b-maint",
      title: "Upgrade spring-boot 4.0.7 → 4.1.0",
      notes: "1. Read the notes\n2. Bump the version",
      columnId: "triage",
    },
  ]);
});

test("a security release lands on Reactive instead", async () => {
  const sink: unknown[] = [];
  await cardForRelease(deps(sink), rel({ security: true }), { workspace: "jefelabs", currentVersion: "4.0.7" });
  assert.equal((sink[0] as { boardId: string }).boardId, "b-react");
});

test("the card goes to the board of the workspace that declared the dependency", async () => {
  const sink: unknown[] = [];
  await cardForRelease(deps(sink), rel(), { workspace: "acme", currentVersion: "4.0.0" });
  assert.equal((sink[0] as { boardId: string }).boardId, "b-maint-other");
});

test("an already-carded item is never carded twice", async () => {
  const sink: unknown[] = [];
  const result = await cardForRelease(
    deps(sink),
    { ...rel(), cardedAt: "2026-08-10T00:00:00Z" },
    { workspace: "jefelabs", currentVersion: "4.0.7" },
  );
  assert.equal(result.carded, false);
  assert.deepEqual(sink, []);
});

test("a missing board is reported, not thrown — conversation must not depend on the boards", async () => {
  const result = await cardForRelease({ ...deps([]), boards: async () => [] }, rel(), {
    workspace: "jefelabs",
    currentVersion: "4.0.7",
  });
  assert.equal(result.carded, false);
  assert.match(result.reason!, /no maintenance board/i);
});

test("a failing board write is reported, not thrown", async () => {
  const result = await cardForRelease(
    {
      ...deps([]),
      addCard: async () => {
        throw new Error("swarm unreachable");
      },
    },
    rel(),
    { workspace: "jefelabs", currentVersion: "4.0.7" },
  );
  assert.equal(result.carded, false);
  assert.match(result.reason!, /swarm unreachable/);
});

test("boardTypeFor and cardTitle stand alone", () => {
  assert.equal(boardTypeFor(rel()), "maintenance");
  assert.equal(boardTypeFor(rel({ security: true })), "reactive");
  assert.equal(cardTitle(rel(), "4.0.7"), "Upgrade spring-boot 4.0.7 → 4.1.0");
});
