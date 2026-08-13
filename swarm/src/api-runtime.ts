// The api-kind agents' runtime (api-runtime spec 2026-08-13). Deliberately
// NOT a RuntimeAdapter: an api agent has no process to launch — its unit is
// a TURN, and its whole runtime state is a serializable session file under
// .smith/api-sessions/<agentId>/. Restarts cost nothing; ECS costs nothing.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComposedAgent } from "./agents.js";
import type { ApiProvider } from "./api-provider.js";

export interface ApiSessionMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface ApiSession {
  id: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  messages: ApiSessionMessage[];
}

/** What a provider call may carry: a thinker session, not an archive problem — the file keeps everything. */
const SEND_CAP = 40;

/** Session ids are path segments; mint and accept only this shape. */
const SESSION_ID = /^[a-z0-9-]{1,64}$/;

export class ApiRuntime {
  constructor(
    private readonly dir: string,
    private readonly provider: ApiProvider,
  ) {}

  private agentDir(agentId: string): string {
    return join(this.dir, agentId);
  }

  private sessionPath(agentId: string, sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
    return join(this.agentDir(agentId), `${sessionId}.json`);
  }

  /**
   * Run one turn. A null sessionId starts a fresh session. The provider sees
   * the persona-built system prompt plus the capped history; BOTH sides are
   * appended only after the provider succeeds — a failed turn persists
   * nothing, so the transcript is exactly what the model has actually seen.
   */
  async runTurn(
    agent: ComposedAgent,
    sessionId: string | null,
    message: string,
  ): Promise<{ sessionId: string; reply: string }> {
    const now = () => new Date().toISOString();
    const id = sessionId ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const path = this.sessionPath(agent.id, id);
    let session: ApiSession;
    if (sessionId === null) {
      session = { id, agentId: agent.id, createdAt: now(), updatedAt: now(), messages: [] };
    } else {
      session = await this.load(agent.id, sessionId);
    }
    const outgoing = [...session.messages, { role: "user" as const, text: message, at: now() }];
    const reply = await this.provider.complete({
      model: agent.engine.model,
      system: buildSystemPrompt(agent),
      messages: outgoing.slice(-SEND_CAP).map((m) => ({ role: m.role, text: m.text })),
    });
    session.messages = [...outgoing, { role: "assistant", text: reply, at: now() }];
    session.updatedAt = now();
    await mkdir(this.agentDir(agent.id), { recursive: true });
    await writeFile(path, JSON.stringify(session, null, 2));
    return { sessionId: id, reply };
  }

  /**
   * One turn, no memory (elections spec 2026-08-13): the persona answers a
   * single message and NOTHING is written to disk. Built for blind,
   * stateless asks — an election claim is evidence on the group, not a
   * conversation with the agent.
   */
  async runOneShot(agent: ComposedAgent, message: string): Promise<string> {
    return this.provider.complete({
      model: agent.engine.model,
      system: buildSystemPrompt(agent),
      messages: [{ role: "user", text: message }],
    });
  }

  async load(agentId: string, sessionId: string): Promise<ApiSession> {
    const raw = await readFile(this.sessionPath(agentId, sessionId), "utf8");
    return JSON.parse(raw) as ApiSession;
  }

  async listSessions(agentId: string): Promise<Array<{ id: string; createdAt: string; updatedAt: string; messageCount: number }>> {
    let files: string[];
    try {
      files = await readdir(this.agentDir(agentId));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files.filter((f) => f.endsWith(".json"))) {
      try {
        const s = JSON.parse(await readFile(join(this.agentDir(agentId), f), "utf8")) as ApiSession;
        out.push({ id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length });
      } catch {
        // A corrupt session file is skipped, not fatal — the rest still list.
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  /** True when a session was deleted; false when it never existed. */
  async deleteSession(agentId: string, sessionId: string): Promise<boolean> {
    try {
      await rm(this.sessionPath(agentId, sessionId));
      return true;
    } catch {
      return false;
    }
  }
}

/** The thinker's charter: who they are, how they talk, what language they answer in. */
export function buildSystemPrompt(agent: ComposedAgent): string {
  const parts = [
    `You are ${agent.name}, ${agent.role}.`,
    agent.directives,
    agent.persona?.style ? `Communication style: ${agent.persona.style}` : null,
    agent.backstory ? `Background: ${agent.backstory}` : null,
    agent.language ? `Answer in ${agent.language}.` : null,
  ];
  return parts.filter(Boolean).join("\n\n");
}
