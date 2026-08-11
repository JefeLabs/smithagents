import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyAtlassian } from "./verify-atlassian.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async (url: unknown) => {
    assert.match(String(url), /^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/myself$/);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test("verifyAtlassian: ok on a 200 from /myself", async () => {
  const r = await verifyAtlassian(
    "https://acme.atlassian.net",
    "e@acme.com",
    "tok",
    undefined,
    fakeFetch(200, { accountId: "x" }),
  );
  assert.equal(r.ok, true);
});

test("verifyAtlassian: not ok on a 401, detail carries the reason", async () => {
  const r = await verifyAtlassian(
    "https://acme.atlassian.net",
    "e@acme.com",
    "bad-tok",
    undefined,
    fakeFetch(401, { message: "Unauthorized" }),
  );
  assert.equal(r.ok, false);
  assert.match(r.detail, /401|Unauthorized/);
});

test("verifyAtlassian: sends Basic auth of email:apiToken", async () => {
  let sentAuth: string | undefined;
  const f = (async (_url: unknown, init?: RequestInit) => {
    sentAuth = ((init?.headers ?? {}) as Record<string, string>).authorization;
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  await verifyAtlassian("https://acme.atlassian.net", "e@acme.com", "tok", undefined, f);
  assert.equal(sentAuth, `Basic ${Buffer.from("e@acme.com:tok").toString("base64")}`);
});

test("verifyAtlassian: a network failure resolves to {ok:false, detail}, never rejects", async () => {
  const f = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const r = await verifyAtlassian("https://acme.atlassian.net", "e@acme.com", "tok", undefined, f);
  assert.equal(r.ok, false);
  assert.match(r.detail, /fetch failed/);
});
