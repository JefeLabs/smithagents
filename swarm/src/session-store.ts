// Durable records for warm agent sessions.
//
// The tmux process an agent lives in outlives the swarm server — that is the
// whole point of running agents in tmux. But the manager's registry is a Map,
// so a restart forgets every live session: the TUI keeps running with nobody
// holding its handle, and the worktree it owns is never cleaned. Half the
// survival benefit tmux gives us was going unbanked.
//
// One JSON file per session under `.smith/sessions/`, mirroring how agents,
// squads, and workspaces are stored. The file is the durable half of
// SessionState; the driver instance and the launch-time `preexisting` set are
// rebuilt on adoption rather than serialized.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The subset of a live session that survives a restart. */
export interface SessionRecord {
  id: string;
  agentId: string;
  agentName: string;
  tool: string;
  /** Content hash of the agent file at launch — the pin (design §5). */
  profileHash: string;
  cwd: string;
  branch: string;
  tmuxSession: string;
  createdAt: string;
  lastTurnAt?: string;
  turns: number;
  /** Resolved lazily on first send, so it may be absent on a young session. */
  sessionFile?: string;
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  async save(record: SessionRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Write-then-rename would be sturdier, but a torn record here costs one
    // adopted session, and `load` already tolerates unreadable files.
    await writeFile(join(this.dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }

  /**
   * Every readable record. A corrupt or half-written file is skipped rather
   * than thrown: one bad record must not stop the server from booting and
   * adopting the sessions that ARE intact.
   */
  async load(): Promise<SessionRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return []; // no sessions yet is the normal first-boot case
    }
    const records: SessionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.dir, name), "utf8")) as SessionRecord;
        if (parsed?.id && parsed.tmuxSession) records.push(parsed);
      } catch {
        // Unreadable record — the session it described is unreachable anyway.
      }
    }
    return records;
  }

  async delete(id: string): Promise<void> {
    await rm(join(this.dir, `${id}.json`), { force: true });
  }
}
