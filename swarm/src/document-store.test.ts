import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DocStatus, parseDocumentFile } from "./document-file.js";
import type { Problem } from "./document-rules.js";
import {
  AmbiguousDocumentError,
  acceptProposal,
  addProposal,
  changeBlueprint,
  createDocument,
  type DocWire,
  getDocument,
  importDocument,
  type LegacyDoc,
  listDocuments,
  listWorkspaceDocuments,
  patchSection,
  rejectProposal,
  renameDocument,
  resolveDocument,
  setPins,
  setStatus,
} from "./document-store.js";
import { gitCommitAll, makeOrgRepo } from "./org-repo.fixture.js";
import { type SmithPaths, smithPaths } from "./paths.js";
import type { Workspace } from "./workspaces.js";

const EDWIN = { name: "Edwin Cruz", email: "e@example.com" };
const ANDERSON = { name: "anderson", email: "anderson@agents.smithagents" };
const PG: Workspace = { name: "pg", repos: [] };
const OTHER: Workspace = { name: "other", repos: [] };
const WS = [PG, OTHER];
const NOW = () => "2026-08-22T15:30:00.000Z";

function setup(label: string) {
  const root = mkdtempSync(join(tmpdir(), `docstore-${label}-`));
  const paths = smithPaths(root);
  makeOrgRepo(root, ["pg", "other"]);
  return { root, paths };
}
function isDoc(r: unknown): r is DocWire {
  return !!r && typeof r === "object" && "id" in (r as object);
}
function logFor(dir: string, ref = "HEAD"): string {
  return execFileSync("git", ["log", "-1", "--format=%an|%s", "--name-only", ref], { cwd: dir }).toString();
}
function lastLog(dir: string): string {
  return logFor(dir);
}
/**
 * A document file put on disk by something other than the store — a hand copy,
 * or a merged instance branch. The ONLY way to produce a duplicate id now that
 * `freeId` scans the whole org repo, and the way the field produces one.
 * Committed, so the tree stays clean and the dirty-file guards do not fire.
 */
function planted(paths: SmithPaths, slug: string, folder: string, id: string, bytes: Buffer | string): string {
  const dir = join(paths.orgRepo, "workspaces", slug, folder);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.md`);
  writeFileSync(file, bytes);
  gitCommitAll(paths.orgRepo, `planted ${slug}/${folder}/${id}`);
  return file;
}

/**
 * The document half of a StoreResult, asserted as such. `getDocument` can now
 * also answer 422 (final-review Important 2), and `?.field` on that would read
 * as `undefined` and quietly pass — this fails naming what came back instead.
 */
function asDoc(r: unknown): DocWire {
  assert.ok(isDoc(r), `expected a document, got ${JSON.stringify(r)}`);
  return r;
}

/** The error half of a StoreResult, asserted as such rather than as "not a doc". */
function asError(r: unknown): { error: string; status: number } {
  assert.ok(r && typeof r === "object" && "error" in r, `expected an error, got ${JSON.stringify(r)}`);
  return r as { error: string; status: number };
}

test("createDocument: a spec lands in specs/ with the §2 frontmatter, instantiated sections, one authored commit", async () => {
  const { root, paths } = setup("create");
  try {
    const r = await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      title: "Instance provisioning",
      author: EDWIN,
      now: NOW,
    });
    assert.ok(isDoc(r), JSON.stringify(r));
    assert.equal(r.id, "2026-08-22-1530-instance-provisioning-design");
    assert.equal(r.workspace, "pg");
    assert.equal(r.effort, "instance-provisioning");
    assert.deepEqual(
      r.sections.map((s) => s.id),
      ["overview", "ui-refs", "approach", "non-goals", "testing"],
    );
    assert.equal(r.status, "drafting");
    assert.deepEqual(r.problems, []);
    const file = join(paths.orgRepo, "workspaces", "pg", "specs", `${r.id}.md`);
    const text = readFileSync(file, "utf8");
    assert.match(
      text,
      /^---\ntitle: Instance provisioning\nblueprint: spec\nworkType: feature\nstatus: drafting\neffort: instance-provisioning\n/,
    );
    assert.match(text, /^## What this is \{#overview\}$/m);
    assert.match(
      lastLog(paths.orgRepo),
      /^Edwin Cruz\|spec\(instance-provisioning\): create\n[\s\S]*workspaces\/pg\/specs\//,
    );
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: paths.orgRepo }).toString(), "");
    // Everything written round-trips: the file the store just wrote parses back.
    assert.ok(parseDocumentFile(text).doc, JSON.stringify(parseDocumentFile(text).problems));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createDocument: an id collision gets a -2 suffix; an unknown blueprint or workType is a 400", async () => {
  const { root, paths } = setup("collide");
  try {
    const a = await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    });
    const b = await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    });
    assert.ok(isDoc(a) && isDoc(b));
    assert.equal(b.id, `${a.id}-2`);
    const bad = await createDocument(paths, PG, WS, { blueprintId: "nope", author: EDWIN, now: NOW });
    assert.deepEqual(bad, { error: "unknown blueprint: nope", status: 400 });
    const badType = await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "insight",
      author: EDWIN,
      now: NOW,
    });
    assert.equal(asError(badType).status, 400);
    assert.match(asError(badType).error, /workType must be one of: feature, bugfix, integration/);
    const untitled = await createDocument(paths, PG, WS, { blueprintId: "dashboard", author: EDWIN, now: NOW });
    assert.ok(isDoc(untitled));
    assert.equal(untitled.title, "Dashboard", "a blank title takes the blueprint name");
    assert.match(untitled.id, /^2026-08-22-1530-dashboard/);
    assert.ok(statSync(join(paths.orgRepo, "workspaces", "pg", "dashboards", `${untitled.id}.md`)).isFile());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createDocument: an id is free across the WHOLE org repo — every active workspace, every folder", async () => {
  const { root, paths } = setup("cross-ws-id");
  try {
    // Two workspaces, same title, same UTC minute. Before final-review
    // Important 1 both minted the IDENTICAL id, and `resolveDocument` then
    // threw AmbiguousDocumentError → 409 on every id-addressed route for BOTH
    // documents, forever, advising "address it through its workspace" — which
    // no route on either port supports.
    const spec = { blueprintId: "spec", workType: "feature", title: "Twin", author: EDWIN, now: NOW } as const;
    const a = await createDocument(paths, PG, WS, spec);
    const b = await createDocument(paths, OTHER, WS, spec);
    assert.ok(isDoc(a) && isDoc(b), `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    assert.equal(a.id, "2026-08-22-1530-twin-design");
    assert.equal(b.id, "2026-08-22-1530-twin-design-2", "the existing -2 suffix is reused, not a new id format");

    // The other axis: `resolveDocument` scans every FOLDER too, so a plan in
    // one workspace and a dashboard in another collide just as hard.
    const plan = await createDocument(paths, PG, WS, {
      blueprintId: "implementation-plan",
      title: "Twin",
      author: EDWIN,
      now: NOW,
    });
    const dash = await createDocument(paths, OTHER, WS, {
      blueprintId: "dashboard",
      title: "Twin",
      author: EDWIN,
      now: NOW,
    });
    assert.ok(isDoc(plan) && isDoc(dash), `${JSON.stringify(plan)} / ${JSON.stringify(dash)}`);
    assert.equal(plan.id, "2026-08-22-1530-twin");
    assert.equal(dash.id, "2026-08-22-1530-twin-2", "a dashboard in another workspace must not reuse the plan's id");

    // The payoff: all four stay addressable by id.
    for (const [doc, ws] of [
      [a, "pg"],
      [b, "other"],
      [plan, "pg"],
      [dash, "other"],
    ] as const) {
      assert.equal((await resolveDocument(paths, WS, doc.id))?.ws.name, ws, `resolve ${doc.id}`);
      const got = await getDocument(paths, WS, doc.id);
      assert.ok(isDoc(got), `get ${doc.id}: ${JSON.stringify(got)}`);
      assert.equal(got.workspace, ws);
    }
    assert.equal((await listDocuments(paths, WS)).length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createDocument: a blueprint with a blank name still titles the document — serialize refuses an empty title", async () => {
  const { root, paths } = setup("blankname");
  try {
    const dir = join(paths.orgRepo, "workspaces", "pg", "blueprints");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "blank.json"),
      JSON.stringify({
        id: "blank",
        name: "",
        family: "document",
        folder: "specs",
        workTypes: ["feature"],
        sections: [{ id: "only", heading: "Only" }],
      }),
    );
    const r = await createDocument(paths, PG, WS, { blueprintId: "blank", author: EDWIN, now: NOW });
    assert.ok(isDoc(r), JSON.stringify(r));
    assert.equal(r.title, "blank", "falls through the blank name to the blueprint id rather than writing `title: `");
    const text = readFileSync(join(paths.orgRepo, "workspaces", "pg", "specs", `${r.id}.md`), "utf8");
    assert.ok(parseDocumentFile(text).doc, "an empty required scalar would make the file unparseable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createDocument: a workspace whose name slugs to nothing is refused, never written to the shared workspaces/", async () => {
  const { root, paths } = setup("badslug");
  try {
    const nameless: Workspace = { name: "!!!", repos: [] };
    await assert.rejects(() =>
      createDocument(paths, nameless, WS, { blueprintId: "spec", workType: "feature", author: EDWIN, now: NOW }),
    );
    assert.equal(existsSync(join(paths.orgRepo, "workspaces", "specs")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchSection: normalizes, stamps updatedAt, commits as the author with the section in the message", async () => {
  const { root, paths } = setup("patch");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const r = await patchSection(paths, WS, doc.id, "approach", "* a\n* b", EDWIN);
    assert.ok(isDoc(r));
    assert.equal(r.sections.find((s) => s.id === "approach")?.body, "- a\n- b");
    assert.notEqual(r.updatedAt, doc.createdAt);
    assert.match(lastLog(paths.orgRepo), /^Edwin Cruz\|spec\(x\): approach/);
    assert.equal(await patchSection(paths, WS, doc.id, "nope", "x", EDWIN), null);
    assert.equal(await patchSection(paths, WS, "missing-id", "approach", "x", EDWIN), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDocument: finds a document in whichever workspace holds it; the same id twice is ambiguous", async () => {
  const { root, paths } = setup("resolve");
  try {
    const a = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "same",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    assert.equal((await resolveDocument(paths, WS, a.id))?.slug, "pg");
    assert.equal(await resolveDocument(paths, WS, "2099-01-01-0000-nothing"), null);
    // `createDocument` can no longer mint this collision (final-review
    // Important 1 — `freeId` scans the whole org repo), so the duplicate is
    // planted the way the field produces one: a hand-copied file, or a merged
    // `smith/<workId>` instance branch carrying the same name. The ambiguity
    // is still reachable, so `resolveDocument` must still refuse it.
    planted(
      paths,
      "other",
      "specs",
      a.id,
      readFileSync(join(paths.orgRepo, "workspaces", "pg", "specs", `${a.id}.md`)),
    );
    await assert.rejects(() => resolveDocument(paths, WS, a.id), AmbiguousDocumentError);
    const all = await listDocuments(paths, WS);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((d) => d.workspace).sort(), ["other", "pg"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDocument: one workspace, two folders, one id — plans/ and dashboards/ mint the same stem", async () => {
  const { root, paths } = setup("twofolders");
  try {
    const plan = (await createDocument(paths, PG, WS, {
      blueprintId: "implementation-plan",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const dash = (await createDocument(paths, PG, WS, {
      blueprintId: "dashboard",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    // No blueprint suffix outside `spec`, so the two STEMS collide — `freeId`
    // is what separates them, and it now looks across folders, not just
    // across workspaces (final-review Important 1).
    assert.equal(dash.id, `${plan.id}-2`);
    // The ambiguity a hand edit can still produce: the plan's id, in dashboards/.
    planted(
      paths,
      "pg",
      "dashboards",
      plan.id,
      readFileSync(join(paths.orgRepo, "workspaces", "pg", "dashboards", `${dash.id}.md`)),
    );
    await assert.rejects(() => resolveDocument(paths, WS, plan.id), AmbiguousDocumentError);
    await assert.rejects(
      () => resolveDocument(paths, WS, plan.id),
      (err: Error) => /plans/.test(err.message) && /dashboards/.test(err.message),
      "the message names both folders, not one workspace twice",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkspaceDocuments: an unparseable file is skipped, never taking the rest of the listing with it", async () => {
  const { root, paths } = setup("broken");
  try {
    const good = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "good",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    writeFileSync(
      join(paths.orgRepo, "workspaces", "pg", "specs", "2026-01-01-0000-hand-edited-design.md"),
      "no frontmatter here\n",
    );
    const listed = await listWorkspaceDocuments(paths, PG);
    assert.deepEqual(
      listed.map((d) => d.id),
      [good.id],
    );
    // Skipped from the LIST — the wire shape there is unchanged — but
    // addressed directly it is a 422 carrying the problems, not a bare 404
    // that reads as "no such document" (final-review Important 2).
    const broken = await getDocument(paths, WS, "2026-01-01-0000-hand-edited-design");
    assert.ok(broken && "error" in broken, `expected a 422, got ${JSON.stringify(broken)}`);
    assert.equal(broken.status, 422);
    assert.deepEqual(broken.problems, [
      { where: "frontmatter", message: "no frontmatter block at the top of the file" },
    ]);
    assert.ok(isDoc(await getDocument(paths, WS, good.id)));
    // An id that resolves to nothing at all is still a 404.
    assert.equal(await getDocument(paths, WS, "2099-01-01-0000-nothing"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a document one stray hand-edited frontmatter line broke warns by path and problem — it never vanishes silently", async () => {
  const { root, paths } = setup("silent");
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => {
    warned.push(a.map(String).join(" "));
  };
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "vanishing",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const file = join(paths.orgRepo, "workspaces", "pg", "specs", `${doc.id}.md`);
    // Spec §3 makes hand edits and merged instance branches first-class
    // inputs. ONE unknown key used to take the document off the shelf, off
    // the stage and 404 every route, with no log line anywhere.
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("\nstatus: drafting\n", "\nstatus: drafting\nowner: edwin\n"),
    );

    warned.length = 0;
    assert.deepEqual(await listWorkspaceDocuments(paths, PG), [], "still skipped from the listing");
    assert.ok(
      warned.some(
        (w) => w.includes(`workspaces/pg/specs/${doc.id}.md`) && w.includes("frontmatter.owner: unknown key"),
      ),
      `the listing must say WHY the file was skipped; warnings were:\n${warned.join("\n")}`,
    );

    warned.length = 0;
    const got = await getDocument(paths, WS, doc.id);
    assert.ok(got && "error" in got, `expected a 422, got ${JSON.stringify(got)}`);
    assert.equal(got.status, 422);
    assert.match(got.error, new RegExp(`workspaces/pg/specs/${doc.id}\\.md`));
    assert.deepEqual(got.problems, [{ where: "frontmatter.owner", message: "unknown key" }]);
    assert.ok(
      warned.some((w) => w.includes("frontmatter.owner: unknown key")),
      warned.join("\n"),
    );

    // The file is intact — nothing repaired it, nothing deleted it.
    assert.match(readFileSync(file, "utf8"), /^owner: edwin$/m);
  } finally {
    console.warn = realWarn;
    rmSync(root, { recursive: true, force: true });
  }
});

test("setStatus: the gates bite — final refuses an empty required section; reopen always works", async () => {
  const { root, paths } = setup("status");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const toReview = await setStatus(paths, WS, doc.id, "review", EDWIN);
    assert.ok(isDoc(toReview) && toReview.status === "review", JSON.stringify(toReview));
    assert.match(lastLog(paths.orgRepo), /spec\(x\): status → review/);
    const toFinal = await setStatus(paths, WS, doc.id, "final", EDWIN);
    assert.equal(asError(toFinal).status, 409);
    assert.match(asError(toFinal).error, /overview/);
    // The refusal carries problems[] as STRUCTURE, not only inside the message
    // string. Asserting the string alone let the field be dropped silently —
    // the mirror of the success-path gap the round-2 control exposed.
    const refusalProblems = (toFinal as { problems?: Problem[] }).problems;
    assert.ok(Array.isArray(refusalProblems), `no problems[] on the refusal: ${JSON.stringify(toFinal)}`);
    assert.ok(
      refusalProblems.some((p) => p.where === "section:overview" && /must not be empty/.test(p.message)),
      `expected a section:overview problem, got ${JSON.stringify(refusalProblems)}`,
    );
    assert.ok(
      refusalProblems.some((p) => p.where === "section:non-goals"),
      "every blocking problem is reported, not just the first",
    );
    assert.equal(asDoc(await getDocument(paths, WS, doc.id)).status, "review", "a refused transition writes nothing");
    await patchSection(paths, WS, doc.id, "overview", "x", EDWIN);
    await patchSection(paths, WS, doc.id, "non-goals", "y", EDWIN);
    const fin = await setStatus(paths, WS, doc.id, "final", EDWIN);
    assert.ok(isDoc(fin) && fin.status === "final", JSON.stringify(fin));
    const back = await setStatus(paths, WS, doc.id, "drafting", EDWIN);
    assert.ok(isDoc(back) && back.status === "drafting");
    assert.equal(await setStatus(paths, WS, "missing-id", "review", EDWIN), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("§6.3: a write never refuses — the violation comes back as problems[] on the write's OWN result", async () => {
  const { root, paths } = setup("write-problems");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "er",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    // The derived half of a mutation's return value is computed after the
    // org-repo queue is released; this pins that it is still computed, and
    // computed against what the write actually put on disk.
    const r = await patchSection(paths, WS, doc.id, "diagram", "not a fenced diagram at all", EDWIN);
    assert.ok(isDoc(r), JSON.stringify(r));
    assert.ok(
      r.problems.some((p) => p.where === "section:diagram" && /mermaid/.test(p.message)),
      `expected a mermaid shape problem, got ${JSON.stringify(r.problems)}`,
    );
    assert.equal(
      r.sections.find((s) => s.id === "diagram")?.body,
      "not a fenced diagram at all",
      "the write still landed — only status transitions refuse",
    );
    assert.deepEqual(
      r.problems,
      asDoc(await getDocument(paths, WS, doc.id)).problems,
      "same projection as a plain read",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setStatus: a shape violation blocks review — the document keeps its status on disk", async () => {
  const { root, paths } = setup("shape");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "er",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    await patchSection(paths, WS, doc.id, "diagram", "just prose, no fence", EDWIN);
    const refused = await setStatus(paths, WS, doc.id, "review", EDWIN);
    assert.equal(asError(refused).status, 409);
    assert.match(asError(refused).error, /mermaid/);
    assert.equal(asDoc(await getDocument(paths, WS, doc.id)).status, "drafting");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposals: add → listed open → accept writes the section on main as the agent and deletes the branch", async () => {
  const { root, paths } = setup("accept");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const withP = (await addProposal(paths, WS, doc.id, {
      sectionId: "approach",
      newBody: "agent text",
      agentId: "anderson",
      rationale: "tighter",
    })) as DocWire;
    assert.equal(withP.proposals.length, 1);
    assert.equal(withP.proposals[0].state, "open");
    assert.equal(withP.sections.find((s) => s.id === "approach")?.body, "", "a proposal is not a write");
    const accepted = (await acceptProposal(paths, WS, doc.id, withP.proposals[0].id)) as DocWire;
    assert.equal(accepted.sections.find((s) => s.id === "approach")?.body, "agent text");
    assert.deepEqual(accepted.proposals, []);
    assert.match(lastLog(paths.orgRepo), /^anderson\|spec\(x\): accept proposal 1 — approach/);
    // The write is on disk, not only in the returned wire shape.
    assert.equal(
      asDoc(await getDocument(paths, WS, doc.id)).sections.find((s) => s.id === "approach")?.body,
      "agent text",
    );
    const refs = execFileSync("git", ["for-each-ref", "refs/heads/proposals/"], { cwd: paths.orgRepo }).toString();
    assert.equal(refs, "", "branch deleted after accept");
    assert.equal(await acceptProposal(paths, WS, doc.id, withP.proposals[0].id), null, "gone is gone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposals: a human write stales the open proposal; accepting a stale one is refused; reject deletes", async () => {
  const { root, paths } = setup("stale");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const withP = (await addProposal(paths, WS, doc.id, {
      sectionId: "approach",
      newBody: "agent text",
      agentId: "anderson",
      rationale: "r",
    })) as DocWire;
    const pid = withP.proposals[0].id;
    const afterHuman = (await patchSection(paths, WS, doc.id, "approach", "human text", EDWIN)) as DocWire;
    assert.equal(afterHuman.proposals[0].state, "stale");
    const refused = await acceptProposal(paths, WS, doc.id, pid);
    assert.equal(asError(refused).status, 409);
    assert.match(asError(refused).error, /stale/);
    assert.equal(
      asDoc(await getDocument(paths, WS, doc.id)).sections.find((s) => s.id === "approach")?.body,
      "human text",
      "the refusal wrote nothing",
    );
    const rejected = (await rejectProposal(paths, WS, doc.id, pid)) as DocWire;
    assert.deepEqual(rejected.proposals, []);
    assert.equal(rejected.sections.find((s) => s.id === "approach")?.body, "human text");
    assert.equal(await rejectProposal(paths, WS, doc.id, pid), null, "gone is gone");
    assert.equal(
      await addProposal(paths, WS, doc.id, { sectionId: "nope", newBody: "x", agentId: "a", rationale: "r" }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposals: accepting one STALES its siblings on the same section — the deleted DocumentManager deliberately did the opposite", async () => {
  const { root, paths } = setup("siblings");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    for (const [agentId, body] of [
      ["anderson", "a"],
      ["morpheus", "b"],
    ] as const) {
      await addProposal(paths, WS, doc.id, { sectionId: "overview", newBody: body, agentId, rationale: "r" });
    }
    const before = asDoc(await getDocument(paths, WS, doc.id));
    assert.deepEqual(
      before.proposals.map((p) => [p.id, p.newBody, p.state]),
      [
        ["1", "a", "open"],
        ["2", "b", "open"],
      ],
    );

    // No human write anywhere in this sequence — the accept's OWN write is
    // what stales the sibling, because `stale` is a comparison of the
    // section's body at the merge-base against the file now.
    const accepted = (await acceptProposal(paths, WS, doc.id, "1")) as DocWire;
    assert.deepEqual(
      accepted.proposals.map((p) => [p.id, p.state]),
      [["2", "stale"]],
    );

    // This REVERSES `DocumentManager.acceptProposal`, deleted in f249551,
    // which bypassed staling on purpose ("accepting one suggestion must not
    // kill its siblings before the human has looked at them") and had a test
    // asserting it. The new behaviour stands deliberately (see the docblock on
    // `acceptProposal`) and this is the test that pins it: the sibling is
    // refused, loudly and actionably, rather than silently discarding the text
    // just accepted.
    const refused = await acceptProposal(paths, WS, doc.id, "2");
    assert.equal(asError(refused).status, 409);
    assert.match(asError(refused).error, /stale/);
    assert.match(asError(refused).error, /overview/, "the message names the section that moved");
    assert.match(asError(refused).error, /reject it or ask for a new one/, "and says what to do about it");

    // The accepted text survived the refusal, and the sibling's branch is
    // still there for a human to look at.
    const after = asDoc(await getDocument(paths, WS, doc.id));
    assert.equal(after.sections.find((s) => s.id === "overview")?.body, "a");
    assert.deepEqual(
      after.proposals.map((p) => p.id),
      ["2"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renameDocument / setPins: title and pins change, the file does not move, nothing unparseable is written", async () => {
  const { root, paths } = setup("rename");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const renamed = (await renameDocument(paths, WS, doc.id, "  New   title ", EDWIN)) as DocWire;
    assert.equal(renamed.title, "New title");
    assert.equal(renamed.id, doc.id);
    const blank = await renameDocument(paths, WS, doc.id, "   ", EDWIN);
    assert.equal(asError(blank).status, 400, "an empty title would serialize as `title: ` and never parse back");
    assert.equal(asDoc(await getDocument(paths, WS, doc.id)).title, "New title");
    const pinned = (await setPins(paths, WS, doc.id, ["pg", "group:team", " pg ", ""], EDWIN)) as DocWire;
    assert.deepEqual(pinned.pins, ["pg", "group:team"], "trimmed and de-duplicated");
    const badPin = await setPins(paths, WS, doc.id, ["a,b"], EDWIN);
    assert.equal(asError(badPin).status, 400, "a comma would re-parse as two pins");
    assert.equal(asError(await setPins(paths, WS, doc.id, ["a]b"], EDWIN)).status, 400);
    assert.equal(asError(await setPins(paths, WS, doc.id, ["a\nstatus: final"], EDWIN)).status, 400);
    assert.deepEqual(
      asDoc(await getDocument(paths, WS, doc.id)).pins,
      ["pg", "group:team"],
      "no refusal reached the file",
    );
    assert.equal(await renameDocument(paths, WS, "missing-id", "t", EDWIN), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changeBlueprint: an untouched document re-casts freely — a seeded starter is not content the user typed", async () => {
  const { root, paths } = setup("recast");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const toEr = (await changeBlueprint(paths, WS, doc.id, "er", undefined, EDWIN)) as DocWire;
    assert.equal(toEr.blueprintId, "er", "er shares the specs folder, and the document is still empty");
    assert.match(toEr.sections[0].body, /^```mermaid/);
    // The er starter is now the body. Picking the wrong diagram type must
    // still be recoverable — both directions, and back out to prose.
    const toSequence = (await changeBlueprint(paths, WS, doc.id, "sequence", undefined, EDWIN)) as DocWire;
    assert.equal(toSequence.blueprintId, "sequence", "an untouched starter is not content");
    assert.match(toSequence.sections[0].body, /sequenceDiagram/);
    const backToSpec = (await changeBlueprint(paths, WS, doc.id, "spec", undefined, EDWIN)) as DocWire;
    assert.equal(backToSpec.blueprintId, "spec");
    assert.equal(asError(await changeBlueprint(paths, WS, doc.id, "nope", undefined, EDWIN)).status, 400);
    assert.equal(await changeBlueprint(paths, WS, "missing-id", "er", undefined, EDWIN), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changeBlueprint: a body the user actually edited refuses; a different folder refuses first", async () => {
  const { root, paths } = setup("recast-refuse");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "er",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const toPlan = await changeBlueprint(paths, WS, doc.id, "implementation-plan", undefined, EDWIN);
    assert.equal(asError(toPlan).status, 409);
    assert.match(
      asError(toPlan).error,
      /plans\//,
      "a different folder means a different file — create a new document instead",
    );
    await patchSection(paths, WS, doc.id, "diagram", "```mermaid\nerDiagram\n  A ||--o{ B : owns\n```", EDWIN);
    const toSequence = await changeBlueprint(paths, WS, doc.id, "sequence", undefined, EDWIN);
    assert.equal(asError(toSequence).status, 409);
    assert.match(asError(toSequence).error, /content/, "the user edited this diagram — re-casting would discard it");
    assert.equal(asDoc(await getDocument(paths, WS, doc.id)).blueprintId, "er", "no refusal reached the file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const LEGACY: LegacyDoc = {
  id: "d2",
  title: "Design Spec 2",
  blueprintId: "spec",
  workType: "feature",
  sections: [
    { id: "overview", heading: "What this is", body: "hello" },
    { id: "approach", heading: "Approach", body: "" },
  ],
  participants: ["anderson"],
  proposals: [
    {
      id: "p1",
      sectionId: "approach",
      agentId: "anderson",
      newBody: "try this",
      rationale: "r",
      state: "open",
      createdAt: "2026-08-19T17:17:17.910Z",
    },
    {
      id: "p2",
      sectionId: "approach",
      agentId: "anderson",
      newBody: "old",
      rationale: "r",
      state: "rejected",
      createdAt: "2026-08-19T17:17:17.910Z",
    },
  ],
  pins: ["pg"],
  status: "review",
  createdAt: "2026-08-19T17:17:17.910Z",
  updatedAt: "2026-08-19T17:20:00.000Z",
};

test("importDocument: a legacy Doc becomes a file with its sections, pins, status, and its OPEN proposals as branches", async () => {
  const { root, paths } = setup("import");
  try {
    const r = await importDocument(paths, PG, structuredClone(LEGACY));
    assert.ok(isDoc(r), JSON.stringify(r));
    assert.equal(r.id, "2026-08-19-1717-design-spec-2-design");
    assert.equal(r.status, "review");
    assert.deepEqual(r.pins, ["pg"]);
    assert.deepEqual(r.participants, ["anderson"]);
    assert.equal(r.sections.find((s) => s.id === "overview")?.body, "hello");
    assert.equal(r.proposals.length, 1, "only the OPEN proposal becomes a branch");
    assert.equal(r.proposals[0].newBody, "try this");
    // The import commit is the tool's; the proposal commit is the agent's.
    assert.match(lastLog(paths.orgRepo), /^smithagents\|spec\(design-spec-2\): import/);
    assert.match(logFor(paths.orgRepo, `refs/heads/proposals/pg/${r.id}/1`), /^anderson\|r$/m);
    const again = await importDocument(paths, PG, structuredClone(LEGACY));
    assert.equal(asError(again).status, 409, "importing the same document twice is refused, not duplicated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importDocument: legacy metadata that would not parse back is refused or replaced, never written", async () => {
  const { root, paths } = setup("import-bad");
  try {
    const badStatus = await importDocument(paths, PG, { ...structuredClone(LEGACY), status: "archived" as DocStatus });
    assert.equal(asError(badStatus).status, 400);
    assert.match(asError(badStatus).error, /status/);
    const badType = await importDocument(paths, PG, { ...structuredClone(LEGACY), workType: "insight" });
    assert.equal(asError(badType).status, 400);
    assert.match(asError(badType).error, /workType/);
    const badCreated = await importDocument(paths, PG, { ...structuredClone(LEGACY), createdAt: "whenever" });
    assert.equal(asError(badCreated).status, 400);
    assert.match(asError(badCreated).error, /createdAt/);
    const badPin = await importDocument(paths, PG, { ...structuredClone(LEGACY), pins: ["a,b"] });
    assert.equal(asError(badPin).status, 400);
    assert.equal(existsSync(join(paths.orgRepo, "workspaces", "pg", "specs")), false, "nothing was written");
    // updatedAt is derived, not identity: a junk value is replaced so the file still parses back.
    const ok = await importDocument(paths, PG, { ...structuredClone(LEGACY), proposals: [], updatedAt: "x" }, NOW);
    assert.ok(isDoc(ok), JSON.stringify(ok));
    assert.equal(ok.updatedAt, NOW());
    const text = readFileSync(join(paths.orgRepo, "workspaces", "pg", "specs", `${ok.id}.md`), "utf8");
    assert.ok(parseDocumentFile(text).doc, JSON.stringify(parseDocumentFile(text).problems));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importDocument: returns the bytes IT wrote, even when another mutation lands mid-import", async () => {
  const { root, paths } = setup("import-race");
  try {
    // Several open proposals, so the branch loop — which releases and retakes
    // the queue per proposal — keeps the import busy long enough for another
    // caller to get a write in behind it. That window is real: the import's own
    // commit is long since done by then.
    const legacy: LegacyDoc = {
      ...structuredClone(LEGACY),
      proposals: [0, 1, 2, 3].map((i) => ({
        id: `p${i}`,
        sectionId: "approach",
        agentId: `agent-${i}`,
        newBody: `variant ${i}`,
        rationale: `r${i}`,
        state: "open",
        createdAt: "2026-08-19T17:17:17.910Z",
      })),
    };
    const id = "2026-08-19-1717-design-spec-2-design";
    const file = join(paths.orgRepo, "workspaces", "pg", "specs", `${id}.md`);
    const importing = importDocument(paths, PG, legacy);
    // As soon as the import's own commit has landed, race a patch into it.
    while (!existsSync(file)) await new Promise((r) => setImmediate(r));
    const patched = await patchSection(paths, WS, id, "overview", "PATCHED BY SOMEONE ELSE", EDWIN);
    const imported = await importing;
    assert.ok(isDoc(patched) && isDoc(imported), JSON.stringify([patched, imported]));
    assert.equal(
      imported.sections.find((s) => s.id === "overview")?.body,
      "hello",
      "the import must return the bytes it wrote, not whoever wrote last",
    );
    // The patch is not lost either — it is simply someone else's result.
    assert.equal(
      asDoc(await getDocument(paths, WS, id)).sections.find((s) => s.id === "overview")?.body,
      "PATCHED BY SOMEONE ELSE",
    );
    assert.equal(imported.proposals.length, 4, "the derived proposal list is still current");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("importDocument: a legacy section id the heading grammar cannot carry is a 400, not a throw", async () => {
  const { root, paths } = setup("import-badsection");
  try {
    const r = await importDocument(paths, PG, {
      ...structuredClone(LEGACY),
      proposals: [],
      sections: [{ id: "Acceptance Criteria", heading: "Acceptance criteria", body: "x" }],
    });
    assert.equal(asError(r).status, 400, "serializeDocumentFile throws on this id — it must arrive as a refusal");
    assert.match(asError(r).error, /Acceptance Criteria/);
    assert.equal(existsSync(join(paths.orgRepo, "workspaces", "pg", "specs")), false, "nothing was written");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: paths.orgRepo }).toString(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Concurrency. Every mutation is one org-repo queue slot: resolve, read,
// change, write and commit cannot interleave with another mutation of the same
// file. Before that, these three raced — the review measured 8/8 lost edits on
// the first, 20/20 destroyed documents on the second.
// ---------------------------------------------------------------------------

test("concurrency: two patches of one document both land, each in its own commit with its own author", async () => {
  const { root, paths } = setup("race-patch");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "race",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const before = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: paths.orgRepo }).toString());
    const [a, b] = await Promise.all([
      patchSection(paths, WS, doc.id, "overview", "AAA", EDWIN),
      patchSection(paths, WS, doc.id, "testing", "BBB", ANDERSON),
    ]);
    assert.ok(isDoc(a) && isDoc(b), JSON.stringify([a, b]));
    const fresh = asDoc(await getDocument(paths, WS, doc.id));
    assert.equal(fresh.sections.find((s) => s.id === "overview")?.body, "AAA", "Edwin's edit survived");
    assert.equal(fresh.sections.find((s) => s.id === "testing")?.body, "BBB", "anderson's edit survived");
    // TWO commits, each naming its own author and its own section — not one
    // commit carrying the other caller's content.
    const after = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: paths.orgRepo }).toString());
    assert.equal(after - before, 2);
    const log = execFileSync("git", ["log", "-2", "--format=%an|%s"], { cwd: paths.orgRepo }).toString();
    assert.match(log, /^Edwin Cruz\|spec\(race\): overview$/m);
    assert.match(log, /^anderson\|spec\(race\): testing$/m);
    // Neither return value may claim content that is not on disk: the second
    // writer read the first's result, so exactly one carries both edits.
    const both = [a, b].filter(
      (d) =>
        d.sections.find((s) => s.id === "overview")?.body === "AAA" &&
        d.sections.find((s) => s.id === "testing")?.body === "BBB",
    );
    assert.equal(both.length, 1, "the later mutation returns the document as it now is on disk");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: paths.orgRepo }).toString(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrency: two creates for the same effort mint two documents, not one", async () => {
  const { root, paths } = setup("race-create");
  try {
    const input = {
      blueprintId: "spec",
      workType: "feature",
      effort: "twin",
      author: EDWIN,
      now: NOW,
    } as const;
    const [a, b] = await Promise.all([createDocument(paths, PG, WS, input), createDocument(paths, PG, WS, input)]);
    assert.ok(isDoc(a) && isDoc(b), JSON.stringify([a, b]));
    assert.notEqual(a.id, b.id, "freeId reads the directory that decides the id — it must be inside the queue");
    const listed = await listWorkspaceDocuments(paths, PG);
    assert.equal(listed.length, 2, "two documents exist; neither create destroyed the other");
    assert.deepEqual(
      listed.map((d) => d.id).sort(),
      [a.id, b.id].sort(),
      "each returned id resolves to its own document",
    );
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: paths.orgRepo }).toString(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrency: a status transition racing a patch reports the status the disk actually received", async () => {
  const { root, paths } = setup("race-status");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "gate",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    await patchSection(paths, WS, doc.id, "overview", "o", EDWIN);
    await patchSection(paths, WS, doc.id, "non-goals", "n", EDWIN);
    const [status, patched] = await Promise.all([
      setStatus(paths, WS, doc.id, "final", EDWIN),
      patchSection(paths, WS, doc.id, "approach", "later", ANDERSON),
    ]);
    assert.ok(isDoc(status) && isDoc(patched), JSON.stringify([status, patched]));
    const fresh = asDoc(await getDocument(paths, WS, doc.id));
    assert.equal(
      status.status,
      fresh.status,
      "§7's delivery gate reads this — it must not report a status that never landed",
    );
    assert.equal(fresh.status, "final");
    assert.equal(fresh.sections.find((s) => s.id === "approach")?.body, "later");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acceptProposal: a document file with uncommitted changes refuses — §4's dirty-tree gate", async () => {
  const { root, paths } = setup("dirty");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "dirty",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const withP = (await addProposal(paths, WS, doc.id, {
      sectionId: "approach",
      newBody: "agent text",
      agentId: "anderson",
      rationale: "r",
    })) as DocWire;
    const file = join(paths.orgRepo, "workspaces", "pg", "specs", `${doc.id}.md`);
    writeFileSync(file, `${readFileSync(file, "utf8")}\nHAND EDIT BY A HUMAN\n`);
    const refused = await acceptProposal(paths, WS, doc.id, withP.proposals[0].id);
    assert.equal(asError(refused).status, 409);
    assert.match(asError(refused).error, /uncommitted changes/);
    assert.match(asError(refused).error, /workspaces\/pg\/specs\//, "the refusal names the path");
    assert.match(
      readFileSync(file, "utf8"),
      /HAND EDIT BY A HUMAN/,
      "the human's text is untouched — the refusal is not a revert",
    );
    assert.notEqual(
      execFileSync("git", ["for-each-ref", "refs/heads/proposals/"], { cwd: paths.orgRepo }).toString(),
      "",
      "the branch is intact — a refused accept deletes nothing",
    );
    // Commit the hand edit and the same accept goes through, as the agent —
    // even with the rest of the org repo dirty. The check is scoped to THIS
    // document's file: an unrelated edit elsewhere is not this accept's
    // business, and blocking on it would make one stray file freeze every
    // accept in the org.
    execFileSync("git", ["add", "--", `workspaces/pg/specs/${doc.id}.md`], { cwd: paths.orgRepo });
    execFileSync("git", ["-c", "user.name=h", "-c", "user.email=h@h", "commit", "-q", "-m", "hand edit"], {
      cwd: paths.orgRepo,
    });
    writeFileSync(join(paths.orgRepo, "workspaces", "other", "settings.json"), '{"name":"other","repos":[],"x":1}\n');
    writeFileSync(join(paths.orgRepo, "HANDDROP.txt"), "dropped in by a human\n");
    const otherDoc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "neighbour",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const neighbourFile = join(paths.orgRepo, "workspaces", "pg", "specs", `${otherDoc.id}.md`);
    writeFileSync(neighbourFile, `${readFileSync(neighbourFile, "utf8")}\nEDIT TO A SIBLING DOCUMENT\n`);
    const accepted = await acceptProposal(paths, WS, doc.id, withP.proposals[0].id);
    assert.ok(isDoc(accepted), `an unrelated dirty file must not block this accept: ${JSON.stringify(accepted)}`);
    assert.equal(accepted.sections.find((s) => s.id === "approach")?.body, "agent text");
    assert.match(lastLog(paths.orgRepo), /^anderson\|spec\(dirty\): accept proposal 1 — approach/);
    // …and the accept committed only its own file — the sibling's edit and the
    // hand-dropped files are still sitting there uncommitted.
    assert.match(
      readFileSync(neighbourFile, "utf8"),
      /EDIT TO A SIBLING DOCUMENT/,
      "the neighbour's uncommitted edit was neither committed nor reverted",
    );
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: paths.orgRepo }).toString();
    assert.match(porcelain, /HANDDROP\.txt/);
    assert.match(porcelain, /workspaces\/other\/settings\.json/);
    assert.match(porcelain, new RegExp(`${otherDoc.id}\\.md`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listIds: a DIRECTORY named <id>.md is not a document", async () => {
  const { root, paths } = setup("dirmd");
  try {
    const good = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "good",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const fake = "2026-01-01-0000-not-a-doc-design";
    mkdirSync(join(paths.orgRepo, "workspaces", "pg", "specs", `${fake}.md`), { recursive: true });
    writeFileSync(join(paths.orgRepo, "workspaces", "pg", "specs", `${fake}.md`, "inside.txt"), "x\n");
    assert.equal(await resolveDocument(paths, WS, fake), null, "never located, so no mutation can act on it");
    assert.equal(await rejectProposal(paths, WS, fake, "1"), null);
    assert.deepEqual(
      (await listWorkspaceDocuments(paths, PG)).map((d) => d.id),
      [good.id],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchSection: the preamble is writable and its commit subject names it", async () => {
  const { root, paths } = setup("preamble");
  try {
    const doc = (await createDocument(paths, PG, WS, {
      blueprintId: "spec",
      workType: "feature",
      effort: "pre",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    // A preamble only exists once something sits above the first heading.
    const file = join(paths.orgRepo, "workspaces", "pg", "specs", `${doc.id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replace("\n## ", "\nintro line\n\n## "));
    const r = await patchSection(paths, WS, doc.id, "", "a better intro", EDWIN);
    assert.ok(isDoc(r), JSON.stringify(r));
    assert.equal(r.sections.find((s) => s.id === "")?.body, "a better intro");
    assert.match(lastLog(paths.orgRepo), /^Edwin Cruz\|spec\(pre\): preamble$/m, "no commit subject ends at the colon");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
