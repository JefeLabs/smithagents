/**
 * A fresh bundle, diffed against what was approved (spec §6).
 *
 * Returns CANDIDATES, never sources: re-discovery must never activate anything
 * by itself. Flagging is advisory — a flagged source keeps polling.
 */
import type { Candidate, Topic } from './topics.ts';
import type { FeedSource } from './types.ts';

/** Six months: long enough that a quiet-but-alive blog is not mistaken for a dead one. */
const QUIET_DAYS = 180;

export function diffBundle(input: {
  topic: Topic;
  fresh: Candidate[];
  approved: FeedSource[];
  now: string;
}): { additions: Candidate[]; flagged: string[] } {
  const declined = new Set(input.topic.declined);
  const approvedLocators = new Set(input.approved.map((s) => s.locator));

  const additions = input.fresh.filter(
    (c) => !declined.has(c.url) && !approvedLocators.has(c.url) && !input.topic.candidates.some((x) => x.url === c.url),
  );

  const cutoff = Date.parse(input.now) - QUIET_DAYS * 86_400_000;
  const freshByUrl = new Map(input.fresh.map((c) => [c.url, c]));
  const flagged = input.approved
    .filter((s) => {
      const match = freshByUrl.get(s.locator);
      if (!match) return true; // gone from the bundle entirely
      const last = match.lastActivity ? Date.parse(match.lastActivity) : Number.NaN;
      return !Number.isNaN(last) && last < cutoff;
    })
    .map((s) => s.id);

  return { additions, flagged };
}
