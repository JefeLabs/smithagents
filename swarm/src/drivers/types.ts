// Per-tool drivers (design §4). Each CLI tool the swarm can run gets one
// driver owning the five responsibilities: launch, discover, parse, complete,
// materialize. Everything tool-specific lives here — the dispatcher and the
// session manager stay tool-agnostic.
/** The slice of an agent profile that materializes into tool config. */
export interface AgentProfile {
  name: string;
  role: string;
  directives: string;
}

/** A session-file message normalized across tools. */
export interface NormalizedMessage {
  role: 'user' | 'assistant';
  /** Concatenated text content (tool-use payloads and internals are elided). */
  text: string;
  timestamp?: string;
  uuid?: string;
  /** Tool-reported stop reason for assistant messages; null/undefined mid-turn. */
  stopReason?: string | null;
}

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
   */
  interactiveCommand(baseCommand: string, model?: string): string;

  /** One-shot command for a fire-and-forget task run. */
  taskCommand(baseCommand: string, escapedPrompt: string, model?: string): string;

  /** Where this tool persists session files for work rooted at `cwd`. */
  sessionDir(cwd: string): string;

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
   * the worktree (design §5). Returns the created paths relative to the
   * worktree so callers can keep them out of task commits.
   */
  materialize(agent: AgentProfile, worktreePath: string): Promise<string[]>;
}
