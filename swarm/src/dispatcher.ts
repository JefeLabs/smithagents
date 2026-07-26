// ---------------------------------------------------------------------------
// orchestrator/dispatcher.ts — Fire-and-Forget Dispatcher
//
// The dispatcher is the top-level orchestrator. It is a PURE DISPATCHER:
//   - It does NOT care how many sub-agents were spawned
//   - It does NOT care how they communicated
//   - It only cares about a binary exit signal: 0 (completed) or 1 (failed)
//
// On exit 0 → triggers the verification pipeline
// On exit 1 → immediate quarantine, no retries, human review required
//
// The dispatcher is runtime-agnostic. It delegates session management to
// a RuntimeAdapter (tmux or docker) resolved from the task manifest.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

import type {
  OrchestratorConfig,
  TaskManifest,
  TaskResult,
  DispatcherEvent,
  RuntimeType,
} from './types.js';
import type { RuntimeAdapter } from './runtime.js';
import { createRuntime } from './runtime.js';
import { QuarantineManager } from './quarantine.js';

/**
 * Fire-and-Forget Dispatcher.
 *
 * Dispatches a task by:
 *   1. Creating a git worktree
 *   2. Injecting the smith-delegate tool
 *   3. Resolving the appropriate runtime (tmux or docker)
 *   4. Launching the Alpha agent session
 *   5. Blocking until the session exits
 *   6. Routing to completed (verify) or failed (quarantine)
 *   7. Tearing down all sessions (orphan cleanup)
 *
 * @example
 * ```typescript
 * const config = loadConfig();
 * const dispatcher = new Dispatcher(config);
 *
 * dispatcher.on('task:completed', (event) => {
 *   console.log(`Task ${event.taskId} completed — triggering verification`);
 * });
 *
 * // Dispatch with default runtime (tmux)
 * const result = await dispatcher.dispatch(manifest);
 *
 * // Dispatch with Docker runtime
 * const dockerResult = await dispatcher.dispatch({
 *   ...manifest,
 *   runtime: 'docker',
 * });
 * ```
 */
export class Dispatcher extends EventEmitter {
  private readonly config: OrchestratorConfig;
  private readonly quarantine: QuarantineManager;

  constructor(config: OrchestratorConfig) {
    super();
    this.config = config;
    this.quarantine = new QuarantineManager(config.logsDir);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Dispatch a task manifest: create worktree → launch Alpha → wait → route.
   *
   * This method blocks until the Alpha agent exits. The swarm may have
   * spawned dozens of sub-agents internally — we don't care. We only
   * care about the final exit code.
   *
   * The runtime (tmux or docker) is resolved from:
   *   1. manifest.runtime (if specified)
   *   2. config.defaultRuntime (fallback)
   *
   * @param manifest - The task to dispatch
   * @returns TaskResult with outcome and metadata
   */
  async dispatch(manifest: TaskManifest): Promise<TaskResult> {
    const sessionName = `${this.config.tmuxPrefix}-${manifest.taskId}`;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    // Resolve the runtime for this task
    const runtimeType: RuntimeType =
      manifest.runtime ?? this.config.defaultRuntime;
    const runtime = createRuntime(runtimeType, this.config.docker);

    let worktreePath = '';

    try {
      // Phase 1: Prepare the isolated worktree environment
      worktreePath = await this.prepareWorktree(manifest);

      // Phase 2: Build the full CLI command for the Alpha agent
      const command = this.buildAgentCommand(manifest, worktreePath);

      // Phase 3: Emit dispatch event and launch
      this.emitEvent({
        type: 'task:dispatched',
        taskId: manifest.taskId,
        sessionName,
      });

      await runtime.launch(sessionName, command, worktreePath);

      // Phase 4: THE WAIT STATE — block until the Alpha session exits
      // This is the "Fire-and-Forget" core. We sit here doing nothing
      // until the entire swarm collapses to a single exit code.
      const exitCode = await runtime.waitFor(sessionName);

      // Phase 5: Build the result
      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - startMs;

      const result: TaskResult = {
        taskId: manifest.taskId,
        outcome: exitCode === 0 ? 'completed' : 'failed',
        exitCode,
        sessionName,
        worktreePath,
        startedAt,
        completedAt,
        durationMs,
        logs: join(this.config.logsDir, manifest.taskId, 'session.log'),
      };

      // Phase 6: Capture session output to logs before teardown
      await this.captureSessionLogs(manifest.taskId, runtime, sessionName);

      // Phase 7: Route based on exit code — the binary evaluation
      if (exitCode === 0) {
        await this.onCompleted(manifest, result);
      } else {
        await this.onFailed(manifest, result);
      }

      return result;
    } finally {
      // Phase 8: ALWAYS tear down — kill orphan sessions, clean up
      await this.teardown(manifest.taskId, sessionName, runtime);
    }
  }

  // -------------------------------------------------------------------------
  // Private: Environment Preparation
  // -------------------------------------------------------------------------

  /**
   * Prepare the git worktree and inject delegation tools.
   *
   * Creates: .smith/worktrees/<taskId>/
   * With:    bin/smith-delegate (executable, copied from project root)
   *
   * @returns Absolute path to the worktree directory
   */
  private async prepareWorktree(manifest: TaskManifest): Promise<string> {
    // Workspace-routed tasks worktree from their repo's clone; otherwise from
    // the server's own repo (legacy behavior). repoPath is server-resolved
    // from the workspace registry — never a client-supplied path.
    const repoRoot = manifest.context.repoPath;
    const worktreePath = repoRoot
      ? resolve(repoRoot, this.config.worktreeDir, manifest.taskId)
      : resolve(this.config.worktreeDir, manifest.taskId);

    // Create the git worktree on a dedicated branch.
    // The base branch comes from the (untrusted) task manifest: validate it and
    // pass it after `--` so a value like `--upload-pack=…` can't be parsed as a
    // git flag (argument injection). branchName is derived from a server-issued
    // UUID taskId, so it can't begin with `-`.
    const baseBranch = manifest.context.branch;
    if (!/^[A-Za-z0-9._/-]+$/.test(baseBranch) || baseBranch.startsWith('-')) {
      throw new Error(`Invalid base branch: ${baseBranch}`);
    }
    const branchName = `smith/${manifest.taskId}`;
    await this.git([
      'worktree', 'add',
      worktreePath,
      '-b', branchName,
      '--',
      baseBranch,
    ], repoRoot);

    // Inject the smith-delegate tool into the worktree's bin/ directory
    // so the Alpha agent can find it on PATH
    const worktreeBin = join(worktreePath, 'bin');
    await mkdir(worktreeBin, { recursive: true });
    await copyFile(
      resolve(this.config.delegateBin),
      join(worktreeBin, 'smith-delegate'),
    );

    return worktreePath;
  }

  /**
   * Build the full CLI command string for the Alpha agent.
   *
   * The command:
   *   1. Prepends the worktree's bin/ to PATH (so smith-delegate is available)
   *   2. Invokes the agent CLI with the task prompt
   *
   * Prompt escaping uses single quotes with embedded quote escaping
   * to prevent shell injection.
   */
  private buildAgentCommand(
    manifest: TaskManifest,
    worktreePath: string,
  ): string {
    const agentCmd = this.config.agentCommands[manifest.agent];
    const escapedPrompt = manifest.prompt.replace(/'/g, "'\\''");
    const binDir = join(worktreePath, 'bin');

    // Build the full command with PATH injection
    // The agent CLI gets the task via --task (agy) or --print (claude) or
    // positional arg (codex). We normalize to a simple prompt append.
    const promptFlag = this.getPromptFlag(manifest.agent);

    return [
      `export PATH="${binDir}:$PATH"`,
      `${agentCmd} ${promptFlag} '${escapedPrompt}'`,
    ].join(' && ');
  }

  /**
   * Get the CLI flag used to pass the prompt to each agent type.
   */
  private getPromptFlag(agent: TaskManifest['agent']): string {
    switch (agent) {
      case 'agy':   return '--task';
      case 'claude': return '--print';
      case 'codex':  return '';  // codex uses positional arg
    }
  }

  // -------------------------------------------------------------------------
  // Private: Outcome Handlers
  // -------------------------------------------------------------------------

  /**
   * Handle a completed task (exit 0).
   *
   * The orchestrator's job here is simple: emit the event so the
   * verification pipeline (Phase 7) can pick it up.
   */
  private async onCompleted(
    manifest: TaskManifest,
    result: TaskResult,
  ): Promise<void> {
    // Write the result to the logs directory for audit
    await this.writeResultLog(manifest.taskId, result);

    this.emitEvent({
      type: 'task:completed',
      taskId: manifest.taskId,
      result,
    });
  }

  /**
   * Handle a failed task (exit 1).
   *
   * IMMEDIATE QUARANTINE — no retries. Every failure goes straight to
   * human review. This is the conservative approach: we'd rather have
   * a human look at a flaky failure than burn tokens re-running it.
   */
  private async onFailed(
    manifest: TaskManifest,
    result: TaskResult,
  ): Promise<void> {
    const reason = `Alpha agent exited with code ${result.exitCode}. ` +
      `Task quarantined for human review (no automatic retries).`;

    // Write the result log
    await this.writeResultLog(manifest.taskId, result);

    // Quarantine the task
    await this.quarantine.quarantine(result, reason);

    this.emitEvent({
      type: 'task:failed',
      taskId: manifest.taskId,
      result,
    });

    this.emitEvent({
      type: 'task:quarantined',
      taskId: manifest.taskId,
      reason,
    });
  }

  // -------------------------------------------------------------------------
  // Private: Teardown & Cleanup
  // -------------------------------------------------------------------------

  /**
   * Tear down all sessions related to this task.
   *
   * Works identically for both runtimes:
   *   - TmuxRuntime: kills tmux sessions matching the pattern
   *   - DockerRuntime: removes containers matching the pattern
   *
   * This is the "orphan cleanup" — even if the Alpha agent forgot to
   * clean up its children, we nuke everything from orbit.
   */
  private async teardown(
    taskId: string,
    sessionName: string,
    runtime: RuntimeAdapter,
  ): Promise<void> {
    try {
      // Kill the primary session and any sub-sessions
      const killed = await runtime.killPattern(sessionName);

      // Also kill any lingering sub-* sessions
      // (these might have been spawned with different naming)
      const subKilled = await runtime.killPattern('sub-');

      const totalKilled = killed + subKilled;

      if (totalKilled > 0) {
        this.emitEvent({
          type: 'session:orphan_cleanup',
          sessionPattern: `${sessionName}*`,
          killed: totalKilled,
        });
      }
    } catch (error) {
      // Teardown should never throw — log and continue
      console.error(
        `[dispatcher] teardown error for task ${taskId}:`,
        error,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: Logging
  // -------------------------------------------------------------------------

  /**
   * Capture session output and write it to the logs dir.
   * Works with any RuntimeAdapter — tmux captures pane, docker captures logs.
   */
  private async captureSessionLogs(
    taskId: string,
    runtime: RuntimeAdapter,
    sessionName: string,
  ): Promise<void> {
    try {
      const output = await runtime.captureOutput(sessionName);
      const logDir = join(this.config.logsDir, taskId);
      await mkdir(logDir, { recursive: true });
      await writeFile(join(logDir, 'session.log'), output, 'utf-8');
    } catch {
      // Best-effort logging — don't let it break the flow
    }
  }

  /**
   * Write the TaskResult JSON to the logs directory.
   */
  private async writeResultLog(
    taskId: string,
    result: TaskResult,
  ): Promise<void> {
    try {
      const logDir = join(this.config.logsDir, taskId);
      await mkdir(logDir, { recursive: true });
      await writeFile(
        join(logDir, 'result.json'),
        JSON.stringify(result, null, 2),
        'utf-8',
      );
    } catch {
      // Best-effort — don't break the dispatch flow
    }
  }

  // -------------------------------------------------------------------------
  // Private: Helpers
  // -------------------------------------------------------------------------

  /**
   * Type-safe event emission.
   */
  private emitEvent(event: DispatcherEvent): void {
    this.emit(event.type, event);
  }

  /**
   * Execute a git command and return stdout.
   */
  private git(args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`git ${args[0]} failed: ${stderr || error.message}`),
          );
          return;
        }
        resolve(stdout.trim());
      });
    });
  }
}
