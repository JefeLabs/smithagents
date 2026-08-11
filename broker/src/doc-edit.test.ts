import assert from "node:assert/strict";
import { test } from "node:test";
import { runDocEditTurn } from "./doc-edit.ts";
import type { Doc } from "./documents.ts";

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
  const calls: object[] = [];
  const create = async (params: object) => {
    calls.push(params);
    return { content: [{ type: "text", text: reply }] };
  };
  return { calls, create };
}

test("happy path: parses the fenced JSON, validates sections, carries target + persona into the prompt", async () => {
  const { calls, create } = stub(
    'Here you go:\n```json\n{"rewrites":[{"sectionId":"approach","newBody":"New approach."}],"note":"tightened Approach"}\n```',
  );
  const r = await runDocEditTurn({
    doc: DOC,
    instruction: "tighten the approach",
    targetSectionId: "approach",
    persona: "Osvaldo, senior",
    create,
  });
  assert.deepEqual(r.rewrites, [{ sectionId: "approach", newBody: "New approach." }]);
  assert.equal(r.note, "tightened Approach");
  const params = calls[0] as { model: string; system: string; messages: Array<{ content: string }> };
  assert.equal(params.model, "claude-sonnet-5");
  assert.match(params.system, /Osvaldo, senior/);
  assert.match(params.messages[0].content, /TARGET SECTION: approach/);
  assert.match(params.messages[0].content, /Old overview\./); // full doc rides along
  assert.match(params.messages[0].content, /tighten the approach/);
});

test("a dashboard doc's prompt carries the spec schema — texts[] included", async () => {
  const { calls, create } = stub('```json\n{"rewrites":[{"sectionId":"spec","newBody":"{}"}],"note":"n"}\n```');
  await runDocEditTurn({
    doc: { ...DOC, blueprintId: "dashboard", sections: [{ id: "spec", heading: "Spec", body: "{}" }] },
    instruction: "add a text card",
    create,
  });
  const content = String((calls[0] as { messages: Array<{ content: string }> }).messages[0]!.content);
  assert.match(content, /SPEC SCHEMA/);
  assert.match(content, /texts\?:/);
  // A prose doc's prompt does NOT carry it.
  const second = stub('```json\n{"rewrites":[{"sectionId":"overview","newBody":"x"}],"note":"n"}\n```');
  await runDocEditTurn({ doc: DOC, instruction: "tighten", create: second.create });
  assert.doesNotMatch(
    String((second.calls[0] as { messages: Array<{ content: string }> }).messages[0]!.content),
    /SPEC SCHEMA/,
  );
});

test("bare JSON (no fence) parses too; model overridable", async () => {
  const { calls, create } = stub('{"rewrites":[{"sectionId":"overview","newBody":"X"}],"note":"n"}');
  const r = await runDocEditTurn({ doc: DOC, instruction: "x", create, model: "claude-haiku-4-5" });
  assert.equal(r.rewrites[0].sectionId, "overview");
  assert.equal((calls[0] as { model: string }).model, "claude-haiku-4-5");
});

test("a rewrite naming an unknown section throws — never a partial apply", async () => {
  const { create } = stub('```json\n{"rewrites":[{"sectionId":"ghost","newBody":"X"}],"note":"n"}\n```');
  await assert.rejects(runDocEditTurn({ doc: DOC, instruction: "x", create }), /usable rewrites/);
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
  const { create } = stub(
    '```json\n{"rewrites":[{"sectionId":"approach","newBody":"## section id=approach heading=\\"Approach\\"\\nReal content."}],"note":"n"}\n```',
  );
  const r = await runDocEditTurn({ doc: DOC, instruction: "x", create });
  assert.equal(r.rewrites[0].newBody, "Real content.");
});
