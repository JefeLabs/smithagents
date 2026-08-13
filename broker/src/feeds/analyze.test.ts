import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeBrief, workItemsFrom } from "./analyze.ts";

test("the brief carries the source's own prompt and caps the raw payload", () => {
  const brief = analyzeBrief({ label: "Sentry acme", analyzePrompt: "only real incidents" }, "x".repeat(10_000));
  assert.match(brief, /only real incidents/);
  assert.match(brief, /Sentry acme/);
  assert.ok(brief.length < 7_000);
});

test("workItemsFrom parses WORK ITEM blocks and returns [] for NOTHING", () => {
  const parsed = workItemsFrom(
    "WORK ITEM: Fix payment webhook 500s\nSeen 42 times since Tuesday.\nWORK ITEM: Rotate expiring cert\nExpires in 6 days.",
  );
  assert.deepEqual(parsed, [
    { title: "Fix payment webhook 500s", notes: "Seen 42 times since Tuesday." },
    { title: "Rotate expiring cert", notes: "Expires in 6 days." },
  ]);
  assert.deepEqual(workItemsFrom("NOTHING"), []);
  assert.deepEqual(workItemsFrom(""), []);
});
