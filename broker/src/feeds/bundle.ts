/**
 * The bundle a discovery agent writes to `.smith/topics/<id>.json` (spec §3.1).
 *
 * It is written by a CLI agent reading the open web, so every field is
 * untrusted: unknown kinds and unsafe URLs are DROPPED, and what was dropped
 * is reported in the note rather than swallowed.
 */
import type { Candidate } from "./topics.ts";
import { urlRejectionReason } from "./url-guard.ts";

const KINDS = new Set<Candidate["kind"]>(["site", "github", "youtube", "x"]);

export function parseBundle(raw: string | null): { candidates: Candidate[]; note?: string } {
  if (raw === null) return { candidates: [], note: "no bundle file was written" };

  let body: { candidates?: unknown };
  try {
    body = JSON.parse(raw) as { candidates?: unknown };
  } catch {
    return { candidates: [], note: "the bundle file could not be read as JSON" };
  }

  const rejected: string[] = [];
  const candidates = (Array.isArray(body.candidates) ? body.candidates : []).flatMap((entry): Candidate[] => {
    const c = entry as Partial<Candidate>;
    if (!c.kind || !KINDS.has(c.kind) || typeof c.url !== "string" || !c.url) return [];
    const refusal = urlRejectionReason(c.url);
    if (refusal) {
      rejected.push(`${c.url} (${refusal})`);
      return [];
    }
    return [
      {
        kind: c.kind,
        url: c.url,
        label: typeof c.label === "string" && c.label ? c.label : c.url,
        // Never undefined: the review list renders this directly.
        evidence: typeof c.evidence === "string" ? c.evidence : "",
        lastActivity: typeof c.lastActivity === "string" ? c.lastActivity : undefined,
      },
    ];
  });

  if (!candidates.length && !rejected.length) return { candidates, note: "the agent found no sources" };
  return { candidates, note: rejected.length ? `dropped unsafe: ${rejected.join(", ")}` : undefined };
}
