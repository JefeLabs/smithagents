import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyElevenlabs } from "./verify-elevenlabs.js";

test("verifyElevenlabs: ok on 200 from /v1/voices, sends xi-api-key header", async () => {
  const f = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), "https://api.elevenlabs.io/v1/voices");
    assert.equal(((init?.headers ?? {}) as Record<string, string>)["xi-api-key"], "el-key");
    return new Response(JSON.stringify({ voices: [{ voice_id: "a" }, { voice_id: "b" }] }), { status: 200 });
  }) as typeof fetch;
  const r = await verifyElevenlabs("el-key", f);
  assert.equal(r.ok, true);
  assert.match(r.detail, /2 voices/);
});

test("verifyElevenlabs: 401 missing_permissions is a VALID key — restricted scope, ok with caveat", async () => {
  // ElevenLabs only evaluates permissions on a key it recognizes, so this
  // response authenticates the key. TTS may still work; only voice listing is blocked.
  const f = (async () =>
    new Response(
      JSON.stringify({
        detail: {
          status: "missing_permissions",
          message: "The API key you used is missing the permission voices_read to execute this operation.",
        },
      }),
      { status: 401 },
    )) as typeof fetch;
  const r = await verifyElevenlabs("scoped-key", f);
  assert.equal(r.ok, true);
  assert.match(r.detail, /restricted/i);
  assert.match(r.detail, /Voices: Read/);
});

test("verifyElevenlabs: not ok on 401 with unrecognized key", async () => {
  const f = (async () =>
    new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), {
      status: 401,
    })) as typeof fetch;
  const r = await verifyElevenlabs("bad", f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /401/);
  assert.match(r.detail, /Invalid API key/);
});

test("verifyElevenlabs: network failure resolves {ok:false}, never rejects", async () => {
  const f = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const r = await verifyElevenlabs("el-key", f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /fetch failed/);
});
