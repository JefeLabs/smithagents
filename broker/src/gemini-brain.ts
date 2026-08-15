/**
 * GeminiBrain — a Gemini-backed StreamFactory for BrokerBrain.
 *
 * The brain speaks one dialect: Anthropic-shaped params in, Anthropic-shaped
 * content blocks out (see brain.ts BrainStreamLike/StreamFactory). This module
 * is the only place that knows Gemini exists; brain.ts is untouched, which is
 * the whole point of the StreamFactory seam.
 *
 * Three things about Gemini that the translation turns on, all verified
 * against the live API rather than assumed:
 *
 *  1. `finishReason` is "STOP" even when the model emits a function call —
 *     there is no TOOL_CALLS equivalent. So `stop_reason: "tool_use"` is
 *     derived from the PRESENCE of functionCall parts. Reading finishReason
 *     instead would silently break every tool round.
 *  2. `functionCall` carries its own `id` ("call_224103"), so tool_use ids
 *     round-trip without synthesis. We still synthesize a fallback, because
 *     older models omit it and Anthropic requires an id.
 *  3. A tool RESULT going back to Gemini is keyed by function NAME, but
 *     Anthropic's tool_result block only carries `tool_use_id`. We therefore
 *     walk the history building an id → name map from the preceding assistant
 *     turn. Without it every second tool round is unaddressable.
 */

/** Injected so tests script turns without network. Production: global fetch. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Gemini's Schema is a strict SUBSET of JSON Schema and 400s on unknown keys
 * (`additionalProperties` and `$schema` are the ones our tool defs actually
 * carry). Recursively keep only what it accepts.
 */
const SCHEMA_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
  "minItems",
  "maxItems",
  "anyOf",
]);

export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    out[k] = k === "properties" ? mapValues(v as Record<string, unknown>, sanitizeSchema) : sanitizeSchema(v);
  }
  return out;
}

function mapValues(o: Record<string, unknown>, fn: (v: unknown) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fn(v)]));
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  /**
   * Carried through the brain's history purely so it can be handed back to
   * Gemini on the next round. brain.ts never reads it — the block is opaque
   * data to everything between blocksFromParts() and toGeminiContents().
   */
  thoughtSignature?: string;
}

interface HistoryMessage {
  role: string;
  content: string | AnthropicBlock[];
}

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
  /**
   * Gemini 3's opaque reasoning receipt, a SIBLING of functionCall (not a field
   * inside it). Replaying a functionCall without it is a hard 400: "Function
   * call is missing a thought_signature in functionCall parts." So it has to
   * survive the round trip through Anthropic-shaped history — see
   * AnthropicBlock.thoughtSignature.
   */
  thoughtSignature?: string;
}

/**
 * Anthropic history → Gemini `contents`.
 *
 * Roles: user stays "user", assistant becomes "model". A user turn whose
 * content is an array of tool_result blocks is not really a user turn — it is
 * the function-response turn, and each block needs the name of the tool it
 * answers, recovered from the assistant turn that requested it.
 */
export function toGeminiContents(messages: unknown[]): Array<{ role: string; parts: GeminiPart[] }> {
  const idToName = new Map<string, string>();
  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];

  for (const raw of messages as HistoryMessage[]) {
    const { role, content } = raw;

    if (typeof content === "string") {
      contents.push({ role: role === "assistant" ? "model" : "user", parts: [{ text: content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const block of content ?? []) {
      if (block.type === "text" && block.text) {
        parts.push({ text: block.text });
      } else if (block.type === "tool_use" && block.name) {
        if (block.id) idToName.set(block.id, block.name);
        parts.push({
          functionCall: {
            name: block.name,
            args: (block.input as Record<string, unknown>) ?? {},
            ...(block.id ? { id: block.id } : {}),
          },
          ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
        });
      } else if (block.type === "tool_result") {
        const name = (block.tool_use_id && idToName.get(block.tool_use_id)) || "unknown_tool";
        parts.push({
          functionResponse: {
            name,
            ...(block.tool_use_id ? { id: block.tool_use_id } : {}),
            // Gemini requires an object; the brain's executors return a string.
            response: { result: typeof block.content === "string" ? block.content : JSON.stringify(block.content) },
          },
        });
      }
    }

    // An assistant turn that produced nothing is dropped: Gemini rejects
    // `parts: []`, and an empty model turn carries no information anyway.
    if (parts.length === 0) continue;
    contents.push({ role: role === "assistant" ? "model" : "user", parts });
  }

  return contents;
}

export interface AnthropicParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: unknown[];
  tools: unknown[];
  tool_choice?: unknown;
}

/** Anthropic-shaped request → the Gemini request body. Pure, so tests can assert it. */
export function toGeminiRequest(params: AnthropicParams): Record<string, unknown> {
  const declarations = (params.tools as Array<{ name: string; description?: string; input_schema?: unknown }>).map(
    (t) => ({
      name: t.name,
      description: t.description ?? "",
      parameters: sanitizeSchema(t.input_schema),
    }),
  );

  // brain.ts sends `{type:"none"}` on the final round to force a text-only
  // close. Gemini spells the same intent as functionCallingConfig.mode.
  const mode = (params.tool_choice as { type?: string } | undefined)?.type === "none" ? "NONE" : "AUTO";

  return {
    systemInstruction: { parts: [{ text: params.system }] },
    contents: toGeminiContents(params.messages),
    ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
    toolConfig: { functionCallingConfig: { mode } },
    generationConfig: { maxOutputTokens: params.max_tokens },
  };
}

/**
 * Gemini parts → Anthropic content blocks.
 *
 * `stop_reason` is "tool_use" iff a functionCall is present — see note 1 in the
 * file header. Empty text parts (Gemini emits one carrying only a
 * thoughtSignature) are dropped so they can't become empty speech.
 */
export function blocksFromParts(parts: GeminiPart[]): {
  content: AnthropicBlock[];
  stop_reason: string;
} {
  const content: AnthropicBlock[] = [];
  let sawToolCall = false;
  let synth = 0;

  for (const p of parts) {
    if (p.functionCall) {
      sawToolCall = true;
      content.push({
        type: "tool_use",
        id: p.functionCall.id ?? `gemini_call_${++synth}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
        ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {}),
      });
    } else if (p.text) {
      content.push({ type: "text", text: p.text });
    }
  }

  return { content, stop_reason: sawToolCall ? "tool_use" : "end_turn" };
}

/** One `data:` payload from the SSE stream. */
interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  error?: { message?: string; status?: string };
}

/**
 * Splits an SSE byte stream into parsed `data:` payloads. Chunk boundaries fall
 * anywhere, so a partial line is held in `buffer` until its newline arrives —
 * parsing per network chunk instead would corrupt long tool arguments.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<GeminiChunk> {
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
            yield JSON.parse(payload) as GeminiChunk;
          } catch {
            // A malformed frame is skipped rather than killing the turn.
          }
        }
      }
      nl = buffer.indexOf("\n");
    }
  }
}

export class GeminiError extends Error {}

/**
 * Bounds a single request — the identical gap local-brain.ts closes, and for
 * the identical reason: a request that hangs instead of rejecting would queue
 * every later turn behind it forever (brain.ts's caller only catches
 * rejections). Same value and justification as local-brain.ts's
 * BRAIN_REQUEST_TIMEOUT_MS: matches research.ts's 120s CLI-kill order of
 * magnitude, generous enough for a cold-loaded model's first response.
 */
const BRAIN_REQUEST_TIMEOUT_MS = 120_000;

/**
 * AbortSignal.timeout()'s firing surfaces as a `TimeoutError` DOMException
 * (or, depending on where fetch/undici observes the abort, a generic
 * `AbortError`) whose message is the unhelpful "The operation was aborted."
 * Recognize either by name so the caller can throw something that names the
 * URL and the timeout instead.
 */
function isAbortTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export interface GeminiDeps {
  apiKey: string;
  /** Defaults to global fetch; injected in tests. */
  fetchImpl?: FetchLike;
  /** Overridable for tests; production default is BRAIN_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Build a StreamFactory the BrokerBrain can use in place of the Anthropic SDK.
 *
 * The request is issued lazily inside finalMessage(), not in the factory:
 * brain.ts registers its "text" listener AFTER calling the factory
 * (`stream.on(...)` then `await stream.finalMessage()`), so starting the
 * network early would risk dropping the opening speech deltas.
 */
export function createGeminiStreamFactory(deps: GeminiDeps) {
  const doFetch: FetchLike = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = deps.timeoutMs ?? BRAIN_REQUEST_TIMEOUT_MS;

  return (params: AnthropicParams) => {
    const listeners: Array<(delta: string) => void> = [];

    return {
      on(event: "text", cb: (delta: string) => void) {
        if (event === "text") listeners.push(cb);
      },

      async finalMessage() {
        const url = `${ENDPOINT}/${params.model}:streamGenerateContent?alt=sse`;
        let res: Response;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: { "x-goog-api-key": deps.apiKey, "content-type": "application/json" },
            body: JSON.stringify(toGeminiRequest(params)),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          if (isAbortTimeout(err)) {
            throw new GeminiError(`Gemini ${url} timed out after ${timeoutMs}ms`);
          }
          throw new GeminiError(`Gemini request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new GeminiError(`Gemini ${res.status}: ${detail.slice(0, 400) || "no response body"}`);
        }

        const parts: GeminiPart[] = [];
        for await (const chunk of parseSse(res.body)) {
          if (chunk.error) throw new GeminiError(`Gemini: ${chunk.error.message ?? chunk.error.status}`);
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            parts.push(part);
            // Speech streams as it arrives; tool calls are silent by nature.
            if (part.text) for (const cb of listeners) cb(part.text);
          }
        }

        return blocksFromParts(parts);
      },
    };
  };
}
