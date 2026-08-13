import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertGroup, expandGroup, type WorkspaceGroup, wouldCycle } from "./groups.js";
import type { Workspace } from "./workspaces.js";

const ws = (name: string, archived = false): Workspace => ({ name, archived, repos: [{ name, path: "/tmp/x" }] });
const g = (name: string, workspaces: string[] = [], groups: string[] = []): WorkspaceGroup => ({
  name,
  workspaces,
  groups,
});

describe("assertGroup", () => {
  it("accepts empty member arrays (a group may be built up gradually)", () => {
    assert.deepEqual(assertGroup("f.json", { name: "a", workspaces: [], groups: [] }).name, "a");
  });
  it("accepts a valid opt-in sprint config and rejects malformed ones", () => {
    const ok = assertGroup("f.json", {
      name: "a",
      workspaces: [],
      groups: [],
      sprint: { anchor: "2026-08-03", lengthDays: 14 },
    });
    assert.equal(ok.sprint?.lengthDays, 14);
    assert.throws(() =>
      assertGroup("f.json", { name: "a", workspaces: [], groups: [], sprint: { anchor: "2026-08-03", lengthDays: 0 } }),
    );
    assert.throws(() =>
      assertGroup("f.json", {
        name: "a",
        workspaces: [],
        groups: [],
        sprint: { anchor: "not-a-date", lengthDays: 14 },
      }),
    );
  });

  it("rejects a missing name or non-array members", () => {
    assert.throws(() => assertGroup("f.json", { workspaces: [], groups: [] }));
    assert.throws(() => assertGroup("f.json", { name: "a", workspaces: "x", groups: [] }));
  });
});

describe("expandGroup", () => {
  const workspaces = [ws("acme-web"), ws("acme-api"), ws("labs"), ws("old", true)];
  it("resolves nested membership transitively", () => {
    const all = [g("frontend", ["acme-web"]), g("acme", ["acme-api"], ["frontend"])];
    assert.deepEqual([...expandGroup("acme", all, workspaces)].sort(), ["acme-api", "acme-web"]);
  });
  it("survives cycles and skips missing/archived members", () => {
    const all = [g("a", ["acme-web", "gone", "old"], ["b"]), g("b", [], ["a"])];
    assert.deepEqual([...expandGroup("a", all, workspaces)], ["acme-web"]);
  });
  it("unknown group expands to nothing", () => {
    assert.equal(expandGroup("nope", [], workspaces).size, 0);
  });
});

describe("wouldCycle", () => {
  it("rejects a group that reaches itself transitively", () => {
    const all = [g("b", [], ["c"]), g("c", [], ["a"])];
    assert.equal(wouldCycle(g("a", [], ["b"]), all), true);
  });
  it("accepts a DAG", () => {
    const all = [g("b", [], ["c"]), g("c", [], [])];
    assert.equal(wouldCycle(g("a", [], ["b", "c"]), all), false);
  });
  it("rejects direct self-membership", () => {
    assert.equal(wouldCycle(g("a", [], ["a"]), []), true);
  });
});

describe("one context entity (spec 2026-08-13)", () => {
  it("groupViewsFrom splits members by each member's OWN kind; dangling names stay visible", async () => {
    const { groupViewsFrom } = await import("./groups.js");
    const all: Workspace[] = [
      ws("acme"),
      { name: "core", repos: [], members: ["acme", "platform", "ghost"] },
      { name: "platform", repos: [], members: ["acme"] },
    ];
    const views = groupViewsFrom(all);
    const core = views.find((v) => v.name === "core");
    assert.deepEqual(core?.workspaces, ["acme", "ghost"]); // ghost dangles under workspaces — visible
    assert.deepEqual(core?.groups, ["platform"]);
    // Expansion still resolves through the views exactly as before the merge.
    assert.deepEqual([...expandGroup("core", views, all.filter((w) => w.members === undefined))], ["acme"]);
  });

  it("save/load round-trips through the ONE store; an empty group STAYS a group", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveGroup, loadGroupsFromDir } = await import("./groups.js");
    const { loadAllContextsFromDir, loadWorkspacesFromDir, isGroupRecord } = await import("./workspaces.js");
    const dir = await mkdtemp(join(tmpdir(), "one-store-"));
    await saveGroup(dir, { name: "empty-g", workspaces: [], groups: [] });
    const [record] = await loadAllContextsFromDir(dir);
    assert.equal(isGroupRecord(record), true); // presence is the kind
    assert.deepEqual(await loadWorkspacesFromDir(dir), []); // never a plain workspace
    const [view] = await loadGroupsFromDir(dir);
    assert.deepEqual([view.name, view.workspaces, view.groups], ["empty-g", [], []]);
  });

  it("removeGroupFile refuses a plain workspace and deletes only groupish records", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveGroup, removeGroupFile } = await import("./groups.js");
    const dir = await mkdtemp(join(tmpdir(), "one-store-rm-"));
    await writeFile(join(dir, "acme.json"), JSON.stringify(ws("acme")));
    await saveGroup(dir, { name: "core", workspaces: ["acme"], groups: [] });
    await assert.rejects(() => removeGroupFile(dir, "acme"), /is a workspace, not a group/);
    await removeGroupFile(dir, "core");
    await assert.rejects(() => removeGroupFile(dir, "core"), /not found/);
  });

  it("migrateGroupsDir folds legacy files in, renames collisions, retires the dir", async () => {
    const { mkdtemp, mkdir, writeFile, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { migrateGroupsDir, loadGroupsFromDir } = await import("./groups.js");
    const base = await mkdtemp(join(tmpdir(), "one-store-mig-"));
    const groupsDir = join(base, "groups");
    const wsDir = join(base, "workspaces");
    await mkdir(groupsDir, { recursive: true });
    await mkdir(wsDir, { recursive: true });
    await writeFile(join(wsDir, "acme.json"), JSON.stringify(ws("acme")));
    await writeFile(join(groupsDir, "core.json"), JSON.stringify({ name: "core", workspaces: ["acme"], groups: [] }));
    // Collides with the existing workspace — must land renamed.
    await writeFile(join(groupsDir, "acme.json"), JSON.stringify({ name: "acme", workspaces: [], groups: ["core"] }));
    const log = await migrateGroupsDir(groupsDir, wsDir);
    assert.ok(log.some((l) => l.includes('renamed to "acme-group"')));
    const views = await loadGroupsFromDir(wsDir);
    assert.deepEqual(views.map((v) => v.name).sort(), ["acme-group", "core"]);
    assert.deepEqual(views.find((v) => v.name === "acme-group")?.groups, ["core"]);
    // The legacy dir is retired; a second run is a clean no-op.
    assert.deepEqual(await readdir(base).then((e) => e.sort()), ["groups.migrated", "workspaces"]);
    assert.deepEqual(await migrateGroupsDir(groupsDir, wsDir), []);
  });
});
