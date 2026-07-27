// Claude CLI driver — the first and primary tool driver (design §4).
//
// Claude persists sessions as JSONL under
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// where <encoded-cwd> is the working directory with every non-alphanumeric
// character replaced by '-'. Each line is one event; conversation lines have
// type 'user' | 'assistant' with a `message` payload. The final assistant
// message of a turn carries a terminal stop_reason — that, and only that, is
// the turn-completion signal (never process exit, never screen state).
import { readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionParseError } from './errors.js';
import type { AgentProfile, NormalizedMessage, ToolDriver } from './types.js';

/** stop_reason values that end a turn; 'tool_use' and null are mid-turn. */
const TERMINAL_STOP_REASONS = new Set(['end_turn', 'stop_sequence', 'max_tokens', 'refusal']);

interface ClaudeLine {
  type?: string;
  isSidechain?: boolean;
  timestamp?: string;
  uuid?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    stop_reason?: string | null;
  };
}

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export class ClaudeDriver implements ToolDriver {
  readonly id = 'claude';

  constructor(private readonly configDir: string = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) {}

  interactiveCommand(baseCommand: string, model?: string): string {
    return `${baseCommand}${modelFlag(model)}`;
  }

  taskCommand(baseCommand: string, escapedPrompt: string, model?: string): string {
    return `${baseCommand}${modelFlag(model)} --print '${escapedPrompt}'`;
  }

  sessionDir(cwd: string): string {
    return join(this.configDir, 'projects', encodeProjectDir(cwd));
  }

  async listSessionFiles(cwd: string): Promise<string[]> {
    const dir = this.sessionDir(cwd);
    try {
      const entries = await readdir(dir);
      return entries.filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
    } catch {
      return []; // tool hasn't created the project dir yet
    }
  }

  parseSessionFile(content: string): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let parsed: ClaudeLine;
      try {
        parsed = JSON.parse(line) as ClaudeLine;
      } catch (err) {
        throw new SessionParseError('claude', line, err);
      }
      if (parsed.type !== 'user' && parsed.type !== 'assistant') continue; // titles, modes, snapshots, …
      if (parsed.isSidechain) continue; // subagent transcripts are not the conversation
      const message = parsed.message;
      if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
      const text =
        typeof message.content === 'string'
          ? message.content
          : (message.content ?? [])
              .filter((block) => block.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text as string)
              .join('\n');
      messages.push({
        role: message.role,
        text,
        timestamp: parsed.timestamp,
        uuid: parsed.uuid,
        stopReason: message.stop_reason,
      });
    }
    return messages;
  }

  isTurnComplete(messages: NormalizedMessage[], sinceIso: string): boolean {
    return messages.some(
      (m) =>
        m.role === 'assistant' &&
        m.stopReason != null &&
        TERMINAL_STOP_REASONS.has(m.stopReason) &&
        (m.timestamp ?? '') > sinceIso,
    );
  }

  async materialize(agent: AgentProfile, worktreePath: string): Promise<string[]> {
    // CLAUDE.md is claude's native instruction surface — by the time the TUI
    // starts, the agent already is this persona (design §5). Meeting-only
    // fields (voice, persona.style) are deliberately not rendered.
    const lines = [
      `# ${agent.name} — ${agent.role}`,
      '',
      agent.directives,
      '',
      `You are ${agent.name}. Stay within your role's domain; when work belongs to another specialist, say so instead of doing it badly.`,
      '',
    ];
    await writeFile(join(worktreePath, 'CLAUDE.md'), lines.join('\n'));
    return ['CLAUDE.md'];
  }
}

/**
 * `claude` takes `--model <id>`. A blank or "default" model means "whatever the
 * tool is configured for" — emit nothing rather than an invalid flag.
 */
function modelFlag(model?: string): string {
  const id = model?.trim();
  if (!id || id === 'default') return '';
  return ` --model ${id}`;
}
