import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendUpdate, feedPath, readFeed } from "./squad-feed.js";

test("feedPath: the feed lives with the instance, in its unversioned half", () => {
  assert.equal(feedPath("/i"), join("/i", ".runtime", "updates.jsonl"));
});

test("appendUpdate: one JSON object per line, with attribution and a timestamp", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-"));
  try {
    await appendUpdate(dir, "Fabian", "interface committed");
    await appendUpdate(dir, "Santiago", { status: "SUCCESS", summary: "tests green" });

    const lines = readFileSync(feedPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 2, "one line per update");
    const first = JSON.parse(lines[0]);
    assert.equal(first.agentName, "Fabian");
    assert.equal(first.update, "interface committed");
    assert.match(first.timestamp, /^\d{4}-\d{2}-\d{2}T/, "ISO timestamp");
    assert.deepEqual(JSON.parse(lines[1]).update, { status: "SUCCESS", summary: "tests green" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendUpdate: an update containing a newline stays ONE line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-nl-"));
  try {
    await appendUpdate(dir, "Fabian", "line one\nline two");
    const lines = readFileSync(feedPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 1, "a newline in the payload must not split the record");
    assert.equal(JSON.parse(lines[0]).update, "line one\nline two");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFeed: empty when there is no feed yet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-none-"));
  try {
    assert.deepEqual(await readFeed(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFeed: returns updates in append order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-order-"));
  try {
    for (const n of ["a", "b", "c"]) await appendUpdate(dir, n, n);
    assert.deepEqual(
      (await readFeed(dir)).map((u) => u.agentName),
      ["a", "b", "c"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFeed: since returns only later entries, so a member can poll", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-since-"));
  try {
    let t = 0;
    const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++));
    await appendUpdate(dir, "a", "1", clock);
    const second = await appendUpdate(dir, "b", "2", clock);
    await appendUpdate(dir, "c", "3", clock);

    const later = await readFeed(dir, { since: second.timestamp });

    assert.deepEqual(
      later.map((u) => u.agentName),
      ["c"],
      "since is exclusive",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFeed: a corrupt line does not lose the rest of the feed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-bad-"));
  try {
    await appendUpdate(dir, "a", "1");
    writeFileSync(feedPath(dir), `${readFileSync(feedPath(dir), "utf8")}{not json\n`);
    await appendUpdate(dir, "c", "3");

    const feed = await readFeed(dir);

    assert.deepEqual(
      feed.map((u) => u.agentName),
      ["a", "c"],
      "the readable entries survive",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
