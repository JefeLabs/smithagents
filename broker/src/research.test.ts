import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicResearch, ResearchError } from "./research.ts";

/** Minimal stand-in for the SDK's messages.create. */
const createStub = (reply: unknown) => {
  const calls: unknown[] = [];
  return {
    calls,
    fn: async (params: unknown) => {
      calls.push(params);
      return reply;
    },
  };
};

test("AnthropicResearch returns the concatenated text of the reply", async () => {
  const stub = createStub({ content: [{ type: "text", text: "a title" }] });
  const engine = new AnthropicResearch(stub.fn, "claude-haiku-4-5");
  const out = await engine.complete({ system: "sys", prompt: "name this", maxTokens: 64 });
  assert.equal(out, "a title");
});

test("AnthropicResearch passes system, prompt and maxTokens through unchanged", async () => {
  const stub = createStub({ content: [{ type: "text", text: "x" }] });
  const engine = new AnthropicResearch(stub.fn, "claude-haiku-4-5");
  await engine.complete({ system: "SYS", prompt: "PROMPT", maxTokens: 123 });
  const p = stub.calls[0] as { model: string; max_tokens: number; system: string; messages: unknown[] };
  assert.equal(p.model, "claude-haiku-4-5");
  assert.equal(p.max_tokens, 123);
  assert.equal(p.system, "SYS");
  assert.deepEqual(p.messages, [{ role: "user", content: "PROMPT" }]);
});

test("AnthropicResearch ignores non-text blocks rather than stringifying them", async () => {
  const stub = createStub({
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "answer" },
    ],
  });
  const engine = new AnthropicResearch(stub.fn, "claude-haiku-4-5");
  assert.equal(await engine.complete({ system: "s", prompt: "p", maxTokens: 8 }), "answer");
});

test("AnthropicResearch turns a rejected call into a typed ResearchError", async () => {
  const engine = new AnthropicResearch(async () => {
    throw new Error("credit balance is too low");
  }, "claude-haiku-4-5");
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError && /credit balance/.test((err as Error).message),
  );
});

test("AnthropicResearch treats an empty reply as an error, never as empty text", async () => {
  // An empty string would silently poison a feed card or an election claim —
  // the caller cannot tell "the model said nothing" from "the call failed".
  const engine = new AnthropicResearch(async () => ({ content: [] }), "claude-haiku-4-5");
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError,
  );
});
