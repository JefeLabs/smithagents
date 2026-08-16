import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { smithPaths } from "./paths.js";

test("smithPaths: every state path hangs off the given root", () => {
  const p = smithPaths("/state");
  assert.equal(p.root, "/state");
  assert.equal(p.users, join("/state", "users"));
  assert.equal(p.workspaces, join("/state", "workspaces"));
  assert.equal(p.agents, join("/state", "agents"));
  assert.equal(p.cliTools, join("/state", "cli-tools.json"));
  assert.equal(p.apiKeys, join("/state", "api-keys.json"));
  assert.equal(p.containers, join("/state", "containers.json"));
  assert.equal(p.devices, join("/state", "devices.json"));
  assert.equal(p.channels, join("/state", "channels"));
  assert.equal(p.avatars, join("/state", "avatars"));
  assert.equal(p.sessions, join("/state", "sessions"));
  assert.equal(p.apiSessions, join("/state", "api-sessions"));
  assert.equal(p.work, join("/state", "work"));
  assert.equal(p.workCapabilities, join("/state", "work", "capabilities"));
  assert.equal(p.squads, join("/state", "squads"));
  assert.equal(p.groups, join("/state", "groups"));
});

test("smithPaths: legacy project markers keep their exact names", () => {
  const p = smithPaths("/state");
  assert.equal(p.legacyProjectFile, join("/state", "project.json"));
  assert.equal(p.legacyProjectsDir, join("/state", "projects"));
});

test("smithPaths.archived: timestamped sibling of the live directory", () => {
  const p = smithPaths("/state");
  assert.equal(p.archived("work", "20260816T120000"), join("/state", "work-archived-20260816T120000"));
  assert.equal(p.archived("squads", "S"), join("/state", "squads-archived-S"));
  assert.equal(p.archived("avatars", "S"), join("/state", "avatars-archived-S"));
  assert.equal(p.archived("agents", "S"), join("/state", "agents-archived-S"));
});

test("smithPaths: the returned object is frozen — callers cannot repoint state at runtime", () => {
  const p = smithPaths("/state");
  assert.throws(() => {
    (p as unknown as Record<string, string>).users = "/tmp/hijacked";
  }, TypeError);
});
