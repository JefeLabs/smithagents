// Boot-time reconciliation policy for warm sessions.
//
// On start the server holds two sources of truth that may disagree: the
// records on disk (what we believed was running) and tmux (what is actually
// running). This module decides, per session, what that disagreement means.
//
// It is deliberately pure — no tmux, no filesystem — so every branch is
// testable without a live process.

/** What boot observed about one session. */
export interface ReconcileFacts {
  /** Is the tmux session from the record still alive? */
  processAlive: boolean;
  /** Profile hash recorded when the session was launched (the pin). */
  recordedProfileHash: string;
  /**
   * Profile hash of the agent file as it stands NOW, or null when the agent
   * has been deleted (or reset) while the server was down.
   */
  currentProfileHash: string | null;
}

export type ReconcileAction =
  /** Take the live process back under management, as-is. */
  | 'adopt'
  /** Drop the record; there is no live process behind it. */
  | 'forget'
  /** Kill the live process, then drop the record. */
  | 'kill';

export interface ReconcileVerdict {
  action: ReconcileAction;
  /** Logged verbatim on boot, so a surprising decision is explainable. */
  reason: string;
}

/**
 * Decide what to do with one session found at boot.
 *
 * Two of these branches are mechanical and two are policy. The mechanical
 * ones are settled below. The policy ones are marked and are where the
 * interesting trade-off lives — see `resolveChangedProfile`.
 */
export function classifySession(facts: ReconcileFacts): ReconcileVerdict {
  // Mechanical: the process is gone, so there is nothing to adopt. The record
  // is a tombstone from a crash, a reboot, or a manual tmux kill.
  if (!facts.processAlive) {
    return { action: 'forget', reason: 'tmux session is gone; record is stale' };
  }

  // Mechanical: the agent file is byte-identical to launch time, so the live
  // process still matches its definition exactly. This is the happy path — a
  // plain server restart with the crew untouched.
  if (facts.currentProfileHash === facts.recordedProfileHash) {
    return { action: 'adopt', reason: 'profile unchanged; session still matches its definition' };
  }

  // Policy: the process is alive but its definition moved out from under it.
  return resolveChangedProfile(facts);
}

/**
 * A live session whose agent definition no longer matches the one it launched
 * with. Either the agent file was edited while the server was down
 * (`currentProfileHash` differs) or the agent was deleted entirely
 * (`currentProfileHash` is null, e.g. after a Settings reset).
 *
 * The tension:
 *   - Pinning (design §5) says a changed agent file means a NEW session — the
 *     running TUI no longer represents its definition, so adopting it hands
 *     the user an agent that quietly disagrees with what the UI shows.
 *   - But that process is a live TUI holding real conversation state, in a
 *     worktree that may contain uncommitted work. Killing it destroys both,
 *     and does so on boot, before anyone can look at it.
 *
 * The conservative default below never destroys anything, at the cost of
 * letting a stale session linger. See the note in the module docs for the
 * alternatives worth weighing.
 */
function resolveChangedProfile(facts: ReconcileFacts): ReconcileVerdict {
  if (facts.currentProfileHash === null) {
    return { action: 'adopt', reason: 'agent definition is gone, but the live process was left running' };
  }
  return { action: 'adopt', reason: 'profile changed since launch; live process kept' };
}
