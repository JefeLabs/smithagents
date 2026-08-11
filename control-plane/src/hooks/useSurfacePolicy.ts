import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { BROKER_BASE, brokerFetch } from "../api/origin";
import { useAgentRecords } from "../queries/http";
import { qk } from "../queries/keys";

export type SurfaceMode = "autojoin" | "on-request" | "disabled";

export const SURFACES = [
  { key: "discord", label: "Discord text" },
  { key: "discord-voice", label: "Discord voice" },
] as const;

const KNOWN_SURFACES = ["discord", "discord-voice"] as const;
const MODES: ReadonlySet<string> = new Set(["autojoin", "on-request", "disabled"]);
/** Retired surface keys: skipped in every branch, mirroring the broker parser. */
const RETIRED_SURFACES: ReadonlySet<string> = new Set(["tauri"]);

/**
 * Pure: agent record → mode map. Mirrors the broker's surface-modes.ts parser
 * exactly (same three branches, including the legacy array form and the
 * absent-field default) so a control-plane popover and the broker never
 * disagree about what an agent's `channels` field means. Kept dependency-free
 * on purpose — no cross-package import — so the two copies must be updated
 * in lockstep if the semantics ever change. The tauri app is not a surface — a
 * `tauri` key is retired and parsed away.
 */
export function modesFrom(record: { channels?: unknown }): Record<string, SurfaceMode> {
  const channels = record.channels;
  if (channels === undefined || channels === null) {
    return { discord: "autojoin", "discord-voice": "disabled" };
  }
  if (Array.isArray(channels)) {
    const out: Record<string, SurfaceMode> = {};
    for (const surface of KNOWN_SURFACES) {
      out[surface] = channels.includes(surface) ? "autojoin" : "disabled";
    }
    for (const surface of channels) {
      if (typeof surface === "string" && !RETIRED_SURFACES.has(surface) && !(surface in out)) {
        out[surface] = "autojoin";
      }
    }
    return out;
  }
  if (typeof channels === "object") {
    const out: Record<string, SurfaceMode> = {};
    for (const surface of KNOWN_SURFACES) out[surface] = "disabled";
    for (const [surface, mode] of Object.entries(channels as Record<string, unknown>)) {
      if (RETIRED_SURFACES.has(surface)) continue;
      out[surface] = typeof mode === "string" && MODES.has(mode) ? (mode as SurfaceMode) : "disabled";
    }
    return out;
  }
  return { discord: "disabled", "discord-voice": "disabled" };
}

/** Pure: Join now renders only for on-request agents not currently present. */
export function joinNowVisible(mode: SurfaceMode, present: boolean): boolean {
  return mode === "on-request" && !present;
}

interface StoredAgent {
  id?: string;
  channels?: unknown;
  [key: string]: unknown;
}

const NO_DISCORD = { configured: false, voiceReady: false };
const NO_PRESENCE: Record<string, boolean> = {};

export function useSurfacePolicy(agentId: string) {
  // One shared `GET /agents` cache entry, not a per-hook fetch. That is what
  // retired the request-generation ticket this hook used to carry: switching
  // `agentId` now re-selects from data already in hand instead of dispatching
  // a request that could land after the one for the agent we moved to.
  const qc = useQueryClient();
  const { data, isPending } = useAgentRecords();
  const record = data?.agents.find((a) => a.id === agentId);
  const discord = data?.discord ?? NO_DISCORD;
  const presence = record?.presence ?? NO_PRESENCE;

  const [modes, setModesState] = useState<Record<string, SurfaceMode>>({});
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

  // `modes` stays local state rather than a pure derivation because setMode
  // writes to it optimistically and rolls back on failure. Seeding it from the
  // query keeps the same "an unknown agent leaves the previous one's modes
  // showing" behaviour the fetch version had — `record` is a stable reference
  // out of the cached array, so this runs on data change or id change only.
  useEffect(() => {
    if (!record) return;
    const { presence: _presence, ...stored } = record;
    recordRef.current = stored;
    setModes(modesFrom(stored));
  }, [record, setModes]);

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

      void brokerFetch(`/agents/${encodeURIComponent(agentId)}`, BROKER_BASE, {
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
      void brokerFetch(
        `/agents/${encodeURIComponent(agentId)}/surfaces/${encodeURIComponent(surface)}/join`,
        BROKER_BASE,
        {
          method: "POST",
        },
      ).then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setErrors((e) => ({ ...e, [surface]: body.error ?? `HTTP ${res.status}` }));
          return;
        }
        // A join changes `presence`, which only the records carry — invalidating
        // refreshes every consumer of that entry, not just this popover.
        void qc.invalidateQueries({ queryKey: qk.agentRecords });
      });
    },
    [agentId, qc],
  );

  return { loading: isPending, modes, presence, discord, errors, setMode, joinNow };
}
