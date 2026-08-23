import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type DocStatus, parseDocumentFile } from "./document-file.js";
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
import { makeOrgRepo } from "./org-repo.fixture.js";
import { smithPaths } from "./paths.js";
import type { Workspace } from "./workspaces.js";

const EDWIN = { name: "Edwin Cruz", email: "e@example.com" };
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
/** The error half of a StoreResult, asserted as such rather than as "not a doc". */
function asError(r: unknown): { error: string; status: number } {
  assert.ok(r && typeof r === "object" && "error" in r, `expected an error, got ${JSON.stringify(r)}`);
  return r as { error: string; status: number };
}

test("createDocument: a spec lands in specs/ with the §2 frontmatter, instantiated sections, one authored commit", async () => {
  const { root, paths } = setup("create");
  try {
    const r = await createDocument(paths, PG, {
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
    const a = await createDocument(paths, PG, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    });
    const b = await createDocument(paths, PG, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    });
    assert.ok(isDoc(a) && isDoc(b));
    assert.equal(b.id, `${a.id}-2`);
    const bad = await createDocument(paths, PG, { blueprintId: "nope", author: EDWIN, now: NOW });
    assert.deepEqual(bad, { error: "unknown blueprint: nope", status: 400 });
    const badType = await createDocument(paths, PG, {
      blueprintId: "spec",
      workType: "insight",
      author: EDWIN,
      now: NOW,
    });
    assert.equal(asError(badType).status, 400);
    assert.match(asError(badType).error, /workType must be one of: feature, bugfix, integration/);
    const untitled = await createDocument(paths, PG, { blueprintId: "dashboard", author: EDWIN, now: NOW });
    assert.ok(isDoc(untitled));
    assert.equal(untitled.title, "Dashboard", "a blank title takes the blueprint name");
    assert.match(untitled.id, /^2026-08-22-1530-dashboard/);
    assert.ok(statSync(join(paths.orgRepo, "workspaces", "pg", "dashboards", `${untitled.id}.md`)).isFile());
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
    const r = await createDocument(paths, PG, { blueprintId: "blank", author: EDWIN, now: NOW });
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
      createDocument(paths, nameless, { blueprintId: "spec", workType: "feature", author: EDWIN, now: NOW }),
    );
    assert.equal(existsSync(join(paths.orgRepo, "workspaces", "specs")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patchSection: normalizes, stamps updatedAt, commits as the author with the section in the message", async () => {
  const { root, paths } = setup("patch");
  try {
    const doc = (await createDocument(paths, PG, {
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
    const a = (await createDocument(paths, PG, {
      blueprintId: "spec",
      workType: "feature",
      effort: "same",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    assert.equal((await resolveDocument(paths, WS, a.id))?.slug, "pg");
    assert.equal(await resolveDocument(paths, WS, "2099-01-01-0000-nothing"), null);
    await createDocument(paths, OTHER, {
      blueprintId: "spec",
      workType: "feature",
      effort: "same",
      author: EDWIN,
      now: NOW,
    });
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
    const plan = (await createDocument(paths, PG, {
      blueprintId: "implementation-plan",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const dash = (await createDocument(paths, PG, {
      blueprintId: "dashboard",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    assert.equal(plan.id, dash.id, "no blueprint suffix outside `spec`, so the two stems collide");
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
    const good = (await createDocument(paths, PG, {
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
    assert.equal(await getDocument(paths, WS, "2026-01-01-0000-hand-edited-design"), null);
    assert.ok(isDoc(await getDocument(paths, WS, good.id)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setStatus: the gates bite — final refuses an empty required section; reopen always works", async () => {
  const { root, paths } = setup("status");
  try {
    const doc = (await createDocument(paths, PG, {
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
    assert.equal((await getDocument(paths, WS, doc.id))?.status, "review", "a refused transition writes nothing");
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

test("setStatus: a shape violation blocks review — the document keeps its status on disk", async () => {
  const { root, paths } = setup("shape");
  try {
    const doc = (await createDocument(paths, PG, {
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
    assert.equal((await getDocument(paths, WS, doc.id))?.status, "drafting");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("proposals: add → listed open → accept writes the section on main as the agent and deletes the branch", async () => {
  const { root, paths } = setup("accept");
  try {
    const doc = (await createDocument(paths, PG, {
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
    assert.equal((await getDocument(paths, WS, doc.id))?.sections.find((s) => s.id === "approach")?.body, "agent text");
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
    const doc = (await createDocument(paths, PG, {
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
      (await getDocument(paths, WS, doc.id))?.sections.find((s) => s.id === "approach")?.body,
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

test("renameDocument / setPins: title and pins change, the file does not move, nothing unparseable is written", async () => {
  const { root, paths } = setup("rename");
  try {
    const doc = (await createDocument(paths, PG, {
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
    assert.equal((await getDocument(paths, WS, doc.id))?.title, "New title");
    const pinned = (await setPins(paths, WS, doc.id, ["pg", "group:team", " pg ", ""], EDWIN)) as DocWire;
    assert.deepEqual(pinned.pins, ["pg", "group:team"], "trimmed and de-duplicated");
    const badPin = await setPins(paths, WS, doc.id, ["a,b"], EDWIN);
    assert.equal(asError(badPin).status, 400, "a comma would re-parse as two pins");
    assert.equal(asError(await setPins(paths, WS, doc.id, ["a]b"], EDWIN)).status, 400);
    assert.equal(asError(await setPins(paths, WS, doc.id, ["a\nstatus: final"], EDWIN)).status, 400);
    assert.deepEqual((await getDocument(paths, WS, doc.id))?.pins, ["pg", "group:team"], "no refusal reached the file");
    assert.equal(await renameDocument(paths, WS, "missing-id", "t", EDWIN), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changeBlueprint: re-casting needs an empty document AND the same folder — each refusal says which", async () => {
  const { root, paths } = setup("recast");
  try {
    const doc = (await createDocument(paths, PG, {
      blueprintId: "spec",
      workType: "feature",
      effort: "x",
      author: EDWIN,
      now: NOW,
    })) as DocWire;
    const recast = (await changeBlueprint(paths, WS, doc.id, "er", undefined, EDWIN)) as DocWire;
    assert.equal(recast.blueprintId, "er", "er shares the specs folder, and the document is still empty");
    assert.match(recast.sections[0].body, /^```mermaid/);
    const toPlan = await changeBlueprint(paths, WS, doc.id, "implementation-plan", undefined, EDWIN);
    assert.equal(asError(toPlan).status, 409);
    assert.match(
      asError(toPlan).error,
      /plans\//,
      "a different folder means a different file — create a new document instead",
    );
    const toSequence = await changeBlueprint(paths, WS, doc.id, "sequence", undefined, EDWIN);
    assert.equal(asError(toSequence).status, 409);
    assert.match(asError(toSequence).error, /content/, "same folder, but the er starter is content this would discard");
    assert.equal(asError(await changeBlueprint(paths, WS, doc.id, "nope", undefined, EDWIN)).status, 400);
    assert.equal((await getDocument(paths, WS, doc.id))?.blueprintId, "er", "no refusal reached the file");
    assert.equal(await changeBlueprint(paths, WS, "missing-id", "er", undefined, EDWIN), null);
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
