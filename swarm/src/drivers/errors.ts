// Typed failures for persistent sessions (design §7). Task-run error handling
// is untouched — these surface only from the driver/session substrate.

/** The tool binary never produced a session (missing, or died at launch). */
export class ToolLaunchError extends Error {
  readonly code = 'tool_launch_failed';
  constructor(tool: string, detail: string) {
    super(`${tool} failed to launch a session: ${detail}`);
  }
}

/** The addressed session id is unknown. */
export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found';
  constructor(id: string) {
    super(`agent session ${id} not found`);
  }
}

/** The session's process is gone. Context died with it — caller decides whether to rebuild. */
export class SessionDeadError extends Error {
  readonly code = 'session_dead';
  constructor(id: string) {
    super(`agent session ${id} is dead — accumulated context is lost; start a new session to rebuild`);
  }
}

/** A turn did not complete in time; the send was cancelled (C-c). */
export class TurnTimeoutError extends Error {
  readonly code = 'turn_timeout';
  constructor(id: string, timeoutMs: number) {
    super(`agent session ${id}: turn did not complete within ${timeoutMs}ms — cancelled`);
  }
}

/** A session file failed to parse — a driver bug. Fails loud with the offending excerpt. */
export class SessionParseError extends Error {
  readonly code = 'session_parse_failed';
  constructor(tool: string, excerpt: string, cause?: unknown) {
    super(`${tool} session file parse failed on: ${excerpt.slice(0, 200)}${cause ? ` (${String(cause)})` : ''}`);
  }
}
