/**
 * When each source is next due, and what a failure does (spec §9.2, §10).
 *
 * Pure scheduling decisions — the actual fetching lives in main.ts's wiring,
 * so this file can be tested against a clock with no network at all.
 */
import type { FeedSource, FeedState } from "./types.ts";

export const CADENCE_MS: Record<FeedSource["kind"], number> = {
  rss: 20 * 60_000,
  weather: 30 * 60_000,
  x: 30 * 60_000,
  registry: 60 * 60_000,
};

/** Five consecutive failures disables a source: silent decay is the failure nobody notices. */
const MAX_FAILURES = 5;

export function isDisabled(state: FeedState, sourceId: string): boolean {
  return (state.sources[sourceId]?.consecutiveFailures ?? 0) >= MAX_FAILURES;
}

export function dueSources(sources: FeedSource[], state: FeedState, now: number): FeedSource[] {
  return sources.filter((source) => {
    if (!source.enabled || source.dismissed || isDisabled(state, source.id)) return false;
    const last = state.sources[source.id]?.lastFetchedAt;
    if (!last) return true;
    // ±10% jitter so a restart does not fire every adapter at the same instant.
    const jitter = CADENCE_MS[source.kind] * 0.1;
    return now - Date.parse(last) >= CADENCE_MS[source.kind] - jitter;
  });
}

export function recordOutcome(
  state: FeedState,
  sourceId: string,
  outcome: { ok: boolean; at: string; error?: string },
): FeedState {
  const prior = state.sources[sourceId] ?? { consecutiveFailures: 0 };
  return {
    ...state,
    sources: {
      ...state.sources,
      [sourceId]: {
        lastFetchedAt: outcome.at,
        consecutiveFailures: outcome.ok ? 0 : prior.consecutiveFailures + 1,
        lastError: outcome.ok ? undefined : outcome.error,
      },
    },
  };
}
