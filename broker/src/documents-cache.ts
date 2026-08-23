/**
 * Broker-side document plumbing, left over after the swarm took ownership
 * (spec 2026-08-22 §3). The swarm holds the documents; the broker holds only
 * what it needs to serve the UI's frames:
 *
 * - `DocumentsCache` — the last known `documents` frame, plus the rule that a
 *   cache which has NEVER loaded is not an answer (see `seedSession`).
 * - `makeSerialQueue` — the pin/unpin read-modify-write guard.
 * - `nextDefaultTitle` — disambiguation for auto-named documents.
 *
 * Extracted from main.ts so each of these is reachable by a test; main.ts is
 * the process entry point and cannot be imported.
 */
import { docSeedsInWorkspace } from "./pins.ts";
import type { Doc } from "./swarm-client.ts";

export interface GroupExpansion {
  name: string;
  expansion: string[];
}

/**
 * Which documents stand as workspace `workspace`'s context (spec §7: "the
 * session's workspace documents plus pinned ones"). A workspace's own
 * documents seed it; so does anything pinned here from elsewhere, directly or
 * through a group's expansion.
 */
export function docsSeedingWorkspace(docs: Doc[], workspace: string, groups: GroupExpansion[]): Doc[] {
  return docs.filter((doc) => doc.workspace === workspace || docSeedsInWorkspace(doc.pins, workspace, groups));
}

export interface DocumentsCacheDeps {
  /** The swarm read. Rejections are caught — a read path must degrade, never blank. */
  list: () => Promise<Doc[]>;
  /** Add one document to one session's shelf. Expected to be idempotent. */
  seed: (sessionId: string, docId: string) => void;
  /** Group expansions as of now — they change independently of documents. */
  groups: () => GroupExpansion[];
  warn: (line: string) => void;
  /**
   * Deferred sessions were just paid off. The caller owns telling the UI —
   * their shelves changed after the session frame that announced them.
   */
  onSeeded?: (sessions: number) => void;
}

/**
 * The `documents` frame's backing store.
 *
 * Truth is the swarm's disk (spec §3), so this is a cache with exactly one
 * job: keep serving the last good frame when a read fails. Two rules make it
 * safe:
 *
 * 1. A failed refresh NEVER empties the cache — the UI keeps its last frame.
 * 2. A cache that has never successfully loaded is not "no documents", it is
 *    "unknown". `seedSession` refuses to write an empty seed in that state and
 *    defers instead, because a session's `artifacts` list is persisted once at
 *    birth and never re-derived — an empty seed would be permanent.
 */
export class DocumentsCache {
  private docs: Doc[] = [];
  private everLoaded = false;
  private deferred: Array<{ sessionId: string; workspace: string }> = [];

  constructor(private readonly deps: DocumentsCacheDeps) {}

  /** The current frame's payload. Never throws. */
  list(): Doc[] {
    return this.docs;
  }

  /** Has a read ever succeeded? False means the list is unknown, not empty. */
  get loaded(): boolean {
    return this.everLoaded;
  }

  /** Sessions still waiting for a first successful load (test/diagnostic view). */
  get deferredCount(): number {
    return this.deferred.length;
  }

  /** Re-read from the swarm. Returns whether this read succeeded. */
  async refresh(): Promise<boolean> {
    let next: Doc[];
    try {
      next = await this.deps.list();
    } catch (err) {
      this.deps.warn(
        `[documents] could not refresh from the swarm — keeping the last frame: ${(err as Error).message}`,
      );
      return false;
    }
    this.docs = next;
    const first = !this.everLoaded;
    this.everLoaded = true;
    if (first) this.drain();
    return true;
  }

  /**
   * Seed a new session's shelf with its workspace's standing context.
   * Deferred — NOT written as an empty seed — while the list is unknown.
   */
  seedSession(sessionId: string, workspace: string): void {
    if (!this.everLoaded) {
      this.deferred.push({ sessionId, workspace });
      this.deps.warn(
        `[documents] session ${sessionId} opened with no shelf — the document list has never loaded from the swarm; it will be seeded on the first successful refresh`,
      );
      return;
    }
    this.apply(sessionId, workspace);
  }

  private apply(sessionId: string, workspace: string): void {
    for (const doc of docsSeedingWorkspace(this.docs, workspace, this.deps.groups())) {
      this.deps.seed(sessionId, doc.id);
    }
  }

  /** First successful load: pay off every session that opened blind. */
  private drain(): void {
    if (this.deferred.length === 0) return;
    const owed = this.deferred.splice(0);
    for (const { sessionId, workspace } of owed) this.apply(sessionId, workspace);
    this.deps.onSeeded?.(owed.length);
  }
}

/**
 * One-at-a-time execution for operations that must not interleave.
 *
 * `pin`/`unpin` are a read-modify-write over two HTTP calls, and the swarm's
 * PATCH replaces the whole `pins` array — so two overlapping pins would drop
 * one. The broker is the swarm's ONLY caller (spec §3, "No UI → swarm direct
 * calls"), and one swarm owns an org repo, so serializing the read-modify-write
 * here is sufficient for the shipped topology: nothing else can slip between
 * the read and the write.
 *
 * What this does NOT cover: a pins change made outside the broker entirely (a
 * hand edit to frontmatter, a merged instance branch). That is the external-edit
 * class spec §3 answers with "truth is the disk" — the next read picks it up.
 * The complete fix is an atomic `POST /documents/:id/pins` on the swarm, which
 * would also cover a second broker; this queue is the broker-side half.
 */
export function makeSerialQueue(): <T>(op: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(op: () => Promise<T>): Promise<T> => {
    // `.then(op, op)` so a failed predecessor does not wedge the queue.
    const next = tail.then(op, op);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

/**
 * A numbered name for a document nobody named.
 *
 * The swarm's own fallback is the blueprint's name (`document-store.ts`), so
 * three blank specs would all read "Design Spec" on the shelf. This restores
 * the "Design Spec 1 / 2 / 3" the broker's DocumentManager used to mint.
 * ONLY for a defaulted title — a title the user typed is never numbered.
 */
export function nextDefaultTitle(blueprintName: string, existingTitles: Iterable<string>): string {
  const taken = new Set(existingTitles);
  let n = 1;
  while (taken.has(`${blueprintName} ${n}`)) n += 1;
  return `${blueprintName} ${n}`;
}
