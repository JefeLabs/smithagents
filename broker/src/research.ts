/**
 * Research mode — the broker's tool-free calls (session titles, dictation
 * polish, feed plans, brief analysis, election claims, doc edits).
 *
 * Deliberately narrow: a prompt in, text out. No tools, no conversation
 * history, no streamed deltas. The one site that needs those — BrokerBrain,
 * which hands the model ten caller-defined tool schemas and loops on
 * stop_reason === "tool_use" — is NOT a research engine and must never be
 * routed through here. That distinction is what lets any CLI serve this
 * interface: none of them accept a foreign tool schema.
 */

import { spawn } from "node:child_process";

export interface ResearchInput {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface ResearchEngine {
  complete(input: ResearchInput): Promise<string>;
}

/** Typed failure so callers can tell "the engine broke" from "the model said nothing". */
export class ResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchError";
  }
}

/** The shape of `anthropic.messages.create` this needs — injected so tests need no SDK. */
export type MessagesCreate = (params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<unknown>;

export class AnthropicResearch implements ResearchEngine {
  constructor(
    private readonly create: MessagesCreate,
    private readonly model: string,
  ) {}

  async complete(input: ResearchInput): Promise<string> {
    let reply: unknown;
    try {
      reply = await this.create({
        model: this.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
      });
    } catch (err) {
      throw new ResearchError(String((err as Error).message));
    }
    const blocks = (reply as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new ResearchError("engine returned no text");
    return text;
  }
}

/**
 * Injected subprocess runner. Resolves (never rejects) with the exit code —
 * null when killed or timed out — and captured output. Same contract as the
 * swarm's CommandRunner, for the same reason: a spawn failure is data the
 * caller must handle, not an exception thrown past it.
 */
export type Spawner = (
  argv: string[],
  stdin: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * Runs one research turn through a CLI tool.
 *
 * The prompt is the FINAL argv element, matching every shipped driver:
 * claude `--print '<p>'`, agy `--prompt '<p>'`, codex `exec '<p>'`. None of
 * them read a prompt from stdin.
 *
 * It is passed unescaped and unquoted, deliberately. `spawn` receives an argv
 * ARRAY and never sets `shell: true`, so the args reach execve directly with
 * no shell to interpret them — quotes, newlines and backticks are ordinary
 * bytes. The shipped drivers escape only because they assemble a shell STRING
 * for tmux; escaping here would corrupt the prompt instead of protecting it.
 *
 * NOT a ToolDriver. That interface launches interactive panes and rebuilds
 * conversations by discovering and parsing transcript FILES; this spawns a
 * one-shot process and reads STDOUT. What they share is per-tool flag
 * knowledge, which lives in the engine registry both read from.
 */
export class CliResearch implements ResearchEngine {
  constructor(
    private readonly spawn: Spawner,
    private readonly baseArgv: string[],
    private readonly model: string | undefined,
  ) {}

  async complete(input: ResearchInput): Promise<string> {
    const withModel = this.model ? [...this.baseArgv, "--model", this.model] : [...this.baseArgv];
    const argv = [...withModel, `${input.system}\n\n${input.prompt}`];
    const { code, stdout, stderr } = await this.spawn(argv, "");
    if (code !== 0) {
      const detail = stderr.trim() || stdout.trim() || (code === null ? "killed or timed out" : `exit ${code}`);
      throw new ResearchError(`${this.baseArgv[0]} failed: ${detail}`);
    }
    const text = stdout.trim();
    if (!text) throw new ResearchError(`${this.baseArgv[0]} returned no text`);
    return text;
  }
}

const RESEARCH_TIMEOUT_MS = 120_000;

/**
 * Production spawner. Resolves, never rejects: a spawn failure is data the
 * caller must handle, not an exception thrown past it. Mirrors the swarm's
 * defaultRunner contract for the same reason.
 *
 * The timeout matters more here than it looks — a hung CLI would otherwise
 * hang a feed poll or an election indefinitely, and neither has its own clock.
 */
export const defaultSpawner: Spawner = (argv, stdin) =>
  new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, RESEARCH_TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    // A missing binary emits 'error', never 'close' with a code — without this
    // the promise would never settle and the caller would hang until its own
    // timeout, if it has one.
    child.on("error", (err) => {
      stderr += String((err as Error).message);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin.end(stdin);
  });
