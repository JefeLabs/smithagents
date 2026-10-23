// CLI tool registry — machine-level status of the agent CLI tools (spec:
// docs/superpowers/specs/2026-08-06-cli-tool-registry-design.md). ENGINES
// (personas.ts) says which tools CAN exist; this file records which ones this
// machine actually has: detected on PATH, auth-probed via the tool's driver,
// and user-enabled. One untracked JSON file under .smith/ — a machine fact,
// not a per-user fact, so it does not live on the User record. The gate rule
// throughout: block only confirmed negatives, never ignorance.
import { execFile } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getDriver } from "./drivers/index.js";
import type { CommandRunner, ToolDriver } from "./drivers/types.js";
import type { EngineOption } from "./personas.js";

/**
 * Why a tool cannot be used, as a CLASS rather than prose.
 *
 * The prose `detail` stays — it is what a human reads — but a class is what
 * lets the UI offer the RIGHT next action: install a binary, log in, or fix
 * billing. Collapsing these into one "unavailable" is the misdiagnosis the
 * welcome-wizard spec calls out by name.
 *
 * `billing` and `policy` are defined here and rendered by the UI, but NO probe
 * currently detects them: every driver's probe distinguishes only logged-in /
 * logged-out / unrecognised. They are forward compatibility, not shipped
 * detection — do not write guidance implying the system can spot a lapsed
 * subscription today.
 */
export type AuthFailure = "missing" | "unauthenticated" | "billing" | "policy" | "unknown";

export interface CliToolStatus {
  detected: boolean; // binary resolvable on PATH
  authOk: boolean | "unknown"; // driver auth probe result
  enabled: boolean; // user toggle; defaults true on first detection
  detail: string; // human-readable, e.g. "logged in as …"
  /** Set only on a confirmed negative (missing binary or authOk === false); undefined otherwise, always undefined when authOk is 'unknown'. */
  failure?: AuthFailure;
  version?: string; // tool-reported version when cheaply available
  lastCheckedAt: string; // ISO timestamp of last probe
}

export interface CliToolsFile {
  version: 1;
  tools: Record<string, CliToolStatus>;
}

/** One catalog engine joined with this machine's status — drives the whole Settings UI. */
export interface CliToolListing extends EngineOption {
  status: CliToolStatus | null;
  active: boolean;
}

export function emptyCliToolsFile(): CliToolsFile {
  return { version: 1, tools: {} };
}

/** Corrupt or missing file -> empty (the next sweep regenerates it). */
export async function loadCliToolsFile(path: string): Promise<CliToolsFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CliToolsFile;
    if (parsed?.version === 1 && parsed.tools && typeof parsed.tools === "object") return parsed;
    return emptyCliToolsFile();
  } catch {
    return emptyCliToolsFile();
  }
}

/** Owner-only permissions, mirror of channels.ts saveChannels. */
export async function saveCliToolsFile(path: string, file: CliToolsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, "w", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

/**
 * Active = assignable to agents and launchable. undefined (never probed) is
 * ACTIVE: we block only confirmed negatives — a missing binary, a confirmed
 * logged-out state, or the user's own toggle. 'unknown' auth counts as active.
 */
export function isActive(status: CliToolStatus | undefined): boolean {
  if (!status) return true;
  return status.detected && status.enabled && status.authOk !== false;
}

/** Human reason a tool is inactive; '' when active. */
export function inactiveDetail(status: CliToolStatus | undefined): string {
  if (!status || isActive(status)) return "";
  if (!status.detected) return status.detail || "binary not found on PATH";
  if (!status.enabled) return "disabled in Settings → CLI Tools";
  return status.detail || "not logged in";
}

/** '' when `cli` may be assigned/launched; else the human reason to refuse. */
export function gateReason(file: CliToolsFile, cli: string): string {
  return isActive(file.tools[cli]) ? "" : inactiveDetail(file.tools[cli]);
}

export function buildCliToolListings(engines: EngineOption[], file: CliToolsFile): CliToolListing[] {
  return engines.map((e) => ({
    ...e,
    status: file.tools[e.cli] ?? null,
    active: isActive(file.tools[e.cli]),
  }));
}

const AUTH_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 5_000;

/**
 * Real subprocess probes: resolve with exit code + output, never reject. When
 * `signal` aborts, the child is killed at once and the probe resolves with a
 * null code, the same shape as a timeout.
 */
export function subprocessRunner(signal?: AbortSignal): CommandRunner {
  return (argv, timeoutMs) =>
    new Promise((done) => {
      execFile(argv[0], argv.slice(1), { timeout: timeoutMs, signal }, (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : null // killed by timeout, signal or abort
          : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

/** Production subprocess runner with no abort. */
export const defaultRunner: CommandRunner = subprocessRunner();

export interface SweepDeps {
  /** OrchestratorConfig.agentCommands — the binary is the first word. */
  agentCommands: Record<string, string>;
  /** Which tools to keep entries for — pass ENGINES.map(e => e.cli). */
  clis: string[];
  run?: CommandRunner;
  resolveDriver?: (id: string) => Pick<ToolDriver, "verifyAuth"> | null;
  authTimeoutMs?: number;
  now?: () => string;
  /**
   * Cuts the sweep short: in-flight probes give way (real subprocesses are
   * killed) and nothing is written. Aborted probes read as "not found", so
   * saving them would replace good cached entries with false negatives.
   */
  signal?: AbortSignal;
}

const ABORTED_PROBE = { code: null, stdout: "", stderr: "aborted" };

/** `probe`, or an aborted result the moment `signal` fires, whichever comes first. */
function untilAborted(probe: ReturnType<CommandRunner>, signal: AbortSignal): ReturnType<CommandRunner> {
  if (signal.aborted) return Promise.resolve({ ...ABORTED_PROBE });
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ ...ABORTED_PROBE });
    signal.addEventListener("abort", onAbort, { once: true });
    probe.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Probe every tool in `deps.clis` (or just `only`) and persist the result.
 * Detection is generic (`command -v` on the configured binary); the auth
 * probe is the driver's, absent probe = 'unknown'. Entries for tools outside
 * this sweep are preserved verbatim; `enabled` always survives re-probes.
 */
export async function sweepCliTools(path: string, deps: SweepDeps, only?: string): Promise<CliToolsFile> {
  const { signal } = deps;
  const probe = deps.run ?? subprocessRunner(signal);
  // Injected runners give way on abort too, so the sweep can always settle.
  // Once aborted, the next probe is never started (detection → --version →
  // auth run in sequence per tool); one already running gives way at once.
  const run: CommandRunner = signal
    ? (argv, ms) => (signal.aborted ? Promise.resolve({ ...ABORTED_PROBE }) : untilAborted(probe(argv, ms), signal))
    : probe;
  const resolveDriver = deps.resolveDriver ?? getDriver;
  const authTimeoutMs = deps.authTimeoutMs ?? AUTH_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date().toISOString());
  const file = await loadCliToolsFile(path);
  const targets = only ? deps.clis.filter((c) => c === only) : deps.clis;

  await Promise.all(
    targets.map(async (cli) => {
      const baseCommand = deps.agentCommands[cli] ?? cli;
      const binary = baseCommand.split(/\s+/)[0];
      const enabled = file.tools[cli]?.enabled ?? true;
      const entry: CliToolStatus = {
        detected: false,
        authOk: "unknown",
        enabled,
        detail: "",
        lastCheckedAt: now(),
      };
      try {
        const found = await run(["/bin/sh", "-c", `command -v -- ${binary}`], VERSION_TIMEOUT_MS);
        entry.detected = found.code === 0 && found.stdout.trim().length > 0;
        if (!entry.detected) {
          entry.detail = `${binary} not found on PATH`;
          entry.failure = "missing";
        } else {
          const ver = await run([binary, "--version"], VERSION_TIMEOUT_MS);
          if (ver.code === 0 && ver.stdout.trim()) entry.version = ver.stdout.trim().split("\n")[0];
          // Call through the driver — an extracted `probe(...)` loses `this`,
          // and stateful probes (copilot's reads its env/configDir) then throw.
          const driver = resolveDriver(cli);
          if (driver?.verifyAuth) {
            const auth = await driver.verifyAuth(binary, run, authTimeoutMs);
            entry.authOk = auth.ok;
            entry.detail = auth.detail;
            // ok === "unknown" is unconfirmed — never manufacture a class from it.
            if (auth.ok === false) entry.failure = auth.failure ?? "unauthenticated";
          } else {
            entry.authOk = "unknown";
            entry.detail = "no auth probe for this tool";
          }
        }
      } catch (err) {
        // A probe failure is not a confirmed negative — record it, stay 'unknown'.
        entry.authOk = "unknown";
        entry.detail = `probe failed: ${String((err as Error).message ?? err)}`;
      }
      file.tools[cli] = entry;
    }),
  );

  // A cut-short sweep holds the aborted probes' false negatives, and its
  // directory may be mid-teardown: return the result, never persist it.
  if (signal?.aborted) return file;
  await saveCliToolsFile(path, file);
  return file;
}

/**
 * Owns the background CLI-tool probes (the startup sweep and the one-tool
 * re-probes after a launch failure) so a shutdown can settle them. Each probe
 * writes cli-tools.json into the state root, so one that outlived its server
 * could land in, or recreate, a root that is being torn down.
 *
 * close() aborts everything still running (subprocesses killed, nothing
 * written) and resolves once it has all settled. Closing is permanent: work
 * that fails during shutdown must not start new probes.
 */
export class CliToolRefresher {
  private readonly abort = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();

  /** `run` overrides the probe runner (tests); default is real subprocesses. */
  constructor(private readonly run?: CommandRunner) {}

  get closed(): boolean {
    return this.abort.signal.aborted;
  }

  /** A sweep that close() will settle. Rejects only if the sweep itself throws. */
  sweep(path: string, deps: Pick<SweepDeps, "agentCommands" | "clis">, only?: string): Promise<CliToolsFile> {
    const sweep = sweepCliTools(path, { ...deps, run: this.run, signal: this.abort.signal }, only);
    this.inflight.add(sweep);
    const settled = () => this.inflight.delete(sweep);
    sweep.then(settled, settled);
    return sweep;
  }

  /** Re-probe one tool in the background: the launch-failure self-correction. Never throws. */
  refresh(path: string, agentCommands: Record<string, string>, cli: string): void {
    this.sweep(path, { agentCommands, clis: [cli] }, cli).catch(() => {});
  }

  async close(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled(this.inflight);
  }
}
