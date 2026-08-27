import assert from "node:assert/strict";
import { test } from "node:test";
import { createCliStreamFactory, toJsonSchema, toPrompt } from "./cli-brain.ts";

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

test("toJsonSchema forbids tool_calls when forceTextOnly is set — the schema, not just an ignored flag", () => {
  type Schema = { properties: { tool_calls: { maxItems?: number } }; required: string[] };

  const normal = toJsonSchema([{ name: "delegate" }]) as unknown as Schema;
  assert.equal(normal.properties.tool_calls.maxItems, undefined);

  const forced = toJsonSchema([{ name: "delegate" }], true) as unknown as Schema;
  assert.equal(forced.properties.tool_calls.maxItems, 0);
  // speech is still required — this is a text-only close, not a broken turn.
  assert.deepEqual(forced.required, ["speech", "tool_calls"]);
});

test("tool_choice: {type:'none'} reaches the CLI as a schema that cannot yield tool calls", async () => {
  const stub = spawnStub({ code: 0, stdout: JSON.stringify({ speech: "done", tool_calls: [] }), stderr: "" });
  const stream = createCliStreamFactory({ argv: ["claude", "-p"], spawn: stub.fn })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [],
    tools: [{ name: "delegate", description: "hand off work", input_schema: { type: "object" } }],
    tool_choice: { type: "none" },
  });
  await stream.finalMessage();

  const argv = stub.calls[0].argv;
  const schema = JSON.parse(argv[argv.indexOf("--json-schema") + 1] as string) as {
    properties: { tool_calls: { maxItems?: number } };
  };
  assert.equal(schema.properties.tool_calls.maxItems, 0);
});

test("prompt-mode cli (copilot): the schema travels IN THE PROMPT, never as a flag the binary would reject", async () => {
  const stub = spawnStub({ code: 0, stdout: JSON.stringify({ speech: "ok", tool_calls: [] }), stderr: "" });
  const stream = createCliStreamFactory({ argv: ["copilot", "--prompt"], spawn: stub.fn })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "delegate", description: "hand off work", input_schema: { type: "object" } }],
  });
  await stream.finalMessage();

  const argv = stub.calls[0].argv;
  assert.equal(argv.indexOf("--json-schema"), -1, "copilot has no such flag — passing it fails the turn");
  const prompt = argv.at(-1) as string;
  assert.ok(prompt.includes("hi"), "the conversation still reaches the prompt");
  assert.ok(prompt.includes('"delegate"'), "the tool-name enum reaches the prompt-embedded schema");
  assert.ok(/only.*json/i.test(prompt), "the prompt demands a JSON-only reply");
});

test("prompt-mode cli: a fenced ```json reply still parses — soft enforcement means cleaning, not trusting", async () => {
  const envelope = { speech: "done", tool_calls: [] };
  const spawn = async () => ({
    code: 0,
    stdout: `Sure! Here you go:\n\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\`\n`,
    stderr: "",
  });
  const stream = createCliStreamFactory({ argv: ["copilot", "--prompt"], spawn })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [],
    tools: [],
  });
  const final = await stream.finalMessage();
  assert.equal(final.stop_reason, "end_turn");
  assert.deepEqual(final.content, [{ type: "text", text: "done" }]);
});

test("prompt-mode cli: prose with no JSON in it still fails loudly, same as the flag mode", async () => {
  const spawn = async () => ({ code: 0, stdout: "I couldn't do that", stderr: "" });
  const stream = createCliStreamFactory({ argv: ["copilot", "--prompt"], spawn })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [],
    tools: [],
  });
  await assert.rejects(() => stream.finalMessage(), /could not parse/i);
});

test("file-mode cli (codex): schema arrives as a --output-schema file, the envelope is read from --output-last-message, and the temp dir is cleaned up", async () => {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");

  let schemaSeen: { properties?: { tool_calls?: { items?: { properties?: { name?: { enum?: string[] } } } } } } = {};
  let tempDir = "";
  const spawn = async (argv: string[]) => {
    const schemaPath = argv[argv.indexOf("--output-schema") + 1] as string;
    const lastPath = argv[argv.indexOf("--output-last-message") + 1] as string;
    tempDir = schemaPath.slice(0, schemaPath.lastIndexOf("/"));
    schemaSeen = JSON.parse(await readFile(schemaPath, "utf8"));
    await writeFile(lastPath, JSON.stringify({ speech: "from codex", tool_calls: [] }));
    // codex exec prints transcript noise to stdout — the envelope must NOT come from here.
    return { code: 0, stdout: "[2026-08-27] thinking...\ntokens used: 5000", stderr: "" };
  };

  const stream = createCliStreamFactory({ argv: ["codex", "exec"], spawn })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "delegate", description: "hand off work", input_schema: { type: "object" } }],
  });
  const final = await stream.finalMessage();

  assert.equal(schemaSeen.properties?.tool_calls?.items?.properties?.name?.enum?.[0], "delegate");
  assert.deepEqual(final.content, [{ type: "text", text: "from codex" }]);
  assert.ok(tempDir.length > 0, "spawner must have seen a real temp path");
  assert.ok(!existsSync(tempDir), "the per-turn temp dir must not leak");
});

test("toPrompt flattens a tool_use/tool_result history into readable prose, not just plain text turns", () => {
  const messages = [
    { role: "user", content: "check the login bug" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "On it." },
        { type: "tool_use", id: "1", name: "delegate", input: { agent: "Ignacio", task: "fix login" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "1", content: "Ignacio is on it" }],
    },
  ];

  const prompt = toPrompt("s", messages);

  assert.ok(prompt.startsWith("s\n\n"), "system leads the prompt");
  assert.ok(prompt.includes("user: check the login bug"));
  assert.ok(prompt.includes("assistant: On it."));
  assert.ok(prompt.includes('[called delegate with {"agent":"Ignacio","task":"fix login"}]'), "tool_use rendered");
  assert.ok(prompt.includes("[result: Ignacio is on it]"), "tool_result rendered");
});
