/**
 * SwarmClient — the broker's ONLY window into the swarm. HTTP + WS, no code
 * imports: swarm is a service and these wire types mirror its contract
 * (swarm/src/server.ts routes). If swarm's API changes, this file changes.
 */
import WebSocket from 'ws';

export interface SpeechProfile {
  voiceName?: string;
  lang?: string;
  pitch?: number;
  rate?: number;
}

export interface RegistryAgent {
  id: string;
  name: string;
  role: string;
  directives: string;
  engine: { cli: 'agy' | 'claude' | 'codex'; model: string };
  persona?: { style: string };
  voice?: { provider: string; voiceId?: string; speech?: SpeechProfile };
  avatarRing?: string;
  archived?: boolean;
  /** Channel adapter kinds this agent may speak on (e.g. "discord"); undefined = all. */
  channels?: string[];
}

export interface SwarmSquad {
  id: string;
  status: 'active' | 'idle';
  taskId?: string | null;
  leader: { name: string; role: string };
  members: Array<{ name: string; role: string }>;
}

export interface WorkspaceBody {
  name: string;
  description?: string;
  repos: Array<{ name: string; path: string; repository?: string; branch?: string }>;
  default?: boolean;
}

export interface SwarmWorkspace extends WorkspaceBody {
  default: boolean;
  archived?: boolean;
}

export interface SwarmMeeting {
  id: string;
  roomName: string;
  agentIds: string[];
  mode: 'solo' | 'council';
  status: 'open' | 'closed';
  createdAt: string;
}

export type SwarmEvent =
  | ({ type: 'state:snapshot' } & Record<string, unknown>)
  | { type: 'task:dispatched'; taskId: string; sessionName: string }
  | { type: 'task:completed'; taskId: string; result: unknown }
  | { type: 'task:failed'; taskId: string; result: unknown }
  | { type: 'task:quarantined'; taskId: string; reason: string };

export interface WsLike {
  on(ev: 'open' | 'message' | 'close' | 'error', cb: (arg?: unknown) => void): void;
  close(): void;
}

export interface SwarmClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WsLike;
}

export class SwarmClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: (url: string) => WsLike;

  constructor(opts: SwarmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
  }

  async submitTask(req: {
    prompt: string;
    agent: 'agy' | 'claude' | 'codex';
    repository: string;
    branch?: string;
    workspace?: string;
    repo?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ taskId: string; agentName: string | null }> {
    const body = {
      prompt: req.prompt,
      agent: req.agent,
      context: { files: [], repository: req.repository, branch: req.branch ?? '', workspace: req.workspace, repo: req.repo },
      metadata: req.metadata,
    };
    const r = await this.http('POST', '/tasks', body);
    return { taskId: r.taskId as string, agentName: (r.agentName as string | null) ?? null };
  }

  async getOutput(taskIdOrName: string): Promise<{ taskId: string; output: string }> {
    const r = await this.http('GET', `/tasks/${encodeURIComponent(taskIdOrName)}/output`);
    return { taskId: r.taskId as string, output: r.output as string };
  }

  async steer(taskIdOrName: string, message: string): Promise<void> {
    await this.http('POST', `/tasks/${encodeURIComponent(taskIdOrName)}/steer`, { message });
  }

  async killTask(taskIdOrName: string): Promise<void> {
    await this.http('POST', `/tasks/${encodeURIComponent(taskIdOrName)}/kill`, {});
  }

  async registry(): Promise<RegistryAgent[]> {
    const r = await this.http('GET', '/agents/registry');
    return r.agents as RegistryAgent[];
  }

  async listMeetings(): Promise<SwarmMeeting[]> {
    const r = await this.http('GET', '/meetings');
    return r.meetings as SwarmMeeting[];
  }

  async listSquads(): Promise<SwarmSquad[]> {
    const r = await this.http('GET', '/squads');
    return (r.squads as SwarmSquad[]).filter((s) => s.leader?.name);
  }

  /** IDs of tasks the swarm currently considers live (queued or active). */
  async listLiveTaskIds(): Promise<Set<string>> {
    const r = await this.http('GET', '/tasks');
    const ids = new Set<string>();
    for (const t of [...((r.active as Array<{ taskId: string }>) ?? []), ...((r.queued as Array<{ taskId: string }>) ?? [])]) {
      ids.add(t.taskId);
    }
    return ids;
  }

  /** Tiered runtime reset on the orchestrator (remote workers are never killed). */
  async reset(scope: { runtime?: boolean; worktrees?: boolean; agents?: boolean }): Promise<Record<string, unknown>> {
    return this.http('POST', '/reset', scope);
  }

  /** Stereotypes, quick questions and reaction levels for the creation wizard. */
  async agentCatalog(): Promise<Record<string, unknown>> {
    return this.http('GET', '/agents/catalog');
  }

  /** Create a composed agent from the wizard payload. */
  async createAgent(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.http('POST', '/agents', body);
  }

  async updateAgent(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.http('PUT', `/agents/${encodeURIComponent(id)}`, body);
  }

  async agentUsage(id: string): Promise<{ warmSessions: number; activeTasks: number }> {
    const r = await this.http('GET', `/agents/${encodeURIComponent(id)}/usage`);
    return { warmSessions: r.warmSessions as number, activeTasks: r.activeTasks as number };
  }

  async archiveAgent(id: string): Promise<void> {
    await this.http('POST', `/agents/${encodeURIComponent(id)}/archive`, {});
  }

  async deleteAgent(id: string): Promise<void> {
    await this.http('DELETE', `/agents/${encodeURIComponent(id)}`, undefined);
  }

  async createWorkspace(body: WorkspaceBody): Promise<SwarmWorkspace> {
    const r = await this.http('POST', '/workspaces', body);
    return r as unknown as SwarmWorkspace;
  }

  async updateWorkspace(name: string, body: Partial<WorkspaceBody>): Promise<SwarmWorkspace> {
    const r = await this.http('PUT', `/workspaces/${encodeURIComponent(name)}`, body);
    return r as unknown as SwarmWorkspace;
  }

  async archiveWorkspace(name: string): Promise<void> {
    await this.http('POST', `/workspaces/${encodeURIComponent(name)}/archive`, {});
  }

  async deleteWorkspace(name: string): Promise<void> {
    await this.http('DELETE', `/workspaces/${encodeURIComponent(name)}`, undefined);
  }

  async workspaceUsage(name: string): Promise<{ activeTasks: number }> {
    const r = await this.http('GET', `/workspaces/${encodeURIComponent(name)}/usage`);
    return { activeTasks: r.activeTasks as number };
  }

  async listWorkspaces(): Promise<SwarmWorkspace[]> {
    const r = await this.http('GET', '/workspaces');
    return (r.workspaces as SwarmWorkspace[]) ?? [];
  }

  /** Subscribe to /ws events. Reconnects every 2s until the returned fn is called. */
  subscribe(onEvent: (e: SwarmEvent) => void): () => void {
    const wsUrl =
      this.baseUrl.replace(/^http/, 'ws') + '/ws' + (this.token ? `?token=${encodeURIComponent(this.token)}` : '');
    let stopped = false;
    let current: WsLike | null = null;
    let timer: NodeJS.Timeout | null = null;

    const connect = () => {
      if (stopped) return;
      const ws = this.wsFactory(wsUrl);
      current = ws;
      ws.on('message', (data) => {
        try {
          onEvent(JSON.parse(String(data)) as SwarmEvent);
        } catch {
          /* non-JSON frame — ignore */
        }
      });
      ws.on('close', () => {
        if (!stopped) timer = setTimeout(connect, 2000);
      });
      ws.on('error', () => {
        /* close follows; reconnect handles it */
      });
    };
    connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      current?.close();
    };
  }

  private async http(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    // Only set content-type when a body actually follows: fastify's default
    // JSON body parser 400s ("FST_ERR_CTP_EMPTY_JSON_BODY") on a
    // Content-Type: application/json request with no body, which is exactly
    // what deleteAgent/deleteWorkspace send. That 400 silently defeated every
    // delete-outcome removal through the broker until this was e2e-tested.
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // Surface swarm's own reason. Validation errors ("Invalid model id: …")
      // exist to be read by a human in the wizard; a bare status code makes
      // that message unreachable and the field impossible to fix.
      const detail = await res
        .json()
        .then((b) => (b as { error?: string }).error)
        .catch(() => undefined);
      throw new Error(detail ?? `swarm ${method} ${path} -> ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}
