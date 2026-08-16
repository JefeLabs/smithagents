// Claude CLI driver — the first and primary tool driver (design §4).
//
// Claude persists sessions as JSONL under
//   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// where <encoded-cwd> is the working directory with every non-alphanumeric
// character replaced by '-'. Each line is one event; conversation lines have
// type 'user' | 'assistant' with a `message` payload. The final assistant
// message of a turn carries a terminal stop_reason — that, and only that, is
// the turn-completion signal (never process exit, never screen state).
import { execFile } from "node:child_process";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { SessionParseError } from "./errors.js";
import { modelFlag } from "./model-flag.js";
import type { AgentProfile, CommandRunner, NormalizedMessage, ToolDriver } from "./types.js";

/** True when `path` (relative to `cwd`) is already tracked by the repo's git index. Mirrors isGitRepo()'s "call git, interpret exit code" pattern in workspaces.ts. */
async function isTracked(cwd: string, path: string): Promise<boolean> {
  try {
    await promisify(execFile)("git", ["ls-files", "--error-unmatch", path], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** stop_reason values that end a turn; 'tool_use' and null are mid-turn. */
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

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
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export class ClaudeDriver implements ToolDriver {
  readonly id = "claude";

  constructor(private readonly configDir: string = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")) {}

  interactiveCommand(baseCommand: string, model?: string, sessionId?: string): string {
    return `${baseCommand}${modelFlag(model)}${sessionId ? ` --session-id ${sessionId}` : ""}`;
  }

  taskCommand(baseCommand: string, escapedPrompt: string, model?: string): string {
    return `${baseCommand}${modelFlag(model)} --print '${escapedPrompt}'`;
  }

  sessionDir(cwd: string): string {
    return join(this.configDir, "projects", encodeProjectDir(cwd));
  }

  sessionFileFor(cwd: string, sessionId: string): string {
    return join(this.sessionDir(cwd), `${sessionId}.jsonl`);
  }

  /**
   * Pre-accept the folder-trust gate for `cwd`. Every warm session runs in a
   * fresh worktree, which the CLI has never seen, so it opens the "Yes, I trust
   * this folder" modal. That modal satisfies both readiness signals (tmux
   * session exists, process alive), so the session reports ready — and then the
   * first send types into the dialog and its Enter answers the DIALOG instead
   * of submitting the prompt. The turn silently never happens. The Dockerfile
   * clears the same gate for /workspace; this is that fix for the local path.
   */
  async prepareWorkspace(cwd: string): Promise<void> {
    // .claude.json sits BESIDE the config dir, not inside it.
    const configPath = join(dirname(this.configDir), ".claude.json");
    let cfg: { projects?: Record<string, Record<string, unknown>> } = {};
    try {
      cfg = JSON.parse(await readFile(configPath, "utf8"));
    } catch (err) {
      // Only a genuinely absent file justifies starting fresh. A parse error or
      // a permissions failure must NOT be treated as "empty config" — that
      // would overwrite every project the user has, trust flags and all.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    cfg.projects = { ...cfg.projects, [cwd]: { ...cfg.projects?.[cwd], hasTrustDialogAccepted: true } };

    // Write-and-rename: the CLI rewrites this file as it runs, so a torn write
    // here would corrupt a config other live sessions depend on.
    const tmp = `${configPath}.smith-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    await rename(tmp, configPath);
  }

  async listSessionFiles(cwd: string): Promise<string[]> {
    const dir = this.sessionDir(cwd);
    try {
      const entries = await readdir(dir);
      return entries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
    } catch {
      return []; // tool hasn't created the project dir yet
    }
  }

  parseSessionFile(content: string): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let parsed: ClaudeLine;
      try {
        parsed = JSON.parse(line) as ClaudeLine;
      } catch (err) {
        throw new SessionParseError("claude", line, err);
      }
      if (parsed.type !== "user" && parsed.type !== "assistant") continue; // titles, modes, snapshots, …
      if (parsed.isSidechain) continue; // subagent transcripts are not the conversation
      const message = parsed.message;
      if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .filter((block) => block.type === "text" && typeof block.text === "string")
              .map((block) => block.text as string)
              .join("\n");
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
        m.role === "assistant" &&
        m.stopReason != null &&
        TERMINAL_STOP_REASONS.has(m.stopReason) &&
        (m.timestamp ?? "") > sinceIso,
    );
  }

  async materialize(
    agent: AgentProfile,
    worktreePath: string,
    atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[] },
  ): Promise<string[]> {
    // CLAUDE.md is claude's native instruction surface — by the time the TUI
    // starts, the agent already is this persona (design §5). Meeting-only
    // fields (voice, persona.style) are deliberately not rendered.
    const lines = [
      `# ${agent.name} — ${agent.role}`,
      "",
      agent.directives,
      "",
      `You are ${agent.name}. Stay within your role's domain; when work belongs to another specialist, say so instead of doing it badly.`,
      "",
    ];
    await writeFile(join(worktreePath, "CLAUDE.md"), lines.join("\n"));
    const written = ["CLAUDE.md"];

    if (atlassian) {
      const alreadyTracked = await isTracked(worktreePath, ".mcp.json");
      if (alreadyTracked) {
        // The repo has its own committed .mcp.json — never overwrite a tracked file
        // with injected config (it would get swept into the task's commit). Skip
        // Atlassian MCP injection for this task rather than clobber the repo's own
        // config.
        return written;
      }
      // mcp-atlassian (community server, API-token auth — no OAuth) is
      // configured via env vars it reads at startup. JIRA_PROJECTS_FILTER and
      // CONFLUENCE_SPACES_FILTER scope it to the workspace's configured
      // project/space keys when set; omitted = whole site, matching the
      // Workspace.atlassian type's own "omitted = whole site" semantics.
      const mcpConfig = {
        mcpServers: {
          atlassian: {
            command: "uvx",
            args: ["mcp-atlassian"],
            env: {
              JIRA_URL: atlassian.siteUrl,
              // biome-ignore-start lint/suspicious/noTemplateCurlyInString: literal ${VAR} placeholders the CLI expands from its own env at startup — resolving them here would write the credential into .mcp.json
              JIRA_USERNAME: "${SMITH_ATLASSIAN_EMAIL}",
              JIRA_API_TOKEN: "${SMITH_ATLASSIAN_TOKEN}",
              CONFLUENCE_URL: `${atlassian.siteUrl.replace(/\/$/, "")}/wiki`,
              CONFLUENCE_USERNAME: "${SMITH_ATLASSIAN_EMAIL}",
              CONFLUENCE_API_TOKEN: "${SMITH_ATLASSIAN_TOKEN}",
              // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of placeholder block
              ...(atlassian.jiraProjectKeys?.length
                ? { JIRA_PROJECTS_FILTER: atlassian.jiraProjectKeys.join(",") }
                : {}),
              ...(atlassian.confluenceSpaceKeys?.length
                ? { CONFLUENCE_SPACES_FILTER: atlassian.confluenceSpaceKeys.join(",") }
                : {}),
            },
          },
        },
      };
      await writeFile(join(worktreePath, ".mcp.json"), `${JSON.stringify(mcpConfig, null, 2)}\n`);
      written.push(".mcp.json");
    }

    return written;
  }

  async verifyAuth(
    binary: string,
    run: CommandRunner,
    timeoutMs: number,
  ): Promise<{ ok: boolean | "unknown"; detail: string }> {
    // `claude auth status` prints JSON: {"loggedIn":true,"authMethod":"claude.ai","email":…}.
    const res = await run([binary, "auth", "status"], timeoutMs);
    try {
      const parsed = JSON.parse(res.stdout.trim()) as { loggedIn?: boolean; email?: string };
      if (parsed.loggedIn === true) {
        return { ok: true, detail: `logged in${parsed.email ? ` as ${parsed.email}` : ""}` };
      }
      if (parsed.loggedIn === false) return { ok: false, detail: "not logged in — run `claude /login`" };
    } catch {
      /* not JSON — older CLI or unexpected output: not a confirmed negative */
    }
    return { ok: "unknown", detail: "auth status unrecognized" };
  }
}
