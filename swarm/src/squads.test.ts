import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSquadsFromDir, type SquadDefinition } from "./squads.js";

test("defaultSquad-shaped definitions accept 2 and 3 members, not only 4", () => {
  const two: SquadDefinition = {
    id: "alpha",
    members: [
      { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
      { name: "Fabian", pane: 2, model: "claude-fable", role: "architect", squad: "alpha" },
    ],
    leader: { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
  };
  assert.equal(two.members.length, 2, "the type permits a 2-member squad");
});

test("loadSquadsFromDir: a 3-member squad file loads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sq3-"));
  try {
    writeFileSync(
      join(dir, "trio.json"),
      JSON.stringify({
        id: "alpha",
        members: [
          { name: "Gabriel", pane: 1, model: "gemini-pro", role: "leader", squad: "alpha" },
          { name: "Fabian", pane: 2, model: "claude-fable", role: "architect", squad: "alpha" },
          { name: "Santiago", pane: 3, model: "claude-sonnet", role: "developer", squad: "alpha" },
        ],
      }),
    );

    const squads = await loadSquadsFromDir(dir);

    assert.equal(squads.length, 1);
    assert.equal(squads[0].members.length, 3);
    assert.equal(squads[0].leader.name, "Gabriel");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSquadsFromDir: a squad with no explicit leader uses the first member", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sq-nolead-"));
  try {
    writeFileSync(
      join(dir, "nolead.json"),
      JSON.stringify({
        id: "alpha",
        members: [
          { name: "Fabian", pane: 1, model: "claude-fable", role: "architect", squad: "alpha" },
          { name: "Santiago", pane: 2, model: "claude-sonnet", role: "developer", squad: "alpha" },
        ],
      }),
    );
    const squads = await loadSquadsFromDir(dir);
    assert.equal(squads.length, 1);
    assert.equal(squads[0].members.length, 2);
    assert.equal(squads[0].leader.name, "Fabian", "without an explicit leader, the first member is used");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
