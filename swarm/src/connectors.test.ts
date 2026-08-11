// swarm/src/connectors.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { findVendor, VENDORS, verifyBeforeSave } from "./connectors.js";

test("findVendor: resolves each of the 6 shipped vendors by id", () => {
  for (const id of ["atlassian", "github", "datadog", "snyk", "elevenlabs", "deepgram"]) {
    assert.ok(findVendor(id), `expected a vendor def for "${id}"`);
  }
});

test("findVendor: unknown id resolves to undefined", () => {
  assert.equal(findVendor("not-a-vendor"), undefined);
});

test("field keys match the documented shape for each vendor", () => {
  assert.deepEqual(
    findVendor("atlassian")!.fields.map((f) => f.key),
    ["email", "apiToken"],
  );
  assert.deepEqual(
    findVendor("github")!.fields.map((f) => f.key),
    ["token"],
  );
  assert.deepEqual(
    findVendor("datadog")!.fields.map((f) => f.key),
    ["site", "apiKey", "appKey"],
  );
  assert.deepEqual(
    findVendor("snyk")!.fields.map((f) => f.key),
    ["region", "token"],
  );
  assert.deepEqual(
    findVendor("elevenlabs")!.fields.map((f) => f.key),
    ["apiKey"],
  );
  assert.deepEqual(
    findVendor("deepgram")!.fields.map((f) => f.key),
    ["apiKey"],
  );
});

test("only Atlassian declares verifyExtraFields", () => {
  assert.deepEqual(
    findVendor("atlassian")!.verifyExtraFields?.map((f) => f.key),
    ["testSiteUrl"],
  );
  for (const id of ["github", "datadog", "snyk", "elevenlabs", "deepgram"]) {
    assert.equal(findVendor(id)!.verifyExtraFields, undefined);
  }
});

test("VENDORS has exactly the 6 shipped vendors, no duplicates", () => {
  assert.equal(VENDORS.length, 6);
  assert.equal(new Set(VENDORS.map((v) => v.id)).size, 6);
});

test("capabilities: only the two voice vendors declare them, one capability each", () => {
  assert.deepEqual(findVendor("elevenlabs")!.capabilities, ["tts"]);
  assert.deepEqual(findVendor("deepgram")!.capabilities, ["stt"]);
  for (const id of ["atlassian", "github", "datadog", "snyk"]) {
    assert.equal(findVendor(id)!.capabilities, undefined);
  }
});

test("verifyBeforeSave: failing self-contained verify blocks with the vendor detail", async () => {
  const f = (async () =>
    new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key" } }), {
      status: 401,
    })) as typeof fetch;
  const err = await verifyBeforeSave("elevenlabs", { apiKey: "garbage" }, f);
  assert.ok(err, "expected a blocking error");
  assert.match(err!, /Invalid API key/);
  assert.match(err!, /Nothing was saved/);
});

test("verifyBeforeSave: passing verify returns null (save proceeds)", async () => {
  const f = (async () => new Response(JSON.stringify({ projects: [{}] }), { status: 200 })) as typeof fetch;
  assert.equal(await verifyBeforeSave("deepgram", { apiKey: "good" }, f), null);
});

test("verifyBeforeSave: vendors needing verify-time extras (Atlassian) are exempt — no fetch, no block", async () => {
  const f = (async () => {
    throw new Error("must not be called");
  }) as typeof fetch;
  assert.equal(await verifyBeforeSave("atlassian", { email: "e@x.com", apiToken: "t" }, f), null);
});

test("verifyBeforeSave: unknown vendor is not this gate’s problem — returns null for the route’s own 400", async () => {
  assert.equal(await verifyBeforeSave("nope", {}), null);
});
