// Codex CLI driver.
//
// Codex persists a "rollout" JSONL per session under
//   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl
// Sessions are NOT partitioned by working directory — the cwd lives in the
// session_meta line — so discovery reads the meta line of recent rollouts and
// keeps the ones rooted at our worktree.
//
// Lines are {timestamp, type, payload}. Conversation turns are
// type:'response_item' with payload.type:'message' and a role; assistant
// content arrives as output_text parts. Codex writes no explicit stop reason,
// so a turn is complete once an assistant message lands after the send —
// which for a rollout file only happens when the turn is finalized.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionParseError } from './errors.js';
import type { AgentProfile, NormalizedMessage, ToolDriver } from './types.js';

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    cwd?: string;
    content?: Array<{ type?: string; text?: string }> | string;
  };
}

export class CodexDriver implements ToolDriver {
  readonly id = 'codex';

  constructor(private readonly configDir: string = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {}

  interactiveCommand(baseCommand: string, model?: string): string {
    return `${baseCommand}${modelFlag(model)}`;
  }

  taskCommand(baseCommand: string, escapedPrompt: string, model?: string): string {
    return `${baseCommand}${modelFlag(model)} exec '${escapedPrompt}'`;
  }

  sessionDir(_cwd: string): string {
    return join(this.configDir, 'sessions');
  }

  /** Rollouts rooted at `cwd`, newest day first. */
  async listSessionFiles(cwd: string): Promise<string[]> {
    const root = this.sessionDir(cwd);
    const files: string[] = [];
    // sessions/<year>/<month>/<day>/rollout-*.jsonl — walk newest-first and
    // stop early; a warm session's file is always among the most recent.
    const descend = async (dir: string, depth: number): Promise<void> => {
      if (files.length >= 40) return;
      let entries: string[];
      try {
        entries = (await readdir(dir)).sort().reverse();
      } catch {
        return;
      }
      for (const entry of entries) {
        if (depth < 3) await descend(join(dir, entry), depth + 1);
        else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) files.push(join(dir, entry));
        if (files.length >= 40) return;
      }
    };
    await descend(root, 0);

    const matching: string[] = [];
    for (const file of files) {
      const head = (await readFile(file, 'utf8').catch(() => '')).split('\n', 1)[0] ?? '';
      try {
        const meta = JSON.parse(head) as CodexLine;
        if (meta.payload?.cwd === cwd) matching.push(file);
      } catch {
        // A rollout whose meta line is unreadable is not ours to claim.
      }
    }
    return matching;
  }

  parseSessionFile(content: string): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let parsed: CodexLine;
      try {
        parsed = JSON.parse(line) as CodexLine;
      } catch (err) {
        throw new SessionParseError('codex', line, err);
      }
      const payload = parsed.payload;
      if (parsed.type !== 'response_item' || payload?.type !== 'message') continue;
      // 'developer' entries are harness scaffolding, not conversation.
      if (payload.role !== 'user' && payload.role !== 'assistant') continue;
      const text =
        typeof payload.content === 'string'
          ? payload.content
          : (payload.content ?? [])
              .filter((part) => typeof part.text === 'string')
              .map((part) => part.text as string)
              .join('\n');
      messages.push({
        role: payload.role,
        text,
        timestamp: parsed.timestamp,
        // Codex has no stop_reason; a persisted assistant message IS the end
        // of a turn, so mark it terminal for the shared completion check.
        stopReason: payload.role === 'assistant' ? 'end_turn' : null,
      });
    }
    return messages;
  }

  isTurnComplete(messages: NormalizedMessage[], sinceIso: string): boolean {
    return messages.some((m) => m.role === 'assistant' && (m.timestamp ?? '') > sinceIso);
  }

  async materialize(agent: AgentProfile, worktreePath: string): Promise<string[]> {
    await writeFile(
      join(worktreePath, 'AGENTS.md'),
      [`# ${agent.name} — ${agent.role}`, '', agent.directives, '', `You are ${agent.name}. Stay within your role's domain.`, ''].join('\n'),
    );
    return ['AGENTS.md'];
  }
}

/**
 * `codex` takes `--model <id>`. A blank or "default" model means "whatever the
 * tool is configured for" — emit nothing rather than an invalid flag.
 */
function modelFlag(model?: string): string {
  const id = model?.trim();
  if (!id || id === 'default') return '';
  return ` --model ${id}`;
}
