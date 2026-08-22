import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createProposal, deleteProposal, listProposals, proposalFileText, proposalRef } from "./document-proposals.js";
import { gitCommitAll, makeOrgRepo } from "./org-repo.fixture.js";
import { smithPaths } from "./paths.js";

const DOC = `---
title: T
blueprint: spec
workType: feature
status: drafting
effort: t
createdAt: 2026-08-22T15:30:00.000Z
updatedAt: 2026-08-22T15:30:00.000Z
---

## What this is {#overview}

old overview

## Approach {#approach}

old approach
`;
const REL = "workspaces/pg/specs/2026-08-22-1530-t-design.md";
const ID = "2026-08-22-1530-t-design";
const ANDERSON = { name: "anderson", email: "anderson@agents.smithagents" };

function setup(label: string) {
  const root = mkdtempSync(join(tmpdir(), `props-${label}-`));
  const paths = smithPaths(root);
  makeOrgRepo(root, ["pg"]);
  mkdirSync(join(paths.orgRepo, "workspaces", "pg", "specs"), { recursive: true });
  writeFileSync(join(paths.orgRepo, REL), DOC);
  gitCommitAll(paths.orgRepo, "spec(t): create");
  return { root, paths };
}

test("proposalRef: the namespace is per workspace and per document", () => {
  assert.equal(proposalRef("pg", ID, 3), `refs/heads/proposals/pg/${ID}/3`);
});

test("createProposal: one branch, one commit, main and the live tree untouched, n allocated in order", async () => {
  const { root, paths } = setup("create");
  try {
    const head = execFileSync("git", ["rev-parse", "main"], { cwd: paths.orgRepo }).toString().trim();
    const p1 = await createProposal(paths, {
      slug: "pg",
      docId: ID,
      relPath: REL,
      newFileText: DOC.replace("old approach", "new approach"),
      sectionId: "approach",
      author: ANDERSON,
      rationale: "tighter",
    });
    const p2 = await createProposal(paths, {
      slug: "pg",
      docId: ID,
      relPath: REL,
      newFileText: DOC.replace("old overview", "new overview"),
      sectionId: "overview",
      author: ANDERSON,
      rationale: "clearer",
    });
    assert.deepEqual([p1.id, p2.id], ["1", "2"]);
    assert.equal(
      execFileSync("git", ["rev-parse", "main"], { cwd: paths.orgRepo }).toString().trim(),
      head,
      "main did not move",
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd: paths.orgRepo }).toString(),
      "",
      "live tree and index untouched",
    );
    assert.equal(readFileSync(join(paths.orgRepo, REL), "utf8"), DOC, "the live file still has the old text");
    const show = execFileSync("git", ["show", `${proposalRef("pg", ID, 1)}:${REL}`], { cwd: paths.orgRepo }).toString();
    assert.match(show, /new approach/);
    const log = execFileSync("git", ["log", "-1", "--format=%an <%ae>|%cn|%s", proposalRef("pg", ID, 1)], {
      cwd: paths.orgRepo,
    })
      .toString()
      .trim();
    assert.equal(log, "anderson <anderson@agents.smithagents>|smithagents|tighter");
    const parents = execFileSync("git", ["rev-list", "--parents", "-1", proposalRef("pg", ID, 1)], {
      cwd: paths.orgRepo,
    })
      .toString()
      .trim()
      .split(" ");
    assert.equal(parents[1], head, "the proposal commit's parent is main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProposals: derives section, body, author, rationale from the branch; stale when main's section moved", async () => {
  const { root, paths } = setup("list");
  try {
    await createProposal(paths, {
      slug: "pg",
      docId: ID,
      relPath: REL,
      newFileText: DOC.replace("old approach", "new approach"),
      sectionId: "approach",
      author: ANDERSON,
      rationale: "tighter",
    });
    const open = await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: DOC });
    assert.equal(open.length, 1);
    assert.equal(open[0].id, "1");
    assert.equal(open[0].sectionId, "approach");
    assert.equal(open[0].newBody, "new approach");
    assert.equal(open[0].agentId, "anderson");
    assert.equal(open[0].rationale, "tighter");
    assert.equal(open[0].state, "open");
    assert.match(open[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);

    // main edits the SAME section → stale; a different section → still open
    const moved = DOC.replace("old approach", "rewritten on main");
    writeFileSync(join(paths.orgRepo, REL), moved);
    gitCommitAll(paths.orgRepo, "spec(t): approach");
    assert.equal(
      (await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: moved }))[0].state,
      "stale",
    );
    const other = DOC.replace("old overview", "new overview");
    assert.equal(
      (await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: other }))[0].state,
      "open",
      "an edit elsewhere does not stale it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProposals: derives the section id from a diff when the branch has no Section: trailer (a hand-made branch)", async () => {
  const { root, paths } = setup("trailerless");
  try {
    // A hand-made branch: parent is main, edits the SAME text createProposal
    // would edit, but the commit carries no "Section: " trailer at all — the
    // fallback this task must exercise, not just the happy trailer path.
    const base = execFileSync("git", ["rev-parse", "main"], { cwd: paths.orgRepo }).toString().trim();
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: paths.orgRepo,
      input: DOC.replace("old approach", "hand-made approach"),
    })
      .toString()
      .trim();
    // Build the tree via a scratch private index so this fixture never
    // touches the org repo's own live index either.
    const scratchIndexEnv = { ...process.env, GIT_INDEX_FILE: join(root, "scratch-index") };
    execFileSync("git", ["read-tree", base], { cwd: paths.orgRepo, env: scratchIndexEnv });
    execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},${REL}`], {
      cwd: paths.orgRepo,
      env: scratchIndexEnv,
    });
    const writtenTree = execFileSync("git", ["write-tree"], { cwd: paths.orgRepo, env: scratchIndexEnv })
      .toString()
      .trim();
    const commit = execFileSync("git", ["commit-tree", writtenTree, "-p", base, "-m", "hand made, no trailer"], {
      cwd: paths.orgRepo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "human",
        GIT_AUTHOR_EMAIL: "human@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    })
      .toString()
      .trim();
    execFileSync("git", ["update-ref", proposalRef("pg", ID, 1), commit], { cwd: paths.orgRepo });

    const open = await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: DOC });
    assert.equal(open.length, 1);
    assert.equal(open[0].sectionId, "approach", "found by diffing branch text against base text, not a trailer");
    assert.equal(open[0].newBody, "hand-made approach");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listProposals: a malformed hand-made branch (no file at all on it) is skipped, not thrown — the rest of the listing still comes back", async () => {
  const { root, paths } = setup("malformed");
  try {
    await createProposal(paths, {
      slug: "pg",
      docId: ID,
      relPath: REL,
      newFileText: DOC.replace("old approach", "new approach"),
      sectionId: "approach",
      author: ANDERSON,
      rationale: "tighter",
    });
    // A hand-made proposal ref pointing at a totally unrelated, parentless
    // commit: no relPath in its tree at all (git show <sha>:<relPath> fails)
    // AND no shared history with main (git merge-base fails too). Both are
    // real git-command failures a hand-crafted branch can trigger.
    const emptyTree = execFileSync("git", ["hash-object", "-t", "tree", "/dev/null"], { cwd: paths.orgRepo })
      .toString()
      .trim();
    const orphan = execFileSync("git", ["commit-tree", emptyTree, "-m", "unrelated orphan commit"], {
      cwd: paths.orgRepo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "ghost",
        GIT_AUTHOR_EMAIL: "ghost@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    })
      .toString()
      .trim();
    execFileSync("git", ["update-ref", proposalRef("pg", ID, 2), orphan], { cwd: paths.orgRepo });

    const open = await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: DOC });
    assert.equal(open.length, 1, "the malformed ref #2 is skipped; the real proposal #1 still comes back");
    assert.equal(open[0].id, "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposalFileText + deleteProposal: the branch text is readable, and a deleted proposal is gone from the listing", async () => {
  const { root, paths } = setup("delete");
  try {
    await createProposal(paths, {
      slug: "pg",
      docId: ID,
      relPath: REL,
      newFileText: DOC.replace("old approach", "new approach"),
      sectionId: "approach",
      author: ANDERSON,
      rationale: "r",
    });
    const texts = await proposalFileText(paths, { slug: "pg", docId: ID, id: "1", relPath: REL });
    assert.ok(texts);
    assert.match(texts.branchText, /new approach/);
    assert.match(texts.baseText, /old approach/);
    assert.equal(await deleteProposal(paths, { slug: "pg", docId: ID, id: "1" }), true);
    assert.equal(await deleteProposal(paths, { slug: "pg", docId: ID, id: "1" }), false, "deleting twice is a no-op");
    assert.deepEqual(await listProposals(paths, { slug: "pg", docId: ID, relPath: REL, currentFileText: DOC }), []);
    assert.equal(await proposalFileText(paths, { slug: "pg", docId: ID, id: "1", relPath: REL }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createProposal: concurrent proposals on one document get distinct ids", async () => {
  const { root, paths } = setup("concurrent");
  try {
    const ids = await Promise.all(
      ["a", "b", "c"].map((tag) =>
        createProposal(paths, {
          slug: "pg",
          docId: ID,
          relPath: REL,
          newFileText: DOC.replace("old approach", tag),
          sectionId: "approach",
          author: ANDERSON,
          rationale: tag,
        }),
      ),
    );
    assert.deepEqual(ids.map((i) => i.id).sort(), ["1", "2", "3"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
