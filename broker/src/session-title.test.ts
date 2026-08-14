import assert from "node:assert/strict";
import { test } from "node:test";
import { type ResearchEngine, ResearchError } from "./research.ts";
import { generateSessionTitle } from "./session-title.js";

const engineOf = (reply: string): ResearchEngine => ({ complete: async () => reply });
const failing = (): ResearchEngine => ({
  complete: async () => {
    throw new ResearchError("engine down");
  },
});

test("returns a cleaned single-line title", async () => {
  const title = await generateSessionTitle(engineOf('  "Fix deploy pipeline."  '), "u", "r");
  assert.equal(title, "Fix deploy pipeline");
});

test("returns null when the engine fails — a failed title must never break a session", async () => {
  const title = await generateSessionTitle(failing(), "u", "r");
  assert.equal(title, null);
});
