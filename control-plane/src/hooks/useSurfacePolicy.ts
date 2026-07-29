import { useCallback, useEffect, useState } from "react";

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
  const [record, setRecord] = useState<StoredAgent | null>(null);
  const [modes, setModes] = useState<Record<string, SurfaceMode>>({});
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [discord, setDiscord] = useState({ configured: false, voiceReady: false });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const res = await fetch(`http://${BASE}/agents`).then((r) => r.json() as Promise<AgentsResponse>);
    const found = res.agents?.find((a) => a.id === agentId);
    if (found) {
      const { presence: foundPresence, ...stored } = found;
      setRecord(stored);
      setModes(modesFrom(stored));
      setPresence(foundPresence ?? {});
    }
    setDiscord(res.discord ?? { configured: false, voiceReady: false });
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  const setMode = useCallback(
    (surface: string, mode: SurfaceMode) => {
      if (!record) return;
      const previous = modes[surface] ?? "disabled";
      const channels = { ...modes, [surface]: mode };
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
        if (res.ok) return;
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setModes((m) => ({ ...m, [surface]: previous }));
        setErrors((e) => ({ ...e, [surface]: body.error ?? `HTTP ${res.status}` }));
      });
    },
    [agentId, record, modes],
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
