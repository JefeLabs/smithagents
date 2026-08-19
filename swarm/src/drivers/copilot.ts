// GitHub Copilot CLI driver.
//
// Copilot persists to SQLite at ~/.copilot/session-store.db:
//   sessions(id, cwd, repository, branch, …)
//   turns(session_id, turn_index, user_message, assistant_response, timestamp)
//
// The `turns` table is the cleanest completion signal of any tool here: a row
// with a non-null assistant_response IS a finished turn, recorded by the tool
// itself. Sessions are keyed by cwd, so discovery is a single query.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthFailure } from "../cli-tools.js";
import { modelFlag } from "./model-flag.js";
import { query } from "./sqlite.js";
import type { AgentProfile, CommandRunner, NormalizedMessage, ToolDriver } from "./types.js";

/** The CLI's own token precedence (`copilot help environment`). */
const TOKEN_VARS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

export class CopilotDriver implements ToolDriver {
  readonly id = "copilot";

  constructor(
    private readonly configDir: string = process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

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

  async verifyAuth(
    _binary: string,
    _run: CommandRunner,
    _timeoutMs: number,
  ): Promise<{ ok: boolean | "unknown"; detail: string; failure?: AuthFailure }> {
    // Copilot CLI (checked at v1.0.80) has no non-interactive auth-status
    // command, and a real `-p` run costs a premium request — so this probe is
    // PASSIVE: it names the credential this process would launch with. It
    // never confirms either way: a present token can still be policy-blocked,
    // and an absent one can hide a valid keychain login.
    for (const name of TOKEN_VARS) {
      if (this.env[name]?.trim()) return { ok: "unknown", detail: `token present via ${name} (unverified)` };
    }
    try {
      // config.json is JSONC — the CLI writes `//` comment lines above the object.
      const raw = await readFile(join(this.configDir, "config.json"), "utf8");
      const json = raw
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n");
      const login = (JSON.parse(json) as { lastLoggedInUser?: { login?: string } }).lastLoggedInUser?.login;
      if (login) return { ok: "unknown", detail: `stored login as ${login} (unverified)` };
    } catch {
      /* missing or unparsable store — fall through to "nothing visible" */
    }
    return { ok: "unknown", detail: "no credentials visible — run `copilot login` or set COPILOT_GITHUB_TOKEN" };
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
