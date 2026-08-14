import assert from "node:assert/strict";
import { test } from "node:test";
import { polishText } from "./polish.ts";
import { type ResearchEngine, ResearchError } from "./research.ts";

const engineOf = (reply: string): ResearchEngine => ({ complete: async () => reply });
const failing = (): ResearchEngine => ({
  complete: async () => {
    throw new ResearchError("engine down");
  },
});

test("returns the rewritten text trimmed", async () => {
  const out = await polishText(engineOf("  Please review the login fix today.  "), "plz revu login fx tody");
  assert.equal(out, "Please review the login fix today.");
});

test("a failed model call returns null, never throws", async () => {
  const out = await polishText(failing(), "x");
  assert.equal(out, null);
});

test("an empty rewrite returns null so the caller keeps the draft", async () => {
  const out = await polishText(engineOf("   "), "x");
  assert.equal(out, null);
});
