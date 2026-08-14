import assert from "node:assert/strict";
import { test } from "node:test";
import { runDocEditTurn } from "./doc-edit.ts";
import type { Doc } from "./documents.ts";
import type { ResearchInput } from "./research.ts";

const DOC: Doc = {
  id: "d1",
  title: "Login spec",
  blueprintId: "spec",
  workType: "feature",
  sections: [
    { id: "overview", heading: "What this is", body: "Old overview." },
    { id: "approach", heading: "Approach", body: "Old approach." },
  ],
  participants: [],
  proposals: [],
  status: "drafting",
  createdAt: "t",
  updatedAt: "t",
};

function stub(reply: string) {
  const calls: ResearchInput[] = [];
  const engine = {
    complete: async (input: ResearchInput) => {
      calls.push(input);
      return reply;
    },
  };
  return { calls, engine };
}

test("happy path: parses the fenced JSON, validates sections, carries target + persona into the prompt", async () => {
  const { calls, engine } = stub(
    'Here you go:\n```json\n{"rewrites":[{"sectionId":"approach","newBody":"New approach."}],"note":"tightened Approach"}\n```',
  );
  const r = await runDocEditTurn({
    doc: DOC,
    instruction: "tighten the approach",
    targetSectionId: "approach",
    persona: "Osvaldo, senior",
    engine,
  });
  assert.deepEqual(r.rewrites, [{ sectionId: "approach", newBody: "New approach." }]);
  assert.equal(r.note, "tightened Approach");
  const input = calls[0];
  assert.match(input.system, /Osvaldo, senior/);
  assert.match(input.prompt, /TARGET SECTION: approach/);
  assert.match(input.prompt, /Old overview\./); // full doc rides along
  assert.match(input.prompt, /tighten the approach/);
});

test("a dashboard doc's prompt carries the spec schema — texts[] included", async () => {
  const { calls, engine } = stub('```json\n{"rewrites":[{"sectionId":"spec","newBody":"{}"}],"note":"n"}\n```');
  await runDocEditTurn({
    doc: { ...DOC, blueprintId: "dashboard", sections: [{ id: "spec", heading: "Spec", body: "{}" }] },
    instruction: "add a text card",
    engine,
  });
  assert.match(calls[0].prompt, /SPEC SCHEMA/);
  assert.match(calls[0].prompt, /texts\?:/);
  // A prose doc's prompt does NOT carry it.
  const second = stub('```json\n{"rewrites":[{"sectionId":"overview","newBody":"x"}],"note":"n"}\n```');
  await runDocEditTurn({ doc: DOC, instruction: "tighten", engine: second.engine });
  assert.doesNotMatch(second.calls[0].prompt, /SPEC SCHEMA/);
});

test("bare JSON (no fence) parses too", async () => {
  const { engine } = stub('{"rewrites":[{"sectionId":"overview","newBody":"X"}],"note":"n"}');
  const r = await runDocEditTurn({ doc: DOC, instruction: "x", engine });
  assert.equal(r.rewrites[0].sectionId, "overview");
});

test("a rewrite naming an unknown section throws — never a partial apply", async () => {
  const { engine } = stub('```json\n{"rewrites":[{"sectionId":"ghost","newBody":"X"}],"note":"n"}\n```');
  await assert.rejects(runDocEditTurn({ doc: DOC, instruction: "x", engine }), /usable rewrites/);
});

test("malformed or empty replies throw", async () => {
  await assert.rejects(
    runDocEditTurn({ doc: DOC, instruction: "x", ...stub("no json here at all") }),
    /usable rewrites/,
  );
  await assert.rejects(
    runDocEditTurn({ doc: DOC, instruction: "x", ...stub('{"rewrites":[],"note":"n"}') }),
    /usable rewrites/,
  );
});

test("a parroted section-header scaffold line is stripped from newBody", async () => {
  const { engine } = stub(
    '```json\n{"rewrites":[{"sectionId":"approach","newBody":"## section id=approach heading=\\"Approach\\"\\nReal content."}],"note":"n"}\n```',
  );
  const r = await runDocEditTurn({ doc: DOC, instruction: "x", engine });
  assert.equal(r.rewrites[0].newBody, "Real content.");
});
