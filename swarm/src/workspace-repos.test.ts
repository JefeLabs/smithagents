import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { smithPaths } from "./paths.js";
import {
  CLONE_TIMEOUT_MS,
  cloneExecOptions,
  cloneRepoInto,
  commitConfigFiles,
  ensureOrgRepo,
  materializeRepos,
  migrateReposIntoWorkspace,
  repoDirFor,
  repoNameProblem,
  workspaceConfigPaths,
} from "./workspace-repos.js";
import { loadRoster } from "./workspace-roster.js";
import { configDirForName, loadWorkspaces, saveWorkspace } from "./workspaces.js";

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

test("materializeRepos: creates no repo of its own — it clones the project repo into the workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "mat-cfg-"));
  const origin = makeOrigin("f");
  try {
    const paths = smithPaths(root);

    await materializeRepos(smithPaths(root), { name: "pg", repos: [{ name: "app", path: "", repository: origin }] });

    assert.ok(
      statSync(join(paths.workspaces, "pg", "app", ".git")).isDirectory(),
      "the project repo was cloned into the workspace",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: clones an external repo inside and repoints the record", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-"));
  const origin = makeOrigin("g");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] });

    const result = await migrateReposIntoWorkspace(paths, [], []);

    assert.deepEqual(result.cloned, ["pg/app"]);
    const [ws] = await loadWorkspaces(paths);
    assert.equal(ws.repos[0].path, join(paths.workspaces, "pg", "app"), "record points inside the workspace");
    assert.ok(statSync(join(origin, ".git")).isDirectory(), "THE ORIGINAL CHECKOUT IS UNTOUCHED");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: an external repo with no remote is left alone, with a note", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-nourl-"));
  const origin = makeOrigin("h");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin }] });

    const result = await migrateReposIntoWorkspace(paths, [], []);

    assert.deepEqual(result.cloned, []);
    assert.deepEqual(result.skipped, ["pg/app"]);
    assert.equal((await loadWorkspaces(paths))[0].repos[0].path, origin, "record unchanged");
    assert.ok(
      result.notes.some((n) => n.includes("pg/app") && /repository URL/i.test(n)),
      "the note says what is missing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: is idempotent — a second run moves nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-twice-"));
  const origin = makeOrigin("i");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] });
    await migrateReposIntoWorkspace(paths, [], []);

    const second = await migrateReposIntoWorkspace(paths, [], []);

    assert.deepEqual(second.cloned, [], "nothing left to clone");
    assert.deepEqual(second.skipped, [], "and nothing is reported as a problem");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: one bad workspace does not stop the others", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-isolate-"));
  const origin = makeOrigin("j");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "bad", repos: [{ name: "app", path: "/nope", repository: "/does/not/exist" }] });
    await saveWorkspace(paths, { name: "good", repos: [{ name: "app", path: origin, repository: origin }] });

    const result = await migrateReposIntoWorkspace(paths, [], []);

    assert.ok(result.cloned.includes("good/app"), "the healthy workspace still migrated");
    assert.ok(result.skipped.includes("bad/app"), "the broken one is reported, not thrown");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

// --- fix round (review 1) -------------------------------------------------

test("migrateReposIntoWorkspace: a workspace with a malformed dir field is isolated, not fatal to boot", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-baddir-"));
  const origin = makeOrigin("k");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    mkdirSync(paths.workspaces, { recursive: true });
    // assertContext never type-checks `dir` (workspaces.ts), so a raw flat
    // record with a non-string `dir` loads fine even though workspaceDir()'s
    // resolve(ws.dir) cannot handle it — this must not escape the loop.
    writeFileSync(
      join(paths.workspaces, "bad.json"),
      JSON.stringify({ name: "bad", repos: [{ name: "app", path: "/nope", repository: "/does/not/exist" }], dir: 123 }),
    );
    await saveWorkspace(paths, { name: "good", repos: [{ name: "app", path: origin, repository: origin }] });

    const result = await migrateReposIntoWorkspace(paths, [], []);

    assert.ok(result.cloned.includes("good/app"), "the healthy workspace still migrated despite the bad one");
    assert.ok(result.skipped.includes("bad/app"), "the malformed workspace is reported, not thrown");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: a clone that succeeds but fails to save is reported skipped, never cloned", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-badsave-"));
  const origin = makeOrigin("l");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    mkdirSync(paths.workspaces, { recursive: true });
    // A name saveWorkspace's regex rejects (assertContext never enforces
    // it) — the clone itself succeeds, but the write-back that repoints the
    // record cannot.
    writeFileSync(
      join(paths.workspaces, "badname.json"),
      JSON.stringify({ name: "Bad Name", repos: [{ name: "app", path: origin, repository: origin }] }),
    );

    const result = await migrateReposIntoWorkspace(paths, [], []);

    assert.ok(!result.cloned.includes("Bad Name/app"), "a clone that could not be saved must not be reported cloned");
    assert.ok(result.skipped.includes("Bad Name/app"), "it is reported skipped instead");
    assert.ok(
      result.notes.some((n) => n.includes("Bad Name") && /could not save/i.test(n)),
      "the note explains the save failure",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("repoDirFor: rejects a repo name that would escape the workspace directory", () => {
  const ws = mkdtempSync(join(tmpdir(), "repodir-escape-"));
  try {
    assert.throws(
      () => repoDirFor(ws, { name: "../../escaped", path: "" }),
      /Repo "\.\.\/\.\.\/escaped"/,
      "rejects a name that would climb out of the workspace directory",
    );
    assert.throws(() => repoDirFor(ws, { name: "..", path: "" }), /Repo "\.\."/, 'also rejects a bare ".."');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("repoDirFor: rejects a name that would collapse the clone onto the workspace directory itself", () => {
  const ws = mkdtempSync(join(tmpdir(), "repodir-collapse-"));
  try {
    assert.throws(
      () => repoDirFor(ws, { name: ".", path: "" }),
      /Repo "\."/,
      'a bare "." doesn\'t escape but lands ON the workspace directory, merging config/ and .runtime/ into the clone',
    );
    assert.throws(() => repoDirFor(ws, { name: "", path: "" }), /Repo ""/, "an empty name is rejected too");
    assert.throws(
      () => repoDirFor(ws, { name: "   ", path: "" }),
      /Repo " {3}"/,
      "and one that's blank after trimming",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("cloneExecOptions: bounds the clone with a timeout and disables interactive credential prompts", () => {
  const opts = cloneExecOptions();
  assert.equal(opts.timeout, CLONE_TIMEOUT_MS, "a hung or unreachable remote must not block boot forever");
  assert.ok(CLONE_TIMEOUT_MS > 0 && CLONE_TIMEOUT_MS <= 20 * 60 * 1000, "bounded to a sane worst case");
  assert.equal(opts.env.GIT_TERMINAL_PROMPT, "0", "a repo needing credentials fails fast instead of prompting");
});

test("migrateReposIntoWorkspace: the first config commit captures the repointed record, not the stale one", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-commit-order-"));
  const origin = makeOrigin("m");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] });

    await migrateReposIntoWorkspace(paths, [], []);

    const committed = execFileSync("git", ["show", "HEAD:workspaces/pg/settings.json"], {
      cwd: paths.orgRepo,
    }).toString();
    assert.equal(
      JSON.parse(committed).repos[0].path,
      join(paths.workspaces, "pg", "app"),
      "the first commit already has the repointed path, not the external one",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: a clone failure note redacts credentials embedded in the repository URL", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-redact-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    // An unsupported transport fails instantly, with no network I/O — the
    // credentialed URL still lands verbatim in execFile's "Command failed"
    // line, which is what must be redacted before it reaches a note.
    const credentialed = "bogus://user:s3cr3t-token@nowhere.invalid/repo";
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: "/nope", repository: credentialed }] });

    const result = await migrateReposIntoWorkspace(paths, [], []);

    assert.ok(result.skipped.includes("pg/app"));
    for (const note of result.notes) {
      assert.ok(!note.includes("s3cr3t-token"), "the credential must never reach the boot log");
    }
    assert.ok(
      result.notes.some((n) => n.includes("pg/app") && n.includes("***@")),
      "the note still shows a redacted marker in place of the credential",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- fix round (final review) ---------------------------------------------

test("repoNameProblem: an empty or whitespace-only name gets its own message, not the escape one", () => {
  assert.doesNotMatch(repoNameProblem("") ?? "", /path separator/, "an empty name isn't a path-escape problem");
  assert.match(repoNameProblem("") ?? "", /empty/i, "says the actual problem: the name is empty");
  assert.match(repoNameProblem("   ") ?? "", /empty/i, "whitespace-only is empty once trimmed");
});

test("repoNameProblem: '..' padded with whitespace is rejected using the trimmed value", () => {
  assert.ok(repoNameProblem(" .. ") !== null, "a padded '..' still escapes once trimmed, so it must be rejected too");
});

test("migrateReposIntoWorkspace: a null globalAgentIds (id-gathering failed) leaves roster.json absent, not empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-roster-null-"));
  const origin = makeOrigin("o1");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] });

    await migrateReposIntoWorkspace(paths, null, []);

    assert.equal(
      await loadRoster(configDirForName(paths, "pg")),
      null,
      "roster.json must not exist — writing {agents:[],...} here would be a permanent, false 'assigned nothing'",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: an empty (but non-null) globalAgentIds also leaves roster.json absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-roster-empty-"));
  const origin = makeOrigin("o2");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] });

    await migrateReposIntoWorkspace(paths, [], []);

    assert.equal(
      await loadRoster(configDirForName(paths, "pg")),
      null,
      "an empty global agent list must not seed a permanent empty roster",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: a later boot with a real agent list seeds the roster correctly", async () => {
  const root = mkdtempSync(join(tmpdir(), "migrepo-roster-later-"));
  const origin = makeOrigin("o3");
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "pg", repos: [{ name: "app", path: origin, repository: origin }] });
    await migrateReposIntoWorkspace(paths, null, []); // first boot: id-gathering failed, nothing seeded

    await migrateReposIntoWorkspace(paths, ["fabian", "gina"], ["core"]); // second boot: real registry

    assert.deepEqual(
      await loadRoster(configDirForName(paths, "pg")),
      { agents: ["fabian", "gina"], squads: ["core"] },
      "a later boot with a working registry gets to seed it, because nothing was written before",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test("migrateReposIntoWorkspace: seeds the roster in the org subtree and commits it there", async () => {
  const root = mkdtempSync(join(tmpdir(), "repomig-roster-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "t" });
    await saveWorkspace(paths, { name: "pg", repos: [] } as never);

    await migrateReposIntoWorkspace(paths, ["anderson"], ["alpha"]);

    assert.deepEqual(await loadRoster(configDirForName(paths, "pg")), { agents: ["anderson"], squads: ["alpha"] });
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: paths.orgRepo }).toString();
    assert.match(tree, /^workspaces\/pg\/roster\.json$/m);
    assert.match(tree, /^workspaces\/pg\/settings\.json$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureOrgRepo: creates the org repo with settings.json committed; a second call is a no-op", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgrepo-"));
  try {
    const paths = smithPaths(root);
    assert.equal(await ensureOrgRepo(paths, { name: "acme" }), true);
    assert.deepEqual(JSON.parse(readFileSync(join(paths.orgRepo, "settings.json"), "utf8")), { name: "acme" });
    const tracked = execFileSync("git", ["ls-files"], { cwd: paths.orgRepo }).toString();
    assert.match(tracked, /^settings\.json$/m, "the org record is in HEAD");
    const first = execFileSync("git", ["rev-parse", "HEAD"], { cwd: paths.orgRepo }).toString().trim();

    assert.equal(await ensureOrgRepo(paths, { name: "acme" }), false);
    const second = execFileSync("git", ["rev-parse", "HEAD"], { cwd: paths.orgRepo }).toString().trim();
    assert.equal(first, second, "never a second commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureOrgRepo: heals a repo that was git-init'd but never committed", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgrepo-heal-"));
  try {
    const paths = smithPaths(root);
    mkdirSync(paths.orgRepo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: paths.orgRepo });
    assert.equal(await ensureOrgRepo(paths, { name: "acme" }), true);
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: paths.orgRepo });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspaceConfigPaths: every allowlisted path is under the workspace's own subtree", () => {
  for (const p of workspaceConfigPaths("pg")) assert.ok(p.startsWith("workspaces/pg/"), p);
  assert.ok(workspaceConfigPaths("pg").includes("workspaces/pg/settings.json"));
  assert.ok(workspaceConfigPaths("pg").includes("workspaces/pg/boards"));
  assert.ok(workspaceConfigPaths("pg").includes("workspaces/pg/roster.json"));
});

test("commitConfigFiles: stages ONLY the allowlisted paths of ONE subtree — a stray file and a sibling workspace are never committed", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgcommit-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "acme" });
    const pg = join(paths.orgRepo, "workspaces", "pg");
    const other = join(paths.orgRepo, "workspaces", "other");
    mkdirSync(join(pg, "boards"), { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(pg, "settings.json"), '{"name":"pg","repos":[]}\n');
    writeFileSync(join(pg, "boards", "pg-plan.json"), '{"id":"pg-plan"}\n');
    writeFileSync(join(pg, "scratch.txt"), "dropped in by hand\n");
    writeFileSync(join(other, "settings.json"), '{"name":"other","repos":[]}\n');

    assert.equal(await commitConfigFiles(paths, "pg"), true);

    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: paths.orgRepo }).toString();
    assert.match(tree, /^workspaces\/pg\/settings\.json$/m);
    assert.match(tree, /^workspaces\/pg\/boards\/pg-plan\.json$/m);
    assert.doesNotMatch(tree, /scratch\.txt/, "a hand-dropped file is never staged on the user's behalf");
    assert.doesNotMatch(tree, /workspaces\/other/, "another workspace's subtree is not this commit's business");
    assert.equal(await commitConfigFiles(paths, "pg"), false, "nothing changed → no commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitConfigFiles: the AUTHOR is whoever acted, the COMMITTER is always the tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "orgauthor-"));
  try {
    const paths = smithPaths(root);
    await ensureOrgRepo(paths, { name: "acme" });
    const pg = join(paths.orgRepo, "workspaces", "pg");
    mkdirSync(pg, { recursive: true });
    writeFileSync(join(pg, "settings.json"), '{"name":"pg","repos":[]}\n');

    await commitConfigFiles(paths, "pg", {
      author: { name: "Edwin Cruz", email: "e@example.com" },
      message: "config(pg): create",
    });

    const line = execFileSync("git", ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"], { cwd: paths.orgRepo })
      .toString()
      .trim();
    assert.equal(line, "Edwin Cruz <e@example.com>|smithagents <smithagents@localhost>|config(pg): create");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitConfigFiles: refuses a slug that is not a slug — a path could otherwise escape the subtree", async () => {
  const paths = smithPaths(mkdtempSync(join(tmpdir(), "orgslug-")));
  await assert.rejects(() => commitConfigFiles(paths, "../escape"), /slug/);
});
