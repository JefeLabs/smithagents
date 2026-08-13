import assert from "node:assert/strict";
import { test } from "node:test";
import { seedSourceMigration } from "./source-migration.js";
import { createBoard } from "./work-items.js";
import type { Workspace } from "./workspaces.js";

const WS: Workspace = { name: "acme", repos: [{ name: "app", path: "/tmp/app" }] };

test("a repo-bearing workspace gains a releases source; its react/maintain queues bind to it", () => {
  const reactive = createBoard("reactive", "acme");
  const maintenance = createBoard("maintenance", "acme");
  const { workspaceWrites, boardWrites } = seedSourceMigration([structuredClone(WS)], [reactive, maintenance]);
  assert.equal(workspaceWrites.length, 1);
  const src = workspaceWrites[0].sources?.find((s) => s.id === "releases");
  assert.ok(src);
  assert.equal(src.preset, "releases");
  assert.equal(src.cadence, "nightly");
  assert.deepEqual(
    boardWrites.map((b) => b.queue?.sourceIds),
    [["releases"], ["releases"]],
  );
});

test("board.jira becomes a jira source bound to that board's queue", () => {
  const plan = createBoard("plan", "acme");
  plan.jira = { connectorId: "atl-1", siteUrl: "https://acme.atlassian.net", projectKey: "PROJ" };
  const { workspaceWrites, boardWrites } = seedSourceMigration([structuredClone(WS)], [plan]);
  const src = workspaceWrites[0].sources?.find((s) => s.id === "jira-plan");
  assert.ok(src);
  assert.equal(src.preset, "jira");
  assert.equal(src.origin.connectorId, "atl-1");
  assert.equal(src.origin.query, "project = PROJ ORDER BY updated DESC");
  assert.equal(src.transform.mode, "map");
  assert.deepEqual(boardWrites.find((b) => b.id === plan.id)?.queue?.sourceIds, ["jira-plan"]);
});

test("the migration is idempotent — a seeded state produces zero writes", () => {
  const reactive = createBoard("reactive", "acme");
  const first = seedSourceMigration([structuredClone(WS)], [reactive]);
  const again = seedSourceMigration(first.workspaceWrites, first.boardWrites);
  assert.equal(again.workspaceWrites.length, 0);
  assert.equal(again.boardWrites.length, 0);
});

test("groupish records and repo-less workspaces gain nothing", () => {
  const group: Workspace = { name: "core", repos: [], members: ["acme"] };
  const { workspaceWrites } = seedSourceMigration([group], []);
  assert.equal(workspaceWrites.length, 0);
});
