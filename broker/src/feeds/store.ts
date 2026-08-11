/**
 * The one place feed data lives. Three files under .smith/feeds/, read and
 * written through an injected io seam so tests never touch a disk.
 *
 * Trimming runs on every write: 30 days, then a hard cap of 500 items. The
 * `spokenAt`/`cardedAt` markers ride the item, so a trimmed release can never
 * be announced or carded a second time.
 */
import type { FeedItem, FeedSource, FeedState } from './types.ts';

const MAX_ITEMS = 500;
const MAX_AGE_DAYS = 30;

export interface FeedIo {
  read(name: string): string | null;
  write(name: string, body: string): void;
}

const EMPTY_STATE: FeedState = { sources: {}, xUsage: {}, candidates: {}, seenVersions: {} };

export class FeedStore {
  constructor(
    private readonly io: FeedIo,
    private readonly opts: { now?: () => Date } = {},
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** A corrupt or absent file reads as the fallback: a bad write must not brick the broker. */
  private load<T>(name: string, fallback: T): T {
    try {
      const raw = this.io.read(name);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  sources(): FeedSource[] {
    return this.load<FeedSource[]>('sources.json', []);
  }

  putSource(source: FeedSource): void {
    const all = this.sources().filter((s) => s.id !== source.id);
    all.push(source);
    this.io.write('sources.json', JSON.stringify(all, null, 2));
  }

  removeSource(id: string): void {
    this.io.write('sources.json', JSON.stringify(this.sources().filter((s) => s.id !== id), null, 2));
  }

  items(): FeedItem[] {
    return this.load<FeedItem[]>('items.json', []);
  }

  /** Adds unseen items and returns ONLY those — re-fetching a feed yields nothing. */
  addItems(incoming: FeedItem[]): FeedItem[] {
    const existing = this.items();
    const known = new Set(existing.map((i) => i.id));
    const fresh = incoming.filter((i) => !known.has(i.id));
    if (fresh.length) this.writeItems([...existing, ...fresh]);
    return fresh;
  }

  private writeItems(all: FeedItem[]): void {
    const cutoff = this.now().getTime() - MAX_AGE_DAYS * 86_400_000;
    const kept = all
      .filter((i) => Date.parse(i.publishedAt) >= cutoff)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      .slice(0, MAX_ITEMS);
    this.io.write('items.json', JSON.stringify(kept, null, 2));
  }

  markSpoken(ids: string[], at: string): void {
    const set = new Set(ids);
    this.writeItems(this.items().map((i) => (set.has(i.id) ? { ...i, spokenAt: at } : i)));
  }

  markCarded(id: string, at: string): void {
    this.writeItems(this.items().map((i) => (i.id === id ? { ...i, cardedAt: at } : i)));
  }

  state(): FeedState {
    return { ...EMPTY_STATE, ...this.load<Partial<FeedState>>('state.json', {}) };
  }

  patchState(patch: Partial<FeedState>): void {
    this.io.write('state.json', JSON.stringify({ ...this.state(), ...patch }, null, 2));
  }
}
