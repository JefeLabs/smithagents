// Containers registry — machine-level container-provider enablement (spec:
// docs/superpowers/specs/2026-08-07-session-creation-and-execution-mode-design.md §2).
// Shaped as a provider map's first row (docker) so future providers are new
// keys, not a redesign. Same machine-fact storage discipline as cli-tools.ts.
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultRunner } from "./cli-tools.js";
import type { CommandRunner } from "./drivers/types.js";

export type ExecutionModeId = "local-in-process" | "local-docker" | "remote-in-process" | "remote-docker";

export interface ContainersFile {
  version: 1;
  docker: { enabled: boolean };
}

export function emptyContainersFile(): ContainersFile {
  return { version: 1, docker: { enabled: false } };
}

export async function loadContainersFile(path: string): Promise<ContainersFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ContainersFile;
    if (parsed?.version === 1 && typeof parsed.docker?.enabled === "boolean") return parsed;
    return emptyContainersFile();
  } catch {
    return emptyContainersFile();
  }
}

export async function saveContainersFile(path: string, file: ContainersFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, "w", 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

/** Diagnostic only — enabling docker never requires a passing probe (spec §2). */
export async function probeDocker(run: CommandRunner = defaultRunner): Promise<{ ok: boolean; detail: string }> {
  const result = await run(["docker", "info", "--format", "{{.ServerVersion}}"], 5000);
  // CommandRunner resolves (never rejects): code is null when binary not found or killed by timeout.
  // Discriminate: code === null with empty stdout/stderr → binary not found; code !== 0 → daemon error.
  if (result.code === null && !result.stdout && !result.stderr) {
    return { ok: false, detail: "docker binary not found on PATH" };
  }
  if (result.code === 0 && result.stdout.trim()) {
    return { ok: true, detail: `daemon running (server ${result.stdout.trim()})` };
  }
  return { ok: false, detail: "docker daemon unreachable — is Docker running?" };
}

/** Availability = the same data routing uses (spec §2): toggle for docker, advertisement for remote. */
export function buildExecutionModes(
  dockerEnabled: boolean,
  workerRuntimes: Array<Array<"tmux" | "docker">>,
): Record<ExecutionModeId, boolean> {
  return {
    "local-in-process": true,
    "local-docker": dockerEnabled,
    "remote-in-process": workerRuntimes.some((r) => r.includes("tmux")),
    "remote-docker": workerRuntimes.some((r) => r.includes("docker")),
  };
}
