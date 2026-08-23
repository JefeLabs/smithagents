import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { warnLegacyBlueprints } from "./blueprints-legacy.ts";

function fixture(files: Record<string, string> | null) {
  const root = mkdtempSync(join(tmpdir(), "bp-legacy-"));
  const blueprintsDir = join(root, ".smith", "blueprints");
  if (files) {
    mkdirSync(blueprintsDir, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(blueprintsDir, name), body);
  }
  return { root, blueprintsDir, destination: join(root, "config", "blueprints") };
}

test("warnLegacyBlueprints: legacy blueprint files are named, with the exact destination — never silently unread", async () => {
  const { root, blueprintsDir, destination } = fixture({
    "retro.json": '{"id":"retro"}\n',
    "adr.json": '{"id":"adr"}\n',
    "notes.txt": "not a blueprint",
  });
  const logged: string[] = [];
  try {
    const notes = await warnLegacyBlueprints({ blueprintsDir, destination, log: (l) => logged.push(l) });
    assert.equal(notes.length, 1, `expected one warning, got ${JSON.stringify(notes)}`);
    const note = notes[0];
    assert.match(note, /adr\.json/, "names every legacy blueprint file");
    assert.match(note, /retro\.json/);
    assert.doesNotMatch(note, /notes\.txt/, "only *.json files are blueprints");
    assert.match(note, new RegExp(blueprintsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names where they are");
    assert.match(note, new RegExp(destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "names where they belong");
    assert.deepEqual(logged, notes, "logged live, not only returned");

    // A WARNING ONLY (final-review Minor 1): the swarm owns the org repo, so
    // the copy itself is Plan 3 work. Nothing here may move or touch a file.
    assert.deepEqual(readdirSync(blueprintsDir).sort(), ["adr.json", "notes.txt", "retro.json"]);
    assert.equal(readFileSync(join(blueprintsDir, "retro.json"), "utf8"), '{"id":"retro"}\n');
    assert.throws(() => readdirSync(destination), "the destination is NOT created, let alone written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("warnLegacyBlueprints: silent when there is nothing to say — no directory, or no *.json in it", async () => {
  const cases: Array<Record<string, string> | null> = [null, {}, { "README.md": "x" }];
  for (const files of cases) {
    const { root, blueprintsDir, destination } = fixture(files);
    const logged: string[] = [];
    try {
      assert.deepEqual(
        await warnLegacyBlueprints({ blueprintsDir, destination, log: (l) => logged.push(l) }),
        [],
        `expected no warning for ${JSON.stringify(files)}`,
      );
      assert.deepEqual(logged, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
