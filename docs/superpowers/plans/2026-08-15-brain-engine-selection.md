# Brain Engine Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Anderson's engine a stored, per-user setting changeable from an API call instead of a `.env` line plus a broker restart — with **a local model and no API key as the happy path**.

**Architecture:** Mirror the shipped research-engine seam exactly. A `brainEngine` field on the user record, a `PUT /me/brain-engine` route on the swarm, and a pure `resolveBrainEngine()` in the broker consulted **per turn**. `brain.ts` does not change: resolution hides inside a `StreamFactory` that defers its async work into `finalMessage()`, which is how `gemini-brain.ts` already behaves.

**Tech Stack:** TypeScript (node --import tsx), Fastify (swarm), node:test, pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-15-brain-engine-selection-design.md`

## Global Constraints

- **Node test runner**, not vitest, in `swarm/` and `broker/`. Run with `npx tsx --test src/<file>.test.ts`.
- **Broker imports use the `.ts` extension** (`./brain.ts`); **swarm imports use `.js`** (`./users.js`). Match the file you are editing.
- **Biome must stay clean**: `npx biome check <files>` reports zero diagnostics. No `any` — the repo bans it outside tests.
- **No new dependencies.** Local models are reached with global `fetch`.
- **`SMITH_BRAIN_PROVIDER` must keep working** exactly as today when a user record has no `brainEngine`. Existing installs cannot change behaviour.
- **The happy path is local, with no API key.** Resolution prefers `local` (an
  OpenAI-compatible server already running), then `cli` (a subscription), and
  only then `api`. A user who never enters a key must reach a working Anderson.
- **Voice needs a *streaming* brain — not a particular vendor, and not LiveKit.**
  Speech requires Deepgram (STT) and ElevenLabs (TTS) as connectors, with the
  existing invariant that Voice Mode enables only while **both** slots are
  filled. TTS reaches the browser as an `audio` frame over the WebSocket
  (`textChannel.broadcast({type:"audio", mime:"audio/mpeg", dataB64})`), so
  **single-user local voice never touches LiveKit** — that path (`publishPcm`)
  is for meetings and Discord.
  Engine choice matters only because speech chunking needs incremental text:
  **`local` and `api` stream and are voice-capable; `cli` is not**, since
  `--json-schema` suppresses streaming and Anderson would sit silent for ~26s
  then say everything at once. So **the no-key happy path (local model +
  Deepgram + ElevenLabs) is fully voice-capable.**
- **Every task ends green**: `pnpm test` in the package you touched.

---

### Task 1: `brainEngine` on the user record, with validation

**Files:**
- Modify: `swarm/src/users.ts` (add field to `User`, beside `researchEngine`)
- Modify: `swarm/src/server.ts` (add helpers next to `buildResearchEngineUpdate`, ~line 3635)
- Test: `swarm/src/server.test.ts`

**Interfaces:**
- Produces: `BrainEngine` type; `buildBrainEngineUpdate(body, engines, gate)`; `redactBrainEngine(user, gate)`.

- [ ] **Step 1: Write the failing test**

```ts
// swarm/src/server.test.ts
import { buildBrainEngineUpdate, redactBrainEngine } from "./server.js";
import { ENGINES } from "./personas.js";

test("buildBrainEngineUpdate: null clears, cli is gated, local needs a baseUrl", () => {
  const ok = () => "";
  assert.deepEqual(buildBrainEngineUpdate(null, ENGINES, ok), { brainEngine: undefined });

  assert.deepEqual(buildBrainEngineUpdate({ kind: "cli", provider: "claude" }, ENGINES, ok), {
    brainEngine: { kind: "cli", provider: "claude" },
  });

  // A gated CLI is refused with the gate's own reason, like research does.
  const gated = () => "binary not found on PATH";
  assert.deepEqual(buildBrainEngineUpdate({ kind: "cli", provider: "claude" }, ENGINES, gated), {
    error: "binary not found on PATH",
  });

  assert.deepEqual(buildBrainEngineUpdate({ kind: "local", provider: "lmstudio" }, ENGINES, ok), {
    error: "local engines require a baseUrl",
  });

  assert.deepEqual(
    buildBrainEngineUpdate({ kind: "api", provider: "gemini", model: "gemini-flash-latest" }, ENGINES, ok),
    { brainEngine: { kind: "api", provider: "gemini", model: "gemini-flash-latest" } },
  );

  assert.deepEqual(buildBrainEngineUpdate({ kind: "api", provider: "nope" }, ENGINES, ok), {
    error: "Unknown api provider: nope",
  });
});

test("redactBrainEngine hides a cli whose gate now fails", () => {
  const u = { id: "me", name: "You", brainEngine: { kind: "cli" as const, provider: "claude" } };
  assert.deepEqual(redactBrainEngine(u, () => ""), { kind: "cli", provider: "claude" });
  assert.equal(redactBrainEngine(u, () => "not installed"), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd swarm && npx tsx --test src/server.test.ts`
Expected: FAIL — `buildBrainEngineUpdate is not a function`.

- [ ] **Step 3: Add the type**

```ts
// swarm/src/users.ts — inside `export interface User`, directly below researchEngine
/** Which engine backs the conversational brain. Absent = SMITH_BRAIN_PROVIDER, then the no-key default. */
brainEngine?: BrainEngine;
```

```ts
// swarm/src/users.ts — beside the User interface
export interface BrainEngine {
  kind: "cli" | "local" | "api";
  /** cli: a CLI id ("claude") · local: a server id ("lmstudio") · api: "anthropic" | "gemini" */
  provider: string;
  model?: string;
  /** local only — where the OpenAI-compatible server listens. */
  baseUrl?: string;
}
```

- [ ] **Step 4: Implement the helpers**

```ts
// swarm/src/server.ts — beside buildResearchEngineUpdate
const API_BRAIN_PROVIDERS = new Set(["anthropic", "gemini"]);

/** PUT /me/brain-engine body → validated setting. `null` clears it. Mirrors buildResearchEngineUpdate. */
export function buildBrainEngineUpdate(
  body: unknown,
  engines: EngineOption[],
  gate: (cli: string) => string,
): { brainEngine?: BrainEngine } | { error: string } {
  if (body === null) return { brainEngine: undefined };
  const b = (body ?? {}) as Partial<BrainEngine>;

  if (b.kind === "cli") {
    const engine = engines.find((e) => e.cli === b.provider);
    if (!engine || engine.kind === "api") return { error: `Unknown engine: ${String(b.provider)}` };
    const reason = gate(engine.cli);
    if (reason) return { error: reason };
    return { brainEngine: { kind: "cli", provider: engine.cli, ...(b.model ? { model: b.model } : {}) } };
  }

  if (b.kind === "local") {
    if (!b.baseUrl) return { error: "local engines require a baseUrl" };
    return {
      brainEngine: {
        kind: "local",
        provider: b.provider ?? "local",
        baseUrl: b.baseUrl,
        ...(b.model ? { model: b.model } : {}),
      },
    };
  }

  if (b.kind === "api") {
    if (!b.provider || !API_BRAIN_PROVIDERS.has(b.provider)) {
      return { error: `Unknown api provider: ${String(b.provider)}` };
    }
    return { brainEngine: { kind: "api", provider: b.provider, ...(b.model ? { model: b.model } : {}) } };
  }

  return { error: `Unknown engine kind: ${String(b.kind)}` };
}

/** A stored cli brain whose gate now fails is reported as unset, like research. */
export function redactBrainEngine(u: User | null, gate: (cli: string) => string): BrainEngine | null {
  const e = u?.brainEngine;
  if (!e) return null;
  if (e.kind === "cli" && gate(e.provider)) return null;
  return e;
}
```

- [ ] **Step 5: Run the tests**

Run: `cd swarm && npx tsx --test src/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
cd swarm && npx biome check src/users.ts src/server.ts src/server.test.ts && npx tsc --noEmit
git add swarm/src/users.ts swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(swarm): brainEngine on the user record, with validation"
```

> **Note:** `npx tsc --noEmit` currently reports one **pre-existing** error at `swarm/src/server.ts:1577`. Confirm your change adds none beyond it.

---

### Task 2: `PUT /me/brain-engine` on the swarm, and a broker client for it

**Files:**
- Modify: `swarm/src/server.ts` (route beside `PUT /me/research-engine`, ~line 2154)
- Modify: `broker/src/swarm-client.ts` (add `getBrainEngine()`)
- Test: `swarm/src/server.test.ts`

**Interfaces:**
- Consumes: `buildBrainEngineUpdate`, `redactBrainEngine` from Task 1.
- Produces: `PUT /me/brain-engine`; `SwarmClient.getBrainEngine(): Promise<BrainEngine | null>`.

- [ ] **Step 1: Write the failing test**

```ts
test("PUT /me/brain-engine stores, reads back, and clears", async () => {
  const app = await makeTestServer(); // existing helper in this file
  const put = (body: unknown) =>
    app.inject({ method: "PUT", url: "/me/brain-engine", payload: body as object });

  const set = await put({ kind: "api", provider: "gemini", model: "gemini-flash-latest" });
  assert.equal(set.statusCode, 200);
  assert.deepEqual(set.json(), { kind: "api", provider: "gemini", model: "gemini-flash-latest" });

  const bad = await put({ kind: "api", provider: "nope" });
  assert.equal(bad.statusCode, 400);

  const cleared = await put(null);
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json(), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd swarm && npx tsx --test src/server.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Add the route**

```ts
// swarm/src/server.ts — immediately after the PUT /me/research-engine route
this.app.put("/me/brain-engine", async (req, reply) => {
  const dir = resolve(process.cwd(), ".smith/users");
  const users = await loadUsersFromDir(dir);
  const existing = resolveCurrentUser(users) ?? { id: "me", name: "You", default: true, connectors: [] };
  const file = await loadCliToolsFile(resolve(process.cwd(), ".smith/cli-tools.json"));
  const gate = (cli: string) => gateReason(file, cli);
  const r = buildBrainEngineUpdate(req.body, ENGINES, gate);
  if ("error" in r) return reply.status(400).send({ error: r.error });
  const merged: User = { ...existing, brainEngine: r.brainEngine };
  try {
    await saveUser(dir, merged);
  } catch (err) {
    return reply.status(400).send({ error: String((err as Error).message) });
  }
  return redactBrainEngine(merged, gate);
});
```

- [ ] **Step 4: Add the broker client method**

```ts
// broker/src/swarm-client.ts — beside getResearchEngine()
async getBrainEngine(): Promise<BrainEngine | null> {
  const res = await this.fetch("/me/brain-engine", { method: "GET" });
  if (!res.ok) return null;
  return (await res.json()) as BrainEngine | null;
}
```

Add a matching `GET /me/brain-engine` on the swarm returning `redactBrainEngine(resolveCurrentUser(users), gate)`, mirroring how research exposes its getter.

- [ ] **Step 5: Run the tests**

Run: `cd swarm && npx tsx --test src/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/server.ts swarm/src/server.test.ts broker/src/swarm-client.ts
git commit -m "feat(swarm): PUT/GET /me/brain-engine, with a broker client"
```

---

### Task 3: A local OpenAI-compatible brain adapter

**Files:**
- Create: `broker/src/local-brain.ts`
- Test: `broker/src/local-brain.test.ts`

**Interfaces:**
- Produces: `createLocalStreamFactory({ baseUrl, model, fetchImpl? }): StreamFactory`.
- Consumes: `StreamFactory`, `BrainStreamLike` from `./brain.ts`.

Measured: `gpt-oss-20b` on LM Studio streams first words in **1.02s** and returns streamed tool calls in 0.69s. **This is the happy path** — fastest, no key, no per-token cost, and the only no-key kind that streams *and* calls tools, which also makes it the only no-key kind that supports voice.

- [ ] **Step 1: Write the failing test**

```ts
// broker/src/local-brain.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalStreamFactory } from "./local-brain.ts";

const enc = new TextEncoder();
function sse(frames: unknown[]): Response {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(text)); c.close(); },
    }),
    { status: 200 },
  );
}

test("streams text deltas and assembles a tool call into Anthropic blocks", async () => {
  const fetchImpl = async () =>
    sse([
      { choices: [{ delta: { content: "On it. " } }] },
      { choices: [{ delta: { content: "Handing off." } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "delegate", arguments: '{"agent":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ignacio"}' } }] } }] },
    ]);

  const stream = createLocalStreamFactory({ baseUrl: "http://127.0.0.1:1234", model: "m", fetchImpl })({
    model: "ignored", max_tokens: 100, system: "s", messages: [{ role: "user", content: "hi" }], tools: [],
  });

  const deltas: string[] = [];
  stream.on("text", (d) => deltas.push(d));
  const final = await stream.finalMessage();

  assert.deepEqual(deltas, ["On it. ", "Handing off."]);
  assert.equal(final.stop_reason, "tool_use");
  assert.deepEqual(final.content.find((b) => b.type === "tool_use"), {
    type: "tool_use", id: "call_1", name: "delegate", input: { agent: "ignacio" },
  });
});

test("a dead server fails with a message naming the url, not a silent empty turn", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const stream = createLocalStreamFactory({ baseUrl: "http://127.0.0.1:9999", model: "m", fetchImpl })({
    model: "m", max_tokens: 10, system: "s", messages: [], tools: [],
  });
  await assert.rejects(() => stream.finalMessage(), (e: Error) => /9999/.test(e.message));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd broker && npx tsx --test src/local-brain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

Follow `broker/src/gemini-brain.ts` closely — same lazy-start-in-`finalMessage` shape, same SSE line buffering. Differences: OpenAI wire format (`messages`, `tools[].function`), tool-call arguments arrive as **string fragments across chunks keyed by `index`** and must be concatenated then `JSON.parse`d once at the end, and `stop_reason` is `"tool_use"` when any tool call was assembled.

Translate Anthropic-shaped params in: `system` becomes a leading `{role:"system"}` message; `tools[].input_schema` becomes `tools[].function.parameters`; a `tool_result` block becomes `{role:"tool", tool_call_id, content}`.

- [ ] **Step 4: Run the tests**

Run: `cd broker && npx tsx --test src/local-brain.test.ts`
Expected: PASS.

- [ ] **Step 5: Live check against a real server**

Start LM Studio (`lms server start`), load a model, then run a scratch script that drives `createLocalStreamFactory` with the real `BrokerBrain` and a stub `ToolExecutors`, asserting a hello streams and a tool round fires. **Green unit tests do not prove reachability** — `gemini-brain.ts` passed ten unit tests while being broken for multi-round tool turns.

- [ ] **Step 6: Commit**

```bash
cd broker && npx biome check src/local-brain.ts src/local-brain.test.ts
git add broker/src/local-brain.ts broker/src/local-brain.test.ts
git commit -m "feat(broker): local OpenAI-compatible brain adapter"
```

---

### Task 4: A CLI brain adapter (tools, no streaming)

**Files:**
- Create: `broker/src/cli-brain.ts`
- Test: `broker/src/cli-brain.test.ts`

**Interfaces:**
- Produces: `createCliStreamFactory({ argv, model, spawn? }): StreamFactory`.

Measured: `claude -p --json-schema` returns the correct `{speech, tool_calls[]}` shape in **26–29s with no streaming at all**. Tools work; speech arrives only at the end. This kind is therefore **text-capable and not voice-capable**, and must say so.

- [ ] **Step 1: Write the failing test**

```ts
// broker/src/cli-brain.test.ts
test("parses the schema envelope into Anthropic blocks", async () => {
  const spawn = () => ({
    stdoutText: JSON.stringify({
      speech: "Handing that to Ignacio.",
      tool_calls: [{ name: "delegate", input: { agent: "Ignacio", task: "fix login" } }],
    }),
    exitCode: 0,
  });
  const stream = createCliStreamFactory({ argv: ["claude", "-p"], spawn })({
    model: "m", max_tokens: 100, system: "s", messages: [{ role: "user", content: "hi" }], tools: [],
  });
  const deltas: string[] = [];
  stream.on("text", (d) => deltas.push(d));
  const final = await stream.finalMessage();

  // Speech arrives as ONE delta — this kind cannot stream, and the test pins that.
  assert.deepEqual(deltas, ["Handing that to Ignacio."]);
  assert.equal(final.stop_reason, "tool_use");
  assert.equal(final.content.find((b) => b.type === "tool_use")?.name, "delegate");
});

test("a non-JSON reply fails loudly rather than becoming empty speech", async () => {
  const spawn = () => ({ stdoutText: "I couldn't do that", exitCode: 0 });
  const stream = createCliStreamFactory({ argv: ["claude", "-p"], spawn })({
    model: "m", max_tokens: 10, system: "s", messages: [], tools: [],
  });
  await assert.rejects(() => stream.finalMessage(), /could not parse/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd broker && npx tsx --test src/cli-brain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Build the JSON schema from `params.tools` — an object with `speech: string` and `tool_calls: [{name, input}]`, where `name` is an `enum` of the tool names. Pass it as the **inline** `--json-schema <json>` argument (`claude` rejects a file path). The prompt is the **final argv element, unescaped**; spawn with `spawn(argv[0], argv.slice(1))` and never `shell: true` — copy the discipline in `research.ts`. Emit `speech` to `on("text")` listeners as a single delta before resolving.

- [ ] **Step 4: Run the tests, then commit**

```bash
cd broker && npx tsx --test src/cli-brain.test.ts && npx biome check src/cli-brain.ts src/cli-brain.test.ts
git add broker/src/cli-brain.ts broker/src/cli-brain.test.ts
git commit -m "feat(broker): CLI brain adapter — tools via --json-schema, no streaming"
```

---

### Task 5: Per-turn resolution

**Files:**
- Create: `broker/src/brain-engine.ts`
- Test: `broker/src/brain-engine.test.ts`

**Interfaces:**
- Consumes: `createLocalStreamFactory` (Task 3), `createCliStreamFactory` (Task 4), `createGeminiStreamFactory` (`./gemini-brain.ts`).
- Produces: `resolveBrainFactory(deps): Promise<StreamFactory>` and `resolvingStreamFactory(deps): StreamFactory`.

- [ ] **Step 1: Write the failing test**

```ts
test("prefers no-key options: local, then cli, then api, then the env fallback", async () => {
  const seen: string[] = [];
  const deps = (stored: BrainEngine | null, envProvider?: string) => ({
    getStoredEngine: async () => stored,
    argvFor: (cli: string) => (cli === "claude" ? ["claude", "-p"] : undefined),
    envProvider,
    geminiApiKey: "k",
    anthropicFactory: () => { seen.push("anthropic"); return dummyFactory; },
  });

  await resolveBrainFactory(deps({ kind: "local", provider: "lmstudio", baseUrl: "http://x" }));
  await resolveBrainFactory(deps({ kind: "cli", provider: "claude" }));
  await resolveBrainFactory(deps({ kind: "api", provider: "gemini" }));

  // No stored setting and no env → anthropic fallback, exactly today's behaviour.
  await resolveBrainFactory(deps(null));
  assert.deepEqual(seen, ["anthropic"]);
});

test("resolution happens per turn, not once", async () => {
  let calls = 0;
  const factory = resolvingStreamFactory({
    getStoredEngine: async () => { calls++; return null; },
    argvFor: () => undefined, geminiApiKey: undefined, anthropicFactory: () => dummyFactory,
  });
  await factory(PARAMS).finalMessage();
  await factory(PARAMS).finalMessage();
  assert.equal(calls, 2, "each turn re-reads the setting, so a change needs no restart");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd broker && npx tsx --test src/brain-engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// broker/src/brain-engine.ts
/**
 * Per-turn brain resolution — the sibling of research-engine.ts. Resolution is
 * deferred into finalMessage() because StreamFactory is synchronous while
 * reading the stored setting is not; brain.ts registers its "text" listener
 * between the factory call and finalMessage(), so listeners are buffered and
 * replayed rather than dropped.
 */
export function resolvingStreamFactory(deps: BrainEngineDeps): StreamFactory {
  return (params) => {
    const listeners: Array<(d: string) => void> = [];
    return {
      on(event, cb) { if (event === "text") listeners.push(cb); },
      async finalMessage() {
        const inner = await resolveBrainFactory(deps);
        const stream = inner(params);
        for (const cb of listeners) stream.on("text", cb);
        return stream.finalMessage();
      },
    };
  };
}
```

`resolveBrainFactory` picks in this order, which encodes the no-key-first rule: a stored `local` → `createLocalStreamFactory`; a stored `cli` whose `argvFor` resolves → `createCliStreamFactory`; a stored `api` → gemini or anthropic; **no stored setting** → `envProvider === "gemini"` → gemini, else the anthropic factory. The resolved engine's `model` **overrides `params.model`**, since `brain.ts` fills that in at construction time.

- [ ] **Step 4: Run the tests, then commit**

```bash
cd broker && npx tsx --test src/brain-engine.test.ts && npx biome check src/brain-engine.ts src/brain-engine.test.ts
git add broker/src/brain-engine.ts broker/src/brain-engine.test.ts
git commit -m "feat(broker): per-turn brain engine resolution"
```

---

### Task 6: Wire it in and demote the env var

**Files:**
- Modify: `broker/src/main.ts:108-120` (replace the `useGemini` block)
- Modify: `broker/src/config.ts:70-77` (comment `brain.provider` as a fallback)

**Interfaces:**
- Consumes: `resolvingStreamFactory` (Task 5), `swarm.getBrainEngine()` (Task 2).

- [ ] **Step 1: Replace the static factory**

```ts
// broker/src/main.ts — replacing the `useGemini` block
const streamFactory: StreamFactory = resolvingStreamFactory({
  getStoredEngine: () => swarm.getBrainEngine().catch(() => null),
  argvFor: researchArgvFor,
  spawn: defaultSpawner,
  envProvider: config.brain.provider,
  envModel: config.brain.model,
  geminiApiKey: config.geminiApiKey,
  anthropicFactory: () => anthropicStream,
});
```

Delete the `useGemini` constant, its `throw`, and the `brainModel` constant. Keep `anthropicStream`. Keep passing `identity` to `BrokerBrain`; **remove** the `model` option, since the resolver now supplies it per turn.

- [ ] **Step 2: Re-comment the config field**

```ts
// broker/src/config.ts
/**
 * Fallback only. The user record's `brainEngine` wins; this is consulted when
 * that is unset, so existing installs keep working unchanged.
 */
brain: { provider: "anthropic" | "gemini"; model?: string };
```

- [ ] **Step 3: Full suites**

Run: `cd broker && pnpm test` then `cd ../swarm && pnpm test`
Expected: PASS. Broker was 634 before this plan; expect 634 plus the new tests.

- [ ] **Step 4: Live smoke — the step that actually proves it**

With services running:

```bash
# 1. no stored setting → env fallback still works (existing behaviour preserved)
curl -s -X PUT localhost:7777/me/brain-engine -H 'content-type: application/json' -d 'null'
# say hello in the UI or via POST /utterance — Anderson replies on the env provider

# 2. store a setting and change engines WITHOUT restarting the broker
curl -s -X PUT localhost:7777/me/brain-engine -H 'content-type: application/json' \
  -d '{"kind":"api","provider":"gemini","model":"gemini-flash-latest"}'
# say hello again — still replies, now on the stored engine

# 3. the no-key path
curl -s -X PUT localhost:7777/me/brain-engine -H 'content-type: application/json' \
  -d '{"kind":"cli","provider":"claude"}'
# say hello — replies in ~26s, all at once, and can still delegate
```

**No restart between steps.** That is the whole feature: if a change needs a restart, it is not settable from a wizard.

- [ ] **Step 5: Commit**

```bash
git add broker/src/main.ts broker/src/config.ts
git commit -m "feat(broker): resolve the brain per turn; SMITH_BRAIN_PROVIDER is now a fallback"
```

---

## Self-review notes

- **Spec coverage:** contract (T1, T2), three engine kinds (T3, T4, plus the shipped gemini adapter reused in T5), per-turn resolution (T5), env demotion (T6), verify-before-save (T1 validation + T2 400s), no-key-first default (T5).
- **Deliberately deferred:** *verify by completing one live turn before saving* is specified but not implemented here — validation is structural only. Doing it properly means the swarm calling an engine, which it has no client for. Raise it as a follow-up rather than smuggling it in.
- **`agy` is excluded as a brain** — it accepted `--json-schema` and answered *about* the schema instead of obeying it.
