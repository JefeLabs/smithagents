# Broker Engine Selection — Design

**Date:** 2026-08-14 · **Status:** DRAFT, awaiting Edwin's review

Edwin's ask, in his words:

> "i want to use the agy cli for my broker and i would like to change that assignment in my settings"

> "actually i also want claude cli option for my broker"

> "CAN WE add attribute on our agents for streaming candidates so the user can select from appropriate candidates"

> "so claude Code, Antigravity or codex should be the option"

## Why

The broker is hardcoded to the Anthropic SDK — `new Anthropic({ apiKey: config.anthropicApiKey })` in `broker/src/main.ts`, five call sites. That key is out of credits, so **every LLM path in the broker is dead**: chat, voice, document edits, feed analysis, and election claims.

Meanwhile five CLI tools are installed, authenticated and idle on this machine, under subscriptions already being paid for. This is the subscription-first principle the portfolio already runs on: API keys only for what subscriptions cannot do.

## Part 1 — The capability flag

`EngineOption` (swarm `personas.ts`) gains one field:

```ts
/** Whether the tool can stream a one-shot response as it generates
    (--output-format stream-json, codex exec --json). ORTHOGONAL to
    warmSessions: agy streams a print-mode response but cannot host a warm
    session, because it persists no transcript to observe turn completion
    from. One flag answers "can I tail its turns from disk?", the other
    "can it emit tokens as it thinks?" — the broker only needs the second. */
streaming: boolean;
```

`agy` is the proof that these are independent: `streaming: true`, `warmSessions: false`. Reusing `warmSessions` would have excluded exactly the engine Edwin asked for first.

**Values, read from the installed binaries' own `--help`, not assumed:**

| engine | `streaming` | `warmSessions` | evidence |
|---|---|---|---|
| `claude` | `true` | `true` | `--print --output-format=stream-json` |
| `codex` | `true` | `true` | `codex exec --json` — JSONL events to stdout |
| `agy` | `true` | `false` | `--print --output-format stream-json` |
| `copilot` | `false` | `true` | `-p/--prompt` only; no stream format in `--help` |
| `opencode` | `false` | `true` | no stream flag in `--help` — unverified |
| `api:anthropic` | `false` | `false` | the Messages API streams, but `ApiProvider.complete()` does not |

The two unverified entries default to `false` deliberately. A wrong `true` fails inside the broker's voice path — the worst place to discover it. A wrong `false` merely hides an option until someone verifies the flag and flips it.

`api:anthropic` at `false` documents an honest gap rather than hiding one: when `ApiProvider` learns to stream, the flag flips and API engines join the picker with no UI change.

## Part 2 — The setting

**Persistence** follows the existing `/me/voice` shape — operator-level machine config, stored on the user record in the swarm, read by the broker:

```ts
/** Which engine the broker runs its LLM turns on. Absent = the built-in default. */
brokerEngine?: { cli: string; model?: string };
```

**Route:** `GET /me/broker-engine`, `PUT /me/broker-engine`, mirroring the voice routes exactly — same redaction shape, same validation posture.

**Validation is server-side and layered**, because a client cannot be trusted to have filtered correctly:
1. the `cli` must name a known engine;
2. that engine must have `streaming: true`;
3. the tool-registry gate must pass (`detected`, `authOk`, `enabled`) — the same gate agent launches already use.

A request failing any of these is a 400 naming which check failed, never a silent coercion.

**UI:** a new Settings group beside Voice, listing `ENGINES.filter(e => e.streaming)` and further narrowed to tools the registry reports active. Today that yields exactly three: **Claude Code**, **Antigravity**, **Codex**. Each shows its model list from the same registry entry, so model choice comes free and stays data-driven.

If no engine qualifies — nothing installed, or all unauthenticated — the group says so and points at CLI Tools, rather than rendering an empty dropdown.

## Part 3 — The broker side

The broker's five LLM call sites (`broker/src/main.ts`) today:

| line | site | shape |
|---|---|---|
| 100 | `streamFactory` → `messages.stream` | streaming — chat + voice |
| 1513 | `runDocEditTurn` | one-shot |
| 1704 | feeds → `plan` | one-shot |
| 2034 | `analyzeBrief` | one-shot |
| 2396 | `askForClaim` → `brokerAsk` | one-shot |

Four are `{system, prompt} → text`. One streams. **A CLI engine serves both**: the same subprocess with `--print --output-format stream-json` streams for the chat path, and its reduction to final text serves the other four — the same `invoke() = reduceStream` relationship helmsmith's adapter already models.

**The seam:** a `BrokerEngine` interface with two methods — `stream(input): AsyncIterable<Chunk>` and `complete(input): Promise<string>`, where `complete` is `reduceStream`. Two implementations to start: the existing Anthropic SDK path (unchanged, still the default) and a CLI path that spawns the chosen tool.

The CLI implementation owns exactly what the SDK gave us for free, and each is a real failure mode rather than a hypothetical:
- **process lifecycle** — non-zero exit, killed, never-starts;
- **partial JSON lines** — a JSONL stream chunked mid-line across reads must buffer, not parse-and-throw;
- **per-tool event shapes** — `claude`, `codex` and `agy` emit different JSON; normalising them is the adapter's job, exactly as `ToolDriver.parseSessionFile` already normalises transcripts;
- **timeouts** — a hung subprocess must not hang a voice turn.

`ToolDriver` is deliberately **not** reused. It is CLI-shaped but for a different job: it launches interactive panes and reconstructs conversations by discovering and parsing transcript **files on disk**. The broker spawns a one-shot process and reads **stdout**. Sharing an interface across those two would serve neither; what they share is knowledge of each tool's flags, which stays in the registry.

## Part 4 — Switching

Changing the setting takes effect on the **next turn**, not at restart. The engine is resolved per-turn from the stored setting, so a bad choice is corrected by changing it back rather than by restarting a service. This matters because the broker is long-lived and holds LiveKit and Discord connections that a restart drops.

## Part 5 — Out of scope

- **Retiring `ToolDriver` or `ApiProvider`.** Three provider abstractions will exist after this. Consolidating them — plausibly onto helmsmith's `AgentAdapter`, which already spans CLI and SDK behind one interface — is a portfolio decision, not a broker feature, and should not be made as a side effect of wanting a working broker.

- **Adopting `@helmsmith/agent-adapter` now.** Checked on 2026-08-14 and it is all-or-nothing: `src/adapters/index.ts` is a side-effect barrel of eleven bare imports, each running a module-level `registerAdapter(...)`, and its own comment states the intent — *"nothing here is re-exported (the public surface is `createAgent`, not the adapter classes)."* The `exports` map carries only `"."` and `"./conformance"`, no per-adapter subpath, and the root exports the `AdapterFactory` *type* but no individual factory. So a consumer wanting three CLI tools gets eleven adapters and their SDKs — `@anthropic-ai/sdk` is already a declared dependency, with bedrock/openai/copilot/gemini implied — from a package that is `private: true`, unbuilt, and pulls `@helmsmith/agent-auth` behind it.

  `registerAdapter` *is* public, so the registry itself supports selective registration; the package simply exposes no handle on a single factory. **The concrete ask for helmsmith, if this is revisited:** add subpath exports (`./adapters/gemini-sdk`) or export the factories, so a consumer can register only what it supports. That is their change to make — deep-importing `src/` to work around it would couple this repo to their file layout.
- **Gemini.** `@google/genai` is already a broker dependency but wired only to avatar images. Once `streaming` exists as a flag and the CLI seam is in place, `gemini-cli` is a registry entry plus a normaliser, not a redesign.
- **Streaming `ApiProvider`.** Would flip `api:anthropic` to `streaming: true`, but the API keys are the thing this design routes around.
- **Per-capability engines** (one for reasoning, another for conversation). All three candidates stream, so the split has no reason to exist.

## Open decisions for Edwin

1. **Default when unset.** Keep the Anthropic SDK as the default (behaviour unchanged for anyone who never opens the setting), or default to the first active streaming CLI (works out of the box, but silently changes what the broker runs on). Recommendation: keep the SDK default; changing what a working broker runs on without being asked is the more surprising failure.
2. **Model per engine.** The registry lists models per engine (`claude-opus`/`claude-sonnet`/`claude-haiku`, `gpt-5-codex`/`gpt-5`, `default`). Store a model alongside the engine, or take each tool's default? Recommendation: store it — it's one field and the models are already in the registry.
3. **`copilot` and `opencode`.** Left `streaming: false` on unverified help output. Worth ten minutes each to confirm before shipping, or leave until someone wants them?

## Testing

Swarm (node test runner, pure helpers):
- every `ENGINES` entry carries an explicit `streaming` boolean — no `undefined` treated as false by accident;
- `agy` is `streaming: true, warmSessions: false` — the orthogonality case, asserted directly so a future edit cannot quietly collapse the two flags;
- the setting's validator rejects an unknown cli, a known-but-non-streaming cli, and a streaming cli whose registry gate is closed — each with a distinct message;
- a valid selection round-trips through save and load.

Broker:
- the CLI engine reduces a stream to the same text `complete()` returns — `reduceStream` equivalence, proving the four one-shot sites and the streaming site agree;
- a JSONL event split mid-line across two reads parses as one event, not a throw;
- a non-zero exit surfaces as a typed error, not a hang;
- a timeout aborts the subprocess rather than leaking it;
- each of the three tools' event shapes normalises to the same chunk type — one test per tool, with a captured real payload as the fixture.

Control-plane (vitest + jsdom):
- the picker lists only engines that are both `streaming` and registry-active;
- with none qualifying, the group renders guidance pointing at CLI Tools rather than an empty select;
- selecting an engine issues the PUT and reflects the saved value;
- a rejected save surfaces the server's reason and leaves the prior selection intact — the same contract `VoiceGroup` already follows.
