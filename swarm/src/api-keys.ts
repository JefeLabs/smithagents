// API key registry — machine-level provider keys for agent work that
// subscriptions can't cover (spec:
// docs/superpowers/specs/2026-08-06-settings-agents-api-keys-design.md).
// Sibling of cli-tools.ts: same untracked-0600-file idiom, same
// block-only-confirmed-negatives verify semantics. Raw keys never appear
// in listings; only the swarm-local credential route serves one.
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ApiKeyEntry {
  key: string;                    // raw key — file is 0600, never serialized to clients
  verified: boolean | 'unknown';  // last probe result
  detail: string;                 // human-readable probe outcome
  lastCheckedAt: string;          // ISO timestamp of last probe
}

export interface ApiKeysFile {
  version: 1;
  providers: Record<string, ApiKeyEntry>;
}

/** Registry entry joined with redacted machine state — drives the whole UI. */
export interface ApiKeyListing {
  id: string;
  label: string;
  description: string;
  hasKey: boolean;
  last4: string | null;
  verified: boolean | 'unknown' | null;
  detail: string | null;
  lastCheckedAt: string | null;
}

export interface ApiProviderDef {
  id: string;
  label: string;
  description: string;
  verify(key: string, fetchImpl?: typeof fetch): Promise<{ ok: boolean | 'unknown'; detail: string }>;
}

/** Filled in Task 2 — keep the export so listings can iterate it now. */
export const PROVIDERS: ApiProviderDef[] = [];

export const findProvider = (id: string): ApiProviderDef | undefined => PROVIDERS.find((p) => p.id === id);

export function emptyApiKeysFile(): ApiKeysFile {
  return { version: 1, providers: {} };
}

/** Corrupt or missing file -> empty (mirror of loadCliToolsFile). */
export async function loadApiKeysFile(path: string): Promise<ApiKeysFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ApiKeysFile;
    if (parsed?.version === 1 && parsed.providers && typeof parsed.providers === 'object') return parsed;
    return emptyApiKeysFile();
  } catch {
    return emptyApiKeysFile();
  }
}

/** Owner-only permissions, mirror of saveCliToolsFile. */
export async function saveApiKeysFile(path: string, file: ApiKeysFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const fh = await open(path, 'w', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(file, null, 2)}\n`);
  } finally {
    await fh.close();
  }
}

export const last4 = (key: string): string => key.slice(-4);

export function buildApiKeyListings(file: ApiKeysFile): ApiKeyListing[] {
  return PROVIDERS.map((p) => {
    const e = file.providers[p.id];
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      hasKey: Boolean(e),
      last4: e ? last4(e.key) : null,
      verified: e ? e.verified : null,
      detail: e?.detail ?? null,
      lastCheckedAt: e?.lastCheckedAt ?? null,
    };
  });
}
