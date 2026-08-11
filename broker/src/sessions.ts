/**
 * Sessions — workspace-scoped persistent conversations. A workspace holds many
 * sessions; exactly one is active at a time. Each session owns its transcript
 * (what UIs render) and the brain's conversation history (what the model
 * remembers), so switching sessions swaps both wholesale.
 */
import type { HistoryEntry } from './brain.ts';
import type { TurnOrigin } from './broker.ts';

export interface TranscriptLine {
  role: 'user' | 'broker';
  text: string;
  at: string;
}

export type ExecutionMode = 'local-in-process' | 'local-docker' | 'remote-in-process' | 'remote-docker';

const LEGACY_MODE: ExecutionMode = 'local-in-process';

export interface Session {
  id: string;
  title: string;
  workspace: string;
  runtime: ExecutionMode;
  /**
   * Documents this session produced and works on. Absent on files written
   * before the artifacts pivot (spec 2026-08-10) — normalized at init(),
   * including the phase-1 `kind`/`docId` pair a document session carried.
   */
  artifacts?: string[];
  /** True while the brain still owes this session its one post-first-reply retitle. */
  awaitingTitle?: boolean;
  createdAt: string;
  updatedAt: string;
  transcript: TranscriptLine[];
  brainHistory: HistoryEntry[];
}

export interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  runtime: ExecutionMode;
  /** Always resolved — absent on the session file means an empty list. */
  artifacts: string[];
  updatedAt: string;
  active: boolean;
}

export interface SessionStoreLike {
  loadAll(): Session[];
  save(session: Session): void;
  /** Erase a session's persisted copy. Called only after it has left the map. */
  remove(id: string): void;
}

const MAX_TRANSCRIPT_LINES = 500;

/** Collapse whitespace, cap at 40 chars with an ellipsis (spec §3). */
export function truncateTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New session';
  return clean.length <= 40 ? clean : `${clean.slice(0, 39).trimEnd()}…`;
}

/** Which workspace a lazily-created session lands in: discord = the attended workspace, every other origin = the default workspace. */
export function resolveLazyWorkspace(
  origin: TurnOrigin | undefined,
  attendedDiscordWorkspace: string | null,
  defaultWorkspace: string,
): string {
  return origin?.kind === 'discord' ? (attendedDiscordWorkspace ?? defaultWorkspace) : defaultWorkspace;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private activeId = '';
  private seq = 0;

  constructor(
    private readonly store: SessionStoreLike,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Load persisted sessions; activate the most recent if any exist. NEVER creates (spec §4b). */
  init(): Session | null {
    for (const s of this.store.loadAll()) {
      s.runtime ??= LEGACY_MODE;
      // Phase-1 files carried kind:"document" + docId. Fold that into artifacts
      // and drop the dead fields; they vanish from disk on the next save.
      const legacy = s as Session & { kind?: string; docId?: string };
      if (!s.artifacts) s.artifacts = legacy.kind === 'document' && legacy.docId ? [legacy.docId] : [];
      delete legacy.kind;
      delete legacy.docId;
      this.sessions.set(s.id, s);
      this.seq = Math.max(this.seq, Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0));
    }
    const latest = [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
    this.activeId = latest?.id ?? '';
    return latest;
  }

  create(
    workspace: string,
    opts?: { title?: string; runtime?: ExecutionMode; artifacts?: string[]; awaitingTitle?: boolean },
  ): Session {
    this.seq += 1;
    const session: Session = {
      id: `s${this.seq}`,
      title: opts?.title?.trim() || `Session ${this.seq}`,
      workspace,
      runtime: opts?.runtime ?? LEGACY_MODE,
      artifacts: opts?.artifacts ?? [],
      awaitingTitle: opts?.awaitingTitle,
      createdAt: this.now(),
      updatedAt: this.now(),
      transcript: [],
      brainHistory: [],
    };
    this.sessions.set(session.id, session);
    this.activeId = session.id;
    this.store.save(session);
    return session;
  }

  activate(id: string): Session | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    this.activeId = id;
    return session;
  }

  /**
   * Delete a session for good. Returns the removed session plus whichever
   * session is active AFTERWARDS (null when none remain), because deleting the
   * active one leaves two things dangling that only the caller can fix: the
   * brain still holds the dead conversation's history, and Discord still
   * attends its workspace. main.ts reloads both from `active` — the same
   * contract the reset path honours.
   *
   * The successor is the most recently updated survivor, matching init()'s
   * choice on boot. Documents this session produced are deliberately NOT
   * deleted: artifacts outlive the conversation that made them, and one
   * document may be attached to several sessions.
   */
  remove(id: string): { removed: Session; active: Session | null } | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    this.sessions.delete(id);
    this.store.remove(id);
    if (this.activeId === id) {
      const successor = [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
      this.activeId = successor?.id ?? '';
    }
    // `seq` is untouched: ids never get reused, so a deleted s2 can't be
    // resurrected by the next create and inherit its artifacts.
    return { removed: session, active: this.activeOrNull() };
  }

  active(): Session {
    const session = this.sessions.get(this.activeId);
    if (!session) throw new Error('no active session — call init() first');
    return session;
  }

  hasActive(): boolean {
    return this.sessions.has(this.activeId);
  }

  activeOrNull(): Session | null {
    return this.sessions.get(this.activeId) ?? null;
  }

  /** Apply the brain's one-time title. Returns false if this session isn't owed one. */
  retitle(id: string, title: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.awaitingTitle) return false;
    session.title = title;
    session.awaitingTitle = undefined;
    session.updatedAt = this.now();
    this.store.save(session);
    return true;
  }

  /**
   * Attach a document to a session (append-once). The artifact list is the
   * session's claim on its work products — a conversation may produce several
   * (spec 2026-08-10, artifacts pivot).
   */
  addArtifact(sessionId: string, docId: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.artifacts ??= [];
    if (!session.artifacts.includes(docId)) {
      session.artifacts.push(docId);
      session.updatedAt = this.now();
      this.store.save(session);
    }
    return session;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: s.id,
        title: s.title,
        workspace: s.workspace,
        runtime: s.runtime,
        artifacts: s.artifacts ?? [],
        updatedAt: s.updatedAt,
        active: s.id === this.activeId,
      }));
  }

  /** Every session with its full transcript — evidence for removal decisions. */
  allSessions(): Session[] {
    return [...this.sessions.values()];
  }

  /** Wipe every conversation. Creates nothing — the UI lands on the composer (spec §4b). */
  resetAll(): void {
    this.sessions.clear();
    this.activeId = '';
    this.seq = 0;
  }

  appendTranscript(role: 'user' | 'broker', text: string): void {
    const session = this.active();
    session.transcript.push({ role, text, at: this.now() });
    if (session.transcript.length > MAX_TRANSCRIPT_LINES) session.transcript.splice(0, session.transcript.length - MAX_TRANSCRIPT_LINES);
    session.updatedAt = this.now();
    this.store.save(session);
  }

  /** Persist the brain's memory after a turn (the brain owns the live copy). */
  saveBrainHistory(history: HistoryEntry[]): void {
    const session = this.active();
    session.brainHistory = history;
    session.updatedAt = this.now();
    this.store.save(session);
  }
}
