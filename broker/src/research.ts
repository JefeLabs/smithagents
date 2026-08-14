/**
 * Research mode — the broker's tool-free calls (session titles, dictation
 * polish, feed plans, brief analysis, election claims, doc edits).
 *
 * Deliberately narrow: a prompt in, text out. No tools, no conversation
 * history, no streamed deltas. The one site that needs those — BrokerBrain,
 * which hands the model ten caller-defined tool schemas and loops on
 * stop_reason === "tool_use" — is NOT a research engine and must never be
 * routed through here. That distinction is what lets any CLI serve this
 * interface: none of them accept a foreign tool schema.
 */

export interface ResearchInput {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface ResearchEngine {
  complete(input: ResearchInput): Promise<string>;
}

/** Typed failure so callers can tell "the engine broke" from "the model said nothing". */
export class ResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchError";
  }
}

/** The shape of `anthropic.messages.create` this needs — injected so tests need no SDK. */
export type MessagesCreate = (params: {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}) => Promise<unknown>;

export class AnthropicResearch implements ResearchEngine {
  constructor(
    private readonly create: MessagesCreate,
    private readonly model: string,
  ) {}

  async complete(input: ResearchInput): Promise<string> {
    let reply: unknown;
    try {
      reply = await this.create({
        model: this.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
      });
    } catch (err) {
      throw new ResearchError(String((err as Error).message));
    }
    const blocks = (reply as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new ResearchError("engine returned no text");
    return text;
  }
}
