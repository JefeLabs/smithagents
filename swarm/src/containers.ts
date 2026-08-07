// Containers registry — machine-level container-provider enablement (spec:
// docs/superpowers/specs/2026-08-07-session-creation-and-execution-mode-design.md §2).
// Shaped as a provider map's first row (docker) so future providers are new
// keys, not a redesign. Same machine-fact storage discipline as cli-tools.ts.
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommandRunner } from './drivers/types.js';
import { defaultRunner } from './cli-tools.js';

export interface ContainersFile {
  version: 1;
  docker: { enabled: boolean };
}

export function emptyContainersFile(): ContainersFile {
  return { version: 1, docker: { enabled: false } };
}

export async function loadContainersFile(path: string): Promise<ContainersFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ContainersFile;
    if (parsed?.version === 1 && typeof parsed.docker?.enabled === 'boolean') return parsed;
    return emptyContainersFile();
  } catch {
    return emptyContainersFile();
  }
}

export async function saveContainersFile(path: string, file: ContainersFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

/** Diagnostic only — enabling docker never requires a passing probe (spec §2). */
export async function probeDocker(run: CommandRunner = defaultRunner): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await run(['docker', 'info', '--format', '{{.ServerVersion}}'], 5000);
    if (result.code === 0 && result.stdout.trim()) {
      return { ok: true, detail: `daemon running (server ${result.stdout.trim()})` };
    }
    return { ok: false, detail: 'docker daemon unreachable — is Docker running?' };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    return { ok: false, detail: /ENOENT|not found/.test(msg) ? 'docker binary not found on PATH' : 'docker daemon unreachable — is Docker running?' };
  }
}
