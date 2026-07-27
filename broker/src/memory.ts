/**
 * Crew memory — what the team knows that outlives a single conversation.
 *
 * Sessions already hold a transcript and the brain's history; both are
 * *episodic* and scoped to one conversation. Memory is the other half:
 * durable facts, preferences and decisions that should surface in every
 * later turn — "Edwin prefers draft PRs", "this workspace builds off main",
 * "Aurelio owns the composer".
 *
 * Deliberately dependency-free. Recall is lexical (term overlap, IDF-weighted,
 * recency-tilted) rather than vector similarity: the corpus is small, human
 * text, and a few hundred entries per workspace. That keeps the whole thing
 * inspectable JSON on disk with no native modules and no daemon — and leaves
 * the door open for a similarity backend behind this same port if the corpus
 * ever outgrows it.
 */
export type MemoryScopeKind = 'global' | 'workspace' | 'session' | 'agent';

export interface MemoryScope {
  workspace?: string;
  session?: string;
  /** Agent id — memory *about* a teammate, not written by them. */
  agent?: string;
}

export interface MemoryEntry {
  id: string;
  /** Short handle so a later write can supersede this one. */
  key: string;
  text: string;
  scope: MemoryScope;
  createdAt: string;
  updatedAt: string;
  /** Who asked for it: the human's turn, or the crew noticing something. */
  source: 'human' | 'crew';
}

export interface RecallQuery {
  text: string;
  scope: MemoryScope;
  limit?: number;
}

export interface MemoryPort {
  remember(input: { key: string; text: string; scope: MemoryScope; source?: 'human' | 'crew' }): MemoryEntry;
  recall(query: RecallQuery): MemoryEntry[];
  forget(key: string, scope: MemoryScope): boolean;
  all(scope?: MemoryScope): MemoryEntry[];
}

export interface MemoryStoreFile {
  load(): MemoryEntry[];
  save(entries: MemoryEntry[]): void;
}

/** Words that carry no signal in a corpus this small. */
const STOPWORDS = new Set(
  ('a an and are as at be but by for from has have how i if in is it its of on or that the their then there these this to was what when where which who will with you your' +
    ' quiero para pero como este esta los las del una uno por con que')
    .split(' '),
);

const MAX_ENTRIES = 500;

/**
 * Crude suffix stripping so morphology does not defeat recall: a memory about
 * "branches" must answer a question about "branch". Full stemming would be
 * overkill (and wrong across the Spanish the crew mixes in) — this trims the
 * handful of English endings that actually cost us matches.
 */
function stem(token: string): string {
  for (const suffix of ['ing', 'ies', 'es', 'ed', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      const base = token.slice(0, -suffix.length);
      return suffix === 'ies' ? `${base}y` : base;
    }
  }
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // fold accents so "sesión" matches "sesion"
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map(stem);
}

export class LocalMemory implements MemoryPort {
  private entries: MemoryEntry[];
  private seq = 0;

  constructor(
    private readonly store: MemoryStoreFile,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.entries = store.load();
    this.seq = this.entries.length;
  }

  remember(input: { key: string; text: string; scope: MemoryScope; source?: 'human' | 'crew' }): MemoryEntry {
    const key = input.key.trim().toLowerCase();
    const at = this.now();
    // Same key in the same scope is an UPDATE, not a duplicate — otherwise a
    // corrected preference would compete with the stale one at recall time.
    const existing = this.entries.find((e) => e.key === key && sameScope(e.scope, input.scope));
    if (existing) {
      existing.text = input.text.trim();
      existing.updatedAt = at;
      existing.source = input.source ?? existing.source;
      this.persist();
      return existing;
    }
    this.seq += 1;
    const entry: MemoryEntry = {
      id: `m${this.seq}`,
      key,
      text: input.text.trim(),
      scope: { ...input.scope },
      createdAt: at,
      updatedAt: at,
      source: input.source ?? 'human',
    };
    this.entries.push(entry);
    // Oldest-first eviction keeps the file bounded without a background job.
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.persist();
    return entry;
  }

  /**
   * Rank by term overlap (rare terms weighted higher), then nudge by scope
   * specificity and recency. Entries whose scope excludes the caller are
   * never returned — a session's private note must not leak into another.
   */
  recall(query: RecallQuery): MemoryEntry[] {
    const candidates = this.entries.filter((e) => visibleIn(e.scope, query.scope));
    if (candidates.length === 0) return [];

    const queryTerms = new Set(tokenize(query.text));
    const docFreq = new Map<string, number>();
    for (const entry of candidates) {
      for (const term of new Set(tokenize(`${entry.key} ${entry.text}`))) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
    }

    const scored = candidates.map((entry) => {
      const terms = new Set(tokenize(`${entry.key} ${entry.text}`));
      let overlap = 0;
      for (const term of terms) {
        if (!queryTerms.has(term)) continue;
        // Rare term = strong signal; a term in every entry says nothing.
        overlap += Math.log(1 + candidates.length / (docFreq.get(term) ?? 1));
      }
      const specificity = (entry.scope.session ? 2 : 0) + (entry.scope.agent ? 1 : 0) + (entry.scope.workspace ? 1 : 0);
      const ageDays = (Date.now() - Date.parse(entry.updatedAt)) / 86_400_000;
      const recency = 1 / (1 + Math.max(0, ageDays) / 30); // half-ish life of a month
      // Specificity and recency only BREAK TIES among relevant entries; they
      // never make an unrelated memory relevant, or every recall would drag
      // in whatever was written most recently.
      return { entry, score: overlap === 0 ? 0 : overlap + specificity * 0.15 + recency * 0.5 };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.limit ?? 5)
      .map((s) => s.entry);
  }

  forget(key: string, scope: MemoryScope): boolean {
    const target = key.trim().toLowerCase();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.key === target && sameScope(e.scope, scope)));
    if (this.entries.length === before) return false;
    this.persist();
    return true;
  }

  all(scope?: MemoryScope): MemoryEntry[] {
    return scope ? this.entries.filter((e) => visibleIn(e.scope, scope)) : [...this.entries];
  }

  private persist(): void {
    this.store.save(this.entries);
  }
}

function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return a.workspace === b.workspace && a.session === b.session && a.agent === b.agent;
}

/**
 * An entry is visible when every dimension it names matches the caller's.
 * Unset dimensions are wildcards, so a workspace fact reaches every session
 * inside it while a session note stays put.
 */
function visibleIn(entryScope: MemoryScope, callerScope: MemoryScope): boolean {
  if (entryScope.workspace && entryScope.workspace !== callerScope.workspace) return false;
  if (entryScope.session && entryScope.session !== callerScope.session) return false;
  if (entryScope.agent && callerScope.agent && entryScope.agent !== callerScope.agent) return false;
  return true;
}
