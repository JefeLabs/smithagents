import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

test("smithPaths: a relative root is resolved to absolute, so members can't split from it", () => {
  const p = smithPaths("state");
  const absoluteRoot = resolve("state");
  assert.equal(p.root, absoluteRoot);
  assert.equal(p.users, join(absoluteRoot, "users"));
});

test("smithPaths: the returned object is frozen — callers cannot repoint state at runtime", () => {
  const p = smithPaths("/state");
  assert.throws(() => {
    (p as unknown as Record<string, string>).users = "/tmp/hijacked";
  }, TypeError);
});

test("smithPaths: the org config repo is ONE directory under the root, named config", () => {
  const paths = smithPaths("/state");
  assert.equal(paths.orgRepo, join("/state", "config"));
});

/**
 * The refactor this guards is easy to undo one line at a time: the next feature
 * that needs a state path will reach back for process.cwd() and rebuild a
 * ".smith" path by hand, because that is what the surrounding code used to
 * look like. This test fails the moment that happens, and names the file and
 * line. (Written so this comment doesn't trip its own regex — see the check
 * below for the exact idiom it bans.)
 */
test("no source file builds a .smith path from process.cwd()", async () => {
  // Matched against the whole file (not per line) so a call that biome's
  // lineWidth:120 has wrapped across several lines is still caught. Matches
  // both resolve(...) and join(...), with or without a `process.` prefix, so
  // a destructured `cwd()` import doesn't slip past either.
  const banned = /(resolve|join)\(\s*(process\.)?cwd\(\)\s*,\s*["'`]\.smith/g;
  const entries = await readdir("src", { recursive: true });
  const offenders: string[] = [];
  for (const entry of entries) {
    const rel = String(entry);
    if (!rel.endsWith(".ts")) continue;
    const content = await readFile(join("src", rel), "utf8");
    for (const match of content.matchAll(banned)) {
      const line = content.slice(0, match.index).split("\n").length;
      offenders.push(`src/${rel}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `state paths must come from smithPaths(), not process.cwd():\n${offenders.join("\n")}`,
  );
});
