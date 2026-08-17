// Per-tool drivers (design §4). Each CLI tool the swarm can run gets one
// driver owning the five responsibilities: launch, discover, parse, complete,
// materialize. Everything tool-specific lives here — the dispatcher and the
// session manager stay tool-agnostic.
import type { AuthFailure } from "../cli-tools.js";

/** The slice of an agent profile that materializes into tool config. */
export interface AgentProfile {
  name: string;
  role: string;
  directives: string;
}

/** A session-file message normalized across tools. */
export interface NormalizedMessage {
  role: "user" | "assistant";
  /** Concatenated text content (tool-use payloads and internals are elided). */
  text: string;
  timestamp?: string;
  uuid?: string;
  /** Tool-reported stop reason for assistant messages; null/undefined mid-turn. */
  stopReason?: string | null;
}

/**
 * Injected subprocess runner for auth probes — tests stub it; production is
 * cli-tools.defaultRunner. Resolves (never rejects) with the exit code
 * (null when killed/timed out) and captured output.
 */
export type CommandRunner = (
  argv: string[],
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface ToolDriver {
  /** Matches TaskManifest.agent / ComposedAgent.engine.cli. */
  readonly id: string;

  /**
   * False when the tool persists no local transcript, so turn completion
   * cannot be observed honestly (agy). Such tools still run task work and
   * accept steering; they just cannot host a warm session.
   */
  readonly warmSessionsSupported?: boolean;

  /**
   * Interactive TUI command for a warm session. `model` comes from the agent
   * definition — the driver spells the flag its own tool understands.
   * `sessionId`, when given, pins the tool's session id so the caller knows the
   * transcript path without discovering it. Tools that cannot pin ignore it.
   */
  interactiveCommand(baseCommand: string, model?: string, sessionId?: string): string;

  /** One-shot command for a fire-and-forget task run. */
  taskCommand(baseCommand: string, escapedPrompt: string, model?: string): string;

  /** Where this tool persists session files for work rooted at `cwd`. */
  sessionDir(cwd: string): string;

  /**
   * Where this tool writes the transcript when launched with `sessionId`.
   * Present only for tools that let the caller pin the id; absent means the
   * session manager must discover the file after launch.
   */
  sessionFileFor?(cwd: string, sessionId: string): string;

  /**
   * Clear any first-run gate this tool raises for a directory it has not seen
   * before, so the TUI comes up at a real prompt. Optional: tools with no
   * per-directory prompt omit it. Called once, before launch.
   */
  prepareWorkspace?(cwd: string): Promise<void>;

  /** Session files under sessionDir(cwd), absolute paths. Missing dir = []. */
  listSessionFiles(cwd: string): Promise<string[]>;

  /**
   * Parse a session file's content into normalized messages.
   * Throws SessionParseError (with the offending excerpt) on malformed input.
   */
  parseSessionFile(content: string): NormalizedMessage[];

  /**
   * Database-backed tools (opencode, copilot) read messages by handle instead
   * of parsing a file. When present, the session manager prefers this and
   * never reads the handle off disk.
   */
  readMessages?(handle: string): Promise<NormalizedMessage[]>;

  /**
   * Turn completion, detected ONLY from persisted state (design §3): true when
   * an assistant message finalized on disk after `sinceIso`.
   */
  isTurnComplete(messages: NormalizedMessage[], sinceIso: string): boolean;

  /**
   * Render the agent profile into the tool's native config surfaces inside
   * the worktree (design §5). `atlassian`, when given, additionally wires an
   * MCP server for that workspace's Jira/Confluence site — credentials are
   * referenced as `${SMITH_ATLASSIAN_EMAIL}`/`${SMITH_ATLASSIAN_TOKEN}` env
   * placeholders, never embedded literally (design: agent privilege ceiling
   * = the requesting user's own token, injected by the dispatcher at launch,
   * not written to any file in the worktree). Returns the created paths
   * relative to the worktree so callers can keep them out of task commits.
   */
  materialize(
    agent: AgentProfile,
    worktreePath: string,
    atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] },
  ): Promise<string[]>;

  /**
   * Auth/subscription probe for the CLI tool registry. Optional: tools with
   * no reliable non-interactive status command omit it and the registry
   * records authOk 'unknown' — treated as active, since the gate blocks only
   * confirmed negatives. Implementations must not throw and must return
   * ok:false only on a CONFIRMED logged-out signal; anything unrecognizable
   * is 'unknown'. `binary` is the bare executable (no flags). `failure` is
   * supplied only when the driver can itself CONFIRM the cause (e.g. a
   * distinguishable billing/policy response); when omitted, the registry
   * derives the default classification from `ok`.
   */
  verifyAuth?(
    binary: string,
    run: CommandRunner,
    timeoutMs: number,
  ): Promise<{ ok: boolean | "unknown"; detail: string; failure?: AuthFailure }>;
}
