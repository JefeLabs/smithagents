# Broker Engine Selection — Design

**Date:** 2026-08-14 · **Status:** DRAFT, awaiting Edwin's review
**Supersedes:** the first draft of this file, which split the broker by *streaming vs one-shot* and claimed a CLI engine could serve both. Both claims were wrong — see "What the first draft got wrong".

Edwin's framing, which is the one this design uses:

> "so broker has two mode - brain and research?"

> "i want to use the agy cli for my broker and i would like to change that assignment in my settings"

> "actually i also want claude cli option for my broker"

## Why

The broker is hardcoded to the Anthropic SDK — `new Anthropic({ apiKey: config.anthropicApiKey })` in `broker/src/main.ts`. That key is out of credits, so **every LLM path in the broker is dead**.

Five CLI tools sit installed, authenticated and idle on this machine, under subscriptions already being paid for. This is the subscription-first principle the portfolio runs on: API keys only for what subscriptions cannot do.

## The two modes

The broker asks a model for two categorically different things. The division is **tools, not streaming**:

| mode | sites | shape | requires |
|---|---|---|---|
| **Research** | 6 | `{system, prompt} → text`, `tools: []`, no history, no deltas read | anything that turns a prompt into text |
| **Brain** | 1 | 10 caller-defined tool schemas, `stop_reason === "tool_use"` loop, conversation history, text deltas fed to the speech chunker | caller-defined **tool calling** + **streaming** |

**Research mode — six sites**, all on `claude-haiku-4-5`:

| site | file | what it does |
|---|---|---|
| `generateSessionTitle` | `session-title.ts` | names a chat session |
| `polishText` | `polish.ts` | cleans up dictated text |
| feeds → `plan` | `main.ts:1704` | turns a release into work cards |
| `analyzeBrief` | `main.ts:2034` | analyses an HTTP context source |
| `askForClaim` | `main.ts:2396` | election claims |
| `runDocEditTurn` | `main.ts:1513` | rewrites a document from an instruction |

`polish.ts` and `session-title.ts` reach the model through `streamFactory`, which makes them *look* like streaming. They are not: both pass `tools: [] as never` and both only `await stream.finalMessage()`. **Neither ever subscribes to `on("text")`.** The stream is an accident of plumbing, not a requirement.

**Brain mode — one site.** `BrokerBrain` hands the model ten tool schemas (`delegate`, `check_status`, `remember`, `raise_hand`, `lookup_ticket`, `draft_agent`, `confirm_agent`, `track_topic`, `check_feeds`, `search_docs`) and runs the agentic loop: `if (final.stop_reason !== "tool_use") break;`, execute each block, feed back `tool_result`. Its streamed text deltas *are* the speech fed to the chunker.

Both modes already default to the same model, so the brain is not distinguished by needing a bigger one. It is distinguished **solely by needing tool calling** — which is why six of seven sites can move to a CLI and the seventh cannot.

---

# Phase 1 — Research mode (this spec)

## Part 1 — What research mode needs

One capability: turn a prompt into text, non-interactively. **All five CLI engines can:**

| engine | invocation | verified |
|---|---|---|
| `claude` | `--print '<prompt>'` | `--help` |
| `codex` | `codex exec` | `--help` |
| `agy` | `--print '<prompt>'` (alias `--prompt`) | `--help` |
| `copilot` | `-p/--prompt` | `--help` |
| `opencode` | `opencode run <message>` | `--help` |

No new capability flag is needed on `EngineOption`. Research mode's requirement is the definition of a CLI engine in this codebase — every entry in `ENGINES` already satisfies it, and `warmSessions` correctly stays about something else.

> The first draft added `streaming: boolean` and restricted the picker to three engines. That flag solved a problem research mode does not have. It belongs to Phase 2, under a different name — see below.

## Part 2 — The setting

**Persistence** follows the `/me/voice` shape exactly — operator-level machine config on the user record:

```ts
/** Which engine runs the broker's research turns. Absent = the built-in Anthropic default. */
researchEngine?: { cli: string; model?: string };
```

**Routes:** `GET /me/research-engine`, `PUT /me/research-engine`, mirroring `/me/voice` — same redaction shape, same 400-on-invalid posture, same `buildResearchEngineUpdate` pure-helper split that `buildVoiceUpdate` already uses.

**Validation is server-side and layered**, because a client cannot be trusted to have filtered correctly:
1. `cli` names a known `ENGINES` entry;
2. that entry is a CLI (`kind !== "api"`);
3. the tool-registry gate passes — `detected`, `authOk`, `enabled`, the same gate agent launches use;
4. `model`, if given, is one of that entry's `models`.

Each failure returns a 400 naming the check that failed. Never a silent coercion — the voice bug fixed earlier this session was exactly a silent-coercion failure, and it cost a live debugging session to find.

**UI:** a Settings group beside Voice, listing CLI engines the registry reports active, with the model list from the same registry entry so model choice is data-driven and free. If nothing qualifies, the group says so and points at CLI Tools rather than rendering an empty select.

## Part 3 — The broker side

**The seam.** `broker/src/research.ts` exports:

```ts
/** One research turn: a prompt in, text out. No tools, no history, no deltas. */
export interface ResearchEngine {
  complete(input: { system: string; prompt: string; maxTokens: number }): Promise<string>;
}
```

Two implementations:
- **`AnthropicResearch`** — wraps the existing SDK call. Default when the setting is unset, so behaviour is unchanged for anyone who never opens it.
- **`CliResearch`** — spawns the chosen tool, writes the prompt, reads stdout, returns text.

**All six research sites route through `ResearchEngine.complete`.** For `polish` and `session-title` this also removes their accidental dependency on `streamFactory`, which they never used as a stream — a simplification the mode split earns for free.

**What `CliResearch` owns**, each a real failure mode rather than a hypothetical:
- **process lifecycle** — non-zero exit, killed, never-starts, each a typed error;
- **timeouts** — a hung subprocess must not hang a feed poll or an election;
- **prompt delivery** — via argv the prompt must be shell-escaped; prefer stdin where the tool accepts it, since a long system prompt through argv risks `E2BIG`;
- **output shape** — plain stdout for `--print`; JSON modes are Phase 2's problem.

`ToolDriver` is deliberately **not** reused. It is CLI-shaped but for a different job: it launches interactive panes and reconstructs conversations by discovering and parsing transcript **files on disk**. `CliResearch` spawns a one-shot process and reads **stdout**. What they share is per-tool flag knowledge, which stays in the registry where both read it.

## Part 4 — Switching

The engine resolves **per turn** from the stored setting. A bad choice is corrected by changing it back, not by restarting a service — the broker is long-lived and holds LiveKit and Discord connections a restart would drop.

## Part 5 — Phase 1 out of scope

- **Brain mode.** Needs caller-defined tool calling; no CLI provides it. Phase 2.
- **Gemini.** `@google/genai` is already a broker dependency, wired only to avatar images. Once `ResearchEngine` exists, an API-backed research engine is one implementation — but the dead-key problem is what Phase 1 routes around.
- **Retiring `ToolDriver` or `ApiProvider`.** Three provider abstractions will exist after this. Consolidating them is a portfolio decision, not a broker feature.
- **Adopting `@helmsmith/agent-adapter`.** Checked 2026-08-14: all-or-nothing. `src/adapters/index.ts` is a side-effect barrel of eleven bare imports, each running `registerAdapter(...)`, and its comment states the intent — *"nothing here is re-exported (the public surface is `createAgent`, not the adapter classes)."* The `exports` map carries only `"."` and `"./conformance"`; the root exports the `AdapterFactory` *type* but no individual factory. A consumer wanting three CLI tools gets eleven adapters and their SDKs, from a package that is `private: true`, unbuilt, and pulls `@helmsmith/agent-auth` behind it. `registerAdapter` *is* public, so the registry supports selective registration — the package simply exposes no handle on one factory. **The concrete ask for helmsmith, if revisited:** subpath exports (`./adapters/gemini-sdk`) or exported factories. Deep-importing `src/` would couple this repo to their file layout.

---

# Phase 2 — Brain mode (sketch, not this spec)

Recorded so Phase 1 does not foreclose it.

The brain needs a provider that accepts **caller-defined tool schemas**, returns structured tool calls, and **streams text deltas** for the speech chunker. That is an API capability: Anthropic has it today, Gemini and OpenAI both offer function calling.

The `EngineOption` flag Phase 2 wants is therefore **`toolCalling: boolean`**, not `streaming` — every CLI streams text fine. Phase 1 deliberately adds no flag so Phase 2 can add the right one without first removing a wrong one.

## Decided 2026-08-14: the brain stays on an SDK. Do not relitigate.

A CLI *can* technically host the brain, and an earlier claim here that none could was wrong. **MCP is exactly the mechanism for giving a CLI caller-defined tools**, and two of the three streaming engines support it: Claude Code (`--mcp-config`, `--strict-mcp-config`) and Codex (`codex mcp`, `codex mcp-server`). Antigravity does not — its only tool mechanism is `agy plugin`, which imports at install time rather than per invocation. The structure would even fit: `brain.ts` already separates `TOOLS` (ten JSON schemas) from `ToolExecutors` (ten injected functions), so an MCP server would expose the same schemas and route to the same executors.

**It was rejected anyway, because MCP inverts control.**

Today the broker drives the loop: it sends the schemas, sees `stop_reason === "tool_use"`, executes the block, feeds back `tool_result`, and decides when the turn ends. Under MCP the **CLI** drives its own loop and calls back into a broker-hosted MCP server — deciding for itself which tools to call, how often, in what order, and when to stop, using its own system prompt and tool-use policy.

That makes the CLI *the brain*, not the brain's engine. Anderson's persona, the ten-tool choreography, and the speech chunking all live in that loop, and handing the loop away turns them from behaviour into suggestions. Concretely: "have Ana pick up the auth work" today means one `delegate` call the broker chooses to make; under MCP the CLI might call `check_status` first, delegate twice, or ask a clarifying question instead.

Forcing single-tool-call turns to keep control would fight the CLI's design and discard most of what makes it good — so the honest choice is an SDK, where the loop is ours.

**Therefore Phase 2 is: add a second function-calling SDK provider** (Gemini and OpenAI both offer it) behind the same `ApiProvider`-shaped seam, so the brain can move off a dead Anthropic key without moving off a driven loop. Its real work is translating ten Anthropic-shaped tool schemas and the `tool_use`/`tool_result` protocol into another provider's dialect, then proving the loop still terminates.

The real work in Phase 2 is translating ten Anthropic-shaped tool schemas and the `tool_use`/`tool_result` protocol into another provider's function-calling dialect, then proving the loop still terminates. That deserves its own spec.

---

## What the first draft got wrong

Recorded because both errors came from reading the call sites too shallowly, and the second was caught only by reading `polish.ts` line by line:

1. **"A CLI engine serves both."** False. `BrokerBrain` runs an agentic loop over its own tool schemas; `claude --print` runs *Claude Code's* tool loop and will never emit a `tool_use` block for a `delegate` schema it was never given.
2. **The split is streaming vs one-shot.** False. `polish` and `session-title` go *through* `streamFactory` and stream nothing — `tools: []`, and only `finalMessage()` is awaited. The real split is tools vs no tools, which is Edwin's framing.

The `streaming: boolean` flag the first draft proposed would have restricted the research picker to three engines when all five qualify.

## Open decisions for Edwin

1. **Default when unset.** Keep Anthropic (behaviour unchanged for anyone who never opens the setting), or default to the first active CLI (works out of the box, but silently changes what a working broker runs on)? Recommendation: keep Anthropic — silently changing what a working broker runs on is the more surprising failure.
2. **Model per engine.** Store a model alongside the engine, or take each tool's default? Recommendation: store it — one field, and the models are already in the registry.
3. **One engine for all six sites, or per-site?** Recommendation: one. Six settings for six calls that do the same kind of work is configuration nobody wants to maintain.

## Testing

Swarm (node test runner, pure helpers):
- `buildResearchEngineUpdate` rejects an unknown cli, an `api`-kind cli, a cli whose registry gate is closed, and a model not in that engine's list — four distinct messages;
- a valid selection round-trips through save and load;
- an absent setting reads back as absent, not as a coerced default.

Broker:
- `CliResearch.complete` returns stdout text for a stubbed successful process;
- a non-zero exit surfaces as a typed error, not an empty string — an empty string would silently poison a feed card or an election claim;
- a timeout aborts the subprocess rather than leaking it;
- a prompt containing quotes and newlines survives delivery intact;
- `AnthropicResearch` and `CliResearch` satisfy the same interface test, so the six call sites cannot tell them apart.

Control-plane (vitest + jsdom):
- the picker lists only CLI engines the registry reports active;
- with none qualifying, the group renders guidance pointing at CLI Tools rather than an empty select;
- selecting an engine issues the PUT and reflects the saved value;
- a rejected save surfaces the server's reason and leaves the prior selection intact — the contract `VoiceGroup` already follows.
