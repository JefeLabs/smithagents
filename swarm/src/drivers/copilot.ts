// GitHub Copilot CLI driver.
//
// Copilot persists to SQLite at ~/.copilot/session-store.db:
//   sessions(id, cwd, repository, branch, …)
//   turns(session_id, turn_index, user_message, assistant_response, timestamp)
//
// The `turns` table is the cleanest completion signal of any tool here: a row
// with a non-null assistant_response IS a finished turn, recorded by the tool
// itself. Sessions are keyed by cwd, so discovery is a single query.
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { modelFlag } from "./model-flag.js";
import { query } from "./sqlite.js";
import type { AgentProfile, NormalizedMessage, ToolDriver } from "./types.js";

export class CopilotDriver implements ToolDriver {
  readonly id = "copilot";

  constructor(private readonly configDir: string = process.env.COPILOT_HOME ?? join(homedir(), ".copilot")) {}

  private get db(): string {
    return join(this.configDir, "session-store.db");
  }

  interactiveCommand(baseCommand: string, model?: string): string {
    return `${baseCommand}${modelFlag(model)}`;
  }

  taskCommand(baseCommand: string, escapedPrompt: string, model?: string): string {
    return `${baseCommand}${modelFlag(model)} -p '${escapedPrompt}'`;
  }

  sessionDir(_cwd: string): string {
    return this.configDir;
  }

  async listSessionFiles(cwd: string): Promise<string[]> {
    const rows = await query(this.db, "select id from sessions where cwd = ? order by updated_at desc limit 20", [cwd]);
    return rows.map((r) => `db::${r.id}`);
  }

  parseSessionFile(): NormalizedMessage[] {
    return []; // content lives in the database; see readMessages
  }

  async readMessages(handle: string): Promise<NormalizedMessage[]> {
    const sessionId = handle.replace(/^db::/, "");
    const rows = await query(
      this.db,
      "select turn_index, user_message, assistant_response, timestamp from turns where session_id = ? order by turn_index asc",
      [sessionId],
    );
    const messages: NormalizedMessage[] = [];
    for (const row of rows) {
      const at = row.timestamp ? new Date(`${row.timestamp.replace(" ", "T")}Z`).toISOString() : undefined;
      if (row.user_message) messages.push({ role: "user", text: row.user_message, timestamp: at });
      if (row.assistant_response) {
        // A recorded assistant_response is a completed turn by construction.
        messages.push({ role: "assistant", text: row.assistant_response, timestamp: at, stopReason: "end_turn" });
      }
    }
    return messages;
  }

  isTurnComplete(messages: NormalizedMessage[], sinceIso: string): boolean {
    return messages.some(
      (m) => m.role === "assistant" && m.stopReason === "end_turn" && (m.timestamp ?? "") > sinceIso,
    );
  }

  async materialize(agent: AgentProfile, worktreePath: string): Promise<string[]> {
    // Copilot reads repo instructions from .github/copilot-instructions.md.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(worktreePath, ".github"), { recursive: true });
    await writeFile(
      join(worktreePath, ".github/copilot-instructions.md"),
      [
        `# ${agent.name} — ${agent.role}`,
        "",
        agent.directives,
        "",
        `You are ${agent.name}. Stay within your role's domain.`,
        "",
      ].join("\n"),
    );
    return [".github/copilot-instructions.md"];
  }
}
