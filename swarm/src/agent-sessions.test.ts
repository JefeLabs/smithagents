// Persistent-session lifecycle against REAL tmux (design §8), with a scripted
// fake tool so no model API is involved: the "TUI" echoes each input line into
// its session file as a completed assistant turn.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionManager } from './agent-sessions.js';
import type { ComposedAgent } from './agents.js';
import { SessionDeadError, ToolLaunchError } from './drivers/errors.js';
import type { NormalizedMessage, ToolDriver } from './drivers/types.js';
import { TmuxRuntime } from './runtime.js';

const AGENT: ComposedAgent = {
  id: 'manuel',
  name: 'Manuel',
  role: 'The Architect',
  directives: 'Own the routing.',
  engine: { cli: 'claude', model: 'claude-opus' },
};

/** Fake driver over a line-oriented session-file format the script below writes. */
class FakeDriver implements ToolDriver {
  readonly id = 'claude';

  interactiveCommand(baseCommand: string): string {
    return baseCommand;
  }
  taskCommand(baseCommand: string, escapedPrompt: string): string {
    return `${baseCommand} '${escapedPrompt}'`;
  }
  sessionDir(cwd: string): string {
    return join(cwd, '.fake-sessions');
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
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { role: 'user' | 'assistant'; text: string; done?: boolean; ts?: string })
      .map((e) => ({ role: e.role, text: e.text, stopReason: e.done ? 'end_turn' : null, timestamp: e.ts }));
  }
  isTurnComplete(messages: NormalizedMessage[], sinceIso: string): boolean {
    return messages.some((m) => m.role === 'assistant' && m.stopReason === 'end_turn' && (m.timestamp ?? '') > sinceIso);
  }
  async materialize(agent: ComposedAgent, worktreePath: string): Promise<string[]> {
    writeFileSync(join(worktreePath, 'AGENT.md'), `# ${agent.name}\n${agent.directives}\n`);
    return ['AGENT.md'];
  }
}

let repoRoot: string;
let toolScript: string;
const runtime = new TmuxRuntime();
let manager: AgentSessionManager;
const created: string[] = [];

before(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'smith-sessions-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'root'], { cwd: repoRoot });

  // The fake TUI: creates its session file (readiness), then echoes every
  // stdin line as a user entry + a completed assistant entry.
  toolScript = join(repoRoot, 'fake-tool.sh');
  writeFileSync(
    toolScript,
    `#!/bin/bash
mkdir -p .fake-sessions
F=.fake-sessions/session.jsonl
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
    worktreeDir: '.smith/worktrees',
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

test('create: worktree on its own branch, profile materialized + excluded, pinned hash, ready', async () => {
  const info = await manager.create(AGENT, JSON.stringify(AGENT), repoRoot, 'main');
  created.push(info.id);
  assert.equal(info.status, 'ready');
  assert.match(info.branch, /^smith\/session-/);
  assert.equal(info.profileHash.length, 16);
  // Materialized profile exists in the worktree but is invisible to git.
  execFileSync('test', ['-f', join(info.cwd, 'AGENT.md')]);
  const ignored = execFileSync('git', ['check-ignore', 'AGENT.md'], { cwd: info.cwd }).toString().trim();
  assert.equal(ignored, 'AGENT.md');
});

test('send: one turn in, parsed completed turn out — detected from the session file', async () => {
  const info = await manager.create(AGENT, JSON.stringify(AGENT), repoRoot, 'main');
  created.push(info.id);
  const turn = await manager.send(info.id, 'hola crew');
  const assistant = turn.find((m) => m.role === 'assistant');
  assert.ok(assistant, 'assistant reply present');
  assert.match(assistant.text, /hola crew/);
  assert.equal(assistant.stopReason, 'end_turn');
  const all = await manager.messages(info.id);
  assert.ok(all.length >= 2);
  const listed = (await manager.list()).find((s) => s.id === info.id);
  assert.equal(listed?.turns, 1);
});

test('death is surfaced, never silently respawned', async () => {
  const info = await manager.create(AGENT, JSON.stringify(AGENT), repoRoot, 'main');
  created.push(info.id);
  // Kill the process out from under the manager — as a crash would.
  execFileSync('tmux', ['kill-session', '-t', `smith-warm-${info.id}`]);
  await assert.rejects(manager.send(info.id, 'anyone home?'), SessionDeadError);
  const listed = (await manager.list()).find((s) => s.id === info.id);
  assert.equal(listed?.status, 'dead');
});

test('launch failure is a typed error naming the tool', async () => {
  const broken = new AgentSessionManager(runtime, {
    agentCommands: { claude: '/nonexistent/tool-binary' },
    worktreeDir: '.smith/worktrees',
    resolveDriver: () => new FakeDriver(),
    pollIntervalMs: 100,
    readinessTimeoutMs: 3_000,
  });
  await assert.rejects(broken.create(AGENT, '{}', repoRoot, 'main'), ToolLaunchError);
});
