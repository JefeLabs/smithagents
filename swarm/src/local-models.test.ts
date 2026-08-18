import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLocalServers } from "./local-models.js";

/** Maps exact URLs to JSON bodies; anything else rejects, like a closed port. */
function stubJson(responses: Record<string, unknown>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const key = String(url);
    if (!(key in responses)) return Promise.reject(new Error(`ECONNREFUSED: ${key}`));
    return new Response(JSON.stringify(responses[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("detectLocalServers: a server that answers /v1/models is reported with its models", async () => {
  const fetchImpl = stubJson({
    "http://127.0.0.1:11434/v1/models": { data: [{ id: "qwen3:8b" }] },
  });
  const found = await detectLocalServers({ fetchImpl });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, "ollama");
  assert.deepEqual(
    found[0].models.map((m) => m.id),
    ["qwen3:8b"],
  );
});

test("detectLocalServers: nothing running is an empty list, never a throw", async () => {
  // The wizard renders this. A rejected probe must not take the step down.
  const fetchImpl = () => Promise.reject(new Error("ECONNREFUSED"));
  assert.deepEqual(await detectLocalServers({ fetchImpl }), []);
});

test("detectLocalServers: a server answering garbage is skipped, not surfaced as a broken entry", async () => {
  const fetchImpl = stubJson({ "http://127.0.0.1:1234/v1/models": { nope: true } });
  assert.deepEqual(await detectLocalServers({ fetchImpl }), []);
});

test("detectLocalServers: both servers running yields both, in a stable order", async () => {
  const fetchImpl = stubJson({
    "http://127.0.0.1:11434/v1/models": { data: [{ id: "a" }] },
    "http://127.0.0.1:1234/v1/models": { data: [{ id: "b" }] },
  });
  const found = await detectLocalServers({ fetchImpl });
  assert.deepEqual(
    found.map((s) => s.id),
    ["ollama", "lmstudio"],
  );
});
