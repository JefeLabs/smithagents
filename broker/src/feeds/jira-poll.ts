// Jira context sources, map transform (spec 2026-08-13 queue-sources): the
// swarm runs the JQL (it holds the credentials — POST /atlassian/search);
// this module only shapes the wire result into FeedItems. Item id reuses the
// addItems dedup: a re-poll of known issues yields no fresh items, no cards.
import type { FeedItem } from "./types.ts";

export function jiraItemsFrom(
  issues: Array<{ key: string; summary: string; url: string }>,
  sourceId: string,
  publishedAt: string,
): FeedItem[] {
  return issues.map((i) => ({
    id: `${sourceId}-${i.key}`,
    sourceId,
    tag: "tech",
    title: `[${i.key}] ${i.summary}`,
    url: i.url,
    publishedAt,
    summary: i.summary,
  }));
}
