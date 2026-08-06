// CLI tool registry — machine-level status of the agent CLI tools (spec:
// docs/superpowers/specs/2026-08-06-cli-tool-registry-design.md). ENGINES
// (personas.ts) says which tools CAN exist; this file records which ones this
// machine actually has: detected on PATH, auth-probed via the tool's driver,
// and user-enabled. One untracked JSON file under .smith/ — a machine fact,
// not a per-user fact, so it does not live on the User record. The gate rule
// throughout: block only confirmed negatives, never ignorance.
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EngineOption } from './personas.js';

export interface CliToolStatus {
  detected: boolean;              // binary resolvable on PATH
  authOk: boolean | 'unknown';    // driver auth probe result
  enabled: boolean;               // user toggle; defaults true on first detection
  detail: string;                 // human-readable, e.g. "logged in as …"
  version?: string;               // tool-reported version when cheaply available
  lastCheckedAt: string;          // ISO timestamp of last probe
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
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CliToolsFile;
    if (parsed?.version === 1 && parsed.tools && typeof parsed.tools === 'object') return parsed;
    return emptyCliToolsFile();
  } catch {
    return emptyCliToolsFile();
  }
}

/** Owner-only permissions, mirror of channels.ts saveChannels. */
export async function saveCliToolsFile(path: string, file: CliToolsFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, 'w', 0o600);
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
  if (!status || isActive(status)) return '';
  if (!status.detected) return status.detail || 'binary not found on PATH';
  if (!status.enabled) return 'disabled in Settings → CLI Tools';
  return status.detail || 'not logged in';
}

/** '' when `cli` may be assigned/launched; else the human reason to refuse. */
export function gateReason(file: CliToolsFile, cli: string): string {
  return isActive(file.tools[cli]) ? '' : inactiveDetail(file.tools[cli]);
}

export function buildCliToolListings(engines: EngineOption[], file: CliToolsFile): CliToolListing[] {
  return engines.map((e) => ({
    ...e,
    status: file.tools[e.cli] ?? null,
    active: isActive(file.tools[e.cli]),
  }));
}
