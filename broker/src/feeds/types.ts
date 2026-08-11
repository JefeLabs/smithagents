/** Shared feed shapes. No logic lives here — see spec §3. */

export type FeedTag = 'news' | 'tech' | 'sports' | 'gov' | 'release' | 'weather';

export interface FeedSource {
  id: string;
  label: string;
  kind: 'rss' | 'weather' | 'x' | 'registry';
  /** RSS/Atom URL, X handle, registry coordinate, or "lat,lon". */
  locator: string;
  tag: FeedTag;
  /** Manual sources are the human's; derived ones are regenerated and carry `reason`. */
  origin: 'manual' | 'derived';
  /** Why this exists, shown in Settings: "from build.gradle", "you've mentioned RunPod 6×". */
  reason?: string;
  enabled: boolean;
  /** Set when a derived source is dismissed — regeneration must never resurrect it. */
  dismissed?: boolean;
  /** Workspace whose repo declared this (derived release sources only) — decides the card's board. */
  workspace?: string;
}

export interface FeedItem {
  id: string;
  sourceId: string;
  tag: FeedTag;
  title: string;
  url?: string;
  publishedAt: string;
  /** Trimmed to 400 chars at ingest: the store is not an archive. */
  summary: string;
  release?: { name: string; version: string; bump: 'major' | 'minor' | 'patch'; security: boolean };
  /** Stamped when the crew mentions it — the only thing that stops a repeat (spec §5). */
  spokenAt?: string;
  /** Stamped when a card exists for it (spec §5b). */
  cardedAt?: string;
}

export interface FeedState {
  /** sourceId → fetch health. */
  sources: Record<string, { lastFetchedAt?: string; consecutiveFailures: number; lastError?: string }>;
  /** The current reading; not an item, because a temperature is not a document. */
  weather?: { text: string; at: string };
  /** X spend guard: calendar month key → requests made. */
  xUsage: Record<string, number>;
  /** Transcript candidates: name → { mentions, sessions, firstSeen, lastSeen }. */
  candidates: Record<string, { mentions: number; sessions: string[]; firstSeen: string; lastSeen: string }>;
  /** dependency name → last version we have already reacted to. */
  seenVersions: Record<string, string>;
}
