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
