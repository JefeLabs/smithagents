import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BLUEPRINTS } from "./blueprints.js";
import type { ParsedDocument } from "./document-file.js";
import {
  type RuleResolvers,
  shapeProblem,
  structuralProblems,
  transitionProblems,
  validateDocument,
} from "./document-rules.js";

const spec = DEFAULT_BLUEPRINTS.find((b) => b.id === "spec")!;
const plan = DEFAULT_BLUEPRINTS.find((b) => b.id === "implementation-plan")!;

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
