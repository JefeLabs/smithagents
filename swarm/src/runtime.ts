// ---------------------------------------------------------------------------
// orchestrator/runtime.ts — RuntimeAdapter interface + implementations
//
// The abstraction layer that decouples the Dispatcher from the execution
// environment. Ship two implementations:
//
//   TmuxRuntime    — Bare-metal tmux sessions on the host (original)
//   DockerRuntime  — Docker containers with tmux running inside
//
// The Dispatcher doesn't know or care which runtime it's using.
// Tasks opt into Docker mode via a `runtime` field on the manifest.
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkerPool } from "./remote-runtime.js";
import type { DockerConfig, RuntimeType } from "./types.js";

// ---------------------------------------------------------------------------
// RuntimeAdapter Interface
// ---------------------------------------------------------------------------

/**
 * The contract that all execution runtimes must satisfy.
 *
 * The Dispatcher calls these methods without knowing whether it's talking
 * to bare-metal tmux, a Docker container, or any future runtime (Kubernetes,
 * Firecracker, etc.).
 */
export interface RuntimeAdapter {
  /**
   * Launch a new isolated session that runs `command` inside `cwd`.
   * The session is identified by `sessionName` for subsequent operations.
   *
   * `env`, when given, is passed as `tmux new-session -e KEY=VALUE` arguments
   * (TmuxRuntime) — kept out of the wrapped command string entirely, so a
   * secret value never appears in *the task's own process* argv or shell
   * history. It remains visible in `tmux`'s own short-lived launch invocation
   * and `ps` output for that one moment — an intrinsic property of
   * process-based env passing on POSIX systems, not avoidable here without a
   * different IPC mechanism.
   */
  launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>): Promise<void>;

  /**
   * Block until the named session exits and return its exit code.
   * 0 = success, non-zero = failure.
   */
  waitFor(sessionName: string): Promise<number>;

  /**
   * Check if a session with the given name is currently running.
   */
  exists(sessionName: string): Promise<boolean>;

  /**
   * Kill a specific session by name. No-op if already dead.
   */
  kill(sessionName: string): Promise<void>;

  /**
   * Kill all sessions matching a name prefix pattern.
   * @returns Number of sessions killed.
   */
  killPattern(pattern: string): Promise<number>;

  /**
   * List all active sessions whose names start with `prefix`.
   */
  listByPrefix(prefix: string): Promise<string[]>;

  /**
   * Capture the output of a session for logging purposes.
   */
  captureOutput(sessionName: string): Promise<string>;

  /**
   * Send keystrokes to a running session's tmux pane.
   *
   * This enables interactive communication with agent CLIs (claude, agy, codex)
   * running inside tmux — whether bare-metal or inside a Docker container.
   *
   * @param sessionName - The session to target
   * @param keys - The keystrokes to send (tmux send-keys format)
   * @param target - Optional tmux target pane within the session (default: first pane)
   */
  sendKeys(sessionName: string, keys: string, target?: string): Promise<void>;

  /**
   * Deliver arbitrary text as INPUT (bracketed paste + Enter). Unlike
   * sendKeys, the text is never interpreted as tmux key names — a message
   * that happens to be "Enter" is typed, not pressed. The input surface for
   * persistent agent sessions (design: tmux is input-only).
   */
  sendText(sessionName: string, text: string, target?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// TmuxRuntime — Bare-metal tmux sessions
// ---------------------------------------------------------------------------

/**
 * Runs agent sessions as tmux sessions directly on the host machine.
 * This is the original execution mode — no containerisation.
 *
 * Synchronisation strategy:
 *   - On launch, the command is wrapped to write its exit code to a temp file
 *     and then signal a tmux wait-for channel.
 *   - On waitFor, we block on `tmux wait-for <channel>` then read the exit
 *     code from the temp file.
 */
export class TmuxRuntime implements RuntimeAdapter {
  private readonly exitDir: string;

  constructor() {
    this.exitDir = join(tmpdir(), ".smith-exits");
  }

  async launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>): Promise<void> {
    await mkdir(this.exitDir, { recursive: true });

    const exitFile = this.exitFilePath(sessionName);
    const channel = `${sessionName}-done`;

    const wrappedCommand = [command, `; echo $? > ${this.shellEscape(exitFile)}`, `; tmux wait-for -S ${channel}`].join(
      " ",
    );

    const envArgs = env ? Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : [];

    await this.tmux(["new-session", "-d", ...envArgs, "-s", sessionName, "-c", cwd, wrappedCommand]);
  }

  async waitFor(sessionName: string): Promise<number> {
    const channel = `${sessionName}-done`;
    const exitFile = this.exitFilePath(sessionName);

    await this.tmux(["wait-for", channel]);

    try {
      const raw = await readFile(exitFile, "utf-8");
      const code = parseInt(raw.trim(), 10);
      await unlink(exitFile).catch(() => {
        /* ignore */
      });
      return Number.isNaN(code) ? 1 : code;
    } catch {
      return 1;
    }
  }

  async exists(sessionName: string): Promise<boolean> {
    try {
      await this.tmux(["has-session", "-t", sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  async kill(sessionName: string): Promise<void> {
    try {
      await this.tmux(["kill-session", "-t", sessionName]);
    } catch {
      // Already dead — fine
    }
  }

  async killPattern(pattern: string): Promise<number> {
    const sessions = await this.listByPrefix(pattern);
    let killed = 0;
    for (const name of sessions) {
      try {
        await this.tmux(["kill-session", "-t", name]);
        killed++;
      } catch {
        /* continue */
      }
    }
    return killed;
  }

  async listByPrefix(prefix: string): Promise<string[]> {
    try {
      const { stdout } = await this.tmux(["list-sessions", "-F", "#{session_name}"]);
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((n) => n.startsWith(prefix));
    } catch {
      return [];
    }
  }

  async captureOutput(sessionName: string): Promise<string> {
    try {
      const { stdout } = await this.tmux(["capture-pane", "-t", sessionName, "-p", "-S", "-"]);
      return stdout;
    } catch {
      return "";
    }
  }

  async sendKeys(sessionName: string, keys: string, target?: string): Promise<void> {
    const tmuxTarget = target ? `${sessionName}:${target}` : sessionName;

    await this.tmux(["send-keys", "-t", tmuxTarget, keys, "Enter"]);
  }

  async sendText(sessionName: string, text: string, target?: string): Promise<void> {
    const tmuxTarget = target ? `${sessionName}:${target}` : sessionName;
    const buffer = `smith-input-${Date.now()}`;
    // set-buffer + paste-buffer -p = bracketed paste: multi-line text arrives
    // as one input block; -d frees the buffer after pasting.
    await this.tmux(["set-buffer", "-b", buffer, "--", text]);
    await this.tmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", tmuxTarget]);
    await this.tmux(["send-keys", "-t", tmuxTarget, "Enter"]);
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile("tmux", args, { timeout: 0 }, (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new Error(
                "tmux is not installed or not in PATH. " +
                  "Install with: brew install tmux (macOS) or apt-get install tmux (Linux)",
              ),
            );
            return;
          }
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  private exitFilePath(sessionName: string): string {
    return join(this.exitDir, sessionName);
  }

  private shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }
}

// ---------------------------------------------------------------------------
// DockerRuntime — Containerised execution with tmux inside
// ---------------------------------------------------------------------------

/**
 * Runs agent sessions inside Docker containers.
 *
 * Each task gets one container. The container runs the smith image
 * which has tmux, agent CLIs, and smith-delegate pre-installed.
 * Sub-agents spawned by smith-delegate create tmux sessions *inside*
 * the same container — one container per task, not per sub-agent.
 *
 * Lifecycle:
 *   1. `docker run -d` → start container with worktree mounted
 *   2. `docker exec`   → launch the Alpha agent command
 *   3. `docker wait`   → block until the container exits
 *   4. `docker inspect` → read exit code
 *   5. `docker logs`   → capture output
 *   6. `docker rm -f`  → teardown
 *
 * The container name IS the session name, so the RuntimeAdapter
 * interface maps cleanly.
 */
/**
 * The `-v` args that make a task worktree's git usable inside a container.
 *
 * `git worktree add` writes a `.git` FILE containing an absolute host path:
 *   gitdir: /Users/…/<repo>/.git/worktrees/<taskId>
 * That path means nothing in a container unless it is mounted at exactly the
 * same location, so the parent repo's `.git` is bind-mounted at its own host
 * path. Returns [] when `.git` is a directory (a plain clone, not a worktree)
 * or unreadable — callers then get today's behaviour rather than a crash.
 */
async function gitdirMount(worktreePath: string): Promise<string[]> {
  try {
    const dotGit = await readFile(join(worktreePath, ".git"), "utf8");
    const match = /^gitdir:\s*(.+)$/m.exec(dotGit.trim());
    if (!match) return [];
    // …/<repo>/.git/worktrees/<taskId> → …/<repo>/.git
    const repoGitDir = resolve(match[1].trim(), "..", "..");
    return ["-v", `${repoGitDir}:${repoGitDir}`];
  } catch {
    return [];
  }
}

/** Host directory bind-mounted as the container agent's `$HOME/.claude`. */
export function claudeCredentialDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SMITH_DOCKER_CLAUDE_DIR ?? join(homedir(), ".smith", "docker-auth");
}

/**
 * The `-v` args that give a container a working Claude subscription.
 *
 * On macOS the CLI keeps credentials in the Keychain, which a Linux container
 * can never read; on Linux it keeps them in a FILE at `$HOME/.claude/
 * .credentials.json`. Exporting the Keychain's `claudeAiOauth` object into that
 * file format is therefore all it takes to carry a subscription across the
 * boundary — no API key, no `setup-token`.
 *
 * Mounted read-WRITE, and as the directory rather than the file: the access
 * token expires in hours and the CLI rewrites it in place on refresh. A `:ro`
 * file mount passes every test written today and then starts failing overnight,
 * reporting what looks like a dead subscription. Read-write means one shared,
 * self-renewing credential for every container.
 *
 * Returns [] when nothing has been exported, so docker keeps today's behaviour
 * instead of failing to launch.
 */
async function credentialMount(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const dir = claudeCredentialDir(env);
  try {
    await stat(join(dir, ".credentials.json"));
    return ["-v", `${dir}:/home/agent/.claude`];
  } catch {
    return [];
  }
}

export class DockerRuntime implements RuntimeAdapter {
  private readonly dockerConfig: DockerConfig;

  constructor(dockerConfig: DockerConfig) {
    this.dockerConfig = dockerConfig;
  }

  async launch(sessionName: string, command: string, cwd: string, env?: Record<string, string>): Promise<void> {
    const { image, network, extraMounts, extraEnv, cpuLimit, memoryLimit, shmSize } = this.dockerConfig;

    // Build docker run args
    const args: string[] = [
      "run",
      "-d",
      "--name",
      sessionName,

      // Mount the worktree into the container at /workspace
      "-v",
      `${cwd}:/workspace`,
      "-w",
      "/workspace",

      // A task worktree's `.git` is a FILE holding an absolute host path
      // (`gitdir: /…/<repo>/.git/worktrees/<id>`), not a directory. Mounting
      // only the worktree therefore gives the container a dangling pointer:
      // every git command fails with "not a git repository", so the agent
      // cannot commit and the task's work is lost. Mounting the parent .git at
      // that SAME absolute path inside the container makes the pointer
      // resolve. Read-write on purpose — git writes refs and the index there.
      ...(await gitdirMount(cwd)),

      // The agent's Claude subscription, exported from the host Keychain into
      // the Linux credentials-file format. Without this the CLI starts, finds
      // no credential, and every task fails as though the runtime were broken.
      ...(await credentialMount()),

      // Environment variables
      "-e",
      "SMITH_RUNTIME=docker",
      "-e",
      `SMITH_SESSION=${sessionName}`,
    ];

    // Network mode
    if (network) {
      args.push("--network", network);
    }

    // Resource limits
    if (cpuLimit) {
      args.push("--cpus", cpuLimit);
    }
    if (memoryLimit) {
      args.push("--memory", memoryLimit);
    }

    // Shared memory for Playwright/Chromium (default: 2g)
    args.push("--shm-size", shmSize ?? "2g");

    // Extra volume mounts (e.g., SSH keys, git config)
    if (extraMounts) {
      for (const mount of extraMounts) {
        args.push("-v", mount);
      }
    }

    // Extra environment variables
    if (extraEnv) {
      for (const [key, value] of Object.entries(extraEnv)) {
        args.push("-e", `${key}=${value}`);
      }
    }
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        args.push("-e", `${key}=${value}`);
      }
    }

    // Image and command.
    //
    // Pass the command RAW — /entrypoint.sh already runs it inside a tmux
    // session named "main", blocks on `tmux wait-for main-done`, and
    // propagates the inner exit code as the container's. Wrapping it in a
    // second `tmux new-session -d -s main` here made the inner one collide
    // with the session the entrypoint had already created ("duplicate
    // session: main"), so every docker task died with exit 1 in ~500ms.
    //
    // The entrypoint reassembles argv with `printf '%q '`, so the command
    // must arrive as the three args `/bin/bash -c <command>`: a single
    // pre-joined arg would be quoted into one word and exec'd as a literal
    // filename (exit 127).
    args.push(image, "/bin/bash", "-c", command);

    await this.docker(args);
  }

  async waitFor(sessionName: string): Promise<number> {
    // `docker wait` blocks until the container stops and prints the exit code
    try {
      const { stdout } = await this.docker(
        ["wait", sessionName],
        0, // no timeout — block indefinitely
      );
      const code = parseInt(stdout.trim(), 10);
      return Number.isNaN(code) ? 1 : code;
    } catch {
      return 1;
    }
  }

  async exists(sessionName: string): Promise<boolean> {
    try {
      const { stdout } = await this.docker(["inspect", "-f", "{{.State.Running}}", sessionName]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async kill(sessionName: string): Promise<void> {
    try {
      await this.docker(["rm", "-f", sessionName]);
    } catch {
      // Container may already be gone
    }
  }

  async killPattern(pattern: string): Promise<number> {
    const containers = await this.listByPrefix(pattern);
    let killed = 0;
    for (const name of containers) {
      try {
        await this.docker(["rm", "-f", name]);
        killed++;
      } catch {
        /* continue */
      }
    }
    return killed;
  }

  async listByPrefix(prefix: string): Promise<string[]> {
    try {
      const { stdout } = await this.docker(["ps", "-a", "--filter", `name=^${prefix}`, "--format", "{{.Names}}"]);
      return stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((n) => n.length > 0);
    } catch {
      return [];
    }
  }

  async captureOutput(sessionName: string): Promise<string> {
    try {
      const { stdout } = await this.docker(["logs", "--tail", "5000", sessionName]);
      return stdout;
    } catch {
      return "";
    }
  }

  async sendKeys(sessionName: string, keys: string, target?: string): Promise<void> {
    // Reach into the container's tmux server via docker exec.
    // The tmux target inside the container is the session name
    // (typically "main" for the Alpha agent).
    const tmuxTarget = target ?? "main";

    await this.docker(["exec", sessionName, "tmux", "send-keys", "-t", tmuxTarget, keys, "Enter"]);
  }

  async sendText(sessionName: string, text: string, target?: string): Promise<void> {
    const tmuxTarget = target ?? "main";
    const buffer = `smith-input-${Date.now()}`;
    await this.docker(["exec", sessionName, "tmux", "set-buffer", "-b", buffer, "--", text]);
    await this.docker(["exec", sessionName, "tmux", "paste-buffer", "-p", "-d", "-b", buffer, "-t", tmuxTarget]);
    await this.docker(["exec", sessionName, "tmux", "send-keys", "-t", tmuxTarget, "Enter"]);
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private docker(args: string[], timeout: number = 30_000): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile("docker", args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new Error(
                "Docker is not installed or not in PATH. " + "Install from: https://docs.docker.com/get-docker/",
              ),
            );
            return;
          }
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create the appropriate RuntimeAdapter for the requested runtime type.
 *
 * @param runtime - 'tmux' bare-metal, 'docker' containerised, 'remote' via a worker machine
 * @param dockerConfig - Required when runtime is 'docker'
 * @param workerPool - Required when runtime is 'remote'
 */
export function createRuntime(
  runtime: RuntimeType,
  dockerConfig?: DockerConfig,
  workerPool?: WorkerPool,
): RuntimeAdapter {
  switch (runtime) {
    case "tmux":
      return new TmuxRuntime();

    case "docker":
      if (!dockerConfig) {
        throw new Error(
          'DockerConfig is required when runtime is "docker". ' + "Provide it via OrchestratorConfig.docker.",
        );
      }
      return new DockerRuntime(dockerConfig);

    case "remote":
    case "remote-tmux":
    case "remote-docker": {
      if (!workerPool) {
        throw new Error(
          'WorkerPool is required when runtime is "remote". ' +
            "The server must have a WorkerPool with connected workers.",
        );
      }
      // Lazy + require (not a top-level import) to avoid a runtime circular
      // import; createRequire is the ESM-legal way to do that synchronously
      // since this package has no global `require`.
      const { RemoteRuntime } = createRequire(import.meta.url)(
        "./remote-runtime.js",
      ) as typeof import("./remote-runtime.js");
      const kind = runtime === "remote-tmux" ? "tmux" : runtime === "remote-docker" ? "docker" : undefined;
      return new RemoteRuntime(workerPool, kind);
    }

    default: {
      const _exhaustive: never = runtime;
      throw new Error(`Unknown runtime: ${_exhaustive}`);
    }
  }
}
