# Brain Engine Selection — Design

**Status:** design, awaiting review
**Date:** 2026-08-15
**Blocks:** the welcome wizard's *Configure Anderson* step
**Related:** [welcome wizard](2026-08-15-welcome-wizard-design.md), [council turn](2026-08-15-council-turn-design.md)

## Problem

The brain's engine is boot-time configuration. `SMITH_BRAIN_PROVIDER` is read
once in `config.ts:74` and consumed at `main.ts:110`; there is no route, no
per-user storage, and no way to change it without editing `.env` and restarting
the broker. That is exactly how this install was configured by hand on
2026-08-15, and it is not something a wizard — or a user — can do.

It also means the brain has one axis (anthropic vs gemini) when the machine
actually offers three quite different classes of engine, with very different
costs and characteristics.

## Precedent to copy

The *research* engine already solved this. `User.researchEngine?: {cli, model}`
persists per user, `PUT /me/research-engine` sets it, and it resolves per call
rather than at boot. This design applies the same shape to the brain, and should
end up looking like a sibling of that code rather than a new subsystem.

## Three engine kinds

Measured on this machine, 2026-08-15, **with the brain's tools attached** —
tool-less benchmarks materially overstate speed (`gemini-flash-latest` measured
0.98–1.32s without tools and 4.83s with them).

| Kind | Example | First words | Streams speech | Structured tool calls | Needs |
|---|---|---|---|---|---|
| `cli` | `claude` inline | median **2.71s** (cold 5.77s) | yes | **no** | a subscription |
| `local` | `gpt-oss-20b` via LM Studio | **1.02s** (cold load 27s) | yes | yes | a running server |
| `api` | `gemini-3.1-pro-preview` | **3.05s** | yes | yes | a key |

### The CLI constraint is structural, not performance

A CLI can stream speech **or** return caller-defined tool calls, never both in
one turn: `--output-format stream-json` streams text but yields no structured
calls, and `--json-schema` yields calls but suppresses streaming entirely (26–29s
with nothing spoken until the end). A voice brain needs both, so **the CLI kind
is text-capable but not voice-capable**, and the UI must say so.

This corrects the reasoning in `2026-08-14-broker-engine-selection-design.md`,
which held that a CLI cannot accept caller-defined tool schemas without MCP
inverting control. Both `claude` and `agy` expose `--json-schema` and execution
stays in the broker; the real limit is the streaming trade above.

### CLI brains must run inline

Holding one process open and feeding turns over `--input-format stream-json`
takes a warm turn from ~5.8s to a median of 2.71s (n=5, idle machine). Spawning
per turn wastes roughly 3s every time. Inline is a requirement of this kind, not
an optimisation.

`agy` is **not** offered as a brain yet: it accepts `--json-schema` but did not
enforce it, answering *about* the schema instead.

### Local servers are detected, never installed

LM Studio (`:1234`) and Ollama (`:11434`) both expose OpenAI-compatible APIs with
streaming and tool calls. When one is running, offer it; never instruct someone
to install a server or pull a 12 GB model during setup. Cold load is ~27s and
this model holds ~12 GB of RAM, so the first call after a load must not be
mistaken for steady state.

Tool-selection quality across the brain's ten tools is **untested** at 20B and
must be measured before local becomes a default rather than an option.

## Frontier models are the default

On every kind, default to the most capable model available, not the fastest.

| Path | Frontier | Fast tier | What frontier costs |
|---|---|---|---|
| CLI | `opus` 6.80s | `haiku` 6.54s | **+0.26s — free** |
| API | `gemini-3.1-pro-preview` 3.05s | `flash-lite` 0.56s | +2.5s |

On the CLI path model choice is worth a quarter-second because ~6s of startup
dominates, so a small model trades a far better brain for nothing measurable —
and a model picker there implies a tuning knob that does not exist. On the API
path frontier costs ~2.5s and remains conversational. A brain that picks the
wrong agent costs far more than two seconds.

## Contract

```ts
// swarm/src/users.ts — sibling of researchEngine
brainEngine?: {
  kind: "cli" | "local" | "api";
  /** cli: "claude" | "agy" · local: server id · api: "anthropic" | "gemini" */
  provider: string;
  model?: string;
  /** local only — where the OpenAI-compatible server listens. */
  baseUrl?: string;
};
```

- **`PUT /me/brain-engine`** on the swarm, mirroring `PUT /me/research-engine`,
  including its redaction behaviour.
- **The broker resolves the brain per turn**, not at process start, so a change
  takes effect without a restart. This is the load-bearing requirement: it is
  what makes the setting settable at all.
- **`SMITH_BRAIN_PROVIDER` is demoted to a fallback** used only when the user
  record is silent, so every existing install keeps its current behaviour.
- The existing `StreamFactory` seam in `brain.ts` is the injection point;
  `gemini-brain.ts` is the model for an adapter, and `brain.ts` itself does not
  change.

## Error handling

- **An unreachable engine must not kill the turn.** A stopped local server or an
  expired key reports a spoken failure and leaves the previous setting intact,
  rather than throwing into the WebSocket.
- **Verify before saving.** A `PUT` that cannot complete one live turn against
  the requested engine is rejected with the reason, so a bad setting can never be
  persisted. A green probe is not proof; detection was wrong twice in one day.
- **Cold starts are labelled.** A first-call measurement (27s local load, 5.8s
  CLI startup) must never be shown as steady state.

## Testing

Unit: engine resolution per kind, fallback to `SMITH_BRAIN_PROVIDER`, redaction
of keys in `GET`, rejection of an unverifiable engine.

**Live smoke, mandatory, per kind.** Green tests do not prove reachability —
three defects shipped this session with passing suites, and `gemini-brain.ts`
passed ten unit tests while being completely broken for multi-round tool turns.
Each engine kind must complete a real hello and a real tool round.

## Out of scope

Making the CLI kind voice-capable (blocked by the streaming trade above), `agy`
as a brain (its `--json-schema` behaviour is unresolved), and any billing or
hosted-cell engine.
