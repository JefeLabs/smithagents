/**
 * Push-to-talk session bookkeeping for the text-channel's `mic` dep (main.ts).
 * `mic.start(clientId)` must gate on an async STT-key lookup before it may
 * create a real session, but the WS handler that calls it is synchronous —
 * so the slot has to be reserved synchronously, before that lookup's await,
 * or two `mic-start` frames arriving back-to-back (or a `mic-stop` landing
 * mid-gate) can leak a stray, never-torn-down STT session. This class is the
 * reservation: `reserve` claims the slot up front, `commit`/`cancel` resolve
 * it once the async gate finishes, and `stop` always wins regardless of
 * where the gate is.
 */
export class MicSessionGate<T> {
  private slots = new Map<number, T | "pending">();

  /** Synchronously claims the slot before any await. False (no-op) if a session or another gate already owns it. */
  reserve(clientId: number): boolean {
    if (this.slots.has(clientId)) return false;
    this.slots.set(clientId, "pending");
    return true;
  }

  /** Commits a real session once the async gate resolves. Fails (false) if `stop()` cleared the reservation mid-gate — the caller must tear down the session it just built. */
  commit(clientId: number, session: T): boolean {
    if (this.slots.get(clientId) !== "pending") return false;
    this.slots.set(clientId, session);
    return true;
  }

  /** Clears a still-pending reservation (the gate decided not to proceed). No-op once a real session is committed — a stale cancel from a superseded gate must never clobber it. */
  cancel(clientId: number): void {
    if (this.slots.get(clientId) === "pending") this.slots.delete(clientId);
  }

  /** The real session, or undefined while pending/absent. */
  get(clientId: number): T | undefined {
    const s = this.slots.get(clientId);
    return s === "pending" ? undefined : s;
  }

  /** Clears the slot unconditionally and returns the real session, if any, for the caller to tear down. */
  stop(clientId: number): T | undefined {
    const s = this.slots.get(clientId);
    this.slots.delete(clientId);
    return s === "pending" ? undefined : s;
  }
}
