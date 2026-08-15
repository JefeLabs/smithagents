import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalStreamFactory } from "./local-brain.ts";

const enc = new TextEncoder();
function sse(frames: unknown[]): Response {
  const text = `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(text));
        c.close();
      },
    }),
    { status: 200 },
  );
}

test("streams text deltas and assembles a tool call into Anthropic blocks", async () => {
  const fetchImpl = async () =>
    sse([
      { choices: [{ delta: { content: "On it. " } }] },
      { choices: [{ delta: { content: "Handing off." } }] },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "delegate", arguments: '{"agent":' } }] },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ignacio"}' } }] } }] },
    ]);

  const stream = createLocalStreamFactory({ baseUrl: "http://127.0.0.1:1234", model: "m", fetchImpl })({
    model: "ignored",
    max_tokens: 100,
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  });

  const deltas: string[] = [];
  stream.on("text", (d) => deltas.push(d));
  const final = await stream.finalMessage();

  assert.deepEqual(deltas, ["On it. ", "Handing off."]);
  assert.equal(final.stop_reason, "tool_use");
  assert.deepEqual(
    final.content.find((b) => b.type === "tool_use"),
    {
      type: "tool_use",
      id: "call_1",
      name: "delegate",
      input: { agent: "ignacio" },
    },
  );
});

test("a dead server fails with a message naming the url, not a silent empty turn", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const stream = createLocalStreamFactory({ baseUrl: "http://127.0.0.1:9999", model: "m", fetchImpl })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [],
    tools: [],
  });
  await assert.rejects(
    () => stream.finalMessage(),
    (e: Error) => /9999/.test(e.message),
  );
});
