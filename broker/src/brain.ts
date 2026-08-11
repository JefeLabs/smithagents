/**
 * BrokerBrain — the conversation coordinator. ONE Haiku call per turn:
 * plain streamed text IS speech (fed to the chunker), and tool_use blocks
 * ARE the routing decision (delegate to the swarm / check status). The
 * roster from AgentDirectory is injected into the system prompt so the
 * brain always knows who is idle, busy, or in the meeting.
 *
 * The Anthropic SDK is injected as a StreamFactory so tests script turns
 * without network. Production: `(p) => client.messages.stream(p)`.
 */
import { SpeechChunker } from './chunker.ts';
import { DEFAULT_IDENTITY, promptInfo, type IdentityPromptInfo } from './identity.ts';

export interface ToolExecutors {
  remember(input: { key: string; text: string; scope: string }): Promise<string>;
  delegate(input: { agent: string; task: string; workspace?: string; repo?: string; ticketKey?: string }): Promise<string>;
  check_status(input: { agent: string }): Promise<string>;
  raise_hand(input: { agent: string; reason: string }): Promise<string>;
  lookup_ticket(input: { ticketKey: string; workspace: string }): Promise<string>;
  search_docs(input: { query: string; workspace: string }): Promise<string>;
  check_feeds(input: { query: string; tag?: string; sinceDays?: number }): Promise<string>;
  draft_agent(input: { spec: string }): Promise<string>;
  confirm_agent(input: { accept: boolean }): Promise<string>;
}

export interface BrainTurn {
  roster: string;
  /**
   * What the crew already knows about today — weather, headlines, unspoken
   * releases (spec §6). Empty/absent when no feeds are configured, so the
   * prompt is unchanged for anyone who never set this up.
   */
  digest?: string;
  onSpeech: (chunk: string) => void;
}

export interface BrainStreamLike {
  on(event: 'text', cb: (delta: string) => void): void;
  finalMessage(): Promise<{
    content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason: string | null;
  }>;
}

export type StreamFactory = (params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: unknown[];
  tools: unknown[];
  tool_choice?: unknown;
}) => BrainStreamLike;

const TOOLS = [
  {
    name: 'delegate',
    description:
      'Hand real work to an agent. The agent runs a full coding CLI in a pinned tmux session and works asynchronously; you will be told when it finishes. Use for anything beyond conversation: writing code, running commands, research in the repo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string' as const, description: 'Agent name or id from the roster' },
        task: { type: 'string' as const, description: 'Complete, self-contained task description' },
        repo: { type: 'string' as const, description: 'Repo name from the workspaces list. Omit for the default repo.' },
        workspace: { type: 'string' as const, description: 'Workspace name. Omit for the default workspace.' },
        ticketKey: {
          type: 'string' as const,
          description: 'Jira ticket key, only when the human explicitly names one (e.g. "PROJ-123"). Omit otherwise.',
        },
      },
      required: ['agent', 'task'],
    },
  },
  {
    name: 'check_status',
    description: "Read a busy agent's live terminal output to report what they are doing right now.",
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string' as const, description: 'Agent name or id from the roster' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'remember',
    description:
      "Save something the crew should still know in future conversations: a preference the human states, a decision made, a fact about a workspace or teammate. Do NOT use it for chit-chat or for anything already in this conversation — memory is for what outlives it.",
    input_schema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string' as const, description: 'Short stable handle, e.g. "pr-style" or "base-branch". Reusing a key updates that memory.' },
        text: { type: 'string' as const, description: 'The fact, in one sentence, written so it makes sense weeks later.' },
        scope: {
          type: 'string' as const,
          enum: ['session', 'workspace', 'global'],
          description: 'session = only this conversation; workspace = this repo group; global = always true of the crew.',
        },
      },
      required: ['key', 'text', 'scope'],
    },
  },
  {
    name: 'raise_hand',
    description:
      "Raise a hand for an agent or squad leader who was NOT addressed but has something valuable to add. They do not speak — the human sees the hand in the roster and decides whether to call on them. Use instead of letting a non-addressed agent interrupt.",
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: { type: 'string' as const, description: 'Name of the agent or squad leader raising their hand' },
        reason: { type: 'string' as const, description: 'One short line: what they want to add' },
      },
      required: ['agent', 'reason'],
    },
  },
  {
    name: 'lookup_ticket',
    description:
      "Look up a Jira ticket's summary and status to answer a question in conversation. Read-only — never comments or changes status.",
    input_schema: {
      type: 'object' as const,
      properties: {
        ticketKey: { type: 'string' as const, description: 'Jira ticket key, e.g. "PROJ-123"' },
      },
      required: ['ticketKey'],
    },
  },
  {
    name: 'draft_agent',
    description:
      "Generate a complete draft teammate from the human's request (name, role, backstory, style). Does NOT create anything — pitch the draft aloud and ask for confirmation, then use confirm_agent. A new call replaces any unconfirmed draft.",
    input_schema: {
      type: 'object' as const,
      properties: {
        spec: {
          type: 'string' as const,
          description: "The human's words describing the teammate they want, e.g. 'an Architect agent, grumpy veteran'",
        },
      },
      required: ['spec'],
    },
  },
  {
    name: 'confirm_agent',
    description:
      'Resolve the pending draft teammate after the human answered the pitch: accept=true persists them to the crew, accept=false discards the draft. Only call AFTER the human clearly answered.',
    input_schema: {
      type: 'object' as const,
      properties: {
        accept: { type: 'boolean' as const, description: 'true = the human said yes; false = they declined' },
      },
      required: ['accept'],
    },
  },
  {
    name: 'check_feeds',
    description:
      "Look deeper into what the crew has been reading — news, tech, sports, government notices, and release notes. Use when the conversation goes past what you already know from today's digest. Read-only.",
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Free text matched against titles and summaries' },
        tag: { type: 'string' as const, description: 'Optional: news, tech, sports, gov, or release' },
        sinceDays: { type: 'number' as const, description: 'How far back to look; default 7, max 30' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_docs',
    description: 'Search Confluence for docs relevant to a question in conversation. Read-only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Search text' },
      },
      required: ['query'],
    },
  },
];

export function buildPersona(identity: IdentityPromptInfo): string {
  const n = identity.name;
  return `You voice a team of AI agents in a live meeting, plus ${n}, their host. You speak FOR the agents and FOR ${n} — never as an unnamed narrator.

The team is a tight Latino crew out of the Dominican Republic. They speak English sprinkled naturally with Dominican Spanish where it fits ("dale", "tranquilo", "mi gente", "ahora sí") — warm, expressive, proud. Each agent's own persona style always wins over the group default.

${n} (${identity.role}) is the broker's own identity — the host, not crew:
- Speaking style: ${identity.style}
- ${n} owns: the session-open greeting, roster/status/meta answers ("who is free?", "what is everyone doing?"), system-action announcements (agent created, workspace switched), general questions no crew member plausibly owns, and agent creation (draft_agent / confirm_agent).
- Deference: if a crew member plausibly owns the question, ${n} does NOT answer — that agent does. ${n} fronts only what belongs to nobody.
- ${n} never takes delegated work and can never be delegated to. Real work always goes to a crew agent via the delegate tool.
- "Hey team" / "everyone" addresses the crew, not ${n}.

Addressing rules — decide who the human is talking to, and reply accordingly:
- Every spoken line MUST begin with the speaking party's name, a colon, and a space (e.g. "Manuel: On it." or "${n}: Welcome back."). There is NO unnamed narrator — a line without a speaker prefix is a bug. If unsure who was addressed, pick the most relevant agent and have THEM answer.
- Addressed to one agent by name -> ONLY that agent replies. Addressed to ${n} by name -> ONLY ${n} replies.
- Addressed to the whole team, or to no one in particular -> every INDIVIDUAL agent replies once, briefly, in their own voice, and each squad's leader replies once on the squad's behalf. An agent inside a squad exists only as that squad — they never also reply solo.
- Addressed to a squad (by squad id or its leader's name) -> ONLY that squad's leader replies, speaking for the whole squad. This holds even when the message asks squad members to each respond ("introduce yourselves") — the leader answers on the squad's behalf; members never speak.

Meeting etiquette (respectful video-call rules):
- Only the addressed party speaks in a turn. Nobody talks over anybody.
- A non-addressed agent or squad leader with something valuable to add does NOT speak — use the raise_hand tool with their name and a one-line reason. The human sees the hand in the roster and may call on them.
- When the human gives someone the floor ("go ahead, X", "X, you have the floor"), that agent speaks and their hand comes down.

Creating agents (${n} only):
- When the human asks for a new agent/teammate, call draft_agent with their words as the spec. Then, AS ${n}, pitch the draft in one or two sentences (name, role, flavor) and ask whether to add them. NEVER call confirm_agent in the same turn as draft_agent.
- Only after the human clearly accepts ("yes", "dale", "add him") call confirm_agent with accept=true; if they decline, accept=false. A new draft_agent replaces any unconfirmed draft.

Rules:
- Keep every reply SHORT and conversational — one to three spoken sentences per speaker. You are heard, not read.
- Stay in each agent's voice as described by their persona; stay in ${n}'s style for ${n}'s lines.
- Never read code, JSON, file paths, or long output aloud; summarize what it means instead.
- Use the delegate tool for any real work; do not attempt work yourself.
- Use check_status when asked what an agent is doing.
- If the requested agent is busy, say so and offer an idle agent from the roster.
- Task completions are announced by the agent who did the work, in their own voice — not by ${n}.

Current roster:
`;
}

const MAX_TOOL_ROUNDS = 4;

/** A turn is: user(string) -> assistant(...) -> [user(tool_results) -> assistant(...)]*.
 * Only a `{role: 'user', content: string}` entry marks the start of a turn — tool_result
 * entries are also role 'user' but carry array content. */
export type HistoryEntry = { role: 'user' | 'assistant'; content: string | unknown[] };

export class BrokerBrain {
  private history: HistoryEntry[] = [];
  private readonly model: string;
  private readonly maxHistory: number;
  private readonly persona: string;

  constructor(
    private readonly streamFactory: StreamFactory,
    private readonly executors: ToolExecutors,
    opts?: { model?: string; maxHistory?: number; identity?: IdentityPromptInfo },
  ) {
    this.model = opts?.model ?? 'claude-haiku-4-5';
    this.maxHistory = opts?.maxHistory ?? 20;
    this.persona = buildPersona(opts?.identity ?? promptInfo(DEFAULT_IDENTITY));
  }

  async handleUtterance(text: string, turn: BrainTurn): Promise<void> {
    const chunker = new SpeechChunker(turn.onSpeech);
    this.history.push({ role: 'user', content: text });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const params: Parameters<StreamFactory>[0] = {
        model: this.model,
        max_tokens: 1024,
        system: this.persona + turn.roster + (turn.digest ?? ''),
        messages: [...this.history],
        tools: TOOLS,
      };
      if (round === MAX_TOOL_ROUNDS - 1) {
        // Last permitted round: keep tools in the request (required whenever history
        // contains tool blocks) but force a text-only reply so the turn always closes
        // with speech instead of leaving a dangling tool_use with no tool_result.
        params.tool_choice = { type: 'none' };
      }
      const stream = this.streamFactory(params);
      stream.on('text', (delta) => chunker.push(delta));
      const final = await stream.finalMessage();
      // A round boundary is a speech boundary: flush so text that ends without
      // trailing whitespace ("…pain points.") can't concatenate onto the next
      // round's speaker line ("Gabriel: …") inside one chunk.
      chunker.flush();

      this.history.push({ role: 'assistant', content: final.content });

      if (final.stop_reason !== 'tool_use') break;

      const results: unknown[] = [];
      for (const block of final.content) {
        if (block.type !== 'tool_use' || !block.id || !block.name) continue;
        const output = await this.execute(block.name, block.input);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      }
      this.history.push({ role: 'user', content: results });
    }

    chunker.flush();
    this.trimHistory();
  }

  /** Inject a system-originated observation (e.g. "task finished") as a turn. */
  async handleSystemNote(note: string, turn: BrainTurn): Promise<void> {
    await this.handleUtterance(`[system note — not the human speaking] ${note}`, turn);
  }

  /** Snapshot the conversation for session persistence. */
  exportHistory(): HistoryEntry[] {
    return [...this.history];
  }

  /** Deterministic session-birth context (workspace description + links) — no API call (spec §3). */
  seedContext(note: string): void {
    this.history.push({ role: 'user', content: `[workspace context — not the human speaking] ${note}` });
    this.history.push({ role: 'assistant', content: 'Noted.' });
  }

  /** Replace the conversation — switching sessions swaps brain memory wholesale. */
  loadHistory(history: HistoryEntry[]): void {
    this.history = [...history];
  }

  /**
   * Trim history down to maxHistory entries WITHOUT cutting mid-turn: the Anthropic API
   * requires the first message to have role 'user', and every tool_use block must be
   * followed immediately by its tool_result. A naive `slice(-maxHistory)` can land the
   * cut inside a turn (e.g. right after an assistant tool_use, before its tool_result),
   * producing a 400. Instead, scan forward from the naive cut point to the next real
   * turn boundary — a `{role: 'user', content: string}` entry — and cut there.
   */
  private trimHistory(): void {
    if (this.history.length <= this.maxHistory) return;
    let start = this.history.length - this.maxHistory;
    while (start < this.history.length && !(this.history[start]!.role === 'user' && typeof this.history[start]!.content === 'string')) {
      start++;
    }
    this.history = this.history.slice(start);
  }

  private async execute(name: string, input: unknown): Promise<string> {
    try {
      if (name === 'delegate')
        return await this.executors.delegate(input as { agent: string; task: string; workspace?: string; repo?: string; ticketKey?: string });
      if (name === 'check_status') return await this.executors.check_status(input as { agent: string });
      if (name === 'raise_hand') return await this.executors.raise_hand(input as { agent: string; reason: string });
      if (name === 'remember') return await this.executors.remember(input as { key: string; text: string; scope: string });
      if (name === 'lookup_ticket') return await this.executors.lookup_ticket(input as { ticketKey: string; workspace: string });
      if (name === 'search_docs') return await this.executors.search_docs(input as { query: string; workspace: string });
      if (name === 'check_feeds')
        return await this.executors.check_feeds(input as { query: string; tag?: string; sinceDays?: number });
      if (name === 'draft_agent') return await this.executors.draft_agent(input as { spec: string });
      if (name === 'confirm_agent') return await this.executors.confirm_agent(input as { accept: boolean });
      return `unknown tool: ${name}`;
    } catch (err) {
      return `tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
