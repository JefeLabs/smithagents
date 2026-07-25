// ClaudeBrain — an agent's "brain" is a headless Claude Code (`claude -p`)
// session. Each conversational turn shells out to the operator's own `claude`
// CLI so the turn runs on the operator's Claude Code subscription (not a
// metered API key) with native tools + delegation available to the agent.
//
// Step 1 finding (claude 2.1.220, `claude --help`):
//   `--output-format <format>` choices are "text" | "json" (documented as
//   "single result") | "stream-json". Running the exact confirmation command
//   from the task brief —
//     claude -p "reply with exactly: ok" --output-format json \
//       --model claude-haiku-4-5 --session-id "$(uuidgen)"
//   — from *inside this nested Claude Code session* printed a JSON ARRAY of
//   the whole transcript (a `system`/`init` event, several `system`/
//   `thinking_tokens` progress events, `assistant` message events, a
//   `rate_limit_event`, and finally one object) rather than the single JSON
//   object `--help` documents for "json". This is the nested-invocation
//   artifact the task brief anticipated; a non-nested `claude -p` should
//   print only the single result object. In BOTH shapes, the assistant's
//   reply text lives on a `"result"` field of the object whose `"type"` is
//   `"result"` (e.g. `{"type":"result","subtype":"success",...,"result":"ok"}`)
//   — that confirmed field is what this module reads (see
//   `extractResultText` below, which also tolerates the array shape).
//   Confirmed working model alias: `claude-haiku-4-5` (resolved to
//   `claude-haiku-4-5-20251001`). `--permission-mode default` is accepted by
//   the CLI (it is not literally enumerated in `--help`'s choices list, but
//   does not error) and is used here as the "read-oriented/default mode"
//   this v1 bridge calls for — no `--dangerously-skip-permissions`.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ComposedAgent } from './agents.js';

export interface BrainDeps {
  /** The exec seam: given argv (sans `claude`), stdin content, and the child env, resolves the child's stdout. */
  run?: (args: string[], input: string, env: NodeJS.ProcessEnv) => Promise<string>;
}

/** Default `run`: spawns the real `claude` binary and collects its stdout. */
function spawnClaude(cwd: string | undefined): NonNullable<BrainDeps['run']> {
  return (args, input, env) =>
    new Promise((resolve, reject) => {
      const child = spawn('claude', args, { cwd, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`claude exited with code ${code}: ${stderr}`));
        else resolve(stdout);
      });
      child.stdin.end(input);
    });
}

/** Reads the confirmed `.result` field, tolerating the nested-session array artifact noted above. */
function extractResultText(stdout: string): string {
  const parsed: unknown = JSON.parse(stdout);
  const resultObj = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  const text = (resultObj as { result?: unknown } | undefined)?.result;
  if (typeof text !== 'string') {
    throw new Error('claude -p --output-format json: no string "result" field in output');
  }
  return text;
}

/**
 * An agent's brain, backed by a headless Claude Code session. The first
 * `turn()` starts the session (`--session-id`); every subsequent turn
 * resumes it (`--resume`), so the conversation persists across turns.
 */
export class ClaudeBrain {
  readonly sessionId: string = randomUUID();

  private readonly model: string;
  private readonly run: NonNullable<BrainDeps['run']>;
  #started = false;

  constructor(
    private readonly agent: ComposedAgent,
    opts?: { model?: string; cwd?: string },
    deps?: BrainDeps,
  ) {
    this.model = opts?.model ?? 'claude-haiku-4-5';
    this.run = deps?.run ?? spawnClaude(opts?.cwd);
  }

  async turn(userText: string): Promise<string> {
    const argv = [
      '-p',
      userText,
      '--output-format',
      'json',
      '--model',
      this.model,
      '--append-system-prompt',
      this.agent.directives,
      '--permission-mode',
      'default',
      this.#started ? '--resume' : '--session-id',
      this.sessionId,
    ];
    this.#started = true;

    // Subscription auth: a present ANTHROPIC_API_KEY makes `claude` bill the
    // metered API instead of the operator's Claude Code subscription.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const stdout = await this.run(argv, '', env);
    return extractResultText(stdout);
  }
}
