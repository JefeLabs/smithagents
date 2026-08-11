import assert from "node:assert/strict";
import { test } from "node:test";
import { draftToAgentBody, type PersonaDraft } from "./persona-generator.ts";

const DRAFT: PersonaDraft = {
  name: "Rafael",
  role: "Software Architect",
  backstory: "From La Vega.",
  style: "Blunt.",
  directives: "Own the seams.",
  reactions: [
    { level: "agree", line: "Sound." },
    { level: "disagree", line: "No." },
  ],
  quickAnswers: [
    { id: "name", answer: "Rafael." },
    { id: "role", answer: "Architect." },
  ],
};

test("maps a draft to the wizard-equivalent create payload", () => {
  const body = draftToAgentBody(DRAFT, { language: "en-do", voiceId: "v-default" });
  assert.equal(body.name, "Rafael");
  assert.equal(body.role, "Software Architect");
  assert.equal(body.language, "en-do");
  assert.deepEqual(body.persona, { style: "Blunt." });
  assert.equal(body.directives, "Own the seams.");
  assert.deepEqual(body.engine, { cli: "claude", model: "claude-opus" });
  assert.deepEqual(body.voice, { voiceId: "v-default" });
  assert.deepEqual(body.reactions, { agree: ["Sound."], disagree: ["No."] });
  assert.deepEqual(body.quickAnswers, { name: "Rafael.", role: "Architect." });
});

test("omits voice when no voiceId is given", () => {
  const body = draftToAgentBody(DRAFT, { language: "en-do" });
  assert.equal(body.voice, undefined);
});
