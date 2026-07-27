// agy driver — STEERING-ONLY, deliberately.
//
// agy keeps conversations server-side (its binary speaks RPCs like
// /new-conversation and resumes with --continue / --conversation <id>); it
// persists no local transcript we can tail. The design spec calls this exact
// case: "if agy persists nothing usable, agy stays steering-only
// (pane-scrape parsing is explicitly out of scope)."
//
// So: agy runs task work and accepts steering keystrokes like any other tool,
// but it cannot host a WARM session, because we would have no honest way to
// know a turn had finished. listSessionFiles returning [] makes the session
// manager fail fast at launch instead of hanging until the readiness timeout.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentProfile, NormalizedMessage, ToolDriver } from './types.js';

export class AgyDriver implements ToolDriver {
  readonly id = 'agy';
  /** Warm sessions need persisted turns; agy has none locally. */
  readonly warmSessionsSupported = false;

  interactiveCommand(baseCommand: string): string {
    return baseCommand;
  }

  taskCommand(baseCommand: string, escapedPrompt: string): string {
    return `${baseCommand} --prompt '${escapedPrompt}'`;
  }

  sessionDir(cwd: string): string {
    return cwd; // no local session storage
  }

  async listSessionFiles(): Promise<string[]> {
    return [];
  }

  parseSessionFile(): NormalizedMessage[] {
    return [];
  }

  isTurnComplete(): boolean {
    return false; // never claim completion we cannot observe
  }

  async materialize(agent: AgentProfile, worktreePath: string): Promise<string[]> {
    await writeFile(
      join(worktreePath, 'AGENTS.md'),
      [`# ${agent.name} — ${agent.role}`, '', agent.directives, '', `You are ${agent.name}. Stay within your role's domain.`, ''].join('\n'),
    );
    return ['AGENTS.md'];
  }
}
