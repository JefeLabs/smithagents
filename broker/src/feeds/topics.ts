/**
 * A topic is the unit you configure; sources hang off it (spec §2). It sits
 * ABOVE the feed pipe — approving a topic writes ordinary FeedSource rows, and
 * everything downstream (ingest, digest, check_feeds, cards) is untouched.
 */
import type { FeedIo } from './store.ts';

export interface Candidate {
  kind: 'site' | 'github' | 'youtube' | 'x';
  url: string;
  label: string;
  /** Why the agent believes this is the right source — shown in the review list. */
  evidence: string;
  /** ISO date of the newest thing found there; absent when unknown. */
  lastActivity?: string;
}

export interface Topic {
  id: string;
  name: string;
  status: 'discovering' | 'pending' | 'active';
  /** Why it is in this status when something went wrong. Every non-active status has one. */
  note?: string;
  candidates: Candidate[];
  /** URLs you unticked. Re-discovery must never offer them again. */
  declined: string[];
  lastDiscoveredAt?: string;
}

/** A stable id from a human name. Never empty, so a topic always has a key. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'topic';
}

export class TopicStore {
  constructor(private readonly io: FeedIo) {}

  all(): Topic[] {
    try {
      const raw = this.io.read('topics.json');
      return raw ? (JSON.parse(raw) as Topic[]) : [];
    } catch {
      return []; // a bad write must not brick the broker
    }
  }

  get(id: string): Topic | null {
    return this.all().find((t) => t.id === id) ?? null;
  }

  put(topic: Topic): void {
    const rest = this.all().filter((t) => t.id !== topic.id);
    this.io.write('topics.json', JSON.stringify([...rest, topic], null, 2));
  }

  remove(id: string): void {
    this.io.write('topics.json', JSON.stringify(this.all().filter((t) => t.id !== id), null, 2));
  }
}
