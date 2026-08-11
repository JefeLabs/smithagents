/**
 * The one adapter that can generate a bill, so the one adapter with a hard
 * stop (spec §9.3).
 *
 * Every outcome is a value, never an exception: no key, over budget, or rate
 * limited all come back as `skipped` with a reason the Settings screen shows.
 */
import type { FeedItem, FeedSource, FeedState } from "./types.ts";

export function monthKey(at: string): string {
  return at.slice(0, 7); // YYYY-MM — a calendar month, matching how the bill arrives
}

export function parsePosts(source: FeedSource, body: unknown): FeedItem[] {
  const data = (body as { data?: Array<{ id?: string; text?: string; created_at?: string }> })?.data ?? [];
  return data.flatMap((post) => {
    if (!post.id || !post.text) return [];
    return [
      {
        id: `${source.id}-${post.id}`,
        sourceId: source.id,
        tag: source.tag,
        title: post.text.slice(0, 200),
        url: `https://x.com/${source.locator}/status/${post.id}`,
        publishedAt: post.created_at ?? new Date().toISOString(),
        summary: post.text.slice(0, 400),
      },
    ];
  });
}

export async function fetchX(
  deps: { fetchJson(url: string, token: string): Promise<unknown>; token: string | null; cap: number; now(): string },
  source: FeedSource,
  state: FeedState,
): Promise<{ items: FeedItem[]; usage: number; skipped?: string }> {
  const key = monthKey(deps.now());
  const used = state.xUsage[key] ?? 0;

  if (!deps.token) return { items: [], usage: used, skipped: "no API key configured" };
  if (used >= deps.cap) return { items: [], usage: used, skipped: `monthly budget reached (${used}/${deps.cap})` };

  try {
    const url =
      `https://api.x.com/2/tweets/search/recent?query=from:${encodeURIComponent(source.locator)}` +
      `&max_results=10&tweet.fields=created_at`;
    const body = await deps.fetchJson(url, deps.token);
    return { items: parsePosts(source, body), usage: used + 1 };
  } catch (err) {
    // A rate limit costs nothing and must not count against the budget.
    return { items: [], usage: used, skipped: String((err as Error).message ?? err) };
  }
}
