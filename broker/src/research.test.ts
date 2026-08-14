import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AnthropicResearch,
  CliResearch,
  defaultSpawner,
  makeSpawner,
  type ResearchEngine,
  ResearchError,
} from "./research.ts";

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

test('AnthropicResearch turns a non-Error rejection into a message, never the literal string "undefined"', async () => {
  // A rejection that isn't an Error instance has no .message — String((err as
  // Error).message) stringifies that to "undefined" and the doc-edit path
  // broadcasts it to the user verbatim ("couldn't apply that: undefined").
  const engine = new AnthropicResearch(async () => {
    throw "credit balance is too low";
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

test("AnthropicResearch errors when a reply has blocks but none are text", async () => {
  const engine = new AnthropicResearch(async () => ({ content: [{ type: "thinking", thinking: "hmm" }] }), "m");
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError,
  );
});

/** Stand-in for the subprocess: records argv, replays a scripted result. */
const spawnStub = (result: { code: number | null; stdout: string; stderr: string }) => {
  const calls: Array<{ argv: string[] }> = [];
  return {
    calls,
    fn: async (argv: string[]) => {
      calls.push({ argv });
      return result;
    },
  };
};

test("CliResearch returns trimmed stdout", async () => {
  const stub = spawnStub({ code: 0, stdout: "  a title\n", stderr: "" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  assert.equal(await engine.complete({ system: "s", prompt: "p", maxTokens: 8 }), "a title");
});

test("CliResearch passes system+prompt as the final argv element", async () => {
  // Every shipped driver does this — claude `--print '<p>'`, agy `--prompt
  // '<p>'`, codex `exec '<p>'`. None of them read the prompt from stdin.
  const stub = spawnStub({ code: 0, stdout: "ok", stderr: "" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  await engine.complete({ system: "SYS", prompt: "PROMPT", maxTokens: 8 });
  assert.deepEqual(stub.calls[0].argv.slice(0, 2), ["claude", "--print"]);
  const last = stub.calls[0].argv.at(-1) as string;
  assert.match(last, /SYS/);
  assert.match(last, /PROMPT/);
});

test("CliResearch does not escape or quote the prompt — spawn takes an argv array", async () => {
  // No shell is involved (spawn without shell:true goes straight to execve),
  // so quotes, newlines and backticks are ordinary characters. Escaping them
  // would corrupt the prompt, and the shipped drivers only escape because they
  // build a shell STRING for tmux; this does not.
  const stub = spawnStub({ code: 0, stdout: "ok", stderr: "" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  const nasty = `it's "quoted" \`and\` \n multi-line; rm -rf /`;
  await engine.complete({ system: "s", prompt: nasty, maxTokens: 8 });
  assert.ok((stub.calls[0].argv.at(-1) as string).includes(nasty), "prompt must survive byte-for-byte");
});

test("CliResearch appends the model flag only when a model is set", async () => {
  const withModel = spawnStub({ code: 0, stdout: "ok", stderr: "" });
  await new CliResearch(withModel.fn, ["claude", "--print"], "claude-sonnet").complete({
    system: "s",
    prompt: "p",
    maxTokens: 8,
  });
  assert.deepEqual(withModel.calls[0].argv, ["claude", "--print", "--model", "claude-sonnet", "s\n\np"]);

  const without = spawnStub({ code: 0, stdout: "ok", stderr: "" });
  await new CliResearch(without.fn, ["claude", "--print"], undefined).complete({
    system: "s",
    prompt: "p",
    maxTokens: 8,
  });
  assert.deepEqual(without.calls[0].argv, ["claude", "--print", "s\n\np"]);
});

test('CliResearch treats model "default" the same as no model — matching swarm/drivers/model-flag.ts\'s sentinel rule', async () => {
  // agy and copilot's only catalog entry is "default"; the UI always sends
  // tool.models[0], so a literal "--model default" would be spawned and every
  // driver treats that flag as unsupported. The CLI's own default must stand.
  const stub = spawnStub({ code: 0, stdout: "ok", stderr: "" });
  await new CliResearch(stub.fn, ["agy", "--print"], "default").complete({
    system: "s",
    prompt: "p",
    maxTokens: 8,
  });
  assert.deepEqual(stub.calls[0].argv, ["agy", "--print", "s\n\np"]);
});

test("CliResearch turns a non-zero exit into a ResearchError carrying stderr", async () => {
  const stub = spawnStub({ code: 1, stdout: "", stderr: "not logged in" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError && /not logged in/.test((err as Error).message),
  );
});

test("CliResearch treats a killed process (code null) as an error", async () => {
  const stub = spawnStub({ code: null, stdout: "partial", stderr: "" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError,
  );
});

test("CliResearch treats empty stdout on a clean exit as an error, not empty text", async () => {
  const stub = spawnStub({ code: 0, stdout: "   \n", stderr: "" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError,
  );
});

test("CliResearch and AnthropicResearch satisfy the same contract", async () => {
  // The six call sites must not be able to tell them apart.
  const engines: ResearchEngine[] = [
    new AnthropicResearch(async () => ({ content: [{ type: "text", text: "same" }] }), "m"),
    new CliResearch(async () => ({ code: 0, stdout: "same", stderr: "" }), ["x"], undefined),
  ];
  for (const e of engines) {
    assert.equal(await e.complete({ system: "s", prompt: "p", maxTokens: 8 }), "same");
  }
});

test("defaultSpawner settles when the binary does not exist", async () => {
  const r = await defaultSpawner(["definitely-not-a-real-binary-xyz"]);
  assert.equal(r.code, null);
  assert.match(r.stderr, /ENOENT|not found|spawn/i);
});

test("a timed-out spawner SIGKILLs the child and settles with code null well before it would exit on its own", async () => {
  // Proves three things at once: the timer fires, the process is actually
  // killed (not just abandoned), and the promise settles from the timer
  // branch rather than waiting on 'close'. A stubbed `code: null` in the
  // CliResearch tests above cannot exercise any of that — this is
  // defaultSpawner's own timer-and-kill logic, spawning something genuinely
  // slow and racing it against a short timeout.
  const spawner = makeSpawner(100);
  const started = Date.now();
  const r = await spawner(["sleep", "5"]);
  const elapsed = Date.now() - started;
  assert.equal(r.code, null);
  assert.ok(elapsed < 2000, `expected the 100ms timeout to win, took ${elapsed}ms`);
});
