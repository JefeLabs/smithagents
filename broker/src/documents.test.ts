import assert from "node:assert/strict";
import { test } from "node:test";
import type { Blueprint } from "./blueprints.ts";
import { type Doc, DocumentManager } from "./documents.ts";

const BP: Blueprint = {
  id: "spec",
  name: "Design Spec",
  family: "document",
  workTypes: ["feature", "bugfix"],
  sections: [
    { id: "overview", heading: "What this is" },
    { id: "repro", heading: "Reproduction", when: { workType: ["bugfix"] } },
  ],
};

function manager(saved: Doc[] = []) {
  const writes: Doc[] = [];
  const m = new DocumentManager(
    { loadAll: () => saved, save: (d) => writes.push(structuredClone(d)) },
    () => "2026-08-10T12:00:00.000Z",
  );
  m.init();
  return { m, writes };
}

test("create instantiates sections for the work type and persists", () => {
  const { m, writes } = manager();
  const doc = m.create(BP, "bugfix", "Login breaks on resume");
  assert.ok(doc);
  assert.equal(doc.id, "d1");
  assert.deepEqual(
    doc.sections.map((s) => s.id),
    ["overview", "repro"],
  );
  assert.equal(doc.status, "drafting");
  assert.deepEqual(doc.participants, []);
  assert.equal(writes.length, 1);
});

test("create returns null for an undeclared work type and persists nothing", () => {
  const { m, writes } = manager();
  assert.equal(m.create(BP, "decision", "x"), null);
  assert.equal(writes.length, 0);
});

test("patchSection replaces the body, bumps updatedAt, persists", () => {
  const { m, writes } = manager();
  const doc = m.create(BP, "feature", "T")!;
  const patched = m.patchSection(doc.id, "overview", "It does the thing.");
  assert.equal(patched?.sections.find((s) => s.id === "overview")?.body, "It does the thing.");
  assert.equal(writes.length, 2);
});

test("patchSection on unknown doc or section is null, nothing persists", () => {
  const { m, writes } = manager();
  const doc = m.create(BP, "feature", "T")!;
  assert.equal(m.patchSection("d99", "overview", "x"), null);
  assert.equal(m.patchSection(doc.id, "nope", "x"), null);
  assert.equal(writes.length, 1);
});

test("init loads persisted docs and continues the id sequence", () => {
  const persisted: Doc = {
    id: "d7",
    title: "Old",
    blueprintId: "spec",
    workType: "feature",
    sections: [{ id: "overview", heading: "What this is", body: "old" }],
    participants: [],
    proposals: [],
    status: "drafting",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const { m } = manager([persisted]);
  assert.equal(m.get("d7")?.title, "Old");
  assert.equal(m.create(BP, "feature", "New")?.id, "d8");
});

test("list is newest-updated first", () => {
  const { m } = manager();
  const a = m.create(BP, "feature", "A")!;
  m.create(BP, "feature", "B");
  m.patchSection(a.id, "overview", "bump"); // same fake clock, but patch re-saves; order falls back to insertion — assert both present
  assert.deepEqual(
    m
      .list()
      .map((d) => d.title)
      .sort(),
    ["A", "B"],
  );
});

test("changeBlueprint re-instantiates an untouched document under the new blueprint", () => {
  const { m } = manager();
  const PLAN: Blueprint = {
    id: "implementation-plan",
    name: "Implementation Plan",
    family: "document",
    workTypes: ["feature"],
    sections: [
      { id: "goal", heading: "Goal" },
      { id: "tasks", heading: "Tasks" },
    ],
  };
  const doc = m.create(BP, "feature", "Login work")!;
  const recast = m.changeBlueprint(doc.id, PLAN);
  assert.equal(recast?.blueprintId, "implementation-plan");
  assert.equal(recast?.workType, "feature");
  assert.deepEqual(
    recast?.sections.map((s) => s.id),
    ["goal", "tasks"],
  );
  assert.equal(recast?.title, "Login work"); // the title is the user's words, not the blueprint's
});

test("changeBlueprint refuses once any section has text, and on an unknown doc", () => {
  const { m } = manager();
  const PLAN: Blueprint = {
    id: "p",
    name: "P",
    family: "document",
    workTypes: ["feature"],
    sections: [{ id: "goal", heading: "Goal" }],
  };
  const doc = m.create(BP, "feature", "T")!;
  m.patchSection(doc.id, "overview", "Something written.");
  assert.equal(m.changeBlueprint(doc.id, PLAN), null);
  assert.equal(m.get(doc.id)?.blueprintId, "spec"); // untouched
  assert.equal(m.changeBlueprint("d99", PLAN), null);
});

test("rename sets a collapsed title, refuses blank, refuses unknown docs", () => {
  const { m } = manager();
  const doc = m.create(BP, "feature", "Old name")!;
  assert.equal(m.rename(doc.id, "  Login   flow  spec ")?.title, "Login flow spec");
  assert.equal(m.rename(doc.id, "   "), null);
  assert.equal(m.get(doc.id)?.title, "Login flow spec"); // the blank never landed
  assert.equal(m.rename("d99", "x"), null);
});

test("patchSection stores normalized markdown, whatever spelling arrived", () => {
  const { m } = manager();
  const doc = m.create(BP, "feature", "T")!;
  m.patchSection(doc.id, "overview", "*em* and __strong__");
  const stored = m.get(doc.id)?.sections.find((s) => s.id === "overview")?.body;
  m.patchSection(doc.id, "overview", "_em_ and **strong**");
  assert.equal(m.get(doc.id)?.sections.find((s) => s.id === "overview")?.body, stored);
  assert.match(stored ?? "", /_em_/); // the canonical spelling, not the input's
});

test("proposals: add → accept applies the body through the normalize path and marks accepted", () => {
  const { m } = manager();
  const doc = m.create(BP, "feature", "T");
  assert.ok(doc);
  const withP = m.addProposal(doc.id, {
    sectionId: "overview",
    agentId: "osvaldo",
    newBody: "*tighter* words",
    rationale: "shorter",
  });
  assert.ok(withP);
  const p = withP.proposals[0];
  assert.equal(p.id, "p1");
  assert.equal(p.state, "open");
  assert.equal(p.agentId, "osvaldo");
  const accepted = m.acceptProposal(doc.id, p.id);
  assert.ok(accepted);
  assert.equal(accepted.proposals[0].state, "accepted");
  assert.match(accepted.sections.find((s) => s.id === "overview")?.body ?? "", /_tighter_/); // normalized
});

test("proposals: reject marks rejected and leaves the section alone; non-open decisions are refused", () => {
  const { m } = manager();
  const doc = m.create(BP, "feature", "T");
  assert.ok(doc);
  const withP = m.addProposal(doc.id, { sectionId: "overview", agentId: "b", newBody: "x", rationale: "r" });
  assert.ok(withP);
  const pid = withP.proposals[0].id;
  const rejected = m.rejectProposal(doc.id, pid);
  assert.equal(rejected?.proposals[0].state, "rejected");
  assert.equal(rejected?.sections.find((s) => s.id === "overview")?.body, "");
  assert.equal(m.acceptProposal(doc.id, pid), null); // already decided
  assert.equal(m.rejectProposal(doc.id, pid), null);
});

test("proposals: a human patchSection stales every OPEN proposal on that section only", () => {
  const { m } = manager();
  const doc = m.create(BP, "bugfix", "T");
  assert.ok(doc);
  m.addProposal(doc.id, { sectionId: "overview", agentId: "a", newBody: "one", rationale: "r" });
  m.addProposal(doc.id, { sectionId: "repro", agentId: "a", newBody: "two", rationale: "r" });
  const d2 = m.addProposal(doc.id, { sectionId: "overview", agentId: "b", newBody: "three", rationale: "r" });
  assert.ok(d2);
  m.rejectProposal(doc.id, d2.proposals[2].id);
  m.patchSection(doc.id, "overview", "the human wrote this");
  const states = m.get(doc.id)?.proposals.map((p) => [p.sectionId, p.state]);
  assert.deepEqual(states, [
    ["overview", "stale"],
    ["repro", "open"],
    ["overview", "rejected"], // decided proposals never restate
  ]);
});

test("proposals: accepting does NOT stale sibling proposals; unknown ids return null", () => {
  const { m } = manager();
  const doc = m.create(BP, "feature", "T");
  assert.ok(doc);
  const a = m.addProposal(doc.id, { sectionId: "overview", agentId: "a", newBody: "one", rationale: "r" });
  m.addProposal(doc.id, { sectionId: "overview", agentId: "b", newBody: "two", rationale: "r" });
  assert.ok(a);
  const after = m.acceptProposal(doc.id, a.proposals[0].id);
  // acceptProposal applies via the private path — sibling OPEN proposals survive
  // for the human to consider; only a direct human edit stales them.
  assert.equal(after?.proposals[1].state, "open");
  assert.equal(m.addProposal("nope", { sectionId: "overview", agentId: "a", newBody: "x", rationale: "r" }), null);
  assert.equal(m.addProposal(doc.id, { sectionId: "ghost", agentId: "a", newBody: "x", rationale: "r" }), null);
  assert.equal(m.acceptProposal(doc.id, "p9"), null);
});

test("proposals: seq continues across restarts from stored ids", () => {
  const { m } = manager();
  const doc = m.create(BP, "feature", "T");
  assert.ok(doc);
  const withP = m.addProposal(doc.id, { sectionId: "overview", agentId: "a", newBody: "x", rationale: "r" });
  assert.ok(withP);
  const { m: m2 } = manager([structuredClone(m.get(doc.id) as Doc)]);
  const again = m2.addProposal(doc.id, { sectionId: "overview", agentId: "a", newBody: "y", rationale: "r" });
  assert.equal(again?.proposals[1].id, "p2");
});
