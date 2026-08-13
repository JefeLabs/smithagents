/** Shared feed shapes. No logic lives here — see spec §3. */

export type FeedTag = "news" | "tech" | "sports" | "gov" | "release" | "weather";

export interface FeedSource {
  id: string;
  label: string;
  kind: "rss" | "weather" | "x" | "registry" | "jira" | "http";
  /** RSS/Atom URL, X handle, registry coordinate, or "lat,lon". */
  locator: string;
  tag: FeedTag;
  /** Manual sources are the human's; derived ones are regenerated and carry `reason`. */
  origin: "manual" | "derived";
  /** Why this exists, shown in Settings: "from build.gradle", "you've mentioned RunPod 6×". */
  reason?: string;
  enabled: boolean;
  /** Set when a derived source is dismissed — regeneration must never resurrect it. */
  dismissed?: boolean;
  /** Workspace whose repo declared this (derived release sources only) — decides the card's board. */
  workspace?: string;
  /** The topic this source belongs to. Absent on manifest-derived sources. */
  topicId?: string;
  /** Context-source polling (spec 2026-08-13 queue-sources): the workspace-record
      source this row mirrors. Absent on manual/manifest/topic rows. */
  contextId?: string;
  /** Per-source cadence override; absent = the kind's CADENCE_MS default. */
  cadence?: "hourly" | "6h" | "nightly";
  connectorId?: string;
  query?: string;
  analyzePrompt?: string;
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
  release?: { name: string; version: string; bump: "major" | "minor" | "patch"; security: boolean };
  /** Stamped when the crew mentions it — the only thing that stops a repeat (spec §5). */
  spokenAt?: string;
  /** Stamped when a card exists for it (spec §5b). */
  cardedAt?: string;
}

/** A feed item known to carry a release — what survives a `release` guard. */
export type ReleaseItem = FeedItem & { release: NonNullable<FeedItem["release"]> };

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
  /** In-flight discovery dispatches: taskId → topicId. SwarmEvent carries no metadata, so this IS the correlation. */
  pendingDiscoveries: Record<string, string>;
}
