/**
 * Every shared broker type. Kept React-free and dependency-free so both the
 * fetch layer (api/broker.ts) and the socket store can import it without
 * pulling in hooks.
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

/**
 * A stored agent record as `GET /agents` returns it — the full persona detail
 * the WS roster frame deliberately omits (`broker/src/text-channel.ts:447`).
 * `RosterAgent` is the roster frame's view model and carries neither `engine`
 * nor `channels`, so anything joining on those must read this shape instead.
 * Open-ended by design: only the fields the control plane actually reads are
 * named, and the rest ride along untouched into the PUT that saves them back.
 */
export interface AgentRecord {
  id?: string;
  channels?: unknown;
  engine?: { cli?: string };
  presence?: Record<string, boolean>;
  [key: string]: unknown;
}

/** `GET /agents` in full: the records plus the two siblings the broker adds — surface availability and the voice capability snapshot. */
export interface AgentRecordsResponse {
  agents: AgentRecord[];
  discord?: { configured: boolean; voiceReady: boolean };
  voice?: { stt: boolean; tts: boolean };
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
  /** Optional identity colour; the UI falls back to a hash of `name`. */
  color?: string;
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
