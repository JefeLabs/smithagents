/**
 * The block that rides in the brain's system prompt beside the roster
 * (spec §6). Small, bounded, and built on a timer so a conversation never
 * waits on a fetch.
 *
 * Empty in, empty out: with nothing configured the prompt is byte-for-byte
 * what it was before this feature existed.
 */
import type { FeedItem, ReleaseItem } from "./types.ts";

const WINDOW_HOURS = 48;
/** 150 tokens at the standard ~4-chars-per-token estimate. */
const MAX_CHARS = 600;
const TAG_ORDER: Array<"tech" | "news" | "sports" | "gov"> = ["tech", "news", "sports", "gov"];

export function buildDigest(input: {
  items: FeedItem[];
  weather?: string;
  /** dependency name → agent name, so a release line can be spoken in that voice. */
  owners: Record<string, string>;
  now: string;
}): { text: string; unspokenIds: string[] } {
  const cutoff = Date.parse(input.now) - WINDOW_HOURS * 3_600_000;
  const recent = input.items
    .filter((i) => Date.parse(i.publishedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  const unspoken = recent.filter((i): i is ReleaseItem => Boolean(i.release) && !i.spokenAt);
  const lines: string[] = [];

  if (input.weather) lines.push(`TODAY · ${input.weather}`);

  // Releases first: this is the half the human asked to be told about.
  if (unspoken.length) {
    const rendered = unspoken.slice(0, 4).map((i) => {
      const owner = input.owners[i.release.name];
      return `${i.release.name} ${i.release.version}${owner ? ` [${owner}]` : ""}`;
    });
    lines.push(`releases — ${rendered.join(" · ")}`);
  }

  for (const tag of TAG_ORDER) {
    const top = recent.filter((i) => i.tag === tag && !i.release).slice(0, 2);
    if (top.length) lines.push(`${tag} — ${top.map((i) => i.title).join(" · ")}`);
  }

  // Trim from the END: weather and releases are the lines worth keeping.
  let text = lines.join("\n");
  while (text.length > MAX_CHARS && lines.length > 1) {
    lines.pop();
    text = lines.join("\n");
  }
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1)}…`;

  return { text: text ? `\n\n${text}\n` : "", unspokenIds: unspoken.slice(0, 4).map((i) => i.id) };
}
