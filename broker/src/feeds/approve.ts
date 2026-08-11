/**
 * Ticked candidates become ordinary FeedSource rows (spec §4). Everything
 * downstream — ingest, digest, cards — then treats a topic's source exactly
 * like a manifest-derived one.
 */
import { youtubeFeedUrl } from "./rss.ts";
import type { Candidate, Topic } from "./topics.ts";
import type { FeedSource } from "./types.ts";
import { githubAtomUrl } from "./versions.ts";

/** owner/repo out of a GitHub URL — the key a baseline is stored under. */
export function repoKey(url: string): string | null {
  const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:$|[/#?])/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function sourceFor(topic: Topic, c: Candidate): FeedSource | null {
  const base = {
    id: `topic:${topic.id}:${c.kind}:${c.url}`,
    label: c.label,
    origin: "derived" as const,
    reason: `from ${topic.name} discovery`,
    enabled: true,
    topicId: topic.id,
  };

  if (c.kind === "github") {
    const atom = githubAtomUrl(c.url);
    if (!atom) return null;
    // A release source, so version/bump/security run from the Atom entries —
    // which is what gives a topic the same cards a dependency gets.
    return { ...base, kind: "rss", locator: atom, tag: "release" };
  }
  if (c.kind === "youtube") {
    const feed = youtubeFeedUrl(c.url);
    if (!feed) return null;
    return { ...base, kind: "rss", locator: feed, tag: "tech" };
  }
  if (c.kind === "x") {
    const handle = /x\.com\/@?([A-Za-z0-9_]+)/.exec(c.url)?.[1];
    if (!handle) return null;
    return { ...base, kind: "x", locator: handle, tag: "news" };
  }
  return { ...base, kind: "rss", locator: c.url, tag: "tech" };
}

export function approve(
  topic: Topic,
  keepUrls: string[],
  baseline?: string,
): { topic: Topic; sources: FeedSource[]; baselines: Record<string, string> } {
  const keep = new Set(keepUrls);
  const kept = topic.candidates.filter((c) => keep.has(c.url));
  const sources = kept.flatMap((c) => {
    const s = sourceFor(topic, c);
    return s ? [s] : [];
  });

  const baselines: Record<string, string> = {};
  for (const c of kept) {
    if (c.kind !== "github") continue;
    const key = repoKey(c.url);
    // Without a baseline every historical release would be carded at once —
    // the same failure the manifest-seeded baselines already prevent.
    if (key) baselines[key] = baseline ?? "0.0.0";
  }

  const declined = [
    ...new Set([...topic.declined, ...topic.candidates.filter((c) => !keep.has(c.url)).map((c) => c.url)]),
  ];

  if (!sources.length) {
    return { topic: { ...topic, declined, status: "pending", note: "nothing approved yet" }, sources, baselines };
  }
  return { topic: { ...topic, candidates: [], declined, status: "active", note: undefined }, sources, baselines };
}
