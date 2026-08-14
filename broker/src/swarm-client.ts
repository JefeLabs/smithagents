/**
 * SwarmClient — the broker's ONLY window into the swarm. HTTP + WS, no code
 * imports: swarm is a service and these wire types mirror its contract
 * (swarm/src/server.ts routes). If swarm's API changes, this file changes.
 */
import WebSocket from "ws";
import type { ContextSourceWire } from "./feeds/context-sources.ts";

export interface SpeechProfile {
  voiceName?: string;
  lang?: string;
  pitch?: number;
  rate?: number;
}

export interface ConnectorFieldDef {
  key: string;
  label: string;
  secret: boolean;
  type?: "text" | "select";
  options?: { value: string; label: string }[];
}

export interface ConnectorVendorMeta {
  id: string;
  label: string;
  description: string;
  fields: ConnectorFieldDef[];
  verifyExtraFields: ConnectorFieldDef[];
}

export interface ConnectorInstanceRecord {
  id: string;
  vendorId: string;
  label: string;
  fields: Record<string, string | boolean>;
}

export interface CliToolStatusRecord {
  detected: boolean;
  authOk: boolean | "unknown";
  enabled: boolean;
  detail: string;
  version?: string;
  lastCheckedAt: string;
}

export interface CliToolListing {
  cli: string;
  label: string;
  models: string[];
  warmSessions: boolean;
  note?: string;
  status: CliToolStatusRecord | null;
  active: boolean;
}

export interface VoiceKeys {
  stt: { vendorId: string; apiKey: string } | null;
  tts: { vendorId: string; apiKey: string } | null;
}

export interface RegistryAgent {
  id: string;
  name: string;
  role: string;
  directives: string;
  engine: { cli: "agy" | "claude" | "codex"; model: string };
  persona?: { style: string };
  voice?: { provider: string; voiceId?: string; speech?: SpeechProfile };
  avatarRing?: string;
  /** Portrait filename; fetch bytes via GET /avatars/<file>. */
  avatar?: string;
  archived?: boolean;
  /** Legacy array of adapter kinds this agent may speak on (e.g. "discord"), or a per-surface mode map; undefined = all. */
  channels?: string[] | Record<string, string>;
}

export interface SwarmSquad {
  id: string;
  status: "active" | "idle";
  taskId?: string | null;
  leader: { name: string; role: string };
  members: Array<{ name: string; role: string }>;
}

export interface WorkspaceBody {
  name: string;
  description?: string;
  repos: Array<{
    name: string;
    path: string;
    repository?: string;
    branch?: string;
    github?: { owner: string; repo: string; connectorId?: string };
    /** Creation-time only: git init the path if it isn't a repo yet. Never persisted by swarm. */
    initGit?: boolean;
  }>;
  default?: boolean;
  links?: string[];
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[]; connectorId?: string };
  // sources ride through untouched — dropping them here would wipe context sources on every workspace save
  sources?: unknown[];
}

export interface SwarmWorkspace extends WorkspaceBody {
  default: boolean;
  archived?: boolean;
}

/** What POST/PUT /groups accept — membership is names, nesting allowed. */
export interface SwarmGroupBody {
  name: string;
  description?: string;
  workspaces: string[];
  groups: string[];
  color?: string;
}

/** What GET /groups returns: the group plus its transitive member workspaces. */
export interface SwarmGroup extends SwarmGroupBody {
  expansion: string[];
}

export interface MeRecord {
  id: string;
  name: string;
  connectors: ConnectorInstanceRecord[];
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

export interface ChannelsRecord {
  hasDiscordToken: boolean;
  textChannels: string[];
  voiceChannels: string[];
}

/** Raw shape — holds the actual bot token. Only getWorkspaceDiscordConfig returns this. */
export interface DiscordChannelsConfig {
  botToken: string;
  textChannels: string[];
  voiceChannels: string[];
}

export interface TicketResult {
  key: string;
  summary: string;
  status: string;
  url: string;
}

export interface DocResult {
  title: string;
  excerpt: string;
  url: string;
}

export interface SwarmMeeting {
  id: string;
  roomName: string;
  agentIds: string[];
  mode: "solo" | "council";
  status: "open" | "closed";
  createdAt: string;
}

export type SwarmEvent =
  | ({ type: "state:snapshot" } & Record<string, unknown>)
  | { type: "task:dispatched"; taskId: string; sessionName: string }
  | { type: "task:completed"; taskId: string; result: unknown; workCardRef?: { boardId: string; cardId: string } }
  | { type: "task:failed"; taskId: string; result: unknown; workCardRef?: { boardId: string; cardId: string } }
  | { type: "task:quarantined"; taskId: string; reason: string };

export interface WsLike {
  on(ev: "open" | "message" | "close" | "error", cb: (arg?: unknown) => void): void;
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
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
  }

  async submitTask(req: {
    prompt: string;
    agent: "agy" | "claude" | "codex";
    repository: string;
    branch?: string;
    workspace?: string;
    repo?: string;
    runtime?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ taskId: string; agentName: string | null }> {
    const body = {
      prompt: req.prompt,
      agent: req.agent,
      context: {
        files: [],
        repository: req.repository,
        branch: req.branch ?? "",
        workspace: req.workspace,
        repo: req.repo,
      },
      runtime: req.runtime,
      metadata: req.metadata,
    };
    const r = await this.http("POST", "/tasks", body);
    return { taskId: r.taskId as string, agentName: (r.agentName as string | null) ?? null };
  }

  /**
   * One-shot api-agent turn (elections-via-api-runtime spec 2026-08-13).
   * A clean 404 means "not an api-kind registry agent" — the caller's cue to
   * fall back; any OTHER failure (billing/auth 502s included) throws with the
   * swarm's typed message so it lands in the claim's recorded reason instead
   * of triggering a second paid ask. Bounded at 10s: an election must not
   * hang on one silent member.
   */
  async apiAgentOneShot(agentId: string, message: string): Promise<{ reply: string } | { notApiAgent: true }> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}/api-agents/${encodeURIComponent(agentId)}/turn`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, oneshot: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { notApiAgent: true };
    const parsed = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
    if (!res.ok) throw new Error(parsed.error ?? `swarm turn failed (${res.status})`);
    if (typeof parsed.reply !== "string") throw new Error("swarm turn returned no reply");
    return { reply: parsed.reply };
  }

  async getOutput(taskIdOrName: string): Promise<{ taskId: string; output: string }> {
    const r = await this.http("GET", `/tasks/${encodeURIComponent(taskIdOrName)}/output`);
    return { taskId: r.taskId as string, output: r.output as string };
  }

  async steer(taskIdOrName: string, message: string): Promise<void> {
    await this.http("POST", `/tasks/${encodeURIComponent(taskIdOrName)}/steer`, { message });
  }

  async killTask(taskIdOrName: string): Promise<void> {
    await this.http("POST", `/tasks/${encodeURIComponent(taskIdOrName)}/kill`, {});
  }

  /**
   * Task status passthrough for the external bridge (Copilot/Claude, see
   * broker/bin/smith-broker-check.mjs) — unlike every other method here,
   * this one must tell a genuine "task not found" (404) apart from a real
   * failure (network, 5xx), so it can't reuse the shared `http()` helper,
   * which flattens every non-2xx into a single thrown Error with no status
   * code attached.
   */
  async getTask(taskId: string): Promise<{ taskId: string; status: string; result?: unknown } | null> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}`, { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res
        .json()
        .then((b) => (b as { error?: string }).error)
        .catch(() => undefined);
      throw new Error(detail ?? `swarm GET /tasks/${taskId} -> ${res.status}`);
    }
    return (await res.json()) as { taskId: string; status: string; result?: unknown };
  }

  async registry(): Promise<RegistryAgent[]> {
    const r = await this.http("GET", "/agents/registry");
    return r.agents as RegistryAgent[];
  }

  async listMeetings(): Promise<SwarmMeeting[]> {
    const r = await this.http("GET", "/meetings");
    return r.meetings as SwarmMeeting[];
  }

  async listSquads(): Promise<SwarmSquad[]> {
    const r = await this.http("GET", "/squads");
    return (r.squads as SwarmSquad[]).filter((s) => s.leader?.name);
  }

  /** IDs of tasks the swarm currently considers live (queued or active). */
  async listLiveTaskIds(): Promise<Set<string>> {
    const r = await this.http("GET", "/tasks");
    const ids = new Set<string>();
    for (const t of [
      ...((r.active as Array<{ taskId: string }>) ?? []),
      ...((r.queued as Array<{ taskId: string }>) ?? []),
    ]) {
      ids.add(t.taskId);
    }
    return ids;
  }

  /** Tiered runtime reset on the orchestrator (remote workers are never killed). */
  async reset(scope: { runtime?: boolean; worktrees?: boolean; agents?: boolean }): Promise<Record<string, unknown>> {
    return this.http("POST", "/reset", scope);
  }

  /** Stereotypes, quick questions and reaction levels for the creation wizard. */
  async agentCatalog(): Promise<Record<string, unknown>> {
    return this.http("GET", "/agents/catalog");
  }

  /**
   * Raw PNG bytes for an avatar file, or null when the swarm has none. Can't
   * reuse the shared `http()` helper — that flattens every non-2xx into a
   * thrown Error and always JSON-decodes the body, and a routine 404 here
   * (no such avatar) isn't a failure worth surfacing, plus the body is bytes,
   * not JSON. Same auth as `http()`, no body so no content-type header —
   * matches `getTask`'s GET pattern above.
   */
  async avatarFile(file: string): Promise<Buffer | null> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}/avatars/${encodeURIComponent(file)}`, { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`swarm GET /avatars/${file} -> ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Create a composed agent from the wizard payload. */
  async createAgent(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.http("POST", "/agents", body);
  }

  async updateAgent(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.http("PUT", `/agents/${encodeURIComponent(id)}`, body);
  }

  async agentUsage(id: string): Promise<{ warmSessions: number; activeTasks: number }> {
    const r = await this.http("GET", `/agents/${encodeURIComponent(id)}/usage`);
    return { warmSessions: r.warmSessions as number, activeTasks: r.activeTasks as number };
  }

  async archiveAgent(id: string): Promise<void> {
    await this.http("POST", `/agents/${encodeURIComponent(id)}/archive`, {});
  }

  async deleteAgent(id: string): Promise<void> {
    await this.http("DELETE", `/agents/${encodeURIComponent(id)}`, undefined);
  }

  async createWorkspace(body: WorkspaceBody): Promise<SwarmWorkspace> {
    const r = await this.http("POST", "/workspaces", body);
    return r as unknown as SwarmWorkspace;
  }

  async updateWorkspace(name: string, body: Partial<WorkspaceBody>): Promise<SwarmWorkspace> {
    const r = await this.http("PUT", `/workspaces/${encodeURIComponent(name)}`, body);
    return r as unknown as SwarmWorkspace;
  }

  async archiveWorkspace(name: string): Promise<void> {
    await this.http("POST", `/workspaces/${encodeURIComponent(name)}/archive`, {});
  }

  async deleteWorkspace(name: string): Promise<void> {
    await this.http("DELETE", `/workspaces/${encodeURIComponent(name)}`, undefined);
  }

  async workspaceUsage(name: string): Promise<{ activeTasks: number }> {
    const r = await this.http("GET", `/workspaces/${encodeURIComponent(name)}/usage`);
    return { activeTasks: r.activeTasks as number };
  }

  // sources come back read-only here (Task 1's projection) — writing them back
  // through WorkspaceBody.sources is the swarm's job, never the broker's.
  async listWorkspaces(): Promise<Array<SwarmWorkspace & { sources?: ContextSourceWire[] }>> {
    const r = await this.http("GET", "/workspaces");
    return (r.workspaces as Array<SwarmWorkspace & { sources?: ContextSourceWire[] }>) ?? [];
  }

  // Workspace groups (spec 2026-08-11-workspace-groups). The swarm's GET
  // carries each group's precomputed transitive `expansion` — consumers never
  // re-walk membership.
  async listGroups(): Promise<SwarmGroup[]> {
    const r = await this.http("GET", "/groups");
    return (r.groups as SwarmGroup[]) ?? [];
  }

  async createGroup(body: SwarmGroupBody): Promise<Record<string, unknown>> {
    return await this.http("POST", "/groups", body);
  }

  async updateGroup(name: string, body: Partial<SwarmGroupBody>): Promise<Record<string, unknown>> {
    return await this.http("PUT", `/groups/${encodeURIComponent(name)}`, body);
  }

  async deleteGroup(name: string): Promise<void> {
    await this.http("DELETE", `/groups/${encodeURIComponent(name)}`, undefined);
  }

  async executionModes(): Promise<Record<string, boolean>> {
    const r = await this.http("GET", "/execution-modes");
    return (r.modes as Record<string, boolean>) ?? {};
  }

  async containers(): Promise<{ version: 1; docker: { enabled: boolean } }> {
    return (await this.http("GET", "/containers")) as never;
  }

  async setContainers(dockerEnabled: boolean): Promise<{ version: 1; docker: { enabled: boolean } }> {
    return (await this.http("PUT", "/containers", { docker: { enabled: dockerEnabled } })) as never;
  }

  async verifyContainers(): Promise<{ ok: boolean; detail: string }> {
    return (await this.http("POST", "/containers/verify", {})) as never;
  }

  async lookupTicket(
    workspace: string,
    ticketKey: string,
  ): Promise<{ ok: boolean; ticket?: TicketResult; detail?: string }> {
    return this.http("POST", `/workspaces/${encodeURIComponent(workspace)}/atlassian/lookup-ticket`, {
      ticketKey,
    }) as unknown as Promise<{
      ok: boolean;
      ticket?: TicketResult;
      detail?: string;
    }>;
  }

  async searchDocs(workspace: string, query: string): Promise<{ ok: boolean; docs?: DocResult[]; detail?: string }> {
    return this.http("POST", `/workspaces/${encodeURIComponent(workspace)}/atlassian/search-docs`, {
      query,
    }) as unknown as Promise<{
      ok: boolean;
      docs?: DocResult[];
      detail?: string;
    }>;
  }

  async getMe(): Promise<MeRecord> {
    return this.http("GET", "/me") as unknown as Promise<MeRecord>;
  }

  async updateMe(body: { name?: string }): Promise<MeRecord> {
    return this.http("PUT", "/me", body) as unknown as Promise<MeRecord>;
  }

  async getConnectorVendors(): Promise<ConnectorVendorMeta[]> {
    return this.http("GET", "/connectors/vendors") as unknown as Promise<ConnectorVendorMeta[]>;
  }

  async getMyConnectors(): Promise<ConnectorInstanceRecord[]> {
    return this.http("GET", "/me/connectors") as unknown as Promise<ConnectorInstanceRecord[]>;
  }

  async addConnector(body: {
    vendorId: string;
    label: string;
    fields: Record<string, string>;
  }): Promise<ConnectorInstanceRecord> {
    return this.http("POST", "/me/connectors", body) as unknown as Promise<ConnectorInstanceRecord>;
  }

  async updateConnector(
    id: string,
    body: { label?: string; fields?: Record<string, string> },
  ): Promise<ConnectorInstanceRecord> {
    return this.http(
      "PUT",
      `/me/connectors/${encodeURIComponent(id)}`,
      body,
    ) as unknown as Promise<ConnectorInstanceRecord>;
  }

  async deleteConnector(id: string): Promise<{ ok: boolean }> {
    return this.http("DELETE", `/me/connectors/${encodeURIComponent(id)}`) as unknown as Promise<{ ok: boolean }>;
  }

  async verifyConnector(id: string, extra?: Record<string, string>): Promise<VerifyResult> {
    return this.http("POST", `/me/connectors/${encodeURIComponent(id)}/verify`, {
      extra,
    }) as unknown as Promise<VerifyResult>;
  }

  async listCliTools(): Promise<{ tools: CliToolListing[] }> {
    return this.http("GET", "/cli-tools") as unknown as Promise<{ tools: CliToolListing[] }>;
  }

  async refreshCliTools(tool?: string): Promise<{ tools: CliToolListing[] }> {
    return this.http(
      "POST",
      `/cli-tools/refresh${tool ? `?tool=${encodeURIComponent(tool)}` : ""}`,
    ) as unknown as Promise<{
      tools: CliToolListing[];
    }>;
  }

  async setCliToolEnabled(id: string, enabled: boolean): Promise<{ tools: CliToolListing[] }> {
    return this.http("PUT", `/cli-tools/${encodeURIComponent(id)}`, { enabled }) as unknown as Promise<{
      tools: CliToolListing[];
    }>;
  }

  async listApiKeys() {
    return this.http("GET", "/api-keys") as unknown as Promise<Record<string, unknown>>;
  }
  async saveApiKey(id: string, key: string) {
    return this.http("PUT", `/api-keys/${encodeURIComponent(id)}`, { key }) as unknown as Promise<
      Record<string, unknown>
    >;
  }
  async verifyApiKey(id: string) {
    return this.http("POST", `/api-keys/${encodeURIComponent(id)}/verify`) as unknown as Promise<
      Record<string, unknown>
    >;
  }
  async deleteApiKey(id: string) {
    return this.http("DELETE", `/api-keys/${encodeURIComponent(id)}`) as unknown as Promise<Record<string, unknown>>;
  }
  async getApiKeyCredential(id: string) {
    return this.http("GET", `/api-keys/${encodeURIComponent(id)}/credential`) as unknown as Promise<{
      key?: string;
      error?: string;
    }>;
  }

  async verifyWorkspaceAtlassian(name: string): Promise<VerifyResult> {
    return this.http(
      "POST",
      `/workspaces/${encodeURIComponent(name)}/verify-atlassian`,
      {},
    ) as unknown as Promise<VerifyResult>;
  }

  async verifyRepoGithub(name: string, repoName: string): Promise<VerifyResult> {
    return this.http(
      "POST",
      `/workspaces/${encodeURIComponent(name)}/repos/${encodeURIComponent(repoName)}/verify-github`,
      {},
    ) as unknown as Promise<VerifyResult>;
  }

  async getWorkspaceChannels(name: string): Promise<ChannelsRecord> {
    return this.http("GET", `/workspaces/${encodeURIComponent(name)}/channels`) as unknown as Promise<ChannelsRecord>;
  }

  async saveWorkspaceChannels(
    name: string,
    body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
  ): Promise<ChannelsRecord> {
    return this.http(
      "PUT",
      `/workspaces/${encodeURIComponent(name)}/channels`,
      body,
    ) as unknown as Promise<ChannelsRecord>;
  }

  async verifyWorkspaceDiscord(name: string): Promise<VerifyResult> {
    return this.http(
      "POST",
      `/workspaces/${encodeURIComponent(name)}/channels/verify-discord`,
      {},
    ) as unknown as Promise<VerifyResult>;
  }

  /**
   * The one method in this class that returns a raw secret — used only by
   * main.ts's Discord connection lifecycle (Task 9), never through
   * BrokerDeps/Broker. `http()` throws on any non-2xx (including the expected,
   * routine "this workspace has no Discord config" 404) — that's a normal
   * outcome here, not a failure worth surfacing, so it's swallowed into `null`
   * rather than propagated. A swarm-down/network failure collapses into the
   * same `null` — the lifecycle hook's correct response to "can't reach swarm"
   * is identical to "no Discord configured": skip Discord for this workspace.
   */
  async getWorkspaceDiscordConfig(name: string): Promise<DiscordChannelsConfig | null> {
    try {
      return (await this.http(
        "GET",
        `/workspaces/${encodeURIComponent(name)}/channels/discord-token`,
      )) as unknown as DiscordChannelsConfig;
    } catch {
      return null;
    }
  }

  /**
   * Raw voice keys (spec §4). Returns null ONLY on transport failure — the
   * route itself always 200s with per-slot nulls when keys are unset, so the
   * VoiceKeyResolver can keep its last good keys across a swarm restart
   * instead of flapping voice off.
   */
  async getVoiceKeys(): Promise<VoiceKeys | null> {
    try {
      return (await this.http("GET", "/me/voice/keys")) as unknown as VoiceKeys;
    } catch {
      return null;
    }
  }

  async getMyVoice(): Promise<Record<string, unknown>> {
    return this.http("GET", "/me/voice");
  }

  async getResearchEngine(): Promise<{ cli: string; model?: string } | null> {
    return (await this.http("GET", "/me/research-engine")) as { cli: string; model?: string } | null;
  }

  async saveResearchEngine(body: unknown): Promise<Record<string, unknown>> {
    return this.http("PUT", "/me/research-engine", body);
  }

  async saveMyVoice(body: unknown): Promise<Record<string, unknown>> {
    return this.http("PUT", "/me/voice", body);
  }

  /** Subscribe to /ws events. Reconnects every 2s until the returned fn is called. */
  subscribe(onEvent: (e: SwarmEvent) => void): () => void {
    const query = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/ws${query}`;
    let stopped = false;
    let current: WsLike | null = null;
    let timer: NodeJS.Timeout | null = null;

    const connect = () => {
      if (stopped) return;
      const ws = this.wsFactory(wsUrl);
      current = ws;
      ws.on("message", (data) => {
        try {
          onEvent(JSON.parse(String(data)) as SwarmEvent);
        } catch {
          /* non-JSON frame — ignore */
        }
      });
      ws.on("close", () => {
        if (!stopped) timer = setTimeout(connect, 2000);
      });
      ws.on("error", () => {
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

  /** Verbatim passthrough for the work-board routes — the broker adds no logic. */
  async work(method: string, path: string, body?: unknown): Promise<{ status: number; payload: unknown }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, payload: await res.json().catch(() => ({})) };
  }

  private async http(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    // Only set content-type when a body actually follows: fastify's default
    // JSON body parser 400s ("FST_ERR_CTP_EMPTY_JSON_BODY") on a
    // Content-Type: application/json request with no body, which is exactly
    // what deleteAgent/deleteWorkspace send. That 400 silently defeated every
    // delete-outcome removal through the broker until this was e2e-tested.
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
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
