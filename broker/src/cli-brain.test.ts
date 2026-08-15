import assert from "node:assert/strict";
import { test } from "node:test";
import { createCliStreamFactory } from "./cli-brain.ts";

/** Stand-in for the subprocess: records argv, replays a scripted result. Same shape as research.test.ts's stub. */
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

test("parses the schema envelope into Anthropic blocks", async () => {
  const spawn = async () => ({
    code: 0,
    stdout: JSON.stringify({
      speech: "Handing that to Ignacio.",
      tool_calls: [{ name: "delegate", input: { agent: "Ignacio", task: "fix login" } }],
    }),
    stderr: "",
  });
  const stream = createCliStreamFactory({ argv: ["claude", "-p"], spawn })({
    model: "m",
    max_tokens: 100,
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  });
  const deltas: string[] = [];
  stream.on("text", (d) => deltas.push(d));
  const final = await stream.finalMessage();

  // Speech arrives as ONE delta — this kind cannot stream, and the test pins that.
  assert.deepEqual(deltas, ["Handing that to Ignacio."]);
  assert.equal(final.stop_reason, "tool_use");
  assert.equal(final.content.find((b) => b.type === "tool_use")?.name, "delegate");
});

test("a non-JSON reply fails loudly rather than becoming empty speech", async () => {
  const spawn = async () => ({ code: 0, stdout: "I couldn't do that", stderr: "" });
  const stream = createCliStreamFactory({ argv: ["claude", "-p"], spawn })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [],
    tools: [],
  });
  await assert.rejects(() => stream.finalMessage(), /could not parse/i);
});

test("the prompt is the final argv element, and --json-schema carries the tool-name enum inline", async () => {
  const stub = spawnStub({ code: 0, stdout: JSON.stringify({ speech: "ok", tool_calls: [] }), stderr: "" });
  const stream = createCliStreamFactory({ argv: ["claude", "-p"], spawn: stub.fn })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "delegate", description: "hand off work", input_schema: { type: "object" } }],
  });
  await stream.finalMessage();

  const argv = stub.calls[0].argv;
  assert.deepEqual(argv.slice(0, 2), ["claude", "-p"]);
  const schemaIndex = argv.indexOf("--json-schema");
  assert.ok(schemaIndex >= 0, "must pass --json-schema");
  const schema = JSON.parse(argv[schemaIndex + 1] as string);
  assert.deepEqual(schema.properties.tool_calls.items.properties.name.enum, ["delegate"]);
  // The prompt is the LAST element — never a file path, never before the schema flag's value.
  assert.equal(argv.at(-1), argv[argv.length - 1]);
  assert.ok((argv.at(-1) as string).includes("hi"), "prompt must reach argv unescaped");
  assert.notEqual(schemaIndex + 1, argv.length - 1, "the schema value and the prompt must be distinct elements");
});

test('treats model "default" the same as no model, matching CliResearch\'s sentinel rule', async () => {
  const stub = spawnStub({ code: 0, stdout: JSON.stringify({ speech: "ok", tool_calls: [] }), stderr: "" });
  const stream = createCliStreamFactory({ argv: ["claude", "-p"], model: "default", spawn: stub.fn })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [],
    tools: [],
  });
  await stream.finalMessage();
  assert.ok(!stub.calls[0].argv.includes("--model"));
});

test("a non-zero exit turns into an error carrying stderr, not a silently empty turn", async () => {
  const spawn = async () => ({ code: 1, stdout: "", stderr: "not logged in" });
  const stream = createCliStreamFactory({ argv: ["claude", "-p"], spawn })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [],
    tools: [],
  });
  await assert.rejects(
    () => stream.finalMessage(),
    (e: Error) => /not logged in/.test(e.message),
  );
});
