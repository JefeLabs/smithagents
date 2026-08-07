import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Live transcript + send pipe to the broker's text channel.
 * The transcript is entirely WS-driven: the channel echoes every accepted
 * utterance (ours included) as a frame, so there is no optimistic local
 * append to dedupe. Reconnects on a fixed backoff while the broker is down.
 */
export interface ChatMessage {
  id: number;
  role: "user" | "broker" | "notice";
  text: string;
}

export interface SpeechProfile {
  voiceName?: string;
  lang?: string;
  pitch?: number;
  rate?: number;
}

export interface AudioFrame {
  speaker?: string;
  mime: string;
  dataB64: string;
}

export interface RosterAgent {
  id: string;
  name: string;
  role: string;
  ring?: string;
  avatar?: string;
  status: "idle" | "busy" | "in-meeting" | "offline";
  taskSummary?: string;
  kind: "agent" | "squad";
  speech?: SpeechProfile;
  hand?: string;
  /** True while the live utterance is addressing them ("Hey Manuel"). */
  listening?: boolean;
  members?: string[];
}

/** The broker's own host identity, riding the roster frame — never one of the agents. */
export interface BrokerIdentityInfo {
  name: string;
  role: string;
  ring?: string;
  listening?: boolean;
}

export type ComposeOp = { op: "form"; agents: string[] } | { op: "add" | "remove"; target: string; agent: string };

/** The control plane's copy of the broker's runtime vocabulary — must mirror swarm's ExecutionMode. */
export type ExecutionMode = "local-in-process" | "local-docker" | "remote-in-process" | "remote-docker";

export interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  updatedAt: string;
  active: boolean;
  runtime: ExecutionMode;
}

/**
 * The `session` frame's shape, exactly mirroring broker's text-channel.ts
 * `ChannelFrame`'s `session` variant — the second lockstep parser. `session:
 * null` is a valid, deliberate state (zero sessions exist yet), distinct from
 * "hello frame not sent yet".
 */
export interface SessionFrame {
  type: "session";
  session: { id: string; title: string; workspace: string; runtime: ExecutionMode } | null;
  sessions: SessionSummary[];
  transcript: Array<{ role: "user" | "broker"; text: string }>;
  workspaces: string[];
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
  capabilities?: string[];
}

export interface ConnectorInstanceRecord {
  id: string;
  vendorId: string;
  label: string;
  fields: Record<string, string | boolean>;
}

/** Full workspace record, as the manager UI reads and writes it. */
export interface WorkspaceRecord {
  name: string;
  description?: string;
  default: boolean;
  archived?: boolean;
  repos: Array<{
    name: string;
    path: string;
    branch: string;
    github?: { owner: string; repo: string; connectorId?: string };
    initGit?: boolean;
  }>;
  atlassian?: { siteUrl: string; jiraProjectKeys?: string[]; confluenceSpaceKeys?: string[]; connectorId?: string };
  /** Reference links (repo, docs, tracker) shown on the workspace card. */
  links?: string[];
}

/** The operator's own profile — connector credentials read back redacted, never the secret itself. */
export interface MeRecord {
  id: string;
  name: string;
  connectors: ConnectorInstanceRecord[];
}

/** Per-workspace channel config — Discord token read back as a boolean, never the secret itself. */
export interface ChannelsRecord {
  hasDiscordToken: boolean;
  textChannels: string[];
  voiceChannels: string[];
}

/** The operator's chosen STT/TTS connectors — read back by instance id, never the secret itself. */
export interface VoiceSettingsRecord {
  stt: { instanceId: string } | null;
  tts: { instanceId: string } | null;
  hideInactive: boolean;
}

/** One CLI tool's machine status, as the registry persists it. */
export interface CliToolStatusRecord {
  detected: boolean;
  authOk: boolean | "unknown";
  enabled: boolean;
  detail: string;
  version?: string;
  lastCheckedAt: string;
}

/** Catalog engine joined with machine status — drives the CLI Tools settings cards. */
export interface CliToolListing {
  cli: string;
  label: string;
  models: string[];
  warmSessions: boolean;
  note?: string;
  status: CliToolStatusRecord | null;
  active: boolean;
}

/** Provider key joined with redacted machine state — drives the API Keys settings cards. */
export interface ApiKeyListing {
  id: string;
  label: string;
  description: string;
  hasKey: boolean;
  last4: string | null;
  verified: boolean | "unknown" | null;
  detail: string | null;
  lastCheckedAt: string | null;
}

const DEFAULT_BASE = "127.0.0.1:7790";
const RECONNECT_MS = 2000;

/** All modes assumed unavailable except the one every machine can always run — the honest fallback when the broker's response is unreadable. */
const DEFAULT_EXECUTION_MODES: Record<ExecutionMode, boolean> = {
  "local-in-process": true,
  "local-docker": false,
  "remote-in-process": false,
  "remote-docker": false,
};

/**
 * POST /sessions — atomic create: the broker validates/acquires the runtime
 * before the session exists, so the caller either gets a live session or a
 * clean rejection. Exported standalone (rather than trapped in a useCallback
 * closure) so it's testable without rendering the hook.
 */
export async function postSession(
  base: string,
  workspace: string,
  runtime: ExecutionMode,
  prompt: string,
): Promise<{ error?: string; status?: number }> {
  try {
    const res = await fetch(`http://${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, runtime, prompt }),
    });
    if (res.ok) return {};
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { error: body.error ?? `broker returned ${res.status}`, status: res.status };
  } catch {
    return { error: "broker unreachable" };
  }
}

/** GET /execution-modes — which runtimes this machine can actually run right now, keyed by mode id. */
export async function fetchExecutionModes(base: string): Promise<Record<ExecutionMode, boolean>> {
  const res = await fetch(`http://${base}/execution-modes`);
  const body = (await res.json()) as { modes?: Record<ExecutionMode, boolean> };
  return body.modes ?? DEFAULT_EXECUTION_MODES;
}

export function useBrokerChat(opts?: { base?: string; onAudio?: (frame: AudioFrame) => void }) {
  const base = opts?.base ?? DEFAULT_BASE;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [identity, setIdentity] = useState<BrokerIdentityInfo | null>(null);
  const [connected, setConnected] = useState(false);
  const [audioMode, setAudioMode] = useState(false);
  const [session, setSession] = useState<{
    id: string;
    title: string;
    workspace: string;
    runtime: ExecutionMode;
  } | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [lastBoardUpdate, setLastBoardUpdate] = useState<{ boardId: string; seq: number } | null>(null);
  const boardSeq = useRef(0);
  const [lastCapabilityUpdate, setLastCapabilityUpdate] = useState<{ capabilityId: string; seq: number } | null>(null);
  const capSeq = useRef(0);
  const nextId = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const onAudio = useRef(opts?.onAudio);
  onAudio.current = opts?.onAudio;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const open = () => {
      ws = new WebSocket(`ws://${base}/events`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as
          | { type: "utterance" | "speech"; text: string }
          | { type: "notice"; text: string }
          | { type: "roster"; agents: RosterAgent[]; identity?: BrokerIdentityInfo }
          | { type: "config"; audio: boolean }
          | ({ type: "audio" } & AudioFrame)
          | { type: "board-updated"; boardId: string }
          | { type: "capability-updated"; capabilityId: string }
          | SessionFrame;
        if (frame.type === "session") {
          setSession(frame.session);
          setSessions(frame.sessions);
          setWorkspaces(frame.workspaces);
          nextId.current = 0;
          setMessages(frame.transcript.map((t) => ({ id: nextId.current++, role: t.role, text: t.text })));
          return;
        }
        if (frame.type === "config") {
          setAudioMode(frame.audio);
          return;
        }
        if (frame.type === "audio") {
          onAudio.current?.(frame);
          return;
        }
        if (frame.type === "roster") {
          setRoster(frame.agents);
          setIdentity(frame.identity ?? null);
          return;
        }
        if (frame.type === "notice") {
          setMessages((list) => [...list, { id: nextId.current++, role: "notice", text: frame.text }]);
          return;
        }
        if (frame.type === "board-updated") {
          setLastBoardUpdate({ boardId: frame.boardId, seq: ++boardSeq.current });
          return;
        }
        if (frame.type === "capability-updated") {
          setLastCapabilityUpdate({ capabilityId: frame.capabilityId, seq: ++capSeq.current });
          return;
        }
        if (frame.type !== "utterance" && frame.type !== "speech") return;
        setMessages((list) => [
          ...list,
          { id: nextId.current++, role: frame.type === "utterance" ? "user" : "broker", text: frame.text },
        ]);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!disposed) timer = setTimeout(open, RECONNECT_MS);
      };
      ws.onerror = () => ws?.close();
    };
    open();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [base]);

  const send = useCallback(
    (text: string) => {
      void fetch(`http://${base}/utterance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }).catch(() => {
        /* broker down — the disabled composer already communicates this */
      });
    },
    [base],
  );

  const compose = useCallback(
    (op: ComposeOp) => {
      void fetch(`http://${base}/compose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(op),
      }).catch(() => {
        /* broker down — roster frames simply won't change */
      });
    },
    [base],
  );

  const resetSetup = useCallback(
    async (scope: { runtime?: boolean; conversations?: boolean; worktrees?: boolean; agents?: boolean }) => {
      const res = await fetch(`http://${base}/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scope),
      });
      return (await res.json()) as {
        ok?: boolean;
        error?: string;
        swarm?: { preserved?: string[]; killed?: Record<string, number> };
      };
    },
    [base],
  );

  const activity = useCallback(
    async (name: string): Promise<{ busy: boolean; label?: string; output?: string }> => {
      const res = await fetch(`http://${base}/activity/${encodeURIComponent(name)}`);
      return (await res.json()) as { busy: boolean; label?: string; output?: string };
    },
    [base],
  );

  const removalPreview = useCallback(
    // 404/500 resolve with { error } and no outcome — the broker never fails to return JSON, so
    // callers only need to guard the network layer, not the parse.
    async (id: string): Promise<{ outcome?: "delete" | "archive"; reasons?: string[]; error?: string }> => {
      const res = await fetch(`http://${base}/agents/${encodeURIComponent(id)}/removal`);
      return (await res.json()) as { outcome?: "delete" | "archive"; reasons?: string[]; error?: string };
    },
    [base],
  );

  const removeAgent = useCallback(
    async (id: string): Promise<{ outcome?: string; error?: string }> => {
      const res = await fetch(`http://${base}/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      return (await res.json()) as { outcome?: string; error?: string };
    },
    [base],
  );

  const listWorkspaceRecords = useCallback(async (): Promise<WorkspaceRecord[]> => {
    const res = await fetch(`http://${base}/workspaces`);
    const body = (await res.json()) as { workspaces?: WorkspaceRecord[] };
    return body.workspaces ?? [];
  }, [base]);

  const saveWorkspace = useCallback(
    async (body: WorkspaceRecord, isNew: boolean): Promise<{ error?: string; name?: string }> => {
      const res = await fetch(`http://${base}/workspaces${isNew ? "" : `/${encodeURIComponent(body.name)}`}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as { error?: string; name?: string };
    },
    [base],
  );

  const removeWorkspace = useCallback(
    async (name: string): Promise<{ outcome?: string; error?: string }> => {
      const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}`, { method: "DELETE" });
      return (await res.json()) as { outcome?: string; error?: string };
    },
    [base],
  );

  const verifyWorkspaceAtlassian = useCallback(
    async (name: string): Promise<{ ok?: boolean; detail?: string; error?: string }> => {
      const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/verify-atlassian`, {
        method: "POST",
      });
      return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
    },
    [base],
  );

  const verifyRepoGithub = useCallback(
    async (name: string, repoName: string): Promise<{ ok?: boolean; detail?: string; error?: string }> => {
      const res = await fetch(
        `http://${base}/workspaces/${encodeURIComponent(name)}/repos/${encodeURIComponent(repoName)}/verify-github`,
        { method: "POST" },
      );
      return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
    },
    [base],
  );

  const getWorkspaceChannels = useCallback(
    async (name: string): Promise<ChannelsRecord> => {
      const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/channels`);
      return (await res.json()) as ChannelsRecord;
    },
    [base],
  );

  const saveWorkspaceChannels = useCallback(
    async (
      name: string,
      body: { discord?: { botToken: string; textChannels: string[]; voiceChannels: string[] } },
    ): Promise<ChannelsRecord & { error?: string }> => {
      const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/channels`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as ChannelsRecord & { error?: string };
    },
    [base],
  );

  const verifyWorkspaceDiscord = useCallback(
    async (name: string): Promise<{ ok?: boolean; detail?: string; error?: string }> => {
      const res = await fetch(`http://${base}/workspaces/${encodeURIComponent(name)}/channels/verify-discord`, {
        method: "POST",
      });
      return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
    },
    [base],
  );

  const getVoiceSettings = useCallback(async (): Promise<VoiceSettingsRecord> => {
    const res = await fetch(`http://${base}/me/voice`);
    return (await res.json()) as VoiceSettingsRecord;
  }, [base]);

  const saveVoiceSettings = useCallback(
    async (body: {
      stt: { instanceId: string } | null;
      tts: { instanceId: string } | null;
      hideInactive: boolean;
    }): Promise<VoiceSettingsRecord & { error?: string }> => {
      const res = await fetch(`http://${base}/me/voice`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as VoiceSettingsRecord & { error?: string };
    },
    [base],
  );

  const getMe = useCallback(async (): Promise<MeRecord> => {
    const res = await fetch(`http://${base}/me`);
    return (await res.json()) as MeRecord;
  }, [base]);

  const updateMe = useCallback(
    async (body: { name?: string }): Promise<MeRecord & { error?: string }> => {
      const res = await fetch(`http://${base}/me`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as MeRecord & { error?: string };
    },
    [base],
  );

  const listConnectorVendors = useCallback(async (): Promise<ConnectorVendorMeta[]> => {
    const res = await fetch(`http://${base}/connectors/vendors`);
    return (await res.json()) as ConnectorVendorMeta[];
  }, [base]);

  const listMyConnectors = useCallback(async (): Promise<ConnectorInstanceRecord[]> => {
    const res = await fetch(`http://${base}/me/connectors`);
    return (await res.json()) as ConnectorInstanceRecord[];
  }, [base]);

  const addConnector = useCallback(
    async (body: {
      vendorId: string;
      label: string;
      fields: Record<string, string>;
    }): Promise<ConnectorInstanceRecord & { error?: string }> => {
      const res = await fetch(`http://${base}/me/connectors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as ConnectorInstanceRecord & { error?: string };
    },
    [base],
  );

  const updateConnector = useCallback(
    async (
      id: string,
      body: { label?: string; fields?: Record<string, string> },
    ): Promise<ConnectorInstanceRecord & { error?: string }> => {
      const res = await fetch(`http://${base}/me/connectors/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return (await res.json()) as ConnectorInstanceRecord & { error?: string };
    },
    [base],
  );

  const deleteConnector = useCallback(
    async (id: string): Promise<{ ok?: boolean; error?: string }> => {
      const res = await fetch(`http://${base}/me/connectors/${encodeURIComponent(id)}`, { method: "DELETE" });
      return (await res.json()) as { ok?: boolean; error?: string };
    },
    [base],
  );

  const verifyConnector = useCallback(
    async (id: string, extra?: Record<string, string>): Promise<{ ok?: boolean; detail?: string; error?: string }> => {
      const res = await fetch(`http://${base}/me/connectors/${encodeURIComponent(id)}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extra }),
      });
      return (await res.json()) as { ok?: boolean; detail?: string; error?: string };
    },
    [base],
  );

  const listCliTools = useCallback(async (): Promise<CliToolListing[]> => {
    const res = await fetch(`http://${base}/cli-tools`);
    return ((await res.json()) as { tools?: CliToolListing[] }).tools ?? [];
  }, [base]);

  const listExecutionModes = useCallback(
    (): Promise<Record<ExecutionMode, boolean>> => fetchExecutionModes(base),
    [base],
  );

  const getContainers = useCallback(async (): Promise<{ docker: { enabled: boolean } }> => {
    const res = await fetch(`http://${base}/containers`);
    return (await res.json()) as { docker: { enabled: boolean } };
  }, [base]);

  const setDockerEnabled = useCallback(
    async (enabled: boolean): Promise<{ docker: { enabled: boolean } }> => {
      const res = await fetch(`http://${base}/containers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ docker: { enabled } }),
      });
      return (await res.json()) as { docker: { enabled: boolean } };
    },
    [base],
  );

  const verifyContainers = useCallback(async (): Promise<{ ok: boolean; detail: string }> => {
    const res = await fetch(`http://${base}/containers/verify`, { method: "POST" });
    return (await res.json()) as { ok: boolean; detail: string };
  }, [base]);

  const refreshCliTools = useCallback(
    async (tool?: string): Promise<CliToolListing[]> => {
      const res = await fetch(`http://${base}/cli-tools/refresh${tool ? `?tool=${encodeURIComponent(tool)}` : ""}`, {
        method: "POST",
      });
      return ((await res.json()) as { tools?: CliToolListing[] }).tools ?? [];
    },
    [base],
  );

  const setCliToolEnabled = useCallback(
    async (id: string, enabled: boolean): Promise<CliToolListing[] | { error: string }> => {
      const res = await fetch(`http://${base}/cli-tools/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await res.json()) as { tools?: CliToolListing[]; error?: string };
      return body.error ? { error: body.error } : (body.tools ?? []);
    },
    [base],
  );

  const listApiKeys = useCallback(async (): Promise<ApiKeyListing[]> => {
    const res = await fetch(`http://${base}/api-keys`);
    return ((await res.json()) as { providers?: ApiKeyListing[] }).providers ?? [];
  }, [base]);

  const saveApiKey = useCallback(
    async (id: string, key: string): Promise<ApiKeyListing[] | { error: string }> => {
      const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const body = (await res.json()) as { providers?: ApiKeyListing[]; error?: string };
      return body.error ? { error: body.error } : (body.providers ?? []);
    },
    [base],
  );

  const verifyApiKey = useCallback(
    async (id: string): Promise<ApiKeyListing[] | { error: string }> => {
      const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}/verify`, { method: "POST" });
      const body = (await res.json()) as { providers?: ApiKeyListing[]; error?: string };
      return body.error ? { error: body.error } : (body.providers ?? []);
    },
    [base],
  );

  const deleteApiKey = useCallback(
    async (id: string): Promise<ApiKeyListing[] | { error: string }> => {
      const res = await fetch(`http://${base}/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = (await res.json()) as { providers?: ApiKeyListing[]; error?: string };
      return body.error ? { error: body.error } : (body.providers ?? []);
    },
    [base],
  );

  const workAction = useCallback(
    async (name: string, action: "steer" | "cancel", message?: string): Promise<string | null> => {
      const res = await fetch(`http://${base}/activity/${encodeURIComponent(name)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message ? { message } : {}),
      });
      if (res.ok) return null;
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error ?? `HTTP ${res.status}`;
    },
    [base],
  );

  const createSession = useCallback(
    (workspace: string, runtime: ExecutionMode, prompt: string): Promise<{ error?: string; status?: number }> =>
      postSession(base, workspace, runtime, prompt),
    [base],
  );

  const activateSession = useCallback(
    (id: string) => {
      void fetch(`http://${base}/sessions/${encodeURIComponent(id)}/activate`, { method: "POST" }).catch(() => {});
    },
    [base],
  );

  const micControl = useCallback((type: "mic-start" | "mic-stop") => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify({ type }));
  }, []);

  const micAudio = useCallback((pcm: ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(pcm);
  }, []);

  return {
    messages,
    roster,
    identity,
    connected,
    audioMode,
    session,
    sessions,
    workspaces,
    lastBoardUpdate,
    lastCapabilityUpdate,
    send,
    compose,
    activity,
    removalPreview,
    removeAgent,
    workAction,
    micControl,
    micAudio,
    createSession,
    activateSession,
    resetSetup,
    listWorkspaceRecords,
    saveWorkspace,
    removeWorkspace,
    verifyWorkspaceAtlassian,
    verifyRepoGithub,
    getWorkspaceChannels,
    saveWorkspaceChannels,
    verifyWorkspaceDiscord,
    getVoiceSettings,
    saveVoiceSettings,
    getMe,
    updateMe,
    listConnectorVendors,
    listMyConnectors,
    addConnector,
    updateConnector,
    deleteConnector,
    verifyConnector,
    listCliTools,
    refreshCliTools,
    setCliToolEnabled,
    listExecutionModes,
    getContainers,
    setDockerEnabled,
    verifyContainers,
    listApiKeys,
    saveApiKey,
    verifyApiKey,
    deleteApiKey,
  };
}
