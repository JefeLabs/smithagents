// Local model server detection — probes the OpenAI-compatible /v1/models
// endpoint that both Ollama and LM Studio expose. broker/src/local-brain.ts
// already POSTs `${baseUrl}/v1/chat/completions` in this same dialect (see
// its header comment: the project's happy path, no key, no per-token cost);
// this module is the read-only sibling that finds the server before the
// wizard offers to point a brain at it.
//
// Renders in the wizard, so it must never throw: a fresh machine with
// nothing installed is the common case, not an error, and a rejected probe
// or a server answering garbage is "not found" — never surfaced as a
// broken entry.
export interface LocalServer {
  /** "ollama" | "lmstudio" — which default port answered. */
  id: string;
  label: string;
  baseUrl: string;
  models: { id: string; sizeBytes: number | null }[];
}

interface ServerDef {
  id: string;
  label: string;
  baseUrl: string;
}

// Ollama defaults to 11434, LM Studio to 1234 — both fixed by the tool, not
// configurable here.
const KNOWN_SERVERS: ServerDef[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234" },
];

const PROBE_TIMEOUT_MS = 1_500;

async function probe(def: ServerDef, fetchImpl: typeof fetch): Promise<LocalServer | null> {
  const res = await fetchImpl(`${def.baseUrl}/v1/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null; // not the shape we expect — treat as no server here
  const models = data
    .filter((m): m is { id: string } => typeof (m as { id?: unknown })?.id === "string")
    // The OpenAI-compatible /v1/models never reports a size (Ollama's own
    // /api/tags does); null here means "unavailable", never a guess.
    .map((m) => ({ id: m.id, sizeBytes: null as number | null }));
  return { id: def.id, label: def.label, baseUrl: def.baseUrl, models };
}

/** Probes the known default ports. Never throws — an absent server is []. */
export async function detectLocalServers(deps: { fetchImpl?: typeof fetch } = {}): Promise<LocalServer[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const settled = await Promise.allSettled(KNOWN_SERVERS.map((def) => probe(def, fetchImpl)));
  // Order follows KNOWN_SERVERS, not settle time — stable regardless of
  // which server answers first.
  return settled.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}
