import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSessionTitle } from "./session-title.js";

const fakeStream = (text: string) => ({
  on() {},
  finalMessage: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }),
});

test("returns a cleaned single-line title", async () => {
  const title = await generateSessionTitle((() => fakeStream('  "Fix deploy pipeline."  ')) as never, "m", "u", "r");
  assert.equal(title, "Fix deploy pipeline");
});

test("returns null when the stream factory throws", async () => {
  const title = await generateSessionTitle(
    (() => {
      throw new Error("boom");
    }) as never,
    "m",
    "u",
    "r",
  );
  assert.equal(title, null);
});
