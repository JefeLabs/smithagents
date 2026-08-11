// Auth probes with a stubbed runner — each driver's contract: ok:false only
// on a CONFIRMED logged-out signal, 'unknown' for anything unrecognizable.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { OpencodeDriver } from "./opencode.js";
import type { CommandRunner } from "./types.js";

const respond =
  (code: number | null, stdout: string, stderr = ""): CommandRunner =>
  async () => ({ code, stdout, stderr });

test("claude: loggedIn true -> ok with email; loggedIn false -> confirmed negative", async () => {
  const d = new ClaudeDriver();
  const yes = await d.verifyAuth(
    "claude",
    respond(0, '{\n  "loggedIn": true,\n  "email": "edwin@acme.com"\n}'),
    10_000,
  );
  assert.deepEqual(yes, { ok: true, detail: "logged in as edwin@acme.com" });
  const no = await d.verifyAuth("claude", respond(1, '{"loggedIn": false}'), 10_000);
  assert.equal(no.ok, false);
  assert.match(no.detail, /not logged in/);
});

test("claude: non-JSON output (old CLI, garbage) -> unknown, never false", async () => {
  const d = new ClaudeDriver();
  const res = await d.verifyAuth("claude", respond(1, 'error: unknown command "auth"'), 10_000);
  assert.equal(res.ok, "unknown");
});

test('codex: exit 0 -> ok with first output line; "not logged in" -> confirmed negative; else unknown', async () => {
  const d = new CodexDriver();
  assert.deepEqual(await d.verifyAuth("codex", respond(0, "Logged in using ChatGPT\n"), 10_000), {
    ok: true,
    detail: "Logged in using ChatGPT",
  });
  const no = await d.verifyAuth("codex", respond(1, "Not logged in.\n"), 10_000);
  assert.equal(no.ok, false);
  const weird = await d.verifyAuth("codex", respond(2, "flag provided but not defined"), 10_000);
  assert.equal(weird.ok, "unknown");
});

test("opencode: exit 0 -> ok; anything else -> unknown (local models mean auth never confirms a negative)", async () => {
  const d = new OpencodeDriver();
  assert.equal((await d.verifyAuth("opencode", respond(0, "Credentials …"), 10_000)).ok, true);
  assert.equal((await d.verifyAuth("opencode", respond(1, ""), 10_000)).ok, "unknown");
});
