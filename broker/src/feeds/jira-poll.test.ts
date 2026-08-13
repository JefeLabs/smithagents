import assert from "node:assert/strict";
import { test } from "node:test";
import { jiraItemsFrom } from "./jira-poll.ts";

test("issues map to items keyed by source+issue so a re-poll dedups in addItems", () => {
  const items = jiraItemsFrom(
    [{ key: "PROJ-1", summary: "Fix login", url: "https://a/browse/PROJ-1" }],
    "ctx:acme:jira-plan",
    "2026-08-13T12:00:00Z",
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: "ctx:acme:jira-plan-PROJ-1",
    sourceId: "ctx:acme:jira-plan",
    tag: "tech",
    title: "[PROJ-1] Fix login",
    url: "https://a/browse/PROJ-1",
    publishedAt: "2026-08-13T12:00:00Z",
    summary: "Fix login",
  });
});
