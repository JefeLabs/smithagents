/**
 * RSS 2.0 and Atom, the two shapes that cover news, blogs, government notices,
 * YouTube channels and GitHub releases (spec §2).
 *
 * Regex, not a DOM: the broker has no XML parser and this reads two known
 * element shapes from feeds we chose. Anything unparseable yields fewer items,
 * never an exception — ingest treats zero items as a failure (ingest.ts).
 */
import type { FeedItem, FeedSource } from "./types.ts";

const SUMMARY_MAX = 400;

function decode(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Decode entities FIRST, then strip tags — otherwise escaped markup survives. */
function plain(text: string): string {
  return decode(text)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SUMMARY_MAX);
}

function tagText(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? decode(m[1]!).trim() : undefined;
}

/** Stable per source+guid so a re-fetch is a no-op in the store. */
function idFor(sourceId: string, guid: string): string {
  let hash = 0;
  for (const ch of `${sourceId}|${guid}`) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `${sourceId}-${(hash >>> 0).toString(36)}`;
}

export function parseFeed(source: FeedSource, xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]!);
  return blocks.flatMap((block): FeedItem[] => {
    const title = tagText(block, "title");
    if (!title) return [];
    const link = tagText(block, "link") ?? /<link[^>]*href="([^"]+)"/i.exec(block)?.[1];
    const guid = tagText(block, "guid") ?? tagText(block, "id") ?? link ?? title;
    const raw = tagText(block, "pubDate") ?? tagText(block, "updated") ?? tagText(block, "published");
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    return [
      {
        id: idFor(source.id, guid),
        sourceId: source.id,
        tag: source.tag,
        title: plain(title),
        url: link,
        // No date is not a reason to drop an item — treat it as arriving now.
        publishedAt: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
        summary: plain(tagText(block, "description") ?? tagText(block, "content") ?? tagText(block, "summary") ?? ""),
      },
    ];
  });
}

/** Every YouTube channel exposes an RSS feed — no Data API key required (spec §2). */
export function youtubeFeedUrl(url: string): string | null {
  const m = /youtube\.com\/channel\/([A-Za-z0-9_-]+)/.exec(url);
  return m ? `https://www.youtube.com/feeds/videos.xml?channel_id=${m[1]}` : null;
}
