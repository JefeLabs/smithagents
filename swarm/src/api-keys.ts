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

const PROBE_TIMEOUT_MS = 10_000;

/** One probe idiom for every provider: cheapest authenticated GET; auth in
 *  headers only (keys in URLs leak into logs). 401/403 are the only
 *  confirmed negatives. */
async function probe(
  url: string,
  headers: Record<string, string>,
  label: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean | 'unknown'; detail: string }> {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.ok) return { ok: true, detail: 'key accepted' };
    if (res.status === 401 || res.status === 403) return { ok: false, detail: `${label} rejected the key (${res.status})` };
    return { ok: 'unknown', detail: `${label} answered ${res.status} — could not confirm` };
  } catch (err) {
    return { ok: 'unknown', detail: `could not reach ${label}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const PROVIDERS: ApiProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models over the Messages API — future api-kind thinkers.',
    verify: (key, fetchImpl = fetch) =>
      probe('https://api.anthropic.com/v1/models', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, 'Anthropic', fetchImpl),
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT models over the OpenAI API — future api-kind thinkers.',
    verify: (key, fetchImpl = fetch) =>
      probe('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` }, 'OpenAI', fetchImpl),
  },
  {
    id: 'google',
    label: 'Google',
    description: 'Gemini API — accelerates avatar generation; future api-kind thinkers.',
    verify: (key, fetchImpl = fetch) =>
      probe('https://generativelanguage.googleapis.com/v1beta/models', { 'x-goog-api-key': key }, 'Google', fetchImpl),
  },
];

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
