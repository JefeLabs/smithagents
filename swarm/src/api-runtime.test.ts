import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComposedAgent } from "./agents.js";
import { ApiProviderError, MockProvider } from "./api-provider.js";
import { ApiRuntime, buildSystemPrompt } from "./api-runtime.js";

const AGENT: ComposedAgent = {
  id: "sage",
  name: "Sage",
  role: "Research advisor",
  directives: "Think before answering. Cite what you rely on.",
  engine: { kind: "api", provider: "anthropic", model: "claude-sonnet-5" },
  persona: { style: "Measured, concrete." },
  backstory: "Ex-librarian.",
  language: "English",
};

async function freshRuntime(replies: Array<string | ApiProviderError> = []) {
  const dir = await mkdtemp(join(tmpdir(), "api-rt-"));
  const provider = new MockProvider(replies);
  return { runtime: new ApiRuntime(dir, provider), provider, dir };
}

test("runTurn creates a session, persists both sides, and continues it on the returned id", async () => {
  const { runtime, provider } = await freshRuntime(["hello there", "second thoughts"]);
  const first = await runtime.runTurn(AGENT, null, "hola");
  assert.equal(first.reply, "hello there");
  const second = await runtime.runTurn(AGENT, first.sessionId, "and then?");
  assert.equal(second.sessionId, first.sessionId);
  const session = await runtime.load(AGENT.id, first.sessionId);
  assert.deepEqual(
    session.messages.map((m) => [m.role, m.text]),
    [
      ["user", "hola"],
      ["assistant", "hello there"],
      ["user", "and then?"],
      ["assistant", "second thoughts"],
    ],
  );
  assert.ok(session.messages.every((m) => !Number.isNaN(new Date(m.at).getTime())));
  // The second call carried the full history so far.
  assert.equal(provider.calls[1].messages.length, 3);
});

test("the system prompt carries the persona and the model rides the engine", async () => {
  const { runtime, provider } = await freshRuntime();
  await runtime.runTurn(AGENT, null, "q");
  const call = provider.calls[0];
  assert.equal(call.model, "claude-sonnet-5");
  assert.match(call.system, /Sage, Research advisor/);
  assert.match(call.system, /Think before answering/);
  assert.match(call.system, /Measured, concrete/);
  assert.match(call.system, /Ex-librarian/);
  assert.match(call.system, /Answer in English/);
  // And the pure builder skips absent fields instead of printing "undefined".
  assert.ok(!buildSystemPrompt({ ...AGENT, persona: undefined, backstory: undefined }).includes("undefined"));
});

test("a failed turn persists NOTHING — the transcript is what the model has seen", async () => {
  const { runtime, dir } = await freshRuntime([
    new ApiProviderError("billing", "top up"),
  ]);
  await assert.rejects(() => runtime.runTurn(AGENT, null, "q"), /top up/);
  // No session dir, no half-written file.
  const entries = await readdir(dir).catch(() => []);
  const files = await Promise.all(
    entries.map(async (e) => readdir(join(dir, e)).catch(() => [])),
  );
  assert.deepEqual(files.flat(), []);
});

test("the provider send is capped at 40 messages while the file keeps everything", async () => {
  const { runtime, provider } = await freshRuntime();
  let sid: string | null = null;
  for (let i = 0; i < 25; i++) {
    const r = await runtime.runTurn(AGENT, sid, `m${i}`);
    sid = r.sessionId;
  }
  if (!sid) throw new Error("no session");
  const session = await runtime.load(AGENT.id, sid);
  assert.equal(session.messages.length, 50); // 25 user + 25 assistant, all kept
  assert.equal(provider.calls[24].messages.length, 40); // 49 outgoing capped to the last 40
});

test("listSessions sorts newest first and skips corrupt files; deleteSession reports truthfully", async () => {
  const { runtime, dir } = await freshRuntime();
  const a = await runtime.runTurn(AGENT, null, "one");
  const b = await runtime.runTurn(AGENT, null, "two");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, AGENT.id, "corrupt.json"), "{not json");
  const listed = await runtime.listSessions(AGENT.id);
  assert.deepEqual(listed.map((s) => s.id).sort(), [a.sessionId, b.sessionId].sort());
  assert.equal(listed[0].messageCount, 2);
  assert.equal(await runtime.deleteSession(AGENT.id, a.sessionId), true);
  assert.equal(await runtime.deleteSession(AGENT.id, a.sessionId), false);
  assert.equal((await runtime.listSessions(AGENT.id)).length, 1);
});

test("session ids that are not path-safe are refused outright", async () => {
  const { runtime } = await freshRuntime();
  await assert.rejects(() => runtime.runTurn(AGENT, "../escape", "q"), /Invalid session id/);
  await assert.rejects(() => runtime.load(AGENT.id, "UPPER CASE"), /Invalid session id/);
});

test("MockProvider rejects with typed errors the routes can map", async () => {
  const provider = new MockProvider([new ApiProviderError("auth", "verify the key")]);
  await assert.rejects(
    () => provider.complete({ model: "m", system: "s", messages: [] }),
    (err: unknown) => err instanceof ApiProviderError && err.kind === "auth",
  );
});

test("runOneShot answers from the persona and writes NOTHING to disk", async () => {
  const { runtime, provider, dir } = await freshRuntime(["I should lead."]);
  const reply = await runtime.runOneShot(AGENT, "Should you lead?");
  assert.equal(reply, "I should lead.");
  assert.equal(provider.calls[0].model, "claude-sonnet-5");
  assert.match(provider.calls[0].system, /Sage, Research advisor/);
  assert.deepEqual(provider.calls[0].messages, [{ role: "user", text: "Should you lead?" }]);
  // No agent dir, no session file — a one-shot leaves no residue.
  const entries = await readdir(dir).catch(() => []);
  assert.deepEqual(entries, []);
  // And sessions still list empty afterward.
  assert.deepEqual(await runtime.listSessions(AGENT.id), []);
});
