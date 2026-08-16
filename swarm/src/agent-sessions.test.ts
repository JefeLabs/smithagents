// Persistent-session lifecycle against REAL tmux (design §8), with a scripted
// fake tool so no model API is involved: the "TUI" echoes each input line into
// its session file as a completed assistant turn.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AgentSessionManager } from "./agent-sessions.js";
import type { ComposedAgent } from "./agents.js";
import { SessionDeadError, ToolLaunchError } from "./drivers/errors.js";
import type { NormalizedMessage, ToolDriver } from "./drivers/types.js";
import { TmuxRuntime } from "./runtime.js";
import { SessionStore } from "./session-store.js";

const AGENT: ComposedAgent = {
  id: "manuel",
  name: "Manuel",
  role: "The Architect",
  directives: "Own the routing.",
  engine: { cli: "claude", model: "claude-opus" },
};

/** Fake driver over a line-oriented session-file format the script below writes. */
class FakeDriver implements ToolDriver {
  readonly id = "claude";

  interactiveCommand(baseCommand: string, _model?: string, sessionId?: string): string {
    return sessionId ? `${baseCommand} --session-id ${sessionId}` : baseCommand;
  }
  taskCommand(baseCommand: string, escapedPrompt: string): string {
    return `${baseCommand} '${escapedPrompt}'`;
  }
  sessionDir(cwd: string): string {
    return join(cwd, ".fake-sessions");
  }
  sessionFileFor(cwd: string, sessionId: string): string {
    return join(this.sessionDir(cwd), `${sessionId}.jsonl`);
  }
  async listSessionFiles(cwd: string): Promise<string[]> {
    try {
      return readdirSync(this.sessionDir(cwd)).map((f) => join(this.sessionDir(cwd), f));
    } catch {
      return [];
    }
  }
  parseSessionFile(content: string): NormalizedMessage[] {
    return content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { role: "user" | "assistant"; text: string; done?: boolean; ts?: string })
      .map((e) => ({ role: e.role, text: e.text, stopReason: e.done ? "end_turn" : null, timestamp: e.ts }));
  }
  isTurnComplete(messages: NormalizedMessage[], sinceIso: string): boolean {
    return messages.some(
      (m) => m.role === "assistant" && m.stopReason === "end_turn" && (m.timestamp ?? "") > sinceIso,
    );
  }
  async materialize(agent: ComposedAgent, worktreePath: string): Promise<string[]> {
    writeFileSync(join(worktreePath, "AGENT.md"), `# ${agent.name}\n${agent.directives}\n`);
    return ["AGENT.md"];
  }
}

let repoRoot: string;
let toolScript: string;
const runtime = new TmuxRuntime();
let manager: AgentSessionManager;
const created: string[] = [];

before(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "smith-sessions-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "root"], {
    cwd: repoRoot,
  });

  // The fake TUI: creates its session file (readiness), then echoes every
  // stdin line as a user entry + a completed assistant entry.
  toolScript = join(repoRoot, "fake-tool.sh");
  writeFileSync(
    toolScript,
    `#!/bin/bash
mkdir -p .fake-sessions
SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) SID="$2"; shift 2 ;;
    *) shift ;;
  esac
done
F=.fake-sessions/\${SID:-session}.jsonl
: > "$F"
while IFS= read -r line; do
  clean=$(printf '%s' "$line" | tr -d '\\033' | sed 's/\\[200~//; s/\\[201~//')
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.999Z)
  printf '{"role":"user","text":"%s","ts":"%s"}\\n' "$clean" "$ts" >> "$F"
  printf '{"role":"assistant","text":"echo: %s","done":true,"ts":"%s"}\\n' "$clean" "$ts" >> "$F"
done
`,
  );
  chmodSync(toolScript, 0o755);

  manager = new AgentSessionManager(runtime, {
    agentCommands: { claude: toolScript },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    pollIntervalMs: 100,
    readinessTimeoutMs: 10_000,
    turnTimeoutMs: 10_000,
  });
});

after(async () => {
  for (const id of created) {
    await manager.destroy(id).catch(() => {});
  }
  rmSync(repoRoot, { recursive: true, force: true });
});

test("create: worktree on its own branch, profile materialized + excluded, pinned hash, ready", async () => {
  const info = await manager.create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  created.push(info.id);
  assert.equal(info.status, "ready");
  assert.match(info.branch, /^smith\/session-/);
  assert.equal(info.profileHash.length, 16);
  // Materialized profile exists in the worktree but is invisible to git.
  execFileSync("test", ["-f", join(info.cwd, "AGENT.md")]);
  const ignored = execFileSync("git", ["check-ignore", "AGENT.md"], { cwd: info.cwd }).toString().trim();
  assert.equal(ignored, "AGENT.md");
});

test("send: one turn in, parsed completed turn out — detected from the session file", async () => {
  const info = await manager.create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  created.push(info.id);
  const turn = await manager.send(info.id, "hola crew");
  const assistant = turn.find((m) => m.role === "assistant");
  assert.ok(assistant, "assistant reply present");
  assert.match(assistant.text, /hola crew/);
  assert.equal(assistant.stopReason, "end_turn");
  const all = await manager.messages(info.id);
  assert.ok(all.length >= 2);
  const listed = (await manager.list()).find((s) => s.id === info.id);
  assert.equal(listed?.turns, 1);
});

/**
 * `before` must reflect whatever is already on disk at the moment send() is
 * called, or the turn returns messages.slice(0) — the ENTIRE transcript, not
 * just this turn. Invisible on a fresh session, which has no history to
 * over-report; it fires whenever the TUI accumulated turns before the first
 * API send (someone typed in the pane, or a reconciled session). This fake's
 * driver pins state.sessionFile up front, so the hazard here is purely about
 * `before`'s timing, not file discovery — a non-pinning driver additionally
 * discovers state.sessionFile lazily inside this same call.
 */
test("send: reports only THIS turn when the pane already had turns before the first API send", async () => {
  // A tool that writes its session file only once a turn happens — the real
  // claude behavior. The shared fake creates the file at startup, so create()'s
  // readiness loop discovers it and `before` is populated; that eagerness hides
  // this bug entirely.
  const lazyTool = join(repoRoot, "fake-tool-lazy.sh");
  writeFileSync(
    lazyTool,
    `#!/bin/bash
mkdir -p .fake-sessions
SID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) SID="$2"; shift 2 ;;
    *) shift ;;
  esac
done
F=.fake-sessions/\${SID:-session}.jsonl
while IFS= read -r line; do
  clean=$(printf '%s' "$line" | tr -d '\\033' | sed 's/\\[200~//; s/\\[201~//')
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.999Z)
  printf '{"role":"user","text":"%s","ts":"%s"}\\n' "$clean" "$ts" >> "$F"
  printf '{"role":"assistant","text":"echo: %s","done":true,"ts":"%s"}\\n' "$clean" "$ts" >> "$F"
done
`,
  );
  chmodSync(lazyTool, 0o755);
  const lazyManager = new AgentSessionManager(runtime, {
    agentCommands: { claude: lazyTool },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    pollIntervalMs: 100,
    readinessTimeoutMs: 10_000,
    turnTimeoutMs: 10_000,
  });

  const info = await lazyManager.create(AGENT, JSON.stringify(AGENT), repoRoot, "main");

  // Someone types directly into the pane — a turn the API never brokered.
  await runtime.sendText(`smith-warm-${info.id}`, "typed in the pane");
  const sessionFile = join(info.cwd, ".fake-sessions", `${info.id}.jsonl`);
  for (let i = 0; i < 100; i++) {
    try {
      if (readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).length >= 2) break;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const turn = await lazyManager.send(info.id, "via the api");

  assert.ok(
    turn.some((m) => m.text.includes("via the api")),
    "this turn's own exchange is reported",
  );
  assert.ok(
    !turn.some((m) => m.text.includes("typed in the pane")),
    `a turn that predates this send must not be reported as part of it; got: ${JSON.stringify(turn.map((m) => m.text))}`,
  );

  await lazyManager.destroy(info.id).catch(() => {});
});

test("death is surfaced, never silently respawned", async () => {
  const info = await manager.create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  created.push(info.id);
  // Kill the process out from under the manager — as a crash would.
  execFileSync("tmux", ["kill-session", "-t", `smith-warm-${info.id}`]);
  await assert.rejects(manager.send(info.id, "anyone home?"), SessionDeadError);
  const listed = (await manager.list()).find((s) => s.id === info.id);
  assert.equal(listed?.status, "dead");
});

test("launch failure is a typed error naming the tool", async () => {
  const broken = new AgentSessionManager(runtime, {
    agentCommands: { claude: "/nonexistent/tool-binary" },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    pollIntervalMs: 100,
    readinessTimeoutMs: 3_000,
  });
  await assert.rejects(broken.create(AGENT, "{}", repoRoot, "main"), ToolLaunchError);
});

// ── Boot reconciliation (real tmux) ────────────────────────────────────────
// The point of running agents in tmux is that they outlive the server. These
// tests restart the MANAGER (a fresh instance over the same store) while the
// tmux process keeps running, which is exactly what a swarm restart looks like.

test("reconcile: a session that outlived the server is adopted and still usable", async () => {
  const store = new SessionStore(join(repoRoot, ".smith/sessions"));
  const first = new AgentSessionManager(runtime, {
    agentCommands: { claude: toolScript },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    pollIntervalMs: 100,
    readinessTimeoutMs: 10_000,
    turnTimeoutMs: 10_000,
    store,
  });
  const info = await first.create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  created.push(info.id);

  // The server dies; the tmux process does not.
  const reborn = new AgentSessionManager(runtime, {
    agentCommands: { claude: toolScript },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    pollIntervalMs: 100,
    turnTimeoutMs: 10_000,
    store,
  });
  const hash = createHash("sha256").update(JSON.stringify(AGENT)).digest("hex").slice(0, 16);
  const summary = await reborn.reconcile(new Map([[AGENT.id, hash]]));

  assert.equal(summary.adopted, 1);
  // Claimed sessions are excluded from the orphan sweep. (Sessions from other
  // tests share this tmux server and legitimately show up as orphans here.)
  assert.ok(
    !summary.orphans.includes(`smith-warm-${info.id}`),
    "an adopted session must not also be reported as an orphan",
  );
  // Adoption is only real if the handle works: send a turn through it.
  const replies = await reborn.send(info.id, "still there?");
  assert.match(replies.map((m) => m.text).join(" "), /echo: still there\?/);
});

test("reconcile: a record whose process died is forgotten and its file removed", async () => {
  const store = new SessionStore(join(repoRoot, ".smith/sessions-dead"));
  const first = new AgentSessionManager(runtime, {
    agentCommands: { claude: toolScript },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    pollIntervalMs: 100,
    readinessTimeoutMs: 10_000,
    store,
  });
  const info = await first.create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  assert.equal((await store.load()).length, 1);

  // Kill the process out from under the record, as a reboot would.
  await runtime.kill(`smith-warm-${info.id}`);

  const reborn = new AgentSessionManager(runtime, {
    agentCommands: { claude: toolScript },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    store,
  });
  const summary = await reborn.reconcile(new Map());
  assert.equal(summary.forgotten, 1);
  assert.equal(summary.adopted, 0);
  assert.deepEqual(await store.load(), [], "a stale record must not linger to be re-adopted");
});

test("reconcile: a live warm session with no record is reported, never silently killed", async () => {
  const store = new SessionStore(join(repoRoot, ".smith/sessions-orphan"));
  const orphan = `smith-warm-${randomUUID()}`;
  await runtime.launch(orphan, "sleep 60", repoRoot);

  const manager2 = new AgentSessionManager(runtime, {
    agentCommands: { claude: toolScript },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    store,
  });
  const summary = await manager2.reconcile(new Map());

  // Other tests' sessions share this tmux server and are equally unaccounted
  // for by this store, so assert inclusion rather than exclusivity.
  assert.ok(summary.orphans.includes(orphan), "the unrecorded live session is reported");
  assert.equal(summary.killed, 0);
  assert.equal(await runtime.exists(orphan), true, "an unexplained live process is left for a human to inspect");
  await runtime.kill(orphan);
});

test("create: a pinning driver's transcript path is known without discovery", async () => {
  const info = await manager.create(AGENT, JSON.stringify(AGENT), repoRoot, "main");
  created.push(info.id);

  // The tool wrote its transcript to the id the manager chose, not one of its own.
  const expected = join(info.cwd, ".fake-sessions", `${info.id}.jsonl`);
  execFileSync("test", ["-f", expected]);

  // And the session is usable through that path.
  const turn = await manager.send(info.id, "hola crew");
  assert.ok(turn.some((m) => m.role === "assistant" && m.text.includes("hola crew")));
});

test("create() refuses when toolGate reports a reason — before any worktree or tmux work", async () => {
  const gated = new AgentSessionManager(runtime, {
    agentCommands: { claude: "true" },
    worktreeDir: ".smith/worktrees",
    resolveDriver: () => new FakeDriver(),
    toolGate: async () => "not logged in — run `claude /login`",
  });
  await assert.rejects(
    // repoRoot is deliberately bogus: the gate must fire before git touches it.
    () => gated.create(AGENT, JSON.stringify(AGENT), "/nonexistent-repo-root", "main"),
    (err: unknown) => {
      assert.ok(err instanceof ToolLaunchError);
      assert.match((err as Error).message, /subscription-inactive: not logged in/);
      return true;
    },
  );
});
