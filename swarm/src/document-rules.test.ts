import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BLUEPRINTS } from "./blueprints.js";
import { type DocStatus, type ParsedDocument, splitSections } from "./document-file.js";
import {
  type RuleResolvers,
  shapeProblem,
  structuralProblems,
  transitionProblems,
  validateDocument,
} from "./document-rules.js";

const spec = DEFAULT_BLUEPRINTS.find((b) => b.id === "spec")!;
const plan = DEFAULT_BLUEPRINTS.find((b) => b.id === "implementation-plan")!;
const er = DEFAULT_BLUEPRINTS.find((b) => b.id === "er")!;

function doc(over: Partial<ParsedDocument["frontmatter"]> = {}, sections = defaultSections()): ParsedDocument {
  return {
    frontmatter: {
      title: "T",
      blueprint: "spec",
      workType: "feature",
      status: "drafting",
      effort: "t",
      slices: [],
      participants: [],
      pins: [],
      createdAt: "2026-08-22T15:30:00.000Z",
      updatedAt: "2026-08-22T15:30:00.000Z",
      ...over,
    },
    sections,
  };
}
function defaultSections() {
  return ["overview", "ui-refs", "approach", "non-goals", "testing"].map((id) => ({ id, heading: id, body: "" }));
}
const R: RuleResolvers = { specStatus: async () => null, sliceExists: async () => false };

test("shapeProblem: prose accepts anything; checklist wants - [ ] lines; mermaid wants exactly one fenced block", () => {
  assert.equal(shapeProblem(undefined, "anything"), null);
  assert.equal(shapeProblem("checklist", "- [ ] a\n- [x] b"), null);
  assert.match(shapeProblem("checklist", "- [ ] a\nplain")!, /line 2/);
  assert.equal(shapeProblem("mermaid", "```mermaid\ngraph TD\n```"), null);
  assert.match(shapeProblem("mermaid", "text")!, /fenced mermaid/);
  assert.match(shapeProblem("mermaid", "```mermaid\na\n```\n```mermaid\nb\n```")!, /exactly one/);
});

test("structuralProblems: a missing active section is reported by id; a section for another workType is not required", () => {
  const missing = doc(
    {},
    defaultSections().filter((s) => s.id !== "approach"),
  );
  assert.deepEqual(
    structuralProblems(spec, missing).map((p) => p.where),
    ["section:approach"],
  );
  assert.deepEqual(structuralProblems(spec, doc()), [], "repro is bugfix-only, so its absence is fine for feature");
  assert.ok(structuralProblems(spec, doc({ workType: "nope" })).some((p) => p.where === "frontmatter.workType"));
});

test("validateDocument: cross-refs — unknown slice, a plan whose spec is absent, a spec that names a spec", async () => {
  const bad = await validateDocument(spec, doc({ slices: ["s1"] }), R);
  assert.ok(bad.some((p) => p.where === "frontmatter.slices" && /s1/.test(p.message)));
  const ok = await validateDocument(spec, doc({ slices: ["s1"] }), { ...R, sliceExists: async (id) => id === "s1" });
  assert.deepEqual(ok, []);
  const planSections = plan.sections.map((s) => ({ id: s.id, heading: s.heading, body: "" }));
  const planDoc = doc({ blueprint: "implementation-plan", spec: "2026-08-22-1530-t-design" }, planSections);
  const absent = await validateDocument(plan, planDoc, R);
  assert.ok(absent.some((p) => p.where === "frontmatter.spec" && /not found/.test(p.message)));
  const specWithSpec = await validateDocument(spec, doc({ spec: "x" }), R);
  assert.ok(specWithSpec.some((p) => p.where === "frontmatter.spec" && /only a plan/.test(p.message)));
});

test("transitionProblems: the §6.3 matrix", async () => {
  const d = doc();
  assert.deepEqual(
    await transitionProblems(spec, d, "review", R),
    [],
    "drafting → review with all active sections present (empty is fine)",
  );
  const toFinal = await transitionProblems(spec, d, "final", R);
  assert.ok(toFinal.some((p) => p.where === "section:overview" && /required/.test(p.message)));
  assert.ok(toFinal.some((p) => p.where === "section:non-goals"));
  const filled = doc(
    {},
    defaultSections().map((s) => ({ ...s, body: "x" })),
  );
  assert.deepEqual(await transitionProblems(spec, filled, "final", R), []);
  assert.deepEqual(
    await transitionProblems(spec, doc({ status: "final" }), "drafting", R),
    [],
    "reopen is always allowed",
  );
  const planSections = plan.sections.map((s) => ({
    id: s.id,
    heading: s.heading,
    body: s.id === "tasks" ? "- [ ] t" : "x",
  }));
  const planDoc = doc({ blueprint: "implementation-plan", spec: "s" }, planSections);
  const specNotFinal = await transitionProblems(plan, planDoc, "final", { ...R, specStatus: async () => "review" });
  assert.ok(specNotFinal.some((p) => p.where === "frontmatter.spec" && /final/.test(p.message)));
  assert.deepEqual(await transitionProblems(plan, planDoc, "final", { ...R, specStatus: async () => "final" }), []);
  const badTasks = doc(
    { blueprint: "implementation-plan", spec: "s" },
    planSections.map((s) => (s.id === "tasks" ? { ...s, body: "prose" } : s)),
  );
  assert.ok(
    (await transitionProblems(plan, badTasks, "review", { ...R, specStatus: async () => "final" })).some(
      (p) => p.where === "section:tasks",
    ),
  );
});

test("positive control: a deliberately invalid document fails every gate", async () => {
  const broken = doc({ workType: "nope" }, []);
  assert.ok(structuralProblems(spec, broken).length > 0);
  assert.ok((await transitionProblems(spec, broken, "review", R)).length > 0);
});

test("structuralProblems/transitionProblems: a duplicate {#id} is first-wins, reported once, and the verdict does not depend on order", async () => {
  const rest = plan.sections.filter((s) => s.id !== "tasks").map((s) => ({ id: s.id, heading: s.heading, body: "x" }));
  const proseThenChecklist = [
    ...rest,
    { id: "tasks", heading: "Tasks", body: "prose" },
    { id: "tasks", heading: "Tasks", body: "- [ ] t" },
  ];
  const checklistThenProse = [
    ...rest,
    { id: "tasks", heading: "Tasks", body: "- [ ] t" },
    { id: "tasks", heading: "Tasks", body: "prose" },
  ];
  const a = doc({ blueprint: "implementation-plan" }, proseThenChecklist);
  const b = doc({ blueprint: "implementation-plan" }, checklistThenProse);
  const probsA = structuralProblems(plan, a);
  const probsB = structuralProblems(plan, b);
  // Both orderings must refuse — a duplicate id is a problem in its own
  // right, regardless of which copy's shape happens to govern (first-wins).
  assert.ok(
    probsA.some((p) => p.where === "section:tasks" && /duplicate/.test(p.message)),
    "prose-then-checklist reports the duplicate",
  );
  assert.ok(
    probsB.some((p) => p.where === "section:tasks" && /duplicate/.test(p.message)),
    "checklist-then-prose reports the duplicate",
  );
  // First-wins: the FIRST copy's shape is the one that governs.
  assert.ok(
    probsA.some((p) => p.where === "section:tasks" && /checklist item/.test(p.message)),
    "first copy is prose — a shape violation",
  );
  assert.ok(
    !probsB.some((p) => p.where === "section:tasks" && /checklist item/.test(p.message)),
    "first copy is a valid checklist — no shape violation",
  );
  // Same verdict either way at the gate that matters: → review refuses both.
  assert.ok((await transitionProblems(plan, a, "review", R)).length > 0);
  assert.ok((await transitionProblems(plan, b, "review", R)).length > 0);
});

test("transitionProblems: a plan naming no spec reaches final — the spec gate is opt-in, only for plans that link one", async () => {
  const planSections = plan.sections.map((s) => ({
    id: s.id,
    heading: s.heading,
    body: s.id === "tasks" ? "- [ ] t" : "x",
  }));
  const planDoc = doc({ blueprint: "implementation-plan" }, planSections); // no `spec` field at all
  assert.deepEqual(await transitionProblems(plan, planDoc, "final", R), []);
});

test("transitionProblems: → drafting is unconditional even for a wrecked document", async () => {
  const wreck = doc({ status: "final", workType: "nope" }, []);
  assert.deepEqual(await transitionProblems(spec, wreck, "drafting", R), []);
});

test("transitionProblems: an unrecognized destination status reports frontmatter.status instead of proceeding", async () => {
  const problems = await transitionProblems(spec, doc(), "bogus" as DocStatus, R);
  assert.ok(problems.some((p) => p.where === "frontmatter.status"));
});

test("structuralProblems: a blueprint/document id mismatch is reported", () => {
  assert.ok(structuralProblems(plan, doc()).some((p) => p.where === "frontmatter.blueprint"));
});

test("transitionProblems: an er document with an empty (not yet drawn) diagram section still passes → review", async () => {
  const erDoc = doc({ blueprint: "er", workType: "feature" }, [{ id: "diagram", heading: "Diagram", body: "" }]);
  assert.deepEqual(await transitionProblems(er, erDoc, "review", R), []);
});

test("shapeProblem: an empty-but-closed mermaid fence is VALID (a cleared diagram is a legitimate draft state); a genuinely unclosed one still fails with the unclosed message", () => {
  assert.equal(shapeProblem("mermaid", "```mermaid\n```"), null, "zero content lines between open and close");
  assert.match(shapeProblem("mermaid", "```mermaid\ngraph TD")!, /never closed/, "genuinely unclosed still fails");
  // The tightening this fix round keeps: a closing fence glued to content is not a close (CommonMark).
  assert.match(shapeProblem("mermaid", "```mermaid\ngraph TD```")!, /never closed/);
});

test("shapeProblem: an info string after the mermaid marker is reported by name, not as a missing fence", () => {
  assert.match(shapeProblem("mermaid", "```mermaid title\ngraph TD\n```")!, /info string \("title"\)/);
  assert.match(shapeProblem("mermaid", "```mermaidTitle\ngraph TD\n```")!, /info string \("Title"\)/);
});

test("shapeProblem vs document-file.splitSections: mermaid fence recognition agrees with the parser — a fence indented past column 0 is a fence to NEITHER module", () => {
  // The reviewer's exact fixture: a 3-space-indented fence with a column-0
  // `## ` line inside it. Before this fix round, shapeProblem tolerated the
  // indent (treating this as one valid block) while splitSections does not
  // (it never suppresses heading detection inside an unrecognized fence),
  // so the two modules disagreed about whether this body is one block or
  // two sections. After the fix, neither treats the indented fence as real:
  // shapeProblem refuses it, and splitSections still splits on the embedded
  // heading — same verdict (not one clean block) from both.
  const body = "   ```mermaid\ngraph TD\n## Orders is a table\n   ```";
  assert.notEqual(
    shapeProblem("mermaid", body),
    null,
    "document-rules does not recognize the indented fence as a valid mermaid block",
  );
  const sections = splitSections(`## Diagram {#diagram}\n\n${body}\n`);
  assert.equal(
    sections.length,
    2,
    "document-file also does not treat the indented fence as suppressing the embedded ## heading",
  );
});
