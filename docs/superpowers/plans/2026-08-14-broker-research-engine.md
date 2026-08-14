# Broker Research Engine — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the broker run its six tool-free "research" calls on any authenticated CLI engine, chosen in Settings, instead of a hardcoded Anthropic key that is out of credits.

**Architecture:** One new interface, `ResearchEngine { complete({system, prompt, maxTokens}) → Promise<string> }`, with two implementations — the existing Anthropic SDK call, and a CLI implementation that spawns the chosen tool and reads stdout. The choice persists on the user record as `researchEngine`, served by `/me/research-engine` routes mirroring `/me/voice`, and picked in a Settings group beside Voice. Brain mode (the one site using caller-defined tool schemas) is untouched.

**Tech Stack:** swarm = TypeScript + Fastify, node built-in test runner (`node --import tsx --test`) + `node:assert/strict`. broker = TypeScript, same node test runner. control-plane = React + TanStack Query, vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-08-14-broker-engine-selection-design.md`

## Global Constraints

- pnpm, never npm. Node >= 24, TypeScript ~6.0.0.
- **Biome runs on all three packages.** Baselines are NOT zero — land back at each package's own baseline, verified with `pnpm exec biome check .` from that package. Measure the baseline before you start; do not fix pre-existing debt.
- **Research mode has no tools and no streaming.** `ResearchEngine.complete` returns a string. Never add a `tools` parameter, never expose deltas — the moment it grows either, it has become brain mode and belongs in Phase 2.
- **Never silently coerce an invalid setting.** Every validation failure is a 400 naming the failed check. A silent coercion in the voice settings cost a live debugging session earlier; the same mistake here would leave the broker running an engine the operator did not choose.
- **`BrokerBrain` is out of scope.** Do not route it through `ResearchEngine`; it needs caller-defined tool calling that no CLI provides.
- Run swarm/broker tests from their package dirs; control-plane commands from `control-plane/`.

---

### Task 1: The `ResearchEngine` seam and the Anthropic implementation

**Files:**
- Create: `broker/src/research.ts`
- Create: `broker/src/research.test.ts`

**Interfaces:**
- Produces: `interface ResearchEngine { complete(input: ResearchInput): Promise<string> }`, `interface ResearchInput { system: string; prompt: string; maxTokens: number }`, `class AnthropicResearch implements ResearchEngine`, `class ResearchError extends Error`.

- [ ] **Step 1: Write the failing tests**

Create `broker/src/research.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicResearch, ResearchError } from "./research.ts";

/** Minimal stand-in for the SDK's messages.create. */
const createStub = (reply: unknown) => {
  const calls: unknown[] = [];
  return {
    calls,
    fn: async (params: unknown) => {
      calls.push(params);
      return reply;
    },
  };
};

test("AnthropicResearch returns the concatenated text of the reply", async () => {
  const stub = createStub({ content: [{ type: "text", text: "a title" }] });
  const engine = new AnthropicResearch(stub.fn, "claude-haiku-4-5");
  const out = await engine.complete({ system: "sys", prompt: "name this", maxTokens: 64 });
  assert.equal(out, "a title");
});

test("AnthropicResearch passes system, prompt and maxTokens through unchanged", async () => {
  const stub = createStub({ content: [{ type: "text", text: "x" }] });
  const engine = new AnthropicResearch(stub.fn, "claude-haiku-4-5");
  await engine.complete({ system: "SYS", prompt: "PROMPT", maxTokens: 123 });
  const p = stub.calls[0] as { model: string; max_tokens: number; system: string; messages: unknown[] };
  assert.equal(p.model, "claude-haiku-4-5");
  assert.equal(p.max_tokens, 123);
  assert.equal(p.system, "SYS");
  assert.deepEqual(p.messages, [{ role: "user", content: "PROMPT" }]);
});

test("AnthropicResearch ignores non-text blocks rather than stringifying them", async () => {
  const stub = createStub({
    content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }],
  });
  const engine = new AnthropicResearch(stub.fn, "claude-haiku-4-5");
  assert.equal(await engine.complete({ system: "s", prompt: "p", maxTokens: 8 }), "answer");
});

test("AnthropicResearch turns a rejected call into a typed ResearchError", async () => {
  const engine = new AnthropicResearch(async () => {
    throw new Error("credit balance is too low");
  }, "claude-haiku-4-5");
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError && /credit balance/.test((err as Error).message),
  );
});

test("AnthropicResearch treats an empty reply as an error, never as empty text", async () => {
  // An empty string would silently poison a feed card or an election claim —
  // the caller cannot tell "the model said nothing" from "the call failed".
  const engine = new AnthropicResearch(async () => ({ content: [] }), "claude-haiku-4-5");
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError,
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

From `broker/`:
```bash
node --import tsx --test --test-timeout 60000 src/research.test.ts
```
Expected: FAIL — cannot resolve `./research.ts`.

- [ ] **Step 3: Implement**

Create `broker/src/research.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --import tsx --test --test-timeout 60000 src/research.test.ts
```
Expected: PASS, 5 tests.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check src/research.ts src/research.test.ts
```
Expected: back at the package baseline you measured.

```bash
git add broker/src/research.ts broker/src/research.test.ts
git commit -m "feat(broker): ResearchEngine seam + Anthropic implementation

A prompt in, text out. No tools, no history, no deltas — the one site
that needs those is BrokerBrain, which stays where it is."
```

---

### Task 2: The CLI research implementation

**Files:**
- Modify: `broker/src/research.ts`
- Modify: `broker/src/research.test.ts`

**Interfaces:**
- Consumes: `ResearchEngine`, `ResearchInput`, `ResearchError` from Task 1.
- Produces: `class CliResearch implements ResearchEngine`, `type Spawner`.

- [ ] **Step 1: Write the failing tests**

Append to `broker/src/research.test.ts` (add `CliResearch` to the import):

```ts
/** Stand-in for the subprocess: records argv/stdin, replays a scripted result. */
const spawnStub = (result: { code: number | null; stdout: string; stderr: string }) => {
  const calls: Array<{ argv: string[]; stdin: string }> = [];
  return {
    calls,
    fn: async (argv: string[], stdin: string) => {
      calls.push({ argv, stdin });
      return result;
    },
  };
};

test("CliResearch returns trimmed stdout", async () => {
  const stub = spawnStub({ code: 0, stdout: "  a title\n", stderr: "" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  assert.equal(await engine.complete({ system: "s", prompt: "p", maxTokens: 8 }), "a title");
});

test("CliResearch sends system and prompt on stdin, not argv", async () => {
  // A long system prompt through argv risks E2BIG, and shell-escaping it is a
  // whole class of injection bug we simply decline to have.
  const stub = spawnStub({ code: 0, stdout: "ok", stderr: "" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  await engine.complete({ system: "SYS", prompt: "PROMPT", maxTokens: 8 });
  assert.deepEqual(stub.calls[0].argv, ["claude", "--print"]);
  assert.match(stub.calls[0].stdin, /SYS/);
  assert.match(stub.calls[0].stdin, /PROMPT/);
});

test("CliResearch appends the model flag only when a model is set", async () => {
  const withModel = spawnStub({ code: 0, stdout: "ok", stderr: "" });
  await new CliResearch(withModel.fn, ["claude", "--print"], "claude-sonnet").complete({
    system: "s",
    prompt: "p",
    maxTokens: 8,
  });
  assert.deepEqual(withModel.calls[0].argv, ["claude", "--print", "--model", "claude-sonnet"]);

  const without = spawnStub({ code: 0, stdout: "ok", stderr: "" });
  await new CliResearch(without.fn, ["claude", "--print"], undefined).complete({
    system: "s",
    prompt: "p",
    maxTokens: 8,
  });
  assert.deepEqual(without.calls[0].argv, ["claude", "--print"]);
});

test("CliResearch turns a non-zero exit into a ResearchError carrying stderr", async () => {
  const stub = spawnStub({ code: 1, stdout: "", stderr: "not logged in" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError && /not logged in/.test((err as Error).message),
  );
});

test("CliResearch treats a killed process (code null) as an error", async () => {
  const stub = spawnStub({ code: null, stdout: "partial", stderr: "" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError,
  );
});

test("CliResearch treats empty stdout on a clean exit as an error, not empty text", async () => {
  const stub = spawnStub({ code: 0, stdout: "   \n", stderr: "" });
  const engine = new CliResearch(stub.fn, ["claude", "--print"], undefined);
  await assert.rejects(
    () => engine.complete({ system: "s", prompt: "p", maxTokens: 8 }),
    (err: unknown) => err instanceof ResearchError,
  );
});

test("CliResearch and AnthropicResearch satisfy the same contract", async () => {
  // The six call sites must not be able to tell them apart.
  const engines: ResearchEngine[] = [
    new AnthropicResearch(async () => ({ content: [{ type: "text", text: "same" }] }), "m"),
    new CliResearch(async () => ({ code: 0, stdout: "same", stderr: "" }), ["x"], undefined),
  ];
  for (const e of engines) {
    assert.equal(await e.complete({ system: "s", prompt: "p", maxTokens: 8 }), "same");
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
node --import tsx --test --test-timeout 60000 src/research.test.ts
```
Expected: FAIL — `CliResearch` is not exported.

- [ ] **Step 3: Implement**

Append to `broker/src/research.ts`:

```ts
/**
 * Injected subprocess runner. Resolves (never rejects) with the exit code —
 * null when killed or timed out — and captured output. Same contract as the
 * swarm's CommandRunner, for the same reason: a spawn failure is data the
 * caller must handle, not an exception thrown past it.
 */
export type Spawner = (
  argv: string[],
  stdin: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/**
 * Runs one research turn through a CLI tool.
 *
 * The prompt goes over STDIN, never argv: a system prompt is long enough to
 * risk E2BIG, and shell-escaping it is a class of injection bug worth
 * declining outright.
 *
 * NOT a ToolDriver. That interface launches interactive panes and rebuilds
 * conversations by discovering and parsing transcript FILES; this spawns a
 * one-shot process and reads STDOUT. What they share is per-tool flag
 * knowledge, which lives in the engine registry both read from.
 */
export class CliResearch implements ResearchEngine {
  constructor(
    private readonly spawn: Spawner,
    private readonly baseArgv: string[],
    private readonly model: string | undefined,
  ) {}

  async complete(input: ResearchInput): Promise<string> {
    const argv = this.model ? [...this.baseArgv, "--model", this.model] : [...this.baseArgv];
    const stdin = `${input.system}\n\n${input.prompt}`;
    const { code, stdout, stderr } = await this.spawn(argv, stdin);
    if (code !== 0) {
      const detail = stderr.trim() || stdout.trim() || (code === null ? "killed or timed out" : `exit ${code}`);
      throw new ResearchError(`${this.baseArgv[0]} failed: ${detail}`);
    }
    const text = stdout.trim();
    if (!text) throw new ResearchError(`${this.baseArgv[0]} returned no text`);
    return text;
  }
}
```

Note `maxTokens` is accepted and unused here — CLI tools have no equivalent flag. Keeping it in the interface is what lets the six call sites stay identical across both implementations.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node --import tsx --test --test-timeout 60000 src/research.test.ts
```
Expected: PASS, 12 tests total.

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check src/research.ts src/research.test.ts
git add broker/src/research.ts broker/src/research.test.ts
git commit -m "feat(broker): CLI research engine

Prompt over stdin, not argv — E2BIG and shell escaping are both
avoidable by construction. A non-zero exit, a killed process, and
empty output are all typed errors, never an empty string."
```

---

### Task 3: The setting — swarm side

**Files:**
- Modify: `swarm/src/users.ts` (the `User` interface)
- Modify: `swarm/src/server.ts` (new exported helper + two routes)
- Modify: `swarm/src/server.test.ts`

**Interfaces:**
- Produces: `User.researchEngine?: { cli: string; model?: string }`, `buildResearchEngineUpdate(body, engines, gate): { researchEngine?: {...} } | { error: string }`, `GET /me/research-engine`, `PUT /me/research-engine`.

- [ ] **Step 1: Write the failing tests**

Add to `swarm/src/server.test.ts` (import `buildResearchEngineUpdate` from `./server.js`):

```ts
const ENGINES_FIXTURE = [
  { cli: "claude", label: "Claude Code", models: ["claude-opus", "claude-sonnet"], warmSessions: true },
  { cli: "agy", label: "Antigravity", models: ["default"], warmSessions: false },
  { cli: "api:anthropic", label: "API — Anthropic", models: ["claude-haiku-4-5"], warmSessions: false, kind: "api" as const },
];
/** Returns '' when the tool may be used, else the human reason — mirrors gateReason. */
const openGate = () => "";
const closedGate = () => "claude is not logged in";

test("buildResearchEngineUpdate accepts a known, active CLI engine", () => {
  const r = buildResearchEngineUpdate({ cli: "agy" }, ENGINES_FIXTURE, openGate);
  assert.deepEqual(r, { researchEngine: { cli: "agy", model: undefined } });
});

test("buildResearchEngineUpdate accepts a model from that engine's list", () => {
  const r = buildResearchEngineUpdate({ cli: "claude", model: "claude-sonnet" }, ENGINES_FIXTURE, openGate);
  assert.deepEqual(r, { researchEngine: { cli: "claude", model: "claude-sonnet" } });
});

test("buildResearchEngineUpdate rejects an unknown cli", () => {
  const r = buildResearchEngineUpdate({ cli: "nope" }, ENGINES_FIXTURE, openGate);
  assert.match((r as { error: string }).error, /Unknown engine/);
});

test("buildResearchEngineUpdate rejects an api-kind engine", () => {
  // Research mode spawns a CLI; an api entry has no binary to run.
  const r = buildResearchEngineUpdate({ cli: "api:anthropic" }, ENGINES_FIXTURE, openGate);
  assert.match((r as { error: string }).error, /not a CLI engine/);
});

test("buildResearchEngineUpdate rejects a CLI whose registry gate is closed", () => {
  const r = buildResearchEngineUpdate({ cli: "claude" }, ENGINES_FIXTURE, closedGate);
  assert.match((r as { error: string }).error, /not logged in/);
});

test("buildResearchEngineUpdate rejects a model the engine does not list", () => {
  const r = buildResearchEngineUpdate({ cli: "agy", model: "gpt-5" }, ENGINES_FIXTURE, openGate);
  assert.match((r as { error: string }).error, /Unknown model/);
});

test("buildResearchEngineUpdate clears the setting on null", () => {
  const r = buildResearchEngineUpdate(null, ENGINES_FIXTURE, openGate);
  assert.deepEqual(r, { researchEngine: undefined });
});

test("each rejection names the check that failed, never a silent coercion", () => {
  const messages = [
    buildResearchEngineUpdate({ cli: "nope" }, ENGINES_FIXTURE, openGate),
    buildResearchEngineUpdate({ cli: "api:anthropic" }, ENGINES_FIXTURE, openGate),
    buildResearchEngineUpdate({ cli: "claude" }, ENGINES_FIXTURE, closedGate),
    buildResearchEngineUpdate({ cli: "agy", model: "gpt-5" }, ENGINES_FIXTURE, openGate),
  ].map((r) => (r as { error: string }).error);
  assert.equal(new Set(messages).size, 4, "four distinct failures need four distinct messages");
});
```

- [ ] **Step 2: Run them to verify they fail**

From `swarm/`:
```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='buildResearchEngineUpdate|names the check' src/server.test.ts
```
Expected: FAIL — `buildResearchEngineUpdate` is not exported.

- [ ] **Step 3: Add the field**

In `swarm/src/users.ts`, add to the `User` interface:

```ts
  /** Which CLI engine runs the broker's research turns. Absent = the broker's built-in default. */
  researchEngine?: { cli: string; model?: string };
```

- [ ] **Step 4: Add the pure helper**

In `swarm/src/server.ts`, beside `buildVoiceUpdate`:

```ts
/**
 * Validate a research-engine selection. Pure — engines and the registry gate
 * are injected so this is testable without a filesystem.
 *
 * Every rejection names the check that failed. Never coerce: a silently
 * corrected setting leaves the broker running an engine the operator did not
 * choose, and nothing on screen would say so.
 */
export function buildResearchEngineUpdate(
  body: unknown,
  engines: EngineOption[],
  gate: (cli: string) => string,
): { researchEngine?: { cli: string; model?: string } } | { error: string } {
  if (body === null) return { researchEngine: undefined };
  const b = (body ?? {}) as { cli?: string; model?: string };
  const engine = engines.find((e) => e.cli === b.cli);
  if (!engine) return { error: `Unknown engine: ${String(b.cli)}` };
  if (engine.kind === "api") return { error: `${engine.label} is not a CLI engine` };
  const reason = gate(engine.cli);
  if (reason) return { error: reason };
  if (b.model !== undefined && !engine.models.includes(b.model)) {
    return { error: `Unknown model for ${engine.label}: ${b.model}` };
  }
  return { researchEngine: { cli: engine.cli, model: b.model } };
}
```

- [ ] **Step 5: Add the routes**

In `swarm/src/server.ts`, beside the `/me/voice` routes, following their exact shape:

```ts
    const redactResearchEngine = (u: User | null) => u?.researchEngine ?? null;

    this.app.get("/me/research-engine", async () => {
      const users = await loadUsersFromDir(resolve(process.cwd(), ".smith/users"));
      return redactResearchEngine(resolveCurrentUser(users));
    });

    this.app.put("/me/research-engine", async (req, reply) => {
      const dir = resolve(process.cwd(), ".smith/users");
      const users = await loadUsersFromDir(dir);
      const existing = resolveCurrentUser(users) ?? { id: "me", name: "You", default: true, connectors: [] };
      const file = await loadCliToolsFile(resolve(process.cwd(), ".smith/cli-tools.json"));
      const r = buildResearchEngineUpdate(req.body, ENGINES, (cli) => gateReason(file, cli));
      if ("error" in r) return reply.status(400).send({ error: r.error });
      const merged: User = { ...existing, researchEngine: r.researchEngine };
      try {
        await saveUser(dir, merged);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
      return redactResearchEngine(merged);
    });
```

- [ ] **Step 6: Run the tests, typecheck, full suite**

```bash
node --import tsx --test --test-timeout 60000 --test-name-pattern='buildResearchEngineUpdate|names the check' src/server.test.ts
pnpm typecheck
pnpm test 2>&1 | tail -5
```
Expected: 8 new tests PASS; typecheck back at its baseline; suite `fail 0`. Typecheck is the only check that catches a missing import in `server.ts`, since no unit test boots the server.

- [ ] **Step 7: Lint and commit**

```bash
pnpm exec biome check .
git add swarm/src/users.ts swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(swarm): research-engine setting + validation

Four distinct rejections, four distinct messages. A silently corrected
setting would leave the broker on an engine nobody chose."
```

---

### Task 4: Route the six research sites through the seam

**Files:**
- Modify: `broker/src/main.ts` (engine construction + 4 call sites)
- Modify: `broker/src/polish.ts`, `broker/src/session-title.ts`
- Modify: `broker/src/polish.test.ts`, `broker/src/session-title.test.ts`

**Interfaces:**
- Consumes: `ResearchEngine`, `AnthropicResearch`, `CliResearch` from Tasks 1-2; `GET /me/research-engine` from Task 3.

- [ ] **Step 1: Write the failing tests**

`polish.ts` and `session-title.ts` currently take a `StreamFactory` and a model. Change both to take a `ResearchEngine`. Update their tests first — replace the scripted `StreamFactory` fake with a one-line engine fake:

```ts
const engineOf = (reply: string): ResearchEngine => ({ complete: async () => reply });
const failing = (): ResearchEngine => ({
  complete: async () => {
    throw new ResearchError("engine down");
  },
});

test("polishText returns the engine's text", async () => {
  assert.equal(await polishText(engineOf("Cleaned up."), "raw text", "ctx"), "Cleaned up.");
});

test("polishText returns null when the engine fails — dictation must not break", async () => {
  assert.equal(await polishText(failing(), "raw text", "ctx"), null);
});

test("generateSessionTitle returns null when the engine fails", async () => {
  assert.equal(await generateSessionTitle(failing(), "first", "reply"), null);
});
```

Both files already swallow failures and return null; preserve that exactly — a failed polish must never break dictation, and a failed title must never break a session.

- [ ] **Step 2: Run them to verify they fail**

From `broker/`:
```bash
node --import tsx --test --test-timeout 60000 src/polish.test.ts src/session-title.test.ts
```
Expected: FAIL — signature mismatch.

- [ ] **Step 3: Change the two helpers' signatures**

In `polish.ts` and `session-title.ts`, replace the `streamFactory({...})` block plus `await stream.finalMessage()` with a single `await engine.complete({ system: SYSTEM, prompt, maxTokens })`. The `tools: [] as never` line goes away with it — it existed only to satisfy `StreamFactory`, which these never used as a stream.

- [ ] **Step 4: Construct the engine in main.ts**

In `broker/src/main.ts`, beside the existing `anthropic` client:

```ts
/**
 * Research engine, resolved per turn from the operator's setting so a bad
 * choice is fixed by changing it back — not by restarting a broker that holds
 * live LiveKit and Discord connections.
 *
 * Falls back to the Anthropic default when unset, when the swarm is
 * unreachable, or when the stored engine no longer passes its gate. A research
 * call must never fail because a *setting* could not be read.
 */
const anthropicResearch = new AnthropicResearch(
  (p) => anthropic.messages.create(p as Parameters<typeof anthropic.messages.create>[0]),
  "claude-haiku-4-5",
);

async function researchEngine(): Promise<ResearchEngine> {
  const chosen = await swarm.getResearchEngine().catch(() => null);
  if (!chosen) return anthropicResearch;
  const argv = researchArgvFor(chosen.cli);
  if (!argv) return anthropicResearch;
  return new CliResearch(defaultSpawner, argv, chosen.model);
}
```

`researchArgvFor` maps a cli id to its one-shot invocation — the per-tool knowledge the spec says stays in one place:

```ts
/** One-shot invocation per tool, verified against each binary's --help. */
const RESEARCH_ARGV: Record<string, string[]> = {
  claude: ["claude", "--print"],
  codex: ["codex", "exec"],
  agy: ["agy", "--print"],
  copilot: ["copilot", "--prompt"],
  opencode: ["opencode", "run"],
};
const researchArgvFor = (cli: string): string[] | undefined => RESEARCH_ARGV[cli];
```

Add `getResearchEngine()` to `broker/src/swarm-client.ts` beside `getMyVoice()`:

```ts
  async getResearchEngine(): Promise<{ cli: string; model?: string } | null> {
    return (await this.http("GET", "/me/research-engine")) as { cli: string; model?: string } | null;
  }
```

- [ ] **Step 5: Route the four main.ts sites**

Replace each of these `anthropic.messages.create({...})` calls with `(await researchEngine()).complete({ system, prompt, maxTokens })`, keeping each site's existing system prompt and token budget:

- `main.ts:1513` — `runDocEditTurn`'s injected `create`
- `main.ts:1704` — feeds → `plan`
- `main.ts:2034` — `analyzeBrief`
- `main.ts:2396` — `askForClaim`'s `brokerAsk`

Then pass the engine into `generateSessionTitle` (`main.ts:790`) and `polishText` (`main.ts:1383`) instead of `streamFactory` and a model string.

**Do not touch `streamFactory` itself or `BrokerBrain`.** After this task `streamFactory` has exactly one consumer — the brain — which is the point.

- [ ] **Step 6: Run the broker suite, typecheck, lint**

```bash
pnpm test 2>&1 | tail -5
pnpm typecheck
pnpm exec biome check .
```
Expected: suite green, typecheck and biome at their baselines.

- [ ] **Step 7: Commit**

```bash
git add broker/src/main.ts broker/src/polish.ts broker/src/session-title.ts broker/src/swarm-client.ts broker/src/polish.test.ts broker/src/session-title.test.ts
git commit -m "feat(broker): route the six research sites through ResearchEngine

polish and session-title stop pretending to stream — they passed
tools:[] and only ever awaited finalMessage. streamFactory now has one
consumer left: the brain, which is the only site that needs it."
```

---

### Task 5: The Settings picker

**Files:**
- Create: `control-plane/src/organisms/settings/ResearchEngineGroup.tsx`
- Create: `control-plane/src/organisms/settings/ResearchEngineGroup.test.tsx`
- Modify: `control-plane/src/organisms/SettingsPanel.tsx:58-70` and its import block
- Modify: `control-plane/src/api/broker.ts`, `control-plane/src/queries/http.ts`, `control-plane/src/queries/keys.ts`

**Interfaces:**
- Consumes: `GET/PUT /me/research-engine` from Task 3; the existing `useCliTools()` listing, which already carries `{ cli, label, models, status, active }` per engine.

- [ ] **Step 1: Write the failing tests**

Create `ResearchEngineGroup.test.tsx`, modelled on `VoiceGroup.test.tsx` — seed the query cache, stub the PUT, assert on rendered state:

```tsx
const TOOLS = [
  { cli: "claude", label: "Claude Code", models: ["claude-opus", "claude-sonnet"], warmSessions: true, active: true, status: null },
  { cli: "agy", label: "Antigravity", models: ["default"], warmSessions: false, active: true, status: null },
  { cli: "copilot", label: "GitHub Copilot", models: ["default"], warmSessions: true, active: false, status: null },
];

it("lists only engines the registry reports active", async () => {
  const { client } = renderWithProviders(<ResearchEngineGroup />);
  seed(client, TOOLS, null);
  const select = (await screen.findByLabelText("Research engine")) as HTMLSelectElement;
  const labels = Array.from(select.options).map((o) => o.textContent);
  expect(labels).toContain("Claude Code");
  expect(labels).toContain("Antigravity");
  expect(labels).not.toContain("GitHub Copilot");
});

it("renders guidance instead of an empty select when nothing qualifies", async () => {
  const { client } = renderWithProviders(<ResearchEngineGroup />);
  seed(client, [], null);
  expect(await screen.findByText(/no CLI tools are ready/i)).toBeDefined();
  expect(screen.queryByLabelText("Research engine")).toBeNull();
});

it("selecting an engine PUTs it and reflects the saved value", async () => {
  const fn = stubSave({ cli: "agy", model: "default" });
  const { client } = renderWithProviders(<ResearchEngineGroup />);
  seed(client, TOOLS, null);
  fireEvent.change(await screen.findByLabelText("Research engine"), { target: { value: "agy" } });
  await waitFor(() =>
    expect(fn).toHaveBeenCalledWith(
      expect.stringContaining("/me/research-engine"),
      expect.objectContaining({ method: "PUT" }),
    ),
  );
});

it("surfaces the server's reason and keeps the prior selection on a rejected save", async () => {
  stubSave({ error: "claude is not logged in" });
  const { client } = renderWithProviders(<ResearchEngineGroup />);
  seed(client, TOOLS, { cli: "agy", model: "default" });
  fireEvent.change(await screen.findByLabelText("Research engine"), { target: { value: "claude" } });
  await screen.findByText("claude is not logged in");
  expect((screen.getByLabelText("Research engine") as HTMLSelectElement).value).toBe("agy");
});
```

Follow `VoiceGroup.test.tsx`'s conventions exactly — that file's `afterEach(() => vi.unstubAllGlobals())` and its `stubSave` helper shape both apply here.

- [ ] **Step 2: Run them to verify they fail**

From `control-plane/`:
```bash
pnpm vitest run src/organisms/settings/ResearchEngineGroup.test.tsx
```
Expected: FAIL — module not found.

- [ ] **Step 3: Add the client + query plumbing**

In `api/broker.ts`, beside `getVoiceSettings`/`saveVoiceSettings`:

```ts
/** GET /me/research-engine */
export async function getResearchEngine(base: string = BROKER_BASE): Promise<{ cli: string; model?: string } | null> {
  const res = await brokerFetch(`/me/research-engine`, base);
  return (await res.json()) as { cli: string; model?: string } | null;
}

/** PUT /me/research-engine */
export async function saveResearchEngine(
  body: { cli: string; model?: string } | null,
  base: string = BROKER_BASE,
): Promise<{ cli?: string; model?: string; error?: string }> {
  const res = await brokerFetch(`/me/research-engine`, base, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { cli?: string; model?: string; error?: string };
}
```

Add `qk.researchEngine` to `queries/keys.ts`, and `useResearchEngine()` / `useSaveResearchEngine()` to `queries/http.ts` following `useVoiceSettings` / `useSaveVoiceSettings` — including the "only commit to the cache when the response carries no `error`" contract those already implement.

- [ ] **Step 4: Build the group**

`ResearchEngineGroup.tsx` renders a labelled `<select>` over `cliTools.filter(t => t.active && t.kind !== "api")`, plus a model `<select>` populated from the chosen engine's own `models`. On change it calls the mutation; on a response carrying `error` it renders that message in a `wizard__error` paragraph and leaves the selection as it was. With no qualifying engine it renders a `wizard__hint` explaining that no CLI tools are ready and pointing at the CLI Tools group.

- [ ] **Step 5: Register it in SettingsPanel**

Add the import, then a nav entry in the Workspace heading beside Voice (`SettingsPanel.tsx:58-70`), and the render branch beside `{active === "voice" && <VoiceGroup />}`.

`SettingsPanel.tsx` imports its icons from `lucide-react` in one block at the top (line 11) — add `FlaskConical` there alongside `Mic`, `Blocks` and the rest. Do not introduce a second import statement.

```tsx
      { id: "research", label: "Research engine", icon: FlaskConical },
```
```tsx
        {active === "research" && <ResearchEngineGroup />}
```

- [ ] **Step 6: Run the file, then the full suite**

```bash
pnpm vitest run src/organisms/settings/ResearchEngineGroup.test.tsx
for i in 1 2 3; do pnpm vitest run 2>&1 | tail -3; done
```
Expected: new tests pass; three green full runs. If `MapStage.test.tsx > "MapStage editing"` fails, that is a known pre-existing file-level flake — three different assertions in that block have flaked, it passes in isolation, and this task never touches it. Name it and move on; any flake in *your* files is yours.

- [ ] **Step 7: Lint and commit**

```bash
pnpm exec biome check .
git add control-plane/src/organisms/settings/ResearchEngineGroup.tsx control-plane/src/organisms/settings/ResearchEngineGroup.test.tsx control-plane/src/organisms/SettingsPanel.tsx control-plane/src/api/broker.ts control-plane/src/queries/http.ts control-plane/src/queries/keys.ts
git commit -m "feat(cp): research engine picker in Settings

Lists only CLI tools the registry reports active; renders guidance
rather than an empty select when none qualify."
```

---

## Final verification

- [ ] Restart the swarm and broker — both run from the main checkout and neither watches for changes, so a stale process serves its boot-time module graph:
  ```bash
  tmux send-keys -t smith-swarm C-c && tmux send-keys -t smith-swarm "pnpm serve" Enter
  tmux send-keys -t smith-broker C-c && tmux send-keys -t smith-broker "pnpm serve" Enter
  curl -s --retry 30 --retry-connrefused -o /dev/null -w "swarm %{http_code}\n" http://127.0.0.1:7777/me/research-engine
  ```
- [ ] In Settings → Research engine, pick **Antigravity**. Confirm the PUT succeeds and the value survives a reload.
- [ ] Send a chat message and confirm the session gets a **title** — that is `generateSessionTitle` running on agy rather than the dead key, and it is the fastest end-to-end proof.
- [ ] Dictate something and confirm **polish** still returns text, and that a failure returns the raw text rather than breaking dictation.
- [ ] Pick an engine, then close its gate (log the tool out) and confirm the next research call falls back to Anthropic rather than throwing.
- [ ] Confirm **chat and voice still work exactly as before** — the brain is untouched by this phase, and if it changed behaviour, something routed through the wrong seam.
