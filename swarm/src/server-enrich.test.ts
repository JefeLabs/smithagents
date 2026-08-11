import assert from "node:assert/strict";
import { test } from "node:test";
import type { ComposedAgent } from "./agents.js";
import { buildAgentUpdate, enrichFromComposedAgent } from "./server.js";

const AGENTS = [
  {
    id: "octavio",
    name: "Octavio",
    role: "Backend engineer",
    directives: "Ship small, tested changes.",
    engine: { cli: "claude", model: "claude-opus" },
  },
] as unknown as ComposedAgent[];

test("a delegated task inherits the addressed agent persona AND its model", () => {
  const { profile, model } = enrichFromComposedAgent(AGENTS, "octavio");
  // Both halves matter: profile drives materialization, model drives the launch flag.
  assert.deepEqual(profile, { name: "Octavio", role: "Backend engineer", directives: "Ship small, tested changes." });
  assert.equal(model, "claude-opus");
});

test("an unknown or absent agent id yields no persona and no model, never a partial", () => {
  assert.deepEqual(enrichFromComposedAgent(AGENTS, "nobody"), { profile: undefined, model: undefined });
  assert.deepEqual(enrichFromComposedAgent(AGENTS, undefined), { profile: undefined, model: undefined });
});

test("buildAgentUpdate: avatar survives an update that does not mention it", () => {
  const existing: ComposedAgent = {
    id: "nena",
    name: "Nena",
    role: "QA",
    directives: "test",
    engine: { cli: "claude", model: "claude-opus" },
    avatar: "nena.png",
  };
  assert.equal(buildAgentUpdate(existing, { name: "Nena Dos" }).avatar, "nena.png");
});
