import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { smithPaths } from "./paths.js";
import { cloneRepoInto, ensureConfigRepo, materializeRepos } from "./workspace-repos.js";

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

/** A real local git repo to clone from — never the network. */
function makeOrigin(label: string): string {
  const origin = mkdtempSync(join(tmpdir(), `origin-${label}-`));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: origin });
  writeFileSync(join(origin, "README.md"), "origin content\n");
  execFileSync("git", ["add", "-A"], { cwd: origin });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: origin });
  return origin;
}

test("cloneRepoInto: clones into <workspace>/<repo name> and returns that path", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-"));
  const origin = makeOrigin("a");
  try {
    const path = await cloneRepoInto(ws, { name: "app", path: "", repository: origin });

    assert.equal(path, join(ws, "app"), "returns the in-workspace path");
    assert.ok(statSync(join(ws, "app", ".git")).isDirectory(), "it is a real clone");
    assert.equal(readFileSync(join(ws, "app", "README.md"), "utf8"), "origin content\n");
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("cloneRepoInto: an existing clone is reused, not re-cloned over", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-twice-"));
  const origin = makeOrigin("b");
  try {
    await cloneRepoInto(ws, { name: "app", path: "", repository: origin });
    writeFileSync(join(ws, "app", "LOCAL.md"), "local work\n");

    const path = await cloneRepoInto(ws, { name: "app", path: "", repository: origin });

    assert.equal(path, join(ws, "app"));
    assert.equal(
      readFileSync(join(ws, "app", "LOCAL.md"), "utf8"),
      "local work\n",
      "local work in an existing clone survives — we did not clone over it",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("cloneRepoInto: refuses a repo with no remote to clone from", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-norepo-"));
  try {
    await assert.rejects(
      () => cloneRepoInto(ws, { name: "app", path: "/somewhere/else" }),
      /no repository URL/i,
      "says why it cannot be cloned",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cloneRepoInto: checks out the recorded branch", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-branch-"));
  const origin = makeOrigin("c");
  try {
    execFileSync("git", ["checkout", "-q", "-b", "develop"], { cwd: origin });
    writeFileSync(join(origin, "ON_DEVELOP.md"), "yes\n");
    execFileSync("git", ["add", "-A"], { cwd: origin });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "dev"], { cwd: origin });
    execFileSync("git", ["checkout", "-q", "main"], { cwd: origin });

    await cloneRepoInto(ws, { name: "app", path: "", repository: origin, branch: "develop" });

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: join(ws, "app") })
      .toString()
      .trim();
    assert.equal(branch, "develop");
    assert.ok(statSync(join(ws, "app", "ON_DEVELOP.md")).isFile());
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("cloneRepoInto: rejects a repository URL starting with -", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-dash-repo-"));
  try {
    await assert.rejects(
      () => cloneRepoInto(ws, { name: "app", path: "", repository: "-e open | sh" }),
      /invalid repository URL/i,
      "rejects dash-leading repository to prevent argument injection",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cloneRepoInto: rejects a branch starting with -", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-dash-branch-"));
  const origin = makeOrigin("d");
  try {
    await assert.rejects(
      () => cloneRepoInto(ws, { name: "app", path: "", repository: origin, branch: "-e open | sh" }),
      /invalid branch/i,
      "rejects dash-leading branch to prevent argument injection",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("cloneRepoInto: detects partial clones and refuses to reuse them", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-partial-"));
  const origin = makeOrigin("e");
  try {
    const appDir = join(ws, "app");
    mkdirSync(appDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: appDir });
    // At this point: .git exists but no commits, so hasCommit() returns false

    await assert.rejects(
      () => cloneRepoInto(ws, { name: "app", path: "", repository: origin }),
      /looks like an interrupted clone/i,
      "refuses to treat a partial clone as usable",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("cloneRepoInto: distinguishes interrupted clones from empty directories", async () => {
  const ws = mkdtempSync(join(tmpdir(), "clone-nonempty-"));
  const origin = makeOrigin("f");
  try {
    const appDir = join(ws, "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "some-file.txt"), "stale\n");
    // Directory is non-empty but not a git repo

    await assert.rejects(
      () => cloneRepoInto(ws, { name: "app", path: "", repository: origin }),
      /looks like an interrupted clone/i,
      "gives a distinguishing error for non-repo debris",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("materializeRepos: clones a URL-only repo and repoints its path inside the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "mat-"));
  const origin = makeOrigin("d");
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [{ name: "app", path: "", repository: origin }] };

    const out = await materializeRepos(paths, ws);

    const expected = join(paths.workspaces, "pg", "app");
    assert.equal(out.repos[0].path, expected, "path now points inside the workspace");
    assert.ok(statSync(join(expected, ".git")).isDirectory(), "and there is a real clone there");
    assert.equal(ws.repos[0].path, "", "the input record was not mutated");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("materializeRepos: a repo already at a valid local path is left where it is", async () => {
  const root = mkdtempSync(join(tmpdir(), "mat-keep-"));
  const origin = makeOrigin("e");
  try {
    const paths = smithPaths(root);
    const ws = { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] };

    const out = await materializeRepos(paths, ws);

    assert.equal(out.repos[0].path, origin, "an existing valid checkout is not relocated during creation");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("materializeRepos: also makes config/ a git repo", async () => {
  const root = mkdtempSync(join(tmpdir(), "mat-cfg-"));
  const origin = makeOrigin("f");
  try {
    const paths = smithPaths(root);

    await materializeRepos(smithPaths(root), { name: "pg", repos: [{ name: "app", path: "", repository: origin }] });

    const cfg = join(paths.workspaces, "pg", "config");
    assert.ok(statSync(join(cfg, ".git")).isDirectory(), "config/ is a repo after creation");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});
