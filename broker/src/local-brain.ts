/**
 * LocalBrain — an OpenAI-compatible StreamFactory for BrokerBrain, aimed at a
 * locally-hosted server (LM Studio, Ollama). This is the project's happy
 * path: no API key, no per-token cost, and — measured against `gpt-oss-20b`
 * on LM Studio — 1.02s to first words with tool calls streamed in 0.69s. It
 * is the only no-key kind that both streams and calls tools, which is also
 * what makes it the only no-key kind that can carry voice.
 *
 * The brain speaks one dialect: Anthropic-shaped params in, Anthropic-shaped
 * content blocks out (see brain.ts BrainStreamLike/StreamFactory). This
 * module is the only place that knows the OpenAI wire format exists;
 * brain.ts is untouched, which is the whole point of the StreamFactory seam.
 *
 * Two things about the OpenAI-compatible format that the translation turns on:
 *
 *  1. Tool call arguments arrive as STRING FRAGMENTS spread across multiple
 *     stream chunks, keyed by `index` (there is no single "here is the whole
 *     call" event). Each fragment is concatenated onto an accumulator and the
 *     result is JSON.parsed exactly once, after the stream ends — parsing a
 *     fragment on its own would break on partial JSON like `{"agent":`.
 *  2. There is no dedicated "tool_use" finish reason to key off of (unlike
 *     Anthropic's own `stop_reason`); `stop_reason: "tool_use"` is derived
 *     from whether any tool call was assembled, mirroring how gemini-brain.ts
 *     derives it from the presence of a functionCall part rather than trusting
 *     the provider's own finish signal.
 */

/** Injected so tests script turns without network. Production: global fetch. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface HistoryMessage {
  role: string;
  content: string | AnthropicBlock[];
}

export interface AnthropicParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: unknown[];
  tools: unknown[];
  tool_choice?: unknown;
}

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/**
 * Anthropic history → OpenAI-compatible `messages`, with `system` translated
 * into a leading `{role:"system"}` entry (the OpenAI-compatible wire format
 * has no separate system field).
 *
 * A `tool_result` block is Anthropic's way of keying a result to the call it
 * answers by id; the OpenAI-compatible shape says the same thing as a
 * standalone `{role:"tool", tool_call_id, content}` message, so a single
 * Anthropic user turn carrying several tool_result blocks (multiple tools
 * answered in one round) expands into several tool messages here.
 *
 * Assumes a message's block array is never MIXED — either all tool_result,
 * or all text/tool_use — which holds today because that is what brain.ts's
 * HistoryEntry ever produces. If that invariant ever changes, a mixed array
 * silently drops whichever kind isn't matched by the first branch taken.
 */
export function toOpenAiMessages(system: string, messages: unknown[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];

  for (const raw of messages as HistoryMessage[]) {
    const { role, content } = raw;

    if (typeof content === "string") {
      out.push({ role, content });
      continue;
    }

    const blocks = content ?? [];
    if (blocks.length === 0) continue;

    const toolResults = blocks.filter((b) => b.type === "tool_result");
    if (toolResults.length > 0) {
      for (const b of toolResults) {
        out.push({
          role: "tool",
          tool_call_id: b.tool_use_id ?? "",
          content: typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""),
        });
      }
      continue;
    }

    const text = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
    const toolCalls: OpenAiToolCall[] = blocks
      .filter((b) => b.type === "tool_use" && b.id && b.name)
      .map((b) => ({
        id: b.id as string,
        type: "function",
        function: { name: b.name as string, arguments: JSON.stringify(b.input ?? {}) },
      }));

    out.push({
      role,
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
}

/** Anthropic `tools[].input_schema` → OpenAI-compatible `tools[].function.parameters`. */
export function toOpenAiTools(
  tools: unknown[],
): Array<{ type: "function"; function: { name: string; description: string; parameters: unknown } }> {
  return (tools as Array<{ name: string; description?: string; input_schema?: unknown }>).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * Anthropic-shaped request → the OpenAI-compatible chat completions body. Pure, so tests can assert it.
 *
 * `model` undefined omits the field entirely rather than sending a placeholder —
 * a local server (LM Studio, Ollama) serves one fixed model per instance, so an
 * operator who names only a baseUrl means "whatever's loaded", and the field
 * must not carry brain.ts's Anthropic-model default (see LocalBrainDeps.model).
 */
export function toOpenAiRequest(params: AnthropicParams, model: string | undefined): Record<string, unknown> {
  // brain.ts sends `{type:"none"}` on the final round to force a text-only
  // close; the OpenAI-compatible wire format spells the same intent as the
  // literal string "none" (vs. leaving tool_choice unset, i.e. "auto").
  const forceTextOnly = (params.tool_choice as { type?: string } | undefined)?.type === "none";

  return {
    ...(model ? { model } : {}),
    stream: true,
    max_tokens: params.max_tokens,
    messages: toOpenAiMessages(params.system, params.messages),
    ...(params.tools.length ? { tools: toOpenAiTools(params.tools) } : {}),
    ...(forceTextOnly ? { tool_choice: "none" } : {}),
  };
}

interface OpenAiDeltaToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  choices?: Array<{ delta?: { content?: string; tool_calls?: OpenAiDeltaToolCall[] } }>;
  error?: { message?: string };
}

/**
 * Splits an SSE byte stream into parsed `data:` payloads. Chunk boundaries fall
 * anywhere, so a partial line is held in `buffer` until its newline arrives —
 * parsing per network chunk instead would corrupt long tool arguments.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenAiChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            yield JSON.parse(payload) as OpenAiChunk;
          } catch {
            // A malformed frame is skipped rather than killing the turn.
          }
        }
      }
      nl = buffer.indexOf("\n");
    }
  }
}

export class LocalBrainError extends Error {}

export interface LocalBrainDeps {
  baseUrl: string;
  /**
   * A local server (LM Studio, Ollama) serves one fixed model per running
   * instance, so the model is bound HERE, at factory construction — the
   * per-call `AnthropicParams.model` is intentionally ignored (see
   * toOpenAiRequest, which takes `model` as a separate argument rather than
   * reading `params.model`). This is the opposite of gemini-brain.ts, which
   * reads `params.model` on every call to pick the request URL, because a
   * single Gemini API key can address many models. A caller that resolves
   * the model per turn (e.g. a user picking from several locally-loaded
   * models) must re-create the factory with the resolved model in `deps`,
   * not rely on passing it through `params`.
   *
   * Optional because swarm only requires `baseUrl` for a stored `local`
   * engine — an operator can leave the model unnamed to mean "whatever's
   * loaded". `undefined` here must NOT fall back to `params.model`: that
   * value is BrokerBrain's Anthropic default (brain.ts), which is meaningless
   * — and, against a local server that validates it strictly, breaking —
   * to send to a non-Anthropic API. toOpenAiRequest omits the field outright
   * instead (measured against LM Studio: sending an unrecognized model id is
   * harmless there, silently ignored in favor of whatever's loaded, but that
   * leniency isn't a contract this code should depend on).
   */
  model?: string;
  /** Defaults to global fetch; injected in tests. */
  fetchImpl?: FetchLike;
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  /** String fragments concatenated as they arrive; JSON.parsed once at the end. */
  arguments: string;
}

/**
 * Build a StreamFactory the BrokerBrain can use in place of the Anthropic SDK.
 *
 * The request is issued lazily inside finalMessage(), not in the factory:
 * brain.ts registers its "text" listener AFTER calling the factory
 * (`stream.on(...)` then `await stream.finalMessage()`), so starting the
 * network early would risk dropping the opening speech deltas.
 */
export function createLocalStreamFactory(deps: LocalBrainDeps) {
  const doFetch: FetchLike = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const url = `${deps.baseUrl}/v1/chat/completions`;

  return (params: AnthropicParams) => {
    const listeners: Array<(delta: string) => void> = [];

    return {
      on(event: "text", cb: (delta: string) => void) {
        if (event === "text") listeners.push(cb);
      },

      async finalMessage() {
        let res: Response;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(toOpenAiRequest(params, deps.model)),
          });
        } catch (err) {
          throw new LocalBrainError(
            `Local brain request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new LocalBrainError(
            `Local brain ${url} responded ${res.status}: ${detail.slice(0, 400) || "no response body"}`,
          );
        }

        let text = "";
        const toolCalls = new Map<number, ToolCallAccumulator>();

        for await (const chunk of parseSse(res.body)) {
          if (chunk.error) throw new LocalBrainError(`Local brain ${url}: ${chunk.error.message}`);

          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            for (const cb of listeners) cb(delta.content);
          }

          for (const tc of delta?.tool_calls ?? []) {
            const acc = toolCalls.get(tc.index) ?? { arguments: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
            toolCalls.set(tc.index, acc);
          }
        }

        const content: AnthropicBlock[] = [];
        if (text) content.push({ type: "text", text });

        let sawToolCall = false;
        let synth = 0;
        for (const [index, acc] of [...toolCalls].sort(([a], [b]) => a - b)) {
          if (!acc.name) continue;
          sawToolCall = true;
          let input: unknown = {};
          if (acc.arguments) {
            try {
              input = JSON.parse(acc.arguments);
            } catch (err) {
              // A server killed mid-generation (or a model emitting malformed
              // JSON) leaves a truncated argument string; surface it the same
              // way as every other failure path in this file — a
              // LocalBrainError naming the URL — instead of a raw SyntaxError.
              throw new LocalBrainError(
                `Local brain ${url}: tool call "${acc.name}" had unparseable arguments: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
          content.push({
            type: "tool_use",
            id: acc.id ?? `local_call_${index}_${++synth}`,
            name: acc.name,
            input,
          });
        }

        return { content, stop_reason: sawToolCall ? "tool_use" : "end_turn" };
      },
    };
  };
}
