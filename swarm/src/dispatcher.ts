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
import { appendFile, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';

import type {
  OrchestratorConfig,
  TaskManifest,
  TaskResult,
  DispatcherEvent,
  RuntimeType,
} from './types.js';
import type { RuntimeAdapter } from './runtime.js';
import { getDriver } from './drivers/index.js';
import { createRuntime } from './runtime.js';
import type { WorkerPool } from './remote-runtime.js';
import { QuarantineManager } from './quarantine.js';
import { loadWorkspacesFromDir } from './workspaces.js';
import { loadUsersFromDir, resolveCurrentUser } from './users.js';

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
  private readonly workerPool?: WorkerPool;

  constructor(config: OrchestratorConfig, workerPool?: WorkerPool) {
    super();
    this.config = config;
    this.workerPool = workerPool;
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
   * The runtime is resolved from:
   *   1. manifest.runtime
   *   2. the task's workspace's own runtime
   *   3. config.defaultRuntime
   *
   * @param manifest - The task to dispatch
   * @returns TaskResult with outcome and metadata
   */
  async dispatch(manifest: TaskManifest): Promise<TaskResult> {
    const sessionName = `${this.config.tmuxPrefix}-${manifest.taskId}`;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    // Resolve once: pairs this user's credentials with the workspace/repo
    // config for this task, feeding prepareWorktree (Atlassian MCP
    // materialization), runtime.launch (env injection), and the runtime
    // choice itself (workspace.runtime, design §3) below.
    const connections = await this.resolveConnections(manifest);

    // Per-task override wins, then the task's workspace's own runtime, then
    // the server-wide default. API-created tasks arrive already resolved
    // (resolveTaskRuntime at POST /tasks); this chain covers directly-
    // constructed manifests.
    const runtimeType: RuntimeType =
      manifest.runtime ?? connections.workspaceRuntime ?? this.config.defaultRuntime;
    const runtime = createRuntime(runtimeType, this.config.docker, this.workerPool);

    let worktreePath = '';

    try {
      // Phase 1: Prepare the isolated worktree environment
      worktreePath = await this.prepareWorktree(manifest, connections);

      // Phase 2: Build the full CLI command for the Alpha agent
      const command = this.buildAgentCommand(manifest, worktreePath);

      // Phase 3: Emit dispatch event and launch
      this.emitEvent({
        type: 'task:dispatched',
        taskId: manifest.taskId,
        sessionName,
      });

      await runtime.launch(sessionName, command, worktreePath, connections.env);

      // Phase 4: THE WAIT STATE — block until the Alpha session exits
      // This is the "Fire-and-Forget" core. We sit here doing nothing
      // until the entire swarm collapses to a single exit code.
      const exitCode = await runtime.waitFor(sessionName);

      // Phase 4.5: preserve the work. Agents sometimes exit without
      // committing; anything uncommitted would die with the worktree. Stage
      // and commit as the agent so the task branch always carries the work.
      await this.ensureWorkCommitted(manifest, worktreePath, exitCode === 0);

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

      // Phase 5.5: successful work goes up for human review — push the task
      // branch and open a (draft) pull request. Best effort: a PR failure
      // never fails the task.
      result.branch = `smith/${manifest.taskId}`;
      if (exitCode === 0) {
        result.pullRequestUrl = await this.openPullRequest(manifest, worktreePath);
      }

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
   * Pair the current user's credential with the workspace/repo config that
   * matches this task's already-resolved repoPath. Missing config or missing
   * credential both mean "skip injection for that system" — the task still
   * runs, just without that tool available (design §3).
   */
  async resolveConnections(
    manifest: TaskManifest,
    root: string = process.cwd(),
  ): Promise<{
    atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] };
    env: Record<string, string>;
    workspaceRuntime?: RuntimeType;
  }> {
    const env: Record<string, string> = {};
    if (!manifest.context.repoPath) return { env };

    const workspaces = await loadWorkspacesFromDir(resolve(root, '.smith/workspaces'));
    const workspace = workspaces.find((w) => w.repos.some((r) => r.path === manifest.context.repoPath));
    // repoPath is server-resolved from the workspace registry (see
    // prepareWorktree), so failing to find a match here means this task
    // isn't workspace-routed at all — nothing to pair a credential with.
    if (!workspace) return { env };
    const repo = workspace.repos.find((r) => r.path === manifest.context.repoPath);

    const users = await loadUsersFromDir(resolve(root, '.smith/users'));
    const user = resolveCurrentUser(users);

    const atlassianConnector = workspace.atlassian?.connectorId
      ? user?.connectors?.find((c) => c.id === workspace.atlassian!.connectorId && c.vendorId === 'atlassian')
      : undefined;
    const atlassian = workspace.atlassian && atlassianConnector ? workspace.atlassian : undefined;
    if (atlassian && atlassianConnector) {
      env.SMITH_ATLASSIAN_EMAIL = atlassianConnector.fields.email ?? '';
      env.SMITH_ATLASSIAN_TOKEN = atlassianConnector.fields.apiToken ?? '';
    }

    // GH_TOKEN now resolves per-repo through repo.github.connectorId — a real
    // gate, unlike before this task (which granted GH_TOKEN from "any github
    // token the user has", ignoring repo config). Two repos in the same
    // workspace can legitimately resolve to two different tokens.
    const githubConnector = repo?.github?.connectorId
      ? user?.connectors?.find((c) => c.id === repo.github!.connectorId && c.vendorId === 'github')
      : undefined;
    if (githubConnector?.fields.token) {
      env.GH_TOKEN = githubConnector.fields.token;
    }
    return { atlassian, env, workspaceRuntime: workspace.runtime };
  }

  /**
   * Prepare the git worktree and inject delegation tools.
   *
   * Creates: .smith/worktrees/<taskId>/
   * With:    bin/smith-delegate (executable, copied from project root)
   *
   * @returns Absolute path to the worktree directory
   */
  private async prepareWorktree(
    manifest: TaskManifest,
    connections: { atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] } },
  ): Promise<string> {
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

    // Materialize the composed-agent profile into the tool's native config
    // (design §5): by the time the CLI starts, the agent already is that
    // persona — instructions arrive via the worktree, not only the prompt.
    const injected = ['bin/smith-delegate'];
    const driver = getDriver(manifest.agent);
    if (driver && manifest.profile) {
      injected.push(...(await driver.materialize(manifest.profile, worktreePath, connections.atlassian)));
    }

    // Injected artifacts are plumbing, not work product — exclude them locally
    // so neither the agent's commit nor the auto-commit sweeps them up.
    const excludeFile = await this.git(['rev-parse', '--git-path', 'info/exclude'], worktreePath);
    await mkdir(dirname(resolve(worktreePath, excludeFile)), { recursive: true });
    await appendFile(resolve(worktreePath, excludeFile), `${injected.join('\n')}\n`);

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
    // Work must land on the task branch — the worktree is disposable, commits
    // are not. The dispatcher also auto-commits leftovers after exit.
    const promptWithCommit = `${manifest.prompt}\n\nWhen you finish: stage and commit ALL your changes on the current branch with a concise conventional commit message. Do not push.`;
    const escapedPrompt = promptWithCommit.replace(/'/g, "'\\''");
    const binDir = join(worktreePath, 'bin');

    // Build the full command with PATH injection. Tools with a driver own
    // their invocation shape; the legacy flag map covers the rest until they
    // are characterized (design §4).
    const driver = getDriver(manifest.agent);
    const invocation = driver
      ? driver.taskCommand(agentCmd, escapedPrompt, manifest.model)
      : `${agentCmd} ${this.getPromptFlag(manifest.agent)} '${escapedPrompt}'`;

    return [
      `export PATH="${binDir}:$PATH"`,
      invocation,
    ].join(' && ');
  }

  /**
   * Get the CLI flag used to pass the prompt to each agent type.
   */
  /**
   * Legacy per-tool prompt flags, used only for tools without a driver.
   * Driven tools build their own invocation via driver.taskCommand.
   */
  private getPromptFlag(agent: TaskManifest['agent']): string {
    switch (agent) {
      case 'agy':   return '--task';
      case 'claude': return '--print';
      case 'codex':  return '';  // codex uses positional arg
      default:
        return '--prompt';
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
   * Commit any uncommitted worktree changes on the task branch, authored as
   * the agent. A failed task's partial work is committed too (marked
   * incomplete) — it is forensic value, not garbage. Never throws: a commit
   * failure must not turn a completed task into a failed one.
   */
  private async ensureWorkCommitted(
    manifest: TaskManifest,
    worktreePath: string,
    completed: boolean,
  ): Promise<void> {
    if (!worktreePath) return;
    try {
      const status = await this.git(['status', '--porcelain'], worktreePath);
      if (!status) return;
      const agent = manifest.agentName ?? manifest.agent;
      await this.git(['add', '-A'], worktreePath);
      await this.git(
        [
          '-c', `user.name=${agent} (smith)`,
          '-c', 'user.email=crew@smithagents.local',
          'commit', '-q', '-m',
          `${completed ? 'task' : 'task(incomplete)'}: ${agent} — ${manifest.taskId}\n\nAuto-committed by the dispatcher after the agent session exited${completed ? '' : ' with a non-zero code'}.`,
        ],
        worktreePath,
      );
    } catch (err) {
      console.error(`[dispatch] auto-commit failed for ${manifest.taskId}:`, err);
    }
  }

  /**
   * Push the task branch and open a pull request for review. Defaults ON
   * (draft when the plan allows it); disable per task via
   * manifest.pullRequest.autoCreate = false. Returns the PR URL, or
   * undefined when there is no remote, no work, or gh fails.
   */
  private async openPullRequest(
    manifest: TaskManifest,
    worktreePath: string,
  ): Promise<string | undefined> {
    const pr = manifest.pullRequest ?? {};
    if (pr.autoCreate === false) return undefined;
    const base = pr.targetBranch ?? manifest.context.branch;
    const branchName = `smith/${manifest.taskId}`;
    const agent = manifest.agentName ?? manifest.agent;
    try {
      const remotes = await this.git(['remote'], worktreePath);
      if (!remotes.split('\n').includes('origin')) return undefined;
      const commits = await this.git(['rev-list', '--count', `${base}..HEAD`], worktreePath);
      if (commits === '0') return undefined;
      await this.git(['push', '-u', 'origin', branchName], worktreePath);

      const firstSubject = (await this.git(['log', '--reverse', '--format=%s', `${base}..HEAD`], worktreePath)).split('\n')[0];
      const title = pr.titlePattern
        ? pr.titlePattern
            .replace('{taskId}', manifest.taskId)
            .replace('{agent}', agent)
            .replace('{prompt}', firstSubject ?? '')
        : (firstSubject ?? `task ${manifest.taskId}`);
      const taskText = manifest.prompt.split('Task from the live meeting:').pop()?.trim() ?? manifest.prompt;
      const ticketKey = typeof manifest.metadata?.ticketKey === 'string' ? manifest.metadata.ticketKey : undefined;
      const body = [
        `Delegated task \`${manifest.taskId}\`, completed by **${agent}**.`,
        '',
        '## Task',
        '',
        taskText,
        ...(ticketKey ? ['', `Closes ${ticketKey}`] : []),
        '',
        '---',
        '🤖 Delegated to the crew via smithagents',
      ].join('\n');

      const args = ['pr', 'create', '--head', branchName, '--base', base, '--title', title, '--body', body];
      for (const label of pr.labels ?? []) args.push('--label', label);
      for (const reviewer of pr.reviewers ?? []) args.push('--reviewer', reviewer);
      const wantDraft = pr.draft !== false;
      try {
        const url = await this.run('gh', wantDraft ? [...args, '--draft'] : args, worktreePath);
        return url.split('\n').pop()?.trim();
      } catch (err) {
        // Draft PRs are unavailable on some plans/private repos — retry normal.
        if (wantDraft && /draft/i.test(String(err))) {
          const url = await this.run('gh', args, worktreePath);
          return url.split('\n').pop()?.trim();
        }
        throw err;
      }
    } catch (err) {
      console.error(`[dispatch] PR creation failed for ${manifest.taskId}:`, err);
      return undefined;
    }
  }

  /**
   * Execute a git command and return stdout.
   */
  private git(args: string[], cwd?: string): Promise<string> {
    return this.run('git', args, cwd);
  }

  /** Execute a command, resolving stdout — stderr surfaces in the rejection. */
  private run(cmd: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`${cmd} ${args[0]} failed: ${stderr || error.message}`),
          );
          return;
        }
        resolve(stdout.trim());
      });
    });
  }
}
