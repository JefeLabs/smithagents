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
  /** For a group entry: the agent id its members elected to lead it. */
  leader?: string;
}

/** The broker's own host identity, riding the roster frame — never one of the agents. */
export interface BrokerIdentityInfo {
  name: string;
  role: string;
  ring?: string;
  listening?: boolean;
}

export type ComposeOp = { op: "form"; agents: string[] } | { op: "add" | "remove"; target: string; agent: string };

/**
 * Who a composed message is for — mirrors broker/src/targets.ts `Target`.
 * Kept in lockstep BY HAND: an object rather than an "agent:osvaldo" string so
 * a drifted parser is a type error instead of a silent mis-parse.
 */
export type Target =
  | { kind: "host" }
  | { kind: "crew" }
  | { kind: "squad"; id: string }
  | { kind: "group"; id: string }
  | { kind: "agent"; id: string };

/** The control plane's copy of the broker's runtime vocabulary — must mirror swarm's ExecutionMode. */
export type ExecutionMode = "local-in-process" | "local-docker" | "remote-in-process" | "remote-docker";

export interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  updatedAt: string;
  active: boolean;
  runtime: ExecutionMode;
  /** Documents this session produced/works on; always resolved (absent on the wire = []). */
  artifacts: string[];
}

/**
 * The `session` frame's shape, exactly mirroring broker's text-channel.ts
 * `ChannelFrame`'s `session` variant — the second lockstep parser. `session:
 * null` is a valid, deliberate state (zero sessions exist yet), distinct from
 * "hello frame not sent yet".
 */
export interface SessionFrame {
  type: "session";
  session: {
    id: string;
    title: string;
    workspace: string;
    runtime: ExecutionMode;
    artifacts: string[];
  } | null;
  sessions: SessionSummary[];
  transcript: Array<{ role: "user" | "broker"; text: string }>;
  workspaces: string[];
  /** Absent on an older broker; the socket store normalizes to []. */
  groups?: GroupT[];
}

/**
 * A workspace group (spec 2026-08-11-workspace-groups): a nested, named set
 * of workspaces and other groups. `expansion` is the swarm-computed transitive
 * member-workspace list — consumers never re-walk membership.
 */
export interface GroupT {
  name: string;
  description?: string;
  workspaces: string[];
  groups: string[];
  color?: string;
  /** Opt-in sprint definition (date-range spec 2026-08-12). */
  sprint?: { anchor: string; lengthDays: number };
  expansion: string[];
}

/** A document section — one heading/body pair the collaborative editor renders. */
export interface DocSectionT {
  id: string;
  heading: string;
  body: string;
}

/**
 * A blueprint-instantiated document, mirroring broker's documents.ts `Doc`
 * MINUS `proposals` — phase 1 renders no proposals, so that field simply
 * isn't read; an unknown extra field from the broker is not an error.
 */
/** An agent's suggested section rewrite — a sticky note on the page until decided. */
export interface ProposalT {
  id: string;
  sectionId: string;
  agentId: string;
  newBody: string;
  rationale: string;
  state: "open" | "accepted" | "rejected" | "stale";
  createdAt: string;
}

export interface DocT {
  id: string;
  title: string;
  blueprintId: string;
  workType: string;
  sections: DocSectionT[];
  participants: string[];
  /** Absent on docs stored before proposals existed. */
  proposals?: ProposalT[];
  /** Workspaces (group ids later) this doc is pinned to — new sessions there inherit it. */
  pins?: string[];
  status: "drafting" | "review" | "final";
  createdAt: string;
  updatedAt: string;
}

/** A document schema, as `GET /blueprints` returns it — the creation form's list. */
export interface BlueprintT {
  id: string;
  name: string;
  /** Render family — prose documents, Mermaid diagrams, or spec-driven dashboards; the composer groups by it. */
  family: "document" | "diagram" | "dashboard";
  workTypes: string[];
  /** The broker sends these; the page uses their `hint` as ghost text. */
  sections?: Array<{ id: string; heading: string; hint?: string }>;
}

/** Full-frame-on-change, like the `session` frame — every document, not a diff. */
export interface DocumentsFrame {
  type: "documents";
  documents: DocT[];
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
  /** Opt-in sprint definition (date-range spec 2026-08-12). */
  sprint?: { anchor: string; lengthDays: number };
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

/**
 * The capability (story-map) model, as the broker stores and returns it.
 *
 * These live here rather than beside the stage that renders them because both
 * `api/work.ts` and `queries/work.ts` need them — importing a type out of an
 * organism inverts the dependency direction — and because the map's geometry
 * module (`organisms/map/layout.ts`) must stay React-free, which it cannot be
 * if reaching a type means importing a component.
 *
 * Story positions are DERIVED, never stored: `CapStoryT` carries `stepId` and
 * `order`, and layout turns those into coordinates. Nothing here gains x/y.
 */
export interface CapStoryT {
  id: string;
  stepId: string;
  order: number;
  text: string;
  done: boolean;
  verifiedBy?: string;
  /** Last touch (swarm-stamped). Absent on stories from before dating — those always render. */
  updatedAt?: string;
}
export interface CapActivityT {
  id: string;
  name: string;
  order: number;
  steps: Array<{ id: string; name: string; order: number }>;
}
export interface CapSliceT {
  id: string;
  name: string;
  order: number;
  storyIds: string[];
  specPath?: string;
  planPath?: string;
  capCardRef?: { boardId: string; cardId: string };
  deliveryCardRef?: { boardId: string; cardId: string };
  /** Last touch (swarm-stamped). Absent on slices from before dating — those always render. */
  updatedAt?: string;
}
export interface CapabilityT {
  id: string;
  name: string;
  workspaceId: string;
  /**
   * Position in the capability row. OPTIONAL because the broker's is: capability files
   * written before ordering existed carry none, and the swarm places those by id rather
   * than inventing a value on read. Sort with a fallback, never assume it is there.
   */
  order?: number;
  activities: CapActivityT[];
  stories: CapStoryT[];
  slices: CapSliceT[];
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
