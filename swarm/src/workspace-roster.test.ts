import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRoster, rosterPathFor, saveRoster } from "./workspace-roster.js";

test("loadRoster: an absent roster is null, NOT an empty one", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-absent-"));
  try {
    const roster = await loadRoster(ws);
    assert.equal(roster, null, "absent means 'never recorded', which callers must not read as 'no agents'");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadRoster: an empty roster is a real, distinct value", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-empty-"));
  try {
    await saveRoster(ws, { agents: [], squads: [] });
    const roster = await loadRoster(ws);
    assert.deepEqual(roster, { agents: [], squads: [] }, "deliberately empty is not the same as absent");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadRoster: a malformed roster throws rather than looking unrecorded", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-bad-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(rosterPathFor(ws), "{not json");
    await assert.rejects(() => loadRoster(ws), /roster/i, "a corrupt roster must never read as a fresh workspace");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadRoster: a roster missing its arrays is malformed, not partially valid", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-shape-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(rosterPathFor(ws), '{"agents":"fabian"}');
    await assert.rejects(() => loadRoster(ws), /roster/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("saveRoster: round-trips and lands inside config/", async () => {
  const ws = mkdtempSync(join(tmpdir(), "roster-rt-"));
  try {
    await saveRoster(ws, { agents: ["fabian"], squads: ["core"] });
    assert.equal(rosterPathFor(ws), join(ws, "config", "roster.json"));
    assert.deepEqual(await loadRoster(ws), { agents: ["fabian"], squads: ["core"] });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
