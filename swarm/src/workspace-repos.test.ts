import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureConfigRepo } from "./workspace-repos.js";

test("ensureConfigRepo: turns config/ into a git repo with the settings file committed", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cfgrepo-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[]}\n');

    const created = await ensureConfigRepo(ws);

    assert.equal(created, true, "reports that it created the repo");
    const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: join(ws, "config") })
      .toString()
      .trim();
    assert.ok(gitDir.length > 0, "config/ is a git repo");
    const tracked = execFileSync("git", ["ls-files"], { cwd: join(ws, "config") }).toString();
    assert.match(tracked, /settings\.json/, "the settings file is committed, not just present");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensureConfigRepo: is idempotent and never rewrites history", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cfgrepo-twice-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[]}\n');
    await ensureConfigRepo(ws);
    const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(ws, "config") })
      .toString()
      .trim();

    const created = await ensureConfigRepo(ws);

    assert.equal(created, false, "reports that it found an existing repo");
    const second = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(ws, "config") })
      .toString()
      .trim();
    assert.equal(second, first, "HEAD is unchanged — no new commit, no re-init");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensureConfigRepo: an existing repo with uncommitted edits is left completely alone", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cfgrepo-dirty-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[]}\n');
    await ensureConfigRepo(ws);
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[],"edited":true}\n');

    await ensureConfigRepo(ws);

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: join(ws, "config") }).toString();
    assert.match(status, /settings\.json/, "the edit is still uncommitted — we did not commit on the user's behalf");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensureConfigRepo: self-heals a commit-less repo from a partial prior init", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cfgrepo-partial-"));
  try {
    mkdirSync(join(ws, "config"), { recursive: true });
    writeFileSync(join(ws, "config", "settings.json"), '{"name":"pg","repos":[]}\n');
    // Simulate a partial init: git init succeeded but add/commit failed
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: join(ws, "config") });

    const created = await ensureConfigRepo(ws);

    assert.equal(created, true, "reports that it completed the partial init");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(ws, "config") })
      .toString()
      .trim();
    assert.ok(head.length > 0, "HEAD now resolves — a commit exists");
    const tracked = execFileSync("git", ["ls-files"], { cwd: join(ws, "config") }).toString();
    assert.match(tracked, /settings\.json/, "settings.json is tracked");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
