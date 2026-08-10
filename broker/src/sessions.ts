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

export type SessionKind = 'chat' | 'document';

export interface Session {
  id: string;
  title: string;
  workspace: string;
  runtime: ExecutionMode;
  /** Absent on legacy files = "chat" (lockstep tolerance, same rule the UI parser applies). */
  kind?: SessionKind;
  /** Present iff kind === "document" — the document this session collaborates on. */
  docId?: string;
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
  kind: SessionKind;
  docId?: string;
  updatedAt: string;
  active: boolean;
}

export interface SessionStoreLike {
  loadAll(): Session[];
  save(session: Session): void;
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
      this.sessions.set(s.id, s);
      this.seq = Math.max(this.seq, Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0));
    }
    const latest = [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
    this.activeId = latest?.id ?? '';
    return latest;
  }

  create(
    workspace: string,
    opts?: { title?: string; runtime?: ExecutionMode; kind?: SessionKind; docId?: string; awaitingTitle?: boolean },
  ): Session {
    this.seq += 1;
    const session: Session = {
      id: `s${this.seq}`,
      title: opts?.title?.trim() || `Session ${this.seq}`,
      workspace,
      runtime: opts?.runtime ?? LEGACY_MODE,
      kind: opts?.kind ?? 'chat',
      docId: opts?.docId,
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

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: s.id,
        title: s.title,
        workspace: s.workspace,
        runtime: s.runtime,
        kind: s.kind ?? 'chat',
        docId: s.docId,
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
