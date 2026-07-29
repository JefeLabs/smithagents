import { useCallback, useEffect, useRef, useState } from "react";

const BASE = "127.0.0.1:7790";

export type SurfaceMode = "autojoin" | "on-request" | "disabled";

export const SURFACES = [
  { key: "tauri", label: "Tauri app" },
  { key: "discord", label: "Discord text" },
  { key: "discord-voice", label: "Discord voice" },
] as const;

const KNOWN_SURFACES = ["tauri", "discord", "discord-voice"] as const;
const MODES: ReadonlySet<string> = new Set(["autojoin", "on-request", "disabled"]);

/**
 * Pure: agent record → mode map. Mirrors the broker's surface-modes.ts parser
 * exactly (same three branches, including the legacy array form and the
 * absent-field default) so a control-plane popover and the broker never
 * disagree about what an agent's `channels` field means. Kept dependency-free
 * on purpose — no cross-package import — so the two copies must be updated
 * in lockstep if the semantics ever change.
 */
export function modesFrom(record: { channels?: unknown }): Record<string, SurfaceMode> {
  const channels = record.channels;
  if (channels === undefined || channels === null) {
    return { tauri: "autojoin", discord: "autojoin", "discord-voice": "disabled" };
  }
  if (Array.isArray(channels)) {
    const out: Record<string, SurfaceMode> = {};
    for (const surface of KNOWN_SURFACES) {
      out[surface] = channels.includes(surface) ? "autojoin" : "disabled";
    }
    for (const surface of channels) {
      if (typeof surface === "string" && !(surface in out)) out[surface] = "autojoin";
    }
    return out;
  }
  if (typeof channels === "object") {
    const out: Record<string, SurfaceMode> = {};
    for (const surface of KNOWN_SURFACES) out[surface] = "disabled";
    for (const [surface, mode] of Object.entries(channels as Record<string, unknown>)) {
      out[surface] = typeof mode === "string" && MODES.has(mode) ? (mode as SurfaceMode) : "disabled";
    }
    return out;
  }
  return { tauri: "disabled", discord: "disabled", "discord-voice": "disabled" };
}

/** Pure: Join now renders only for on-request agents not currently present. */
export function joinNowVisible(mode: SurfaceMode, present: boolean): boolean {
  return mode === "on-request" && !present;
}

interface StoredAgent {
  id: string;
  channels?: unknown;
  [key: string]: unknown;
}

interface AgentsResponse {
  agents?: Array<StoredAgent & { presence?: Record<string, boolean> }>;
  discord?: { configured: boolean; voiceReady: boolean };
}

export function useSurfacePolicy(agentId: string) {
  const [loading, setLoading] = useState(true);
  const [modes, setModesState] = useState<Record<string, SurfaceMode>>({});
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [discord, setDiscord] = useState({ configured: false, voiceReady: false });
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Mirrors of state that an in-flight request's continuation needs to read
  // synchronously, i.e. without waiting on a re-render. Every write goes
  // through these too, so a promise callback always sees the truth as of
  // right now — never a value captured (and now stale) at dispatch time.
  const modesRef = useRef<Record<string, SurfaceMode>>({});
  const recordRef = useRef<StoredAgent | null>(null);
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;

  const setModes = useCallback((next: Record<string, SurfaceMode>) => {
    modesRef.current = next;
    setModesState(next);
  }, []);

  // Each refresh() takes the next generation ticket; a response only applies
  // if its ticket is still the newest one issued. A slower GET for an agent
  // id we've since navigated away from (or a plain double-refresh) is
  // discarded instead of clobbering whatever the newer request already set.
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const res = (await fetch(`http://${BASE}/agents`).then((r) => r.json())) as AgentsResponse;
    if (generationRef.current !== generation) return; // superseded by a newer refresh
    const found = res.agents?.find((a) => a.id === agentId);
    if (found) {
      const { presence: foundPresence, ...stored } = found;
      recordRef.current = stored;
      setModes(modesFrom(stored));
      setPresence(foundPresence ?? {});
    }
    setDiscord(res.discord ?? { configured: false, voiceReady: false });
    setLoading(false);
  }, [agentId, setModes]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Per-surface request tickets: the same idea as generationRef, scoped to
  // one surface. A setMode's continuation only reverts/records an error if
  // no newer setMode for that exact surface (on this exact agent) has been
  // dispatched since — otherwise it's a straggler for a change the user has
  // already moved past, and applying it would clobber the newer one.
  const requestSeqRef = useRef<Record<string, number>>({});

  const setMode = useCallback(
    (surface: string, mode: SurfaceMode) => {
      const record = recordRef.current;
      if (!record) return;
      const dispatchedForAgent = agentIdRef.current;
      const seq = (requestSeqRef.current[surface] ?? 0) + 1;
      requestSeqRef.current[surface] = seq;

      const previous = modesRef.current[surface] ?? "disabled";
      const channels = { ...modesRef.current, [surface]: mode };
      setModes(channels);
      setErrors((e) => {
        const { [surface]: _dropped, ...rest } = e;
        return rest;
      });

      void fetch(`http://${BASE}/agents/${encodeURIComponent(agentId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...record, channels }),
      }).then(async (res) => {
        const stale = requestSeqRef.current[surface] !== seq || agentIdRef.current !== dispatchedForAgent;
        if (stale) return;
        if (res.ok) return;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setModes({ ...modesRef.current, [surface]: previous });
        setErrors((e) => ({ ...e, [surface]: body.error ?? `HTTP ${res.status}` }));
      });
    },
    [agentId, setModes],
  );

  const joinNow = useCallback(
    (surface: string) => {
      setErrors((e) => {
        const { [surface]: _dropped, ...rest } = e;
        return rest;
      });
      void fetch(`http://${BASE}/agents/${encodeURIComponent(agentId)}/surfaces/${encodeURIComponent(surface)}/join`, {
        method: "POST",
      }).then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setErrors((e) => ({ ...e, [surface]: body.error ?? `HTTP ${res.status}` }));
          return;
        }
        void refresh();
      });
    },
    [agentId, refresh],
  );

  return { loading, modes, presence, discord, errors, setMode, joinNow };
}
