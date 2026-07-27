// opencode driver.
//
// opencode keeps everything in SQLite at ~/.local/share/opencode/opencode.db:
//   session(id, directory, …)  — one row per session, keyed by working dir
//   message(id, session_id, time_created, data)  — data is a JSON envelope
//     {role, time:{created, completed?}, …}
//   part(message_id, …)        — the actual content parts of a message
//
// A turn is complete when the newest assistant message has a completed time —
// opencode stamps that only when the assistant finishes, which is exactly the
// persisted signal the design asks for.
//
// The driver's "session file" is a synthetic path (db::sessionId) so the
// session manager's file-shaped interface still works; parseSessionFile is
// therefore not used for discovery and only exists for interface parity.
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query } from './sqlite.js';
import type { AgentProfile, NormalizedMessage, ToolDriver } from './types.js';

interface MessageEnvelope {
  role?: string;
  time?: { created?: number; completed?: number };
}

export class OpencodeDriver implements ToolDriver {
  readonly id = 'opencode';

  constructor(
    private readonly dataDir: string = process.env.OPENCODE_DATA_DIR ?? join(homedir(), '.local/share/opencode'),
  ) {}

  private get db(): string {
    return join(this.dataDir, 'opencode.db');
  }

  interactiveCommand(baseCommand: string, model?: string): string {
    return `${baseCommand}${modelFlag(model)}`;
  }

  taskCommand(baseCommand: string, escapedPrompt: string, model?: string): string {
    return `${baseCommand}${modelFlag(model)} run '${escapedPrompt}'`;
  }

  sessionDir(_cwd: string): string {
    return this.dataDir;
  }

  /** Synthetic handles: `db::<sessionId>` for sessions rooted at `cwd`. */
  async listSessionFiles(cwd: string): Promise<string[]> {
    const rows = await query(this.db, 'select id from session where directory = ? order by rowid desc limit 20', [cwd]);
    return rows.map((r) => `db::${r.id}`);
  }

  /** Interface parity only — opencode content is read from the database. */
  parseSessionFile(content: string): NormalizedMessage[] {
    if (!content.startsWith('db::')) return [];
    return [];
  }

  /** The real read path: messages for one session, newest last. */
  async readMessages(handle: string): Promise<NormalizedMessage[]> {
    const sessionId = handle.replace(/^db::/, '');
    const rows = await query(
      this.db,
      `select m.id, m.time_created, m.data,
              (select group_concat(p.data, char(10)) from part p where p.message_id = m.id) as parts
         from message m
        where m.session_id = ?
        order by m.time_created asc, m.id asc`,
      [sessionId],
    );
    const messages: NormalizedMessage[] = [];
    for (const row of rows) {
      let envelope: MessageEnvelope = {};
      try {
        envelope = JSON.parse(row.data ?? '{}') as MessageEnvelope;
      } catch {
        continue; // a malformed envelope is one message, not a broken session
      }
      if (envelope.role !== 'user' && envelope.role !== 'assistant') continue;
      const text = extractText(row.parts ?? '');
      messages.push({
        role: envelope.role,
        text,
        timestamp: new Date(Number(row.time_created ?? 0)).toISOString(),
        uuid: row.id,
        // Completion is opencode's own stamp, not our inference.
        stopReason: envelope.role === 'assistant' && envelope.time?.completed ? 'end_turn' : null,
      });
    }
    return messages;
  }

  isTurnComplete(messages: NormalizedMessage[], sinceIso: string): boolean {
    return messages.some((m) => m.role === 'assistant' && m.stopReason === 'end_turn' && (m.timestamp ?? '') > sinceIso);
  }

  async materialize(agent: AgentProfile, worktreePath: string): Promise<string[]> {
    await writeFile(
      join(worktreePath, 'AGENTS.md'),
      [`# ${agent.name} — ${agent.role}`, '', agent.directives, '', `You are ${agent.name}. Stay within your role's domain.`, ''].join('\n'),
    );
    return ['AGENTS.md'];
  }
}

/** Parts are JSON blobs; keep the text ones and drop tool/step internals. */
function extractText(joined: string): string {
  const out: string[] = [];
  for (const chunk of joined.split('\n')) {
    if (!chunk.trim()) continue;
    try {
      const part = JSON.parse(chunk) as { type?: string; text?: string };
      if (part.type === 'text' && part.text) out.push(part.text);
    } catch {
      // non-JSON part — ignore rather than fail the whole message
    }
  }
  return out.join('\n');
}

/**
 * `opencode` takes `--model <id>`. A blank or "default" model means "whatever the
 * tool is configured for" — emit nothing rather than an invalid flag.
 */
function modelFlag(model?: string): string {
  const id = model?.trim();
  if (!id || id === 'default') return '';
  return ` --model ${id}`;
}
