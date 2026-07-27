/**
 * Sessions — workspace-scoped persistent conversations. A workspace holds many
 * sessions; exactly one is active at a time. Each session owns its transcript
 * (what UIs render) and the brain's conversation history (what the model
 * remembers), so switching sessions swaps both wholesale.
 */
import type { HistoryEntry } from './brain.ts';

export interface TranscriptLine {
  role: 'user' | 'broker';
  text: string;
  at: string;
}

export interface Session {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  transcript: TranscriptLine[];
  brainHistory: HistoryEntry[];
}

export interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  updatedAt: string;
  active: boolean;
}

export interface SessionStoreLike {
  loadAll(): Session[];
  save(session: Session): void;
}

const MAX_TRANSCRIPT_LINES = 500;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private activeId = '';
  private seq = 0;

  constructor(
    private readonly store: SessionStoreLike,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Load persisted sessions; ensure one exists and is active for the given default workspace. */
  init(defaultWorkspace: string): Session {
    for (const s of this.store.loadAll()) {
      this.sessions.set(s.id, s);
      this.seq = Math.max(this.seq, Number(/^s(\d+)$/.exec(s.id)?.[1] ?? 0));
    }
    const latest = [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (latest) {
      this.activeId = latest.id;
      return latest;
    }
    return this.create(defaultWorkspace);
  }

  create(workspace: string, title?: string): Session {
    this.seq += 1;
    const session: Session = {
      id: `s${this.seq}`,
      title: title?.trim() || `Session ${this.seq}`,
      workspace,
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

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({ id: s.id, title: s.title, workspace: s.workspace, updatedAt: s.updatedAt, active: s.id === this.activeId }));
  }

  /**
   * Wipe every conversation and start one fresh session. The store's own
   * files are removed by the caller (it owns persistence); this resets the
   * in-memory world so UIs see a clean slate immediately.
   */
  resetAll(workspace: string): Session {
    this.sessions.clear();
    this.activeId = '';
    this.seq = 0;
    return this.create(workspace);
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
