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

export interface ToolExecutors {
  delegate(input: { agent: string; task: string }): Promise<string>;
  check_status(input: { agent: string }): Promise<string>;
}

export interface BrainTurn {
  roster: string;
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
];

const PERSONA = `You are the meeting coordinator for a team of AI agents, speaking aloud in a live voice meeting.
Rules:
- Keep every reply SHORT and conversational — one to three spoken sentences. You are heard, not read.
- Never read code, JSON, file paths, or long output aloud; summarize what it means instead.
- Use the delegate tool for any real work; do not attempt work yourself.
- Use check_status when asked what an agent is doing.
- If the requested agent is busy, say so and offer an idle agent from the roster.

Current roster:
`;

const MAX_TOOL_ROUNDS = 4;

export class BrokerBrain {
  private history: unknown[] = [];
  private readonly model: string;
  private readonly maxHistory: number;

  constructor(
    private readonly streamFactory: StreamFactory,
    private readonly executors: ToolExecutors,
    opts?: { model?: string; maxHistory?: number },
  ) {
    this.model = opts?.model ?? 'claude-haiku-4-5';
    this.maxHistory = opts?.maxHistory ?? 20;
  }

  async handleUtterance(text: string, turn: BrainTurn): Promise<void> {
    const chunker = new SpeechChunker(turn.onSpeech);
    this.history.push({ role: 'user', content: text });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = this.streamFactory({
        model: this.model,
        max_tokens: 1024,
        system: PERSONA + turn.roster,
        messages: [...this.history],
        tools: TOOLS,
      });
      stream.on('text', (delta) => chunker.push(delta));
      const final = await stream.finalMessage();

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
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }

  /** Inject a system-originated observation (e.g. "task finished") as a turn. */
  async handleSystemNote(note: string, turn: BrainTurn): Promise<void> {
    await this.handleUtterance(`[system note — not the human speaking] ${note}`, turn);
  }

  private async execute(name: string, input: unknown): Promise<string> {
    try {
      if (name === 'delegate') return await this.executors.delegate(input as { agent: string; task: string });
      if (name === 'check_status') return await this.executors.check_status(input as { agent: string });
      return `unknown tool: ${name}`;
    } catch (err) {
      return `tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
