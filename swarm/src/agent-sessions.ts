// Persistent agent sessions — warm conversational workers (design §3).
//
// A task-run session dies with its task; a persistent session keeps the TUI
// alive and is addressed by id across many turns. Turn completion is detected
// ONLY from the tool's persisted session files (the assistant message
// finalized on disk) — never from process exit, never from screen state.
// tmux is input-only (send-keys); capture-pane stays a human watch surface.
//
// Session death loses accumulated context. There is no silent respawn:
// surfacing the death is the caller's signal to decide whether to rebuild.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ComposedAgent } from './agents.js';
import { getDriver } from './drivers/index.js';
import { SessionStore, type SessionRecord } from './session-store.js';
import { classifySession } from './session-reconcile.js';
import { SessionDeadError, SessionNotFoundError, ToolLaunchError, TurnTimeoutError } from './drivers/errors.js';
import type { NormalizedMessage, ToolDriver } from './drivers/types.js';
import type { RuntimeAdapter } from './runtime.js';

export interface AgentSessionInfo {
  id: string;
  agentId: string;
  agentName: string;
  tool: string;
  /** Content hash of the agent file at session start (design §5 pinning). */
  profileHash: string;
  cwd: string;
  branch: string;
  status: 'starting' | 'ready' | 'busy' | 'dead';
  createdAt: string;
  lastTurnAt?: string;
  turns: number;
}

interface SessionState extends AgentSessionInfo {
  tmuxSession: string;
  driver: ToolDriver;
  sessionFile?: string;
  /** Session files present before launch — anything new belongs to us. */
  preexisting: Set<string>;
}

export interface AgentSessionConfig {
  /** Base CLI command per tool (mirrors OrchestratorConfig.agentCommands). */
  agentCommands: Record<string, string>;
  /** Where session worktrees live, relative to the repo they're cut from. */
  worktreeDir: string;
  readinessTimeoutMs?: number;
  /** How long to wait for a session file at launch before going ready anyway. */
  readinessSettleMs?: number;
  turnTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Driver lookup override — tests inject fakes; defaults to the registry. */
  resolveDriver?: (toolId: string) => ToolDriver | null;
  /** Durable session records. Absent = in-memory only (tests, ephemeral runs). */
  store?: SessionStore;
}

const DEFAULTS = { readinessTimeoutMs: 30_000, readinessSettleMs: 3_000, turnTimeoutMs: 300_000, pollIntervalMs: 500 };

export class AgentSessionManager {
  private readonly sessions = new Map<string, SessionState>();

  constructor(
    private readonly runtime: RuntimeAdapter,
    private readonly config: AgentSessionConfig,
  ) {}

  /**
   * Create a warm session for an agent: cut a worktree on its own branch,
   * materialize the profile into the tool's native surfaces, launch the TUI,
   * and wait for the tool's session file to appear (the readiness probe).
   */
  async create(agent: ComposedAgent, agentFileRaw: string, repoRoot: string, baseBranch: string): Promise<AgentSessionInfo> {
    const driver = (this.config.resolveDriver ?? getDriver)(agent.engine.cli);
    if (!driver) throw new ToolLaunchError(agent.engine.cli, 'no driver for this tool — task runs only');
    if (driver.warmSessionsSupported === false) {
      throw new ToolLaunchError(
        agent.engine.cli,
        'this tool keeps conversations server-side and persists no local transcript, so turn completion cannot be observed — it supports task runs and steering, not warm sessions',
      );
    }
    const baseCommand = this.config.agentCommands[agent.engine.cli];
    if (!baseCommand) throw new ToolLaunchError(agent.engine.cli, 'no configured command');

    const id = randomUUID();
    const branch = `smith/session-${id}`;
    const cwd = resolve(repoRoot, this.config.worktreeDir, `session-${id}`);
    await this.git(['worktree', 'add', cwd, '-b', branch, '--', baseBranch], repoRoot);

    // Materialized profile files are plumbing for this session, not work
    // product — keep them out of any commits the agent makes.
    const materialized = await driver.materialize(agent, cwd);
    if (materialized.length > 0) {
      const excludeFile = await this.git(['rev-parse', '--git-path', 'info/exclude'], cwd);
      await mkdir(dirname(resolve(cwd, excludeFile)), { recursive: true });
      await appendFile(resolve(cwd, excludeFile), `${materialized.join('\n')}\n`);
    }

    const state: SessionState = {
      id,
      agentId: agent.id,
      agentName: agent.name,
      tool: agent.engine.cli,
      profileHash: createHash('sha256').update(agentFileRaw).digest('hex').slice(0, 16),
      cwd,
      branch,
      status: 'starting',
      createdAt: new Date().toISOString(),
      turns: 0,
      tmuxSession: `smith-warm-${id}`,
      driver,
      preexisting: new Set(),
    };
    this.sessions.set(id, state);

    state.preexisting = new Set(await driver.listSessionFiles(cwd));
    // The tmux process an agent lives in is fully determined by its
    // definition: its CLI picks the binary, its model picks the flag.
    await this.runtime.launch(state.tmuxSession, driver.interactiveCommand(baseCommand, agent.engine.model), cwd);

    // Readiness: the TUI is up and stays up. Some tools (claude) only write
    // their session file once the first turn happens, so the file is
    // discovered lazily on send — never used as the launch gate.
    const settleMs = this.config.readinessSettleMs ?? DEFAULTS.readinessSettleMs;
    const deadline = Date.now() + (this.config.readinessTimeoutMs ?? DEFAULTS.readinessTimeoutMs);
    const settleUntil = Date.now() + settleMs;
    for (;;) {
      if (!(await this.runtime.exists(state.tmuxSession))) {
        state.status = 'dead';
        throw new ToolLaunchError(agent.engine.cli, 'process exited at launch (binary missing or crashed)');
      }
      const fresh = (await driver.listSessionFiles(cwd)).filter((f) => !state.preexisting.has(f));
      if (fresh.length > 0) {
        state.sessionFile = await this.newest(fresh);
        state.status = 'ready';
        await this.persist(state);
        return this.info(state);
      }
      if (Date.now() >= settleUntil) {
        state.status = 'ready'; // alive; session file resolves on the first turn
        await this.persist(state);
        return this.info(state);
      }
      if (Date.now() > deadline) {
        await this.runtime.kill(state.tmuxSession).catch(() => {});
        state.status = 'dead';
        throw new ToolLaunchError(agent.engine.cli, 'did not become ready in time');
      }
      await this.sleep(this.config.pollIntervalMs ?? DEFAULTS.pollIntervalMs);
    }
  }

  /**
   * One turn: deliver the text to the TUI, then watch the persisted session
   * file until the tool finalizes an assistant message. Returns the messages
   * added by this turn. Timeout cancels the turn (C-c) and throws.
   */
  async send(id: string, text: string, turnTimeoutMs?: number): Promise<NormalizedMessage[]> {
    const state = this.get(id);
    await this.assertAlive(state);

    const before = await this.parse(state);
    const sinceIso = new Date(Date.now() - 1000).toISOString(); // tolerate clock skew vs file timestamps
    state.status = 'busy';
    try {
      // Bracketed paste keeps multi-line text as one input; Enter submits.
      await this.runtime.sendText(state.tmuxSession, text);

      const timeout = turnTimeoutMs ?? this.config.turnTimeoutMs ?? DEFAULTS.turnTimeoutMs;
      const deadline = Date.now() + timeout;
      for (;;) {
        await this.sleep(this.config.pollIntervalMs ?? DEFAULTS.pollIntervalMs);
        // Lazy discovery: tools that write their session file only once a turn
        // starts get picked up here, on the first send.
        if (!state.sessionFile) {
          const fresh = (await state.driver.listSessionFiles(state.cwd)).filter((f) => !state.preexisting.has(f));
          if (fresh.length > 0) state.sessionFile = await this.newest(fresh);
        }
        const messages = await this.parse(state);
        if (state.driver.isTurnComplete(messages, sinceIso)) {
          state.turns += 1;
          state.lastTurnAt = new Date().toISOString();
          state.status = 'ready';
          await this.persist(state);
          return messages.slice(before.length);
        }
        if (!(await this.runtime.exists(state.tmuxSession))) {
          state.status = 'dead';
          throw new SessionDeadError(id);
        }
        if (Date.now() > deadline) {
          // Cancel path: interrupt the turn, leave the session alive.
          await this.runtime.sendKeys(state.tmuxSession, 'C-c').catch(() => {});
          state.status = 'ready';
          throw new TurnTimeoutError(id, timeout);
        }
      }
    } finally {
      if (state.status === 'busy') state.status = 'ready';
    }
  }

  /** Full normalized transcript from the persisted session file. */
  async messages(id: string): Promise<NormalizedMessage[]> {
    const state = this.get(id);
    return this.parse(state);
  }

  async list(): Promise<AgentSessionInfo[]> {
    for (const state of this.sessions.values()) {
      if (state.status !== 'dead' && !(await this.runtime.exists(state.tmuxSession))) state.status = 'dead';
    }
    return [...this.sessions.values()].map((s) => this.info(s));
  }

  /** Interrupt, then kill after a grace period. The record stays (status dead). */
  async destroy(id: string): Promise<void> {
    const state = this.get(id);
    await this.runtime.sendKeys(state.tmuxSession, 'C-c').catch(() => {});
    await this.sleep(500);
    await this.runtime.kill(state.tmuxSession).catch(() => {});
    state.status = 'dead';
    await this.config.store?.delete(id);
  }

  /**
   * Boot-time reconciliation: make the in-memory registry agree with reality.
   *
   * Two directions of drift, and both matter:
   *   - a RECORD with no live process (crash, reboot, manual tmux kill), and
   *   - a live PROCESS with no record (records lost, or a session created by
   *     a build that predates persistence) — an orphan holding a worktree
   *     that nothing will ever clean.
   *
   * `currentHashes` maps agentId to the hash of its agent file as it stands
   * now; a missing entry means the agent is gone. Returns a summary for the
   * boot log, because silently adopting or killing sessions is the kind of
   * thing you want to see in plain text when something looks wrong.
   */
  async reconcile(currentHashes: Map<string, string>): Promise<{ adopted: number; forgotten: number; killed: number; orphans: string[] }> {
    const store = this.config.store;
    const summary = { adopted: 0, forgotten: 0, killed: 0, orphans: [] as string[] };
    if (!store) return summary;

    const records = await store.load();
    const claimed = new Set<string>();

    for (const record of records) {
      claimed.add(record.tmuxSession);
      const verdict = classifySession({
        processAlive: await this.runtime.exists(record.tmuxSession),
        recordedProfileHash: record.profileHash,
        currentProfileHash: currentHashes.get(record.agentId) ?? null,
      });

      if (verdict.action === 'adopt') {
        const driver = (this.config.resolveDriver ?? getDriver)(record.tool);
        if (!driver) {
          // The tool that ran this session is no longer registered, so we
          // cannot read its transcript — adopting would give a handle that
          // can never complete a turn.
          summary.forgotten += 1;
          await store.delete(record.id);
          continue;
        }
        this.sessions.set(record.id, {
          ...record,
          status: 'ready',
          driver,
          // Every file present now predates our adoption; newness is only
          // meaningful relative to a launch we did not perform.
          preexisting: new Set(),
        });
        summary.adopted += 1;
        continue;
      }

      if (verdict.action === 'kill') {
        await this.runtime.kill(record.tmuxSession).catch(() => {});
        summary.killed += 1;
      } else {
        summary.forgotten += 1;
      }
      await store.delete(record.id);
    }

    // Orphans: live warm sessions no record accounts for. Reported, never
    // killed — an unexplained live process is exactly the thing a human
    // should look at before anything destroys it.
    for (const name of await this.runtime.listByPrefix('smith-warm-')) {
      if (!claimed.has(name)) summary.orphans.push(name);
    }
    return summary;
  }

  /** Durable half of a session's state, written on every meaningful change. */
  private async persist(state: SessionState): Promise<void> {
    if (!this.config.store) return;
    const record: SessionRecord = {
      id: state.id,
      agentId: state.agentId,
      agentName: state.agentName,
      tool: state.tool,
      profileHash: state.profileHash,
      cwd: state.cwd,
      branch: state.branch,
      tmuxSession: state.tmuxSession,
      createdAt: state.createdAt,
      lastTurnAt: state.lastTurnAt,
      turns: state.turns,
      sessionFile: state.sessionFile,
    };
    await this.config.store.save(record);
  }

  private get(id: string): SessionState {
    const state = this.sessions.get(id);
    if (!state) throw new SessionNotFoundError(id);
    return state;
  }

  private async assertAlive(state: SessionState): Promise<void> {
    if (state.status === 'dead' || !(await this.runtime.exists(state.tmuxSession))) {
      state.status = 'dead';
      throw new SessionDeadError(state.id);
    }
  }

  private async parse(state: SessionState): Promise<NormalizedMessage[]> {
    if (!state.sessionFile) return [];
    // Database-backed drivers read by handle; file drivers parse from disk.
    if (state.driver.readMessages) return state.driver.readMessages(state.sessionFile);
    const content = await readFile(state.sessionFile, 'utf8').catch(() => '');
    return state.driver.parseSessionFile(content);
  }

  private async newest(files: string[]): Promise<string> {
    // Database handles (db::<id>) come back newest-first from their query and
    // have no mtime to compare.
    if (files.some((f) => f.startsWith('db::'))) return files[0]!;
    const stats = await Promise.all(files.map(async (f) => ({ f, mtime: (await stat(f)).mtimeMs })));
    stats.sort((a, b) => b.mtime - a.mtime);
    return stats[0]!.f;
  }

  private info(state: SessionState): AgentSessionInfo {
    const { tmuxSession: _t, driver: _d, sessionFile: _f, preexisting: _p, ...info } = state;
    return info;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private git(args: string[], cwd: string): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      execFile('git', args, { cwd }, (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]} failed: ${stderr || error.message}`));
        else resolvePromise(stdout.trim());
      });
    });
  }
}
