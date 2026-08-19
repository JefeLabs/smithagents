// Auth probes with a stubbed runner — each driver's contract: ok:false only
// on a CONFIRMED logged-out signal, 'unknown' for anything unrecognizable.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { CopilotDriver } from "./copilot.js";
import { OpencodeDriver } from "./opencode.js";
import type { CommandRunner } from "./types.js";

const respond =
  (code: number | null, stdout: string, stderr = ""): CommandRunner =>
  async () => ({ code, stdout, stderr });

/** copilot has no non-interactive status command, so its probe must never need the runner. */
const neverRun: CommandRunner = async () => {
  throw new Error("copilot probe must not spawn a subprocess");
};

async function copilotHome(config?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copilot-home-"));
  if (config !== undefined) await writeFile(join(dir, "config.json"), config);
  return dir;
}

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

// CopilotDriver's probe is PASSIVE: a stored login can still be policy-blocked
// (a token's presence is not its validity), so every branch stays 'unknown' —
// the detail carries the evidence, never a confirmed positive or negative.

test("copilot: env token -> unknown naming the variable, not a confirmed positive", async () => {
  const d = new CopilotDriver(await copilotHome(), { COPILOT_GITHUB_TOKEN: "github_pat_x" });
  assert.deepEqual(await d.verifyAuth("copilot", neverRun, 10_000), {
    ok: "unknown",
    detail: "token present via COPILOT_GITHUB_TOKEN (unverified)",
  });
});

test("copilot: env precedence matches the CLI — COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN", async () => {
  const home = await copilotHome();
  const all = new CopilotDriver(home, { GITHUB_TOKEN: "c", GH_TOKEN: "b", COPILOT_GITHUB_TOKEN: "a" });
  assert.match((await all.verifyAuth("copilot", neverRun, 10_000)).detail, /via COPILOT_GITHUB_TOKEN/);
  const two = new CopilotDriver(home, { GITHUB_TOKEN: "c", GH_TOKEN: "b" });
  assert.match((await two.verifyAuth("copilot", neverRun, 10_000)).detail, /via GH_TOKEN/);
});

test("copilot: stored login in config.json (JSONC comment lines) -> unknown naming the account", async () => {
  const home = await copilotHome(
    [
      "// This file is managed automatically.",
      JSON.stringify({ lastLoggedInUser: { host: "https://github.com", login: "edwin-skoolscout" } }),
    ].join("\n"),
  );
  const d = new CopilotDriver(home, {});
  assert.deepEqual(await d.verifyAuth("copilot", neverRun, 10_000), {
    ok: "unknown",
    detail: "stored login as edwin-skoolscout (unverified)",
  });
});

test("copilot: blank env values are absent; no credentials anywhere -> unknown with both fixes named", async () => {
  const d = new CopilotDriver(await copilotHome(), { GH_TOKEN: "", GITHUB_TOKEN: "  " });
  const res = await d.verifyAuth("copilot", neverRun, 10_000);
  assert.equal(res.ok, "unknown");
  assert.equal(res.failure, undefined);
  assert.match(res.detail, /`copilot login`/);
  assert.match(res.detail, /COPILOT_GITHUB_TOKEN/);
});

test("copilot: corrupt config.json -> unknown, never throws", async () => {
  const d = new CopilotDriver(await copilotHome("{not json"), {});
  assert.equal((await d.verifyAuth("copilot", neverRun, 10_000)).ok, "unknown");
});
