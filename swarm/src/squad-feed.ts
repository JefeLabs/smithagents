import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One line of the feed: who, when, and whatever they said. */
export interface SquadUpdate {
  agentName: string;
  timestamp: string;
  /** Free-form: a note, or a full AgentOutputContract. The feed orders and
   *  attributes; it deliberately does not impose a schema on the payload. */
  update: unknown;
}

/** The squad's feed, beside the instance it describes. */
export function feedPath(instanceDir: string): string {
  return join(instanceDir, ".runtime", "updates.jsonl");
}

/**
 * Append one update. `JSON.stringify` escapes newlines, so a multi-line payload
 * stays a single record — the property the whole format depends on.
 *
 * Append-only and never rewritten: a reader can consume the file while members
 * are still writing to it, which is what makes polling safe.
 */
export async function appendUpdate(
  instanceDir: string,
  agentName: string,
  update: unknown,
  now: () => Date = () => new Date(),
): Promise<SquadUpdate> {
  const entry: SquadUpdate = { agentName, timestamp: now().toISOString(), update };
  const file = feedPath(instanceDir);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

/**
 * The feed in append order, optionally only what followed `since` (exclusive).
 *
 * A malformed line is SKIPPED rather than fatal: this file is appended to by
 * several processes at once, so a torn final line is an expected transient —
 * failing the whole read would make the feed unusable exactly when it is busiest.
 */
export async function readFeed(instanceDir: string, opts: { since?: string } = {}): Promise<SquadUpdate[]> {
  let raw: string;
  try {
    raw = await readFile(feedPath(instanceDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: SquadUpdate[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: SquadUpdate;
    try {
      parsed = JSON.parse(line) as SquadUpdate;
    } catch {
      continue; // torn or hand-edited line — keep the rest
    }
    if (opts.since && parsed.timestamp <= opts.since) continue;
    out.push(parsed);
  }
  return out;
}
