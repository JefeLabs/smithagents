import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamFactory } from "./brain.ts";
import { polishText } from "./polish.ts";

const factoryReturning = (text: string | Error): StreamFactory =>
  (() => ({
    on: () => {},
    finalMessage: async () => {
      if (text instanceof Error) throw text;
      return { content: [{ type: "text", text }], stop_reason: "end_turn" };
    },
  })) as unknown as StreamFactory;

test("returns the rewritten text trimmed", async () => {
  const out = await polishText(
    factoryReturning("  Please review the login fix today.  "),
    "m",
    "plz revu login fx tody",
  );
  assert.equal(out, "Please review the login fix today.");
});

test("a failed model call returns null, never throws", async () => {
  const out = await polishText(factoryReturning(new Error("rate limited")), "m", "x");
  assert.equal(out, null);
});

test("an empty rewrite returns null so the caller keeps the draft", async () => {
  const out = await polishText(factoryReturning("   "), "m", "x");
  assert.equal(out, null);
});
