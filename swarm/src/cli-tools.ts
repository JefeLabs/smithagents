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

/** Production subprocess runner: resolves with exit code + output, never rejects. */
export const defaultRunner: CommandRunner = (argv, timeoutMs) =>
  new Promise((done) => {
    execFile(argv[0], argv.slice(1), { timeout: timeoutMs }, (err, stdout, stderr) => {
      const code = err
        ? typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : null // killed by timeout/signal
        : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export interface SweepDeps {
  /** OrchestratorConfig.agentCommands — the binary is the first word. */
  agentCommands: Record<string, string>;
  /** Which tools to keep entries for — pass ENGINES.map(e => e.cli). */
  clis: string[];
  run?: CommandRunner;
  resolveDriver?: (id: string) => Pick<ToolDriver, "verifyAuth"> | null;
  authTimeoutMs?: number;
  now?: () => string;
}

/**
 * Probe every tool in `deps.clis` (or just `only`) and persist the result.
 * Detection is generic (`command -v` on the configured binary); the auth
 * probe is the driver's, absent probe = 'unknown'. Entries for tools outside
 * this sweep are preserved verbatim; `enabled` always survives re-probes.
 */
export async function sweepCliTools(path: string, deps: SweepDeps, only?: string): Promise<CliToolsFile> {
  const run = deps.run ?? defaultRunner;
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
          const probe = resolveDriver(cli)?.verifyAuth;
          if (probe) {
            const auth = await probe(binary, run, authTimeoutMs);
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

  await saveCliToolsFile(path, file);
  return file;
}

/** One-tool sweep with production deps — the launch-failure self-correction hook. */
export async function refreshCliTool(path: string, agentCommands: Record<string, string>, cli: string): Promise<void> {
  await sweepCliTools(path, { agentCommands, clis: [cli] }, cli);
}
