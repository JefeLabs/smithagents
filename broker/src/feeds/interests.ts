/**
 * What the human keeps bringing up, and who on the crew owns a given release.
 *
 * Promotion is deliberately hard and reversal is easy (spec §4.3): three
 * mentions across two sessions inside 14 days, and the caller must ALSO
 * resolve the name in a package registry before it becomes a source — that
 * resolution is what drops conversational noise.
 */
import type { Dependency } from "./manifests.ts";
import type { FeedState } from "./types.ts";

const PROMOTE_MENTIONS = 3;
const PROMOTE_SESSIONS = 2;
const PROMOTE_WINDOW_DAYS = 14;
const EXPIRE_DAYS = 30;

/** Words that look like proper nouns in ordinary prose. Not exhaustive; the registry check is the real filter. */
const STOPWORDS = new Set([
  "the",
  "this",
  "that",
  "thing",
  "today",
  "tomorrow",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "ok",
  "okay",
  "yes",
  "no",
  "hola",
  "gracias",
  "bueno",
  "claro",
  "ahora",
  "manana",
  "hoy",
  "and",
  "but",
  "for",
  "you",
  "we",
  "it",
]);

const PACKAGE_SHAPED = /^@?[a-z0-9][a-z0-9._-]{2,}$/;
const PROPER_NOUN = /^[A-Z][A-Za-z0-9]{2,}$/;

export function extractCandidates(text: string, exclude: string[]): string[] {
  const banned = new Set(exclude.map((e) => e.toLowerCase()));
  const seen = new Set<string>();
  for (const raw of text.split(/[^\w@./-]+/)) {
    // Trim edge punctuation before anything else: "jefelabs." must hit the ban
    // list, and "works." must not read as a package name.
    const token = raw.replace(/^[.\-_]+|[.\-_]+$/g, "");
    if (!token || banned.has(token.toLowerCase()) || STOPWORDS.has(token.toLowerCase())) continue;
    // A package name must contain a separator; a bare lowercase word is prose.
    const isPackage = PACKAGE_SHAPED.test(token) && /[-._@]/.test(token);
    if (isPackage || PROPER_NOUN.test(token)) seen.add(token);
  }
  return [...seen];
}

export function recordMentions(
  state: Pick<FeedState, "candidates">,
  names: string[],
  sessionId: string,
  at: string,
): FeedState["candidates"] {
  const next = { ...state.candidates };
  for (const name of names) {
    const prior = next[name];
    next[name] = prior
      ? {
          mentions: prior.mentions + 1,
          sessions: prior.sessions.includes(sessionId) ? prior.sessions : [...prior.sessions, sessionId],
          firstSeen: prior.firstSeen,
          lastSeen: at,
        }
      : { mentions: 1, sessions: [sessionId], firstSeen: at, lastSeen: at };
  }
  return next;
}

export function promotable(candidates: FeedState["candidates"], at: string): string[] {
  const now = Date.parse(at);
  return Object.entries(candidates)
    .filter(([, c]) => {
      const withinWindow = now - Date.parse(c.firstSeen) <= PROMOTE_WINDOW_DAYS * 86_400_000;
      return withinWindow && c.mentions >= PROMOTE_MENTIONS && c.sessions.length >= PROMOTE_SESSIONS;
    })
    .map(([name]) => name);
}

export function expired(candidates: FeedState["candidates"], at: string): string[] {
  const now = Date.parse(at);
  return Object.entries(candidates)
    .filter(([, c]) => now - Date.parse(c.lastSeen) > EXPIRE_DAYS * 86_400_000)
    .map(([name]) => name);
}

/**
 * Who speaks a release line (spec §4.2). Ordered — first match wins, so
 * attribution is deterministic. A miss is null: Anderson delivers it himself
 * rather than a speaker being invented.
 */
const OWNERS: Array<{ role: string; match: (d: Dependency) => boolean }> = [
  { role: "Mobile Engineer", match: (d) => d.eco === "cargo" || /^(react-native|expo|capacitor)/.test(d.name) },
  {
    role: "Frontend Engineer",
    match: (d) => d.eco === "npm" && /^(react|vue|svelte|vite|next|tailwind|@heroui)/.test(d.name),
  },
  { role: "Backend Engineer", match: (d) => d.eco === "maven" || /^(express|fastify|nest)/.test(d.name) },
  { role: "DevOps / Platform", match: (d) => /^(docker|terraform|kubernetes)/.test(d.name) || /-cli$/.test(d.name) },
  { role: "Data / ML Engineer", match: (d) => /^(pandas|numpy|torch|langchain|@anthropic-ai)/.test(d.name) },
];

export function ownerRole(dep: Dependency, security: boolean): string | null {
  // Security outranks the table: a CVE is the Security Engineer's business
  // whatever ecosystem it arrived from (spec §4.2).
  if (security) return "Security Engineer";
  return OWNERS.find((o) => o.match(dep))?.role ?? null;
}
