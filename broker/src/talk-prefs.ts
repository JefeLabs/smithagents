// How I talk — the wizard's conversational preferences, cached per turn.
//
// The brain needs these on every utterance, and they live behind an HTTP call.
// Reading them per turn would put a round-trip in front of every reply; reading
// them once at boot would leave a wizard answer stuck until restart. So: a short
// TTL, plus an explicit invalidate() the wizard's own write path calls, which
// makes a change visible on the very next turn rather than up to a TTL later.

/** Absent fields mean "never answered", which must behave exactly as before. */
export interface TalkPrefs {
  smallTalk?: boolean;
  worldAware?: boolean;
}

export interface TalkPrefsReader {
  get(): Promise<TalkPrefs>;
  /** Drop the cache so the next get() re-reads. Called when the wizard writes. */
  invalidate(): void;
}

const DEFAULT_TTL_MS = 15_000;

export function createTalkPrefsReader(
  fetch: () => Promise<TalkPrefs | undefined>,
  opts: { ttlMs?: number; now?: () => number } = {},
): TalkPrefsReader {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;

  let cached: TalkPrefs | null = null;
  let fetchedAt = 0;
  let inflight: Promise<TalkPrefs> | null = null;

  return {
    get(): Promise<TalkPrefs> {
      if (cached !== null && now() - fetchedAt < ttlMs) return Promise.resolve(cached);
      // Set before any await so concurrent callers in the same tick join this
      // read instead of starting their own.
      if (inflight) return inflight;
      inflight = fetch()
        .then((value) => {
          // An absent setup block is not an error — it is everyone who never
          // answered the wizard, and they must behave exactly as before.
          cached = value ?? {};
          fetchedAt = now();
          return cached;
        })
        .catch(() => {
          // A failed read is not an answer. Keep the last known one and leave
          // fetchedAt alone, so the next turn retries rather than waiting out
          // another window on a value we never received.
          return cached ?? {};
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },

    invalidate(): void {
      cached = null;
    },
  };
}
