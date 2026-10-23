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
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { WorkerPool } from "./remote-runtime.js";
import { secretPaths } from "./secret-file.js";
import { TASK_CLONE_MARKER } from "./task-clone.js";
import type { DockerConfig, RuntimeType } from "./types.js";

// ---------------------------------------------------------------------------
// RuntimeAdapter Interface
// ---------------------------------------------------------------------------

/** Extra, optional launch parameters. Runtimes that cannot honour a field ignore it. */
export interface LaunchOptions {
  /**
   * Host paths a container may READ but never write — the object stores a
   * `--shared` task clone borrows from. DockerRuntime mounts each at the same
   * path with `:ro`; the other runtimes ignore them.
   */
  readOnlyMounts?: string[];
}

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
   *
   * `opts.readOnlyMounts` lists host paths a container gets read-only (see
   * LaunchOptions); TmuxRuntime and RemoteRuntime accept and ignore it.
   */
  launch(
    sessionName: string,
    command: string,
    cwd: string,
    env?: Record<string, string>,
    opts?: LaunchOptions,
  ): Promise<void>;

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

  async launch(
    sessionName: string,
    command: string,
    cwd: string,
    env?: Record<string, string>,
    _opts?: LaunchOptions,
  ): Promise<void> {
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
 * Which mount sources would expose a secret: `resolve(source)` is the secret
 * itself or an ancestor of it at a path-segment boundary (`/h/.smithx` is not
 * `/h/.smith`). Pure string comparison: never stats or reads the secrets.
 */
export function exposedSecrets(mountSources: string[], secrets: string[]): Array<{ source: string; secret: string }> {
  const out: Array<{ source: string; secret: string }> = [];
  for (const source of mountSources) {
    const abs = resolve(source);
    const prefix = abs.endsWith(sep) ? abs : abs + sep;
    for (const secret of secrets) {
      const s = resolve(secret);
      if (s === abs || s.startsWith(prefix)) out.push({ source, secret });
    }
  }
  return out;
}

/**
 * Refuse a host-network container. The broker's session cookie is scoped to
 * the host, not the port, so a container on the host's loopback could listen
 * on a localhost port and receive browser requests carrying `smith_session`.
 */
function assertNotHostNetwork(network: string | undefined): void {
  if (network === "host") {
    throw new Error(`refusing to start container: network "host" would put the container on the host's loopback`);
  }
}

/** Refuse a `docker run` whose `-v` sources would put a ~/.smith secret in a container. */
function assertNoSecretMounts(args: string[]): void {
  const sources = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a.split(":")[0] ?? ""] : []));
  const [hit] = exposedSecrets(sources, secretPaths());
  if (hit) throw new Error(`refusing to start container: mount ${hit.source} would expose ${hit.secret}`);
}

/**
 * Throws unless `cwd` may be bind-mounted into a container. An allowlist:
 *   - `cwd` must exist and be a directory;
 *   - with no `<cwd>/.git` at all, it is not a repository and is allowed;
 *   - a `.git` FILE or symlink (a worktree) is refused: it names the user's real
 *     repository, and making it usable in a container means mounting that .git
 *     read-write, so the container could plant hooks/fsmonitor the host later runs;
 *   - a `.git` directory is allowed only when it carries TASK_CLONE_MARKER,
 *     i.e. it is a disposable clone createTaskClone made (see task-clone.ts);
 *   - anything else at `<cwd>/.git` is refused.
 * It inspects only `<cwd>/.git`, never any repository above or below it.
 */
async function assertMountableCwd(cwd: string): Promise<void> {
  const dir = await stat(cwd).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw new Error(`refusing to start a container in ${cwd}: it does not exist`);
    throw err;
  });
  if (!dir.isDirectory()) throw new Error(`refusing to start a container in ${cwd}: it is not a directory`);
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(join(cwd, ".git"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // not a git dir at all
    throw err;
  }
  if (st.isFile() || st.isSymbolicLink()) {
    throw new Error(
      `refusing to start a container in ${cwd}: it is a git worktree, and its .git would hand the container the host repository`,
    );
  }
  // Allowlist: only a directory carrying the marker createTaskClone planted.
  if (st.isDirectory()) {
    const marker = await lstat(join(cwd, ".git", TASK_CLONE_MARKER)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    if (marker?.isFile()) return;
  }
  throw new Error(
    `refusing to start a container in ${cwd}: its .git is not a smith task clone, and mounting it would hand the container that repository`,
  );
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

/**
 * A loopback URL, rewritten to reach the HOST from inside a container — where
 * 127.0.0.1 is the container itself. Docker Desktop delivers
 * host.docker.internal connections to the host's loopback (they arrive as
 * 127.0.0.1), so a swarm bound to loopback only still accepts them. Anything
 * that is not a loopback URL passes through unchanged.
 */
export function containerReachableUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) return url;
  parsed.hostname = "host.docker.internal";
  const rewritten = parsed.toString();
  // URL adds a "/" to a bare origin; smith-delegate appends "/tasks" itself.
  return rewritten.endsWith("/") && !url.endsWith("/") ? rewritten.slice(0, -1) : rewritten;
}

/**
 * Runs agent sessions inside Docker containers.
 *
 * Each task gets one container, running the smith-agent image
 * (docker/smith-agent/ — build it with `make agent-image`). The image's
 * /entrypoint.sh owns the contract this class depends on: the command runs in
 * tmux session "main", everything the session prints is mirrored to the
 * container's stdout, and the container exits with the command's exit code.
 * runtime.docker.test.ts checks that contract against a real image.
 *
 * Lifecycle:
 *   1. `docker run -d` → start the container; the command starts at once
 *   2. `docker exec`   → type into session "main" (sendKeys / sendText)
 *   3. `docker wait`   → block until the container exits; prints the exit code
 *   4. `docker logs`   → capture output
 *   5. `docker rm -f`  → teardown
 *
 * The container name IS the session name, so the RuntimeAdapter
 * interface maps cleanly.
 */
export class DockerRuntime implements RuntimeAdapter {
  private readonly dockerConfig: DockerConfig;

  constructor(dockerConfig: DockerConfig) {
    this.dockerConfig = dockerConfig;
  }

  async launch(
    sessionName: string,
    command: string,
    cwd: string,
    env?: Record<string, string>,
    opts?: LaunchOptions,
  ): Promise<void> {
    await assertMountableCwd(cwd);
    const { image, network, extraMounts, extraEnv, cpuLimit, memoryLimit, shmSize } = this.dockerConfig;
    assertNotHostNetwork(network);

    // Build docker run args
    const args: string[] = [
      "run",
      "-d",
      "--name",
      sessionName,

      // Mount the task clone (or a plain, non-git directory) at /workspace
      "-v",
      `${cwd}:/workspace`,
      "-w",
      "/workspace",

      // The clone's object stores, read-only at the path its alternates file
      // names: the container can read history but never write the user's objects.
      ...(opts?.readOnlyMounts ?? []).flatMap((m) => ["-v", `${m}:${m}:ro`]),

      // The agent's Claude subscription, exported from the host Keychain into
      // the Linux credentials-file format. Without this the CLI starts, finds
      // no credential, and every task fails as though the runtime were broken.
      ...(await credentialMount()),

      // Environment variables
      "-e",
      "SMITH_RUNTIME=docker",
      "-e",
      `SMITH_SESSION=${sessionName}`,

      // The host, as seen from inside: smith-delegate calls the swarm back
      // there (see containerReachableUrl). Docker Desktop defines the name
      // already; host-gateway defines it on Linux engines too.
      "--add-host",
      "host.docker.internal:host-gateway",
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
        args.push("-e", `${key}=${key === "SMITH_URL" ? containerReachableUrl(value) : value}`);
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
    // The entrypoint hands its argv on as argv — no shell re-parses it — so
    // the command must arrive as the three args `/bin/bash -c <command>`: a
    // single pre-joined arg would be exec'd as a literal filename (exit 127).
    args.push(image, "/bin/bash", "-c", command);

    assertNoSecretMounts(args);
    await this.docker(args);
  }

  /**
   * Run one command in a throwaway container and wait for it: `--rm`, no
   * network, no credentials, no env. Used for in-container git work on a task
   * clone, so the host never runs git there. An explicit `--entrypoint` skips
   * the image's tini+tmux wrapper. A non-zero exit is reported, not thrown.
   */
  async runOnce(
    cwd: string,
    command: string,
    readOnlyMounts: string[],
    timeoutMs: number = 120_000,
  ): Promise<{ exitCode: number; output: string }> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error(
        `runOnce: timeoutMs must be a positive number of milliseconds up to 2147483647, got ${timeoutMs}`,
      );
    }
    await assertMountableCwd(cwd);
    // runOnce always runs with `--network none`, but a host-network config is
    // refused here too, so it fails at the first docker call, not the launch.
    assertNotHostNetwork(this.dockerConfig.network);
    const { image, cpuLimit, memoryLimit } = this.dockerConfig;
    // bash is PID 1 once tini is bypassed and ignores SIGTERM, so `--init` plus
    // our own `docker rm -f` on expiry is what really stops the container.
    const name = `smith-once-${randomUUID()}`;
    const args = [
      "run",
      "--rm",
      "--init",
      "--name",
      name,
      "--network",
      "none",
      "--entrypoint",
      "/bin/bash",
      "-v",
      `${cwd}:/workspace`,
      "-w",
      "/workspace",
      ...readOnlyMounts.flatMap((m) => ["-v", `${m}:${m}:ro`]),
    ];
    if (cpuLimit) args.push("--cpus", cpuLimit);
    if (memoryLimit) args.push("--memory", memoryLimit);
    args.push(image, "-c", command);
    assertNoSecretMounts(args);
    let timer: NodeJS.Timeout | undefined;
    // Set when the timer fires: the FINAL timeout error, composed after the
    // removal settles. Once set it wins over whatever `docker run` does next
    // (killing the container makes the attached CLI exit with 137 at once).
    let timeoutError: Promise<Error> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        // Remove FIRST, report after, and never swallow a failed removal: the
        // container may still be running.
        timeoutError = this.docker(["rm", "-f", name]).then(
          () => new Error(`runOnce timed out after ${timeoutMs}ms (container ${name})`),
          (rmErr: unknown) =>
            new Error(
              `runOnce timed out after ${timeoutMs}ms (container ${name}; removing it failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)})`,
            ),
        );
        resolve("timeout");
      }, timeoutMs);
    });
    // Never rejects, so a run that settles after the timeout is not unhandled.
    const settled = this.docker(args, 0).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      const first = await Promise.race([settled, expiry]);
      if (timeoutError) throw await timeoutError;
      if (first === "timeout") throw new Error("runOnce: unreachable"); // timeoutError is set before expiry resolves
      if ("value" in first) return { exitCode: 0, output: first.value.stdout + first.value.stderr };
      const e = first.error as { code?: unknown; stdout?: string; stderr?: string };
      if (typeof e.code === "number") return { exitCode: e.code, output: (e.stdout ?? "") + (e.stderr ?? "") };
      throw first.error;
    } finally {
      clearTimeout(timer);
    }
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
      await this.removeContainer(sessionName);
    } catch {
      // Container may already be gone
    }
  }

  /**
   * `docker rm -f <name>`. Unlike kill(), a failure is thrown, not swallowed —
   * unless the container is verifiably gone within `graceMs`: an `--rm`
   * container that exited on its own may already be removing itself, and then
   * rm fails with "removal … is already in progress" although nothing is left.
   */
  async removeContainer(name: string, graceMs = 5_000): Promise<void> {
    try {
      await this.docker(["rm", "-f", name]);
    } catch (err) {
      const deadline = Date.now() + graceMs;
      for (;;) {
        let left: string;
        try {
          left = (await this.docker(["ps", "-a", "-q", "--filter", `name=^${name}$`])).stdout.trim();
        } catch {
          throw err; // cannot even look: report the failed removal
        }
        if (left === "") return;
        if (Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
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
