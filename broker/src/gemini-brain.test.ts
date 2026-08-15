import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blocksFromParts,
  createGeminiStreamFactory,
  type FetchLike,
  GeminiError,
  type GeminiPart,
  parseSse,
  sanitizeSchema,
  toGeminiContents,
  toGeminiRequest,
} from "./gemini-brain.ts";

const enc = new TextEncoder();

/** A Response whose body streams `frames` as SSE, split at arbitrary byte offsets. */
function sseResponse(frames: unknown[], opts?: { splitEvery?: number; status?: number }): Response {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  const chunkSize = opts?.splitEvery ?? text.length;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < text.length; i += chunkSize) {
        controller.enqueue(enc.encode(text.slice(i, i + chunkSize)));
      }
      controller.close();
    },
  });
  return new Response(body, { status: opts?.status ?? 200 });
}

test("sanitizeSchema strips keys Gemini rejects, recursively, and keeps the rest", () => {
  const cleaned = sanitizeSchema({
    type: "object",
    additionalProperties: false,
    $schema: "http://json-schema.org/draft-07/schema#",
    properties: {
      agent: { type: "string", description: "who", default: "nobody" },
      tags: { type: "array", items: { type: "string", const: "x" } },
    },
    required: ["agent"],
  });

  assert.deepEqual(cleaned, {
    type: "object",
    properties: {
      agent: { type: "string", description: "who" },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["agent"],
  });
});

test("toGeminiContents maps roles and recovers the tool NAME for a tool_result", () => {
  // Anthropic keys a tool result by tool_use_id only; Gemini needs the name.
  const contents = toGeminiContents([
    { role: "user", content: "who is around?" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "toolu_7", name: "get_roster", input: { scope: "all" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_7", content: "Ignacio, Wilkin" }] },
  ]);

  assert.equal(contents.length, 3);
  assert.deepEqual(contents[0], { role: "user", parts: [{ text: "who is around?" }] });
  assert.equal(contents[1].role, "model");
  assert.deepEqual(contents[1].parts[1], {
    functionCall: { name: "get_roster", args: { scope: "all" }, id: "toolu_7" },
  });
  assert.deepEqual(contents[2], {
    role: "user",
    parts: [{ functionResponse: { name: "get_roster", id: "toolu_7", response: { result: "Ignacio, Wilkin" } } }],
  });
});

test("toGeminiContents drops empty turns — Gemini rejects parts: []", () => {
  const contents = toGeminiContents([
    { role: "assistant", content: [] },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(contents, [{ role: "user", parts: [{ text: "hi" }] }]);
});

/** The shape assertions read against — narrower than `any`, so a rename breaks the test. */
interface GeminiRequestShape {
  systemInstruction: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }>;
  toolConfig: { functionCallingConfig: { mode: string } };
  generationConfig: { maxOutputTokens: number };
}

const asRequest = (v: unknown) => v as unknown as GeminiRequestShape;

test("toGeminiRequest: tool_choice none becomes functionCallingConfig mode NONE", () => {
  const base = {
    model: "gemini-flash-latest",
    max_tokens: 1024,
    system: "You are Anderson.",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "delegate", description: "hand off work", input_schema: { type: "object", properties: {} } }],
  };

  const auto = asRequest(toGeminiRequest(base));
  assert.equal(auto.toolConfig.functionCallingConfig.mode, "AUTO");
  assert.deepEqual(auto.systemInstruction, { parts: [{ text: "You are Anderson." }] });
  assert.equal(auto.generationConfig.maxOutputTokens, 1024);
  assert.equal(auto.tools?.[0].functionDeclarations[0].name, "delegate");

  const forced = asRequest(toGeminiRequest({ ...base, tool_choice: { type: "none" } }));
  assert.equal(forced.toolConfig.functionCallingConfig.mode, "NONE");
});

/**
 * The load-bearing one. Gemini returns finishReason "STOP" even when it emits a
 * function call, so stop_reason must come from the parts. Reading finishReason
 * would leave stop_reason "end_turn" and brain.ts would break out of its tool
 * loop at brain.ts:303 without ever running the tool.
 */
test("blocksFromParts derives stop_reason tool_use from a functionCall, not finishReason", () => {
  const withTool = blocksFromParts([
    { functionCall: { name: "delegate", args: { agent: "ignacio" }, id: "call_224103" } },
  ]);
  assert.equal(withTool.stop_reason, "tool_use");
  assert.deepEqual(withTool.content, [
    { type: "tool_use", id: "call_224103", name: "delegate", input: { agent: "ignacio" } },
  ]);

  const textOnly = blocksFromParts([{ text: "Yes, I can hear you." }]);
  assert.equal(textOnly.stop_reason, "end_turn");
  assert.deepEqual(textOnly.content, [{ type: "text", text: "Yes, I can hear you." }]);
});

test("blocksFromParts synthesizes an id when the model omits one, and drops empty text parts", () => {
  const r = blocksFromParts([{ text: "" }, { functionCall: { name: "remember", args: {} } } as GeminiPart]);
  assert.deepEqual(r.content, [{ type: "tool_use", id: "gemini_call_1", name: "remember", input: {} }]);
});

/**
 * Regression for a live-only failure: Gemini 3 rejects a replayed functionCall
 * that has lost its thought_signature ("Function call is missing a
 * thought_signature in functionCall parts", HTTP 400), which killed every
 * multi-round tool turn while all unit tests stayed green. The signature has to
 * survive out through the Anthropic block and back into the Gemini part.
 */
test("thoughtSignature round-trips: Gemini part -> Anthropic block -> Gemini part", () => {
  const sig = "ErQCCrECARFNMg-opaque-receipt";

  const { content } = blocksFromParts([
    { functionCall: { name: "delegate", args: { agent: "ignacio" }, id: "call_1" }, thoughtSignature: sig },
  ]);
  assert.equal(content[0].thoughtSignature, sig, "block must carry the signature out");

  const contents = toGeminiContents([{ role: "assistant", content }]);
  const part = contents[0].parts[0];
  assert.equal(part.thoughtSignature, sig, "and back in, as a SIBLING of functionCall");
  assert.equal(part.functionCall?.name, "delegate");
  assert.equal(
    (part.functionCall as Record<string, unknown>).thoughtSignature,
    undefined,
    "must not be nested inside functionCall",
  );
});

test("parseSse reassembles frames split across chunk boundaries", async () => {
  // 7-byte chunks guarantee every frame is torn mid-JSON.
  const res = sseResponse(
    [
      { candidates: [{ content: { parts: [{ text: "hello " }] } }] },
      { candidates: [{ content: { parts: [{ text: "world" }] } }] },
    ],
    { splitEvery: 7 },
  );
  const seen: string[] = [];
  for await (const chunk of parseSse(res.body as ReadableStream<Uint8Array>)) {
    for (const p of chunk.candidates?.[0]?.content?.parts ?? []) if (p.text) seen.push(p.text);
  }
  assert.deepEqual(seen, ["hello ", "world"]);
});

test("the factory streams text deltas to on('text') and returns Anthropic blocks", async () => {
  const fetchImpl: FetchLike = async () =>
    sseResponse([
      { candidates: [{ content: { parts: [{ text: "Yes, " }] } }] },
      { candidates: [{ content: { parts: [{ text: "I hear you." }] } }] },
      { candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] },
    ]);

  const factory = createGeminiStreamFactory({ apiKey: "k", fetchImpl });
  const stream = factory({
    model: "gemini-flash-latest",
    max_tokens: 1024,
    system: "s",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  });

  const deltas: string[] = [];
  stream.on("text", (d) => deltas.push(d));
  const final = await stream.finalMessage();

  assert.deepEqual(deltas, ["Yes, ", "I hear you."]);
  assert.equal(final.stop_reason, "end_turn");
  assert.equal(final.content.map((c) => c.text).join(""), "Yes, I hear you.");
});

/**
 * The request must not be issued by the factory itself: brain.ts calls the
 * factory, THEN attaches its listener, then awaits finalMessage. Firing early
 * would drop the opening speech deltas.
 */
test("no request is made until finalMessage() is awaited", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return sseResponse([{ candidates: [{ content: { parts: [{ text: "hi" }] } }] }]);
  };

  const stream = createGeminiStreamFactory({ apiKey: "k", fetchImpl })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [],
    tools: [],
  });
  assert.equal(calls, 0, "factory must not fetch");

  const deltas: string[] = [];
  stream.on("text", (d) => deltas.push(d));
  await stream.finalMessage();
  assert.equal(calls, 1);
  assert.deepEqual(deltas, ["hi"], "listener attached before the request still sees every delta");
});

test("a non-200 surfaces the API's own message instead of a silent empty turn", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ error: { message: "API key not valid", status: "INVALID_ARGUMENT" } }), {
      status: 400,
    });

  const stream = createGeminiStreamFactory({ apiKey: "bad", fetchImpl })({
    model: "m",
    max_tokens: 10,
    system: "s",
    messages: [],
    tools: [],
  });

  await assert.rejects(
    () => stream.finalMessage(),
    (e: Error) => e instanceof GeminiError && /400/.test(e.message) && /API key not valid/.test(e.message),
  );
});
