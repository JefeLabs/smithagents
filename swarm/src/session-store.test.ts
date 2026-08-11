import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type SessionRecord, SessionStore } from "./session-store.js";

const RECORD: SessionRecord = {
  id: "s-1",
  agentId: "octavio",
  agentName: "Octavio",
  tool: "claude",
  profileHash: "abc123",
  cwd: "/work/session-s-1",
  branch: "smith/session-s-1",
  tmuxSession: "smith-warm-s-1",
  createdAt: "2026-07-27T10:00:00.000Z",
  turns: 2,
};

async function store() {
  return new SessionStore(join(await mkdtemp(join(tmpdir(), "smith-sessions-")), "sessions"));
}

test("a saved record survives to be read back — the point of the store", async () => {
  const s = await store();
  await s.save(RECORD);
  assert.deepEqual(await s.load(), [RECORD]);
});

test("saving the same id twice updates rather than duplicating", async () => {
  const s = await store();
  await s.save(RECORD);
  await s.save({ ...RECORD, turns: 9 });
  const all = await s.load();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.turns, 9);
});

test("a destroyed session leaves no record to adopt next boot", async () => {
  const s = await store();
  await s.save(RECORD);
  await s.delete(RECORD.id);
  assert.deepEqual(await s.load(), []);
  // Deleting again is not an error — destroy may race with a manual cleanup.
  await s.delete(RECORD.id);
});

test("no session directory yet is a normal first boot, not a failure", async () => {
  assert.deepEqual(await (await store()).load(), []);
});

test("one corrupt record cannot stop the server adopting the intact ones", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "smith-sessions-")), "sessions");
  const s = new SessionStore(dir);
  await s.save(RECORD);
  await writeFile(join(dir, "torn.json"), '{"id":"torn", TRUNCATED');
  await writeFile(join(dir, "notes.txt"), "ignored — not a record");
  const all = await s.load();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.id, "s-1");
});
