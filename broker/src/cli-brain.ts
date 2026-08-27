/**
 * CliBrain — a subscription-CLI-backed StreamFactory for BrokerBrain, driving
 * `claude -p --json-schema` (or any CLI accepting the same shape) instead of
 * an API key. This is the no-key kind for operators on a `claude` subscription
 * rather than LM Studio/Ollama (local-brain.ts) or a Gemini key
 * (gemini-brain.ts).
 *
 * The brain speaks one dialect: Anthropic-shaped params in, Anthropic-shaped
 * content blocks out (see brain.ts BrainStreamLike/StreamFactory). This
 * module is the only place that knows this CLI's `--json-schema` contract
 * exists; brain.ts is untouched, which is the whole point of the
 * StreamFactory seam.
 *
 * One thing sets this kind apart from every sibling brain: it cannot stream.
 * Measured against `claude -p --json-schema`: the whole `{speech,
 * tool_calls[]}` envelope arrives as a single JSON blob on exit, in
 * 26–29s, with nothing on the wire before then. So this kind is
 * text-capable and NOT voice-capable — voice needs first words in ~1s (see
 * local-brain.ts's 1.02s measurement), and a 26–29s silent wait cannot
 * deliver that by construction. `finalMessage()` does all the work and
 * `on("text")` fires exactly once, with the whole speech string, right
 * before it resolves.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSpawner, type Spawner } from "./research.ts";

/**
 * How each known CLI is made to produce the `{speech, tool_calls[]}` envelope.
 * The dialects genuinely differ, and feeding one CLI another's flags is not a
 * degraded turn but a dead one (`--json-schema` is an unknown flag to codex
 * and copilot — the process exits before any model runs):
 *
 * - `flag`:   `--json-schema '<inline schema>'` — claude, the only CLI
 *             verified to ENFORCE the schema (spec
 *             2026-08-15-brain-engine-selection).
 * - `file`:   `--output-schema <file>` + `--output-last-message <file>` —
 *             codex. Real enforcement, but both sides travel as files: the
 *             schema in, and the final message out (codex's stdout is the
 *             session transcript, not the reply).
 * - `prompt`: no schema support at all (copilot/opencode) or a flag that is
 *             accepted but not enforced (agy). The schema travels in the
 *             prompt and the reply is CLEANED (fences stripped) then parsed
 *             strictly — soft enforcement fails loudly on a malformed reply
 *             rather than degrading into empty speech.
 *
 * A CLI absent from this table has no known brain dialect; brain-engine.ts
 * gates on membership, so an unknown cli falls through to the terminal
 * fallback rather than reaching a spawn that cannot work.
 */
export const BRAIN_SCHEMA_MODES: Record<string, "flag" | "file" | "prompt"> = {
  claude: "flag",
  codex: "file",
  agy: "prompt",
  copilot: "prompt",
  opencode: "prompt",
};

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

interface CliTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

/**
 * Renders one history block to plain text. Tool activity is described in
 * prose rather than replayed as structured turns: unlike the OpenAI-compatible
 * and Gemini wire formats, a one-shot CLI process has no multi-turn protocol
 * of its own — it only ever sees a single prompt string.
 */
function blockText(b: AnthropicBlock): string {
  if (b.type === "text" && b.text) return b.text;
  if (b.type === "tool_use") return `[called ${b.name} with ${JSON.stringify(b.input ?? {})}]`;
  if (b.type === "tool_result") {
    const result = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
    return `[result: ${result}]`;
  }
  return "";
}

/** Anthropic history + system → the single prompt string this kind can accept. */
export function toPrompt(system: string, messages: unknown[]): string {
  const turns = (messages as HistoryMessage[])
    .map((m) => {
      const text =
        typeof m.content === "string" ? m.content : (m.content ?? []).map(blockText).filter(Boolean).join("\n");
      return text ? `${m.role}: ${text}` : "";
    })
    .filter(Boolean);
  return turns.length ? `${system}\n\n${turns.join("\n\n")}` : system;
}

/**
 * Anthropic `tools[]` → the `{speech, tool_calls[]}` JSON Schema this kind's
 * `--json-schema` flag needs. `name` is an enum of the caller's own tool
 * names, so the CLI can only ever request a tool that actually exists.
 *
 * `forceTextOnly` mirrors `tool_choice: {type:"none"}`, which brain.ts sets
 * on the last permitted tool round to force a text-only close — without it,
 * the turn could end with a dangling tool_use that never receives a
 * tool_result. gemini-brain.ts and local-brain.ts honour that flag through
 * their own request shapes (`functionCallingConfig.mode`, `tool_choice:
 * "none"`); a one-shot CLI schema has no such field, so the schema itself is
 * the only lever — `tool_calls` is constrained to length 0 so nothing valid
 * can populate it, rather than merely leaving it unenforced.
 */
export function toJsonSchema(tools: unknown[], forceTextOnly = false): Record<string, unknown> {
  const names = (tools as CliTool[]).map((t) => t.name);
  return {
    type: "object",
    properties: {
      speech: { type: "string" },
      tool_calls: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: names },
            input: { type: "object" },
          },
          required: ["name", "input"],
        },
        ...(forceTextOnly ? { maxItems: 0 } : {}),
      },
    },
    required: ["speech", "tool_calls"],
  };
}

export class CliBrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliBrainError";
  }
}

export interface CliBrainDeps {
  /** The CLI binary and its flags, e.g. `["claude", "-p"]`. The prompt is appended as the final element — never part of this array. */
  argv: string[];
  /** "default" is treated as no opinion — see research.ts's CliResearch.complete. */
  model?: string;
  /** Defaults to research.ts's production spawner. */
  spawn?: Spawner;
}

interface SchemaEnvelope {
  speech: string;
  tool_calls: Array<{ name: string; input: unknown }>;
}

/**
 * Prompt-mode replies come from CLIs nothing forced into raw JSON, so the
 * envelope often arrives dressed — a markdown fence, a "Sure!" preamble.
 * Undress it (fenced block first, else outermost braces) but never repair it:
 * what this returns still has to survive parseEnvelope's strict shape check.
 */
function extractJson(raw: string): string {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return t.slice(start, end + 1);
  return t;
}

/** Parses the CLI's stdout into the envelope this kind requires. Throws rather than degrading into empty speech. */
function parseEnvelope(cliName: string, stdout: string): SchemaEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliBrainError(`${cliName}: could not parse reply as JSON: ${stdout.slice(0, 200)}`);
  }
  const speech = (parsed as { speech?: unknown }).speech;
  const toolCalls = (parsed as { tool_calls?: unknown }).tool_calls;
  if (typeof speech !== "string" || !Array.isArray(toolCalls)) {
    throw new CliBrainError(
      `${cliName}: could not parse reply into the {speech, tool_calls} shape: ${stdout.slice(0, 200)}`,
    );
  }
  return { speech, tool_calls: toolCalls as SchemaEnvelope["tool_calls"] };
}

/**
 * Build a StreamFactory the BrokerBrain can use in place of the Anthropic
 * SDK, driving a subscription CLI instead of an API key.
 *
 * The request is issued lazily inside finalMessage(), not in the factory:
 * brain.ts registers its "text" listener AFTER calling the factory
 * (`stream.on(...)` then `await stream.finalMessage()`), so spawning early
 * would risk the listener missing the (single) speech delta.
 */
export function createCliStreamFactory(deps: CliBrainDeps) {
  const spawn = deps.spawn ?? defaultSpawner;
  // "default" is the sentinel every driver treats as "no opinion, let the
  // CLI's own default stand" (swarm/drivers/model-flag.ts) — same handling
  // as research.ts's CliResearch.complete.
  const model = deps.model && deps.model !== "default" ? deps.model : undefined;

  return (params: AnthropicParams) => {
    const listeners: Array<(delta: string) => void> = [];

    return {
      on(event: "text", cb: (delta: string) => void) {
        if (event === "text") listeners.push(cb);
      },

      async finalMessage() {
        const withModel = model ? [...deps.argv, "--model", model] : [...deps.argv];
        const forceTextOnly = (params.tool_choice as { type?: string } | undefined)?.type === "none";
        const schema = toJsonSchema(params.tools, forceTextOnly);
        // The prompt is the FINAL argv element, unescaped — see research.ts's
        // CliResearch for why: spawn takes an argv ARRAY with no shell, so
        // quotes/newlines/backticks reach execve as ordinary bytes.
        const prompt = toPrompt(params.system, params.messages);
        const mode = BRAIN_SCHEMA_MODES[deps.argv[0]] ?? "prompt";

        const run = async (argv: string[]) => {
          const { code, stdout, stderr } = await spawn(argv);
          if (code !== 0) {
            const detail = stderr.trim() || stdout.trim() || (code === null ? "killed or timed out" : `exit ${code}`);
            throw new CliBrainError(`${deps.argv[0]} failed: ${detail}`);
          }
          return stdout;
        };

        let raw: string;
        if (mode === "file") {
          // Per-turn temp dir, removed in finally — a leak here compounds at
          // one dir per brain turn.
          const dir = await mkdtemp(join(tmpdir(), "smith-brain-"));
          try {
            const schemaPath = join(dir, "schema.json");
            const lastPath = join(dir, "last-message.json");
            await writeFile(schemaPath, JSON.stringify(schema));
            await run([...withModel, "--output-schema", schemaPath, "--output-last-message", lastPath, prompt]);
            // An unwritten file parses as "" and fails parseEnvelope loudly —
            // the transcript on stdout is never a fallback source.
            raw = await readFile(lastPath, "utf8").catch(() => "");
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        } else if (mode === "flag") {
          raw = (await run([...withModel, "--json-schema", JSON.stringify(schema), prompt])).trim();
        } else {
          const framed =
            `${prompt}\n\nRespond with ONLY a single JSON object matching this JSON Schema — ` +
            `no markdown fences, no commentary before or after:\n${JSON.stringify(schema)}`;
          raw = extractJson(await run([...withModel, framed]));
        }

        const envelope = parseEnvelope(deps.argv[0], raw.trim());

        // No streaming exists for this kind — the whole speech string is
        // emitted as ONE delta, after the process exits and before resolving.
        if (envelope.speech) for (const cb of listeners) cb(envelope.speech);

        const content: AnthropicBlock[] = [];
        if (envelope.speech) content.push({ type: "text", text: envelope.speech });
        let synth = 0;
        for (const call of envelope.tool_calls) {
          content.push({ type: "tool_use", id: `cli_call_${++synth}`, name: call.name, input: call.input ?? {} });
        }

        return { content, stop_reason: envelope.tool_calls.length > 0 ? "tool_use" : "end_turn" };
      },
    };
  };
}
