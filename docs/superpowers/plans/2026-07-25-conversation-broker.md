# Conversation Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `broker/` (`@smithagents/broker`) — the voice coordination core that sits between LiveKit (media), Deepgram (STT), ElevenLabs via `@smithagents/voice` (TTS), and the swarm's HTTP API (delegation + results), with a raw `@anthropic-ai/sdk` Haiku brain that routes per turn via tool-use.

**Architecture:** The broker is a long-running Node process. It polls swarm `GET /meetings`, joins open LiveKit rooms as a participant, streams room audio → Deepgram → utterances → the Haiku brain. The brain's plain text is speech (chunked ~200 chars → ElevenLabs → published back to the room); its tool calls are strategies: `delegate` (swarm `POST /tasks` — pinned interactive CLI in tmux) and `check_status` (swarm `GET /tasks/:id/output`). An `AgentDirectory` read-model (seeded from `GET /agents/registry`, updated by `/ws` events + meeting membership) tells the brain who is idle/busy/in-meeting every turn. The broker never imports swarm code — swarm is an HTTP service; wire types are defined broker-side.

**Tech Stack:** TypeScript (source-first via `tsx`, `moduleResolution: Bundler`, `.ts` import extensions — same style as `voice/`), npm (no workspace), `@anthropic-ai/sdk` (Haiku, streaming + tools), `@deepgram/sdk` (live STT), `@livekit/rtc-node` + `livekit-server-sdk` (room media + token mint), `@smithagents/voice` via `file:../voice` (ElevenLabs TTS), `ws`, `node:test`.

## Global Constraints

- **No helmsmith, LangChain, or LangGraph anywhere.** Broker deps are exactly: `@anthropic-ai/sdk`, `@deepgram/sdk`, `@livekit/rtc-node`, `livekit-server-sdk`, `ws`, `@smithagents/voice`.
- **Zero changes to `swarm/`.** The endpoints the broker needs already exist (`POST /tasks`, `GET /tasks/:taskId`, `GET /tasks/:taskId/output`, `POST /tasks/:taskId/steer`, `POST /tasks/:taskId/kill`, `GET /agents/registry`, `GET/POST/DELETE /meetings`, WS `/ws`). Broker ↔ swarm is HTTP/WS only; never `import` from `swarm/src`.
- Brain model is exactly `claude-haiku-4-5` (Edwin's explicit coordinator choice — do not substitute another model), `max_tokens: 1024`.
- Speech chunks target **200 chars max**, min 40 chars before a sentence-boundary flush.
- Swarm base URL default `http://127.0.0.1:7777`; auth header `Authorization: Bearer <SMITH_API_TOKEN>` when token set; WS auth via `?token=`.
- Node >= 24. Tests run with `node --import tsx --test`. Every module runs from source; no `dist`, no build step.
- Modules that load native code (`@livekit/rtc-node`) or hit the network must be behind injected factories so unit tests never touch them. Pure logic (chunker, pcm framing, directory) gets thorough tests; thin I/O wrappers get validation-level tests only.
- All commits on the current branch `feat/swarm-meeting-backend`, message prefix `feat(broker):` (or `test(broker):`).
- Secrets come from the repo-root `.env` via `node --env-file=../.env` — never hardcode keys, never commit `.env`.

## Out of scope (documented, deliberate)

- `convene_council` tool (multi-agent moderation) — spec marks council v1.1; the tool schema ships with `delegate`/`check_status` only.
- Control-plane (Tauri) LiveKit join — separate plan.
- Barge-in/interruption handling, wake-word gate — after the app meeting loop works end-to-end.
- LangSmith tracing — deferred (cloud dep vs local-first).

## File Structure

```
broker/
  package.json           @smithagents/broker (private, type: module)
  tsconfig.json          Bundler + allowImportingTsExtensions + noEmit
  src/
    chunker.ts           SpeechChunker — stream text → ~200-char speakable chunks
    chunker.test.ts
    swarm-client.ts      Wire types + SwarmClient (HTTP + /ws, injectable fetch/WS)
    swarm-client.test.ts
    directory.ts         AgentDirectory — who/where/status read-model
    directory.test.ts
    brain.ts             BrokerBrain — Haiku streaming + tool-use routing
    brain.test.ts
    stt.ts               DeepgramSttStream — live STT wrapper (injectable factory)
    stt.test.ts
    pcm.ts               Pure PCM helpers (bytes → Int16 frames)
    pcm.test.ts
    room.ts              LiveKitRoomBridge — join/subscribe/publish (thin) + token mint
    room.test.ts         (token mint only — no native imports in tests)
    config.ts            loadBrokerConfig(env)
    config.test.ts
    broker.ts            Broker — meeting poll loop + turn pipeline (all deps injected)
    broker.test.ts
    main.ts              Composition root (real deps; the only file importing rtc-node + providers together)
```

---

### Task 1: Broker module scaffold + SpeechChunker

**Files:**
- Create: `broker/package.json`
- Create: `broker/tsconfig.json`
- Create: `broker/src/chunker.ts`
- Test: `broker/src/chunker.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `SpeechChunker` — `new SpeechChunker(onChunk: (text: string) => void, opts?: {maxChars?: number; minChars?: number})`, methods `push(delta: string): void`, `flush(): void`.

- [ ] **Step 1: Create the package manifest**

`broker/package.json`:

```json
{
  "name": "@smithagents/broker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Conversation broker: coordinates LiveKit media, Deepgram STT, ElevenLabs TTS, and swarm delegation around a Haiku tool-use brain.",
  "exports": {
    ".": "./src/broker.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "serve": "node --env-file=../.env --import tsx src/main.ts",
    "test": "node --import tsx --test src/*.test.ts"
  },
  "engines": {
    "node": ">=24.0.0"
  },
  "dependencies": {
    "@smithagents/voice": "file:../voice"
  },
  "devDependencies": {
    "@types/node": "^24.13.3",
    "tsx": "^4.23.1",
    "typescript": "^5.6.0"
  }
}
```

(Remaining runtime deps are added by the task that first needs them, via `npm install <pkg>` so npm resolves current versions into the lockfile: Task 4 adds `@anthropic-ai/sdk`, Task 5 adds `@deepgram/sdk`, Task 6 adds `@livekit/rtc-node` + `livekit-server-sdk`, Task 2 adds `ws` + `@types/ws`.)

- [ ] **Step 2: Create the tsconfig (voice-compatible: Bundler + .ts extensions + noEmit)**

`broker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

Why Bundler + `allowImportingTsExtensions`: `@smithagents/voice` is source-first — its `exports` points at `src/index.ts` and its internal imports use `.ts` extensions. Those files join our TS program, so our flags must allow them. `tsx` handles the same at runtime.

- [ ] **Step 3: Install and verify empty typecheck**

```bash
cd broker && npm install && npx tsc --noEmit
```

Expected: install succeeds (symlinks `../voice`); tsc exits 0 (no source yet — that's fine, `include` matching nothing is not an error; if tsc complains "No inputs were found", proceed — Step 4 adds the first file).

- [ ] **Step 4: Write the failing chunker test**

`broker/src/chunker.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpeechChunker } from './chunker.ts';

function collect(): { chunks: string[]; on: (t: string) => void } {
  const chunks: string[] = [];
  return { chunks, on: (t) => chunks.push(t) };
}

test('flush emits the buffered remainder as one chunk', () => {
  const { chunks, on } = collect();
  const c = new SpeechChunker(on);
  c.push('Hello there.');
  c.flush();
  assert.deepEqual(chunks, ['Hello there.']);
});

test('emits at a sentence boundary once minChars is reached', () => {
  const { chunks, on } = collect();
  const c = new SpeechChunker(on, { minChars: 10, maxChars: 200 });
  c.push('Short. '); // sentence end but < minChars — held
  assert.deepEqual(chunks, []);
  c.push('This second sentence pushes us past the minimum. ');
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.startsWith('Short.'));
  assert.ok(chunks[0]!.endsWith('minimum.'));
});

test('splits a run-on at a word boundary at maxChars', () => {
  const { chunks, on } = collect();
  const c = new SpeechChunker(on, { minChars: 10, maxChars: 40 });
  c.push('one two three four five six seven eight nine ten eleven twelve');
  c.flush();
  assert.ok(chunks.length >= 2);
  for (const ch of chunks) assert.ok(ch.length <= 40, `chunk too long: "${ch}"`);
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), 'one two three four five six seven eight nine ten eleven twelve');
});

test('never emits empty chunks', () => {
  const { chunks, on } = collect();
  const c = new SpeechChunker(on);
  c.push('   ');
  c.flush();
  c.flush();
  assert.deepEqual(chunks, []);
});
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
cd broker && npm test
```

Expected: FAIL — `Cannot find module './chunker.ts'`.

- [ ] **Step 6: Implement SpeechChunker**

`broker/src/chunker.ts`:

```ts
/**
 * SpeechChunker — turns a token stream into speakable ~200-char chunks.
 *
 * Flush rules, in priority order:
 *   1. Sentence boundary (. ! ? followed by whitespace) AND buffer >= minChars.
 *   2. Buffer exceeds maxChars: split at the last word boundary before the cap.
 *   3. flush(): emit whatever remains (trimmed), if non-empty.
 *
 * Feeding TTS sentence-sized pieces is what makes streamed speech start fast:
 * ElevenLabs synthesizes chunk 1 while the brain is still writing chunk 3.
 */
export interface ChunkerOptions {
  maxChars?: number;
  minChars?: number;
}

export class SpeechChunker {
  private buf = '';
  private readonly maxChars: number;
  private readonly minChars: number;

  constructor(
    private readonly onChunk: (text: string) => void,
    opts?: ChunkerOptions,
  ) {
    this.maxChars = opts?.maxChars ?? 200;
    this.minChars = opts?.minChars ?? 40;
  }

  push(delta: string): void {
    this.buf += delta;
    this.drain();
  }

  flush(): void {
    const text = this.buf.trim();
    this.buf = '';
    if (text.length > 0) this.onChunk(text);
  }

  private drain(): void {
    for (;;) {
      // Rule 1 — first sentence boundary at or past minChars (not merely the
      // first boundary: "Short. " below the minimum must not block emission),
      // as long as the resulting chunk stays within the cap.
      const re = /[.!?]["')\]]?\s/g;
      let cut = -1;
      let m: RegExpExecArray | null;
      while ((m = re.exec(this.buf)) !== null) {
        const end = m.index + m[0].length;
        if (end >= this.minChars) {
          cut = end;
          break;
        }
      }
      if (cut > 0 && cut <= this.maxChars + 1) {
        this.emit(this.buf.slice(0, cut));
        this.buf = this.buf.slice(cut);
        continue;
      }
      // Rule 2 — hard cap at a word boundary.
      if (this.buf.length > this.maxChars) {
        const window = this.buf.slice(0, this.maxChars + 1);
        const lastSpace = window.lastIndexOf(' ');
        const cut = lastSpace > 0 ? lastSpace : this.maxChars;
        this.emit(this.buf.slice(0, cut));
        this.buf = this.buf.slice(cut);
        continue;
      }
      return;
    }
  }

  private emit(raw: string): void {
    const text = raw.trim();
    if (text.length > 0) this.onChunk(text);
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd broker && npm test && npx tsc --noEmit
```

Expected: 4/4 pass; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add broker/package.json broker/package-lock.json broker/tsconfig.json broker/src/chunker.ts broker/src/chunker.test.ts
git commit -m "feat(broker): scaffold @smithagents/broker + SpeechChunker"
```

---

### Task 2: Wire types + SwarmClient

**Files:**
- Create: `broker/src/swarm-client.ts`
- Test: `broker/src/swarm-client.test.ts`

**Interfaces:**
- Consumes: nothing broker-side. Swarm HTTP contract (verified against `swarm/src/server.ts`, do not import it):
  - `POST /tasks` body `{prompt, agent: 'agy'|'claude'|'codex', context: {files: string[], repository: string, branch: string}, metadata?}` → 202 `{taskId, agentName, status: 'queued', position}`
  - `GET /tasks/:taskId` → `{taskId, status, ...}` | 404
  - `GET /tasks/:taskId/output` → `{taskId, agentName, sessionName, output, ...}` | 404 (accepts taskId or swarm agentName)
  - `POST /tasks/:taskId/steer` body `{message}` → `{status: 'sent'}` | 404
  - `POST /tasks/:taskId/kill` → `{status: 'killed'}` | 404
  - `GET /agents/registry` → `{agents: RegistryAgent[]}`
  - `GET /meetings` → `{meetings: SwarmMeeting[]}`
  - WS `/ws?token=<t>` → JSON events: `state:snapshot` on connect, then `task:dispatched {taskId, sessionName}`, `task:completed {taskId, result}`, `task:failed {taskId, result}`, `task:quarantined {taskId, reason}`
  - Auth: `Authorization: Bearer <token>` header on HTTP when token set.
- Produces (later tasks consume these exact names):
  - `interface RegistryAgent { id: string; name: string; role: string; directives: string; engine: { cli: 'agy'|'claude'|'codex'; model: string }; voice?: { provider: string; voiceId?: string } }`
  - `interface SwarmMeeting { id: string; roomName: string; agentIds: string[]; mode: 'solo'|'council'; status: 'open'|'closed'; createdAt: string }`
  - `type SwarmEvent = { type: 'state:snapshot' } & Record<string, unknown> | { type: 'task:dispatched'; taskId: string; sessionName: string } | { type: 'task:completed'; taskId: string; result: unknown } | { type: 'task:failed'; taskId: string; result: unknown } | { type: 'task:quarantined'; taskId: string; reason: string }`
  - `class SwarmClient` — `new SwarmClient(opts: {baseUrl: string; token?: string; fetchImpl?: typeof fetch; wsFactory?: (url: string) => WsLike})` with:
    - `submitTask(req: {prompt: string; agent: 'agy'|'claude'|'codex'; repository: string; branch?: string; metadata?: Record<string, unknown>}): Promise<{taskId: string; agentName: string | null}>`
    - `getOutput(taskIdOrName: string): Promise<{taskId: string; output: string}>`
    - `steer(taskIdOrName: string, message: string): Promise<void>`
    - `registry(): Promise<RegistryAgent[]>`
    - `listMeetings(): Promise<SwarmMeeting[]>`
    - `subscribe(onEvent: (e: SwarmEvent) => void): () => void` (returns unsubscribe; auto-reconnects every 2s until unsubscribed)
  - `interface WsLike { on(ev: 'open'|'message'|'close'|'error', cb: (arg?: unknown) => void): void; close(): void }`

- [ ] **Step 1: Install ws**

```bash
cd broker && npm install ws && npm install -D @types/ws
```

- [ ] **Step 2: Write the failing test**

`broker/src/swarm-client.test.ts`:

```ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SwarmClient, type SwarmEvent, type WsLike } from './swarm-client.ts';

interface Call { url: string; init?: RequestInit }

function fakeFetch(routes: Record<string, unknown>): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const f = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const path = new URL(String(url)).pathname;
    const body = routes[path];
    if (body === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { calls, fetch: f };
}

test('submitTask posts prompt/agent/context and returns taskId', async () => {
  const { calls, fetch } = fakeFetch({ '/tasks': { taskId: 't-1', agentName: 'Manuel', status: 'queued', position: 1 } });
  const c = new SwarmClient({ baseUrl: 'http://127.0.0.1:7777', token: 'secret', fetchImpl: fetch });
  const r = await c.submitTask({ prompt: 'do it', agent: 'claude', repository: 'git@x:y.git' });
  assert.equal(r.taskId, 't-1');
  const sent = JSON.parse(String(calls[0]!.init!.body));
  assert.equal(sent.agent, 'claude');
  assert.deepEqual(sent.context, { files: [], repository: 'git@x:y.git', branch: 'main' });
  assert.equal((calls[0]!.init!.headers as Record<string, string>).authorization, 'Bearer secret');
});

test('registry unwraps the agents array', async () => {
  const agents = [{ id: 'manuel', name: 'Manuel', role: 'lead', directives: 'd', engine: { cli: 'claude', model: 'sonnet' } }];
  const { fetch } = fakeFetch({ '/agents/registry': { agents } });
  const c = new SwarmClient({ baseUrl: 'http://x', fetchImpl: fetch });
  assert.deepEqual(await c.registry(), agents);
});

test('getOutput returns output; non-200 throws with status', async () => {
  const { fetch } = fakeFetch({ '/tasks/t-1/output': { taskId: 't-1', output: 'pane text' } });
  const c = new SwarmClient({ baseUrl: 'http://x', fetchImpl: fetch });
  assert.equal((await c.getOutput('t-1')).output, 'pane text');
  await assert.rejects(() => c.getOutput('nope'), /404/);
});

test('subscribe parses events and reconnects; unsubscribe stops it', async () => {
  const sockets: Array<EventEmitter & { close(): void; closed: boolean }> = [];
  const wsFactory = (url: string): WsLike => {
    assert.match(url, /\/ws\?token=tok$/);
    const s = Object.assign(new EventEmitter(), { closed: false, close() { (this as { closed: boolean }).closed = true; } });
    sockets.push(s as never);
    return s as unknown as WsLike;
  };
  const events: SwarmEvent[] = [];
  const c = new SwarmClient({ baseUrl: 'http://h:7777', token: 'tok', wsFactory });
  const stop = c.subscribe((e) => events.push(e));
  sockets[0]!.emit('message', JSON.stringify({ type: 'task:dispatched', taskId: 't-9', sessionName: 's' }));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'task:dispatched');
  stop();
  assert.equal(sockets[0]!.closed, true);
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd broker && npm test
```

Expected: FAIL — `Cannot find module './swarm-client.ts'` (chunker tests still pass).

- [ ] **Step 4: Implement SwarmClient**

`broker/src/swarm-client.ts`:

```ts
/**
 * SwarmClient — the broker's ONLY window into the swarm. HTTP + WS, no code
 * imports: swarm is a service and these wire types mirror its contract
 * (swarm/src/server.ts routes). If swarm's API changes, this file changes.
 */
import WebSocket from 'ws';

export interface RegistryAgent {
  id: string;
  name: string;
  role: string;
  directives: string;
  engine: { cli: 'agy' | 'claude' | 'codex'; model: string };
  voice?: { provider: string; voiceId?: string };
}

export interface SwarmMeeting {
  id: string;
  roomName: string;
  agentIds: string[];
  mode: 'solo' | 'council';
  status: 'open' | 'closed';
  createdAt: string;
}

export type SwarmEvent =
  | ({ type: 'state:snapshot' } & Record<string, unknown>)
  | { type: 'task:dispatched'; taskId: string; sessionName: string }
  | { type: 'task:completed'; taskId: string; result: unknown }
  | { type: 'task:failed'; taskId: string; result: unknown }
  | { type: 'task:quarantined'; taskId: string; reason: string };

export interface WsLike {
  on(ev: 'open' | 'message' | 'close' | 'error', cb: (arg?: unknown) => void): void;
  close(): void;
}

export interface SwarmClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WsLike;
}

export class SwarmClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory: (url: string) => WsLike;

  constructor(opts: SwarmClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
  }

  async submitTask(req: {
    prompt: string;
    agent: 'agy' | 'claude' | 'codex';
    repository: string;
    branch?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ taskId: string; agentName: string | null }> {
    const body = {
      prompt: req.prompt,
      agent: req.agent,
      context: { files: [], repository: req.repository, branch: req.branch ?? 'main' },
      metadata: req.metadata,
    };
    const r = await this.http('POST', '/tasks', body);
    return { taskId: r.taskId as string, agentName: (r.agentName as string | null) ?? null };
  }

  async getOutput(taskIdOrName: string): Promise<{ taskId: string; output: string }> {
    const r = await this.http('GET', `/tasks/${encodeURIComponent(taskIdOrName)}/output`);
    return { taskId: r.taskId as string, output: r.output as string };
  }

  async steer(taskIdOrName: string, message: string): Promise<void> {
    await this.http('POST', `/tasks/${encodeURIComponent(taskIdOrName)}/steer`, { message });
  }

  async registry(): Promise<RegistryAgent[]> {
    const r = await this.http('GET', '/agents/registry');
    return r.agents as RegistryAgent[];
  }

  async listMeetings(): Promise<SwarmMeeting[]> {
    const r = await this.http('GET', '/meetings');
    return r.meetings as SwarmMeeting[];
  }

  /** Subscribe to /ws events. Reconnects every 2s until the returned fn is called. */
  subscribe(onEvent: (e: SwarmEvent) => void): () => void {
    const wsUrl =
      this.baseUrl.replace(/^http/, 'ws') + '/ws' + (this.token ? `?token=${encodeURIComponent(this.token)}` : '');
    let stopped = false;
    let current: WsLike | null = null;
    let timer: NodeJS.Timeout | null = null;

    const connect = () => {
      if (stopped) return;
      const ws = this.wsFactory(wsUrl);
      current = ws;
      ws.on('message', (data) => {
        try {
          onEvent(JSON.parse(String(data)) as SwarmEvent);
        } catch {
          /* non-JSON frame — ignore */
        }
      });
      ws.on('close', () => {
        if (!stopped) timer = setTimeout(connect, 2000);
      });
      ws.on('error', () => {
        /* close follows; reconnect handles it */
      });
    };
    connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      current?.close();
    };
  }

  private async http(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`swarm ${method} ${path} -> ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd broker && npm test && npx tsc --noEmit
```

Expected: all pass (8 total), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add broker/src/swarm-client.ts broker/src/swarm-client.test.ts broker/package.json broker/package-lock.json
git commit -m "feat(broker): SwarmClient — HTTP/WS wire client for the swarm API"
```

---

### Task 3: AgentDirectory (who / where / status)

**Files:**
- Create: `broker/src/directory.ts`
- Test: `broker/src/directory.test.ts`

**Interfaces:**
- Consumes: `RegistryAgent`, `SwarmEvent` from `./swarm-client.ts`.
- Produces:
  - `type AgentStatus = 'idle' | 'busy' | 'in-meeting' | 'offline'`
  - `interface AgentPresence { agent: RegistryAgent; status: AgentStatus; taskId?: string; taskSummary?: string; swarmName?: string }`
  - `class AgentDirectory` — `seed(agents: RegistryAgent[])`, `resolve(nameOrId: string): RegistryAgent | undefined` (case-insensitive), `bindTask(agentId: string, bind: {taskId: string; summary?: string; swarmName?: string})`, `onEvent(e: SwarmEvent): void`, `setMeeting(agentIds: string[]): void` (marks listed agents in-meeting, others keep prior status), `clearMeeting(): void`, `snapshot(): AgentPresence[]`, `describeForPrompt(): string`, `findByTask(taskId: string): AgentPresence | undefined`.

- [ ] **Step 1: Write the failing test**

`broker/src/directory.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentDirectory } from './directory.ts';
import type { RegistryAgent } from './swarm-client.ts';

const AGENTS: RegistryAgent[] = [
  { id: 'manuel', name: 'Manuel', role: 'research lead', directives: 'd1', engine: { cli: 'claude', model: 'claude-sonnet-5' } },
  { id: 'octavio', name: 'Octavio', role: 'builder', directives: 'd2', engine: { cli: 'claude', model: 'claude-sonnet-5' } },
];

test('seed + resolve by id or name, case-insensitive', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  assert.equal(d.resolve('OCTAVIO')?.id, 'octavio');
  assert.equal(d.resolve('Manuel')?.id, 'manuel');
  assert.equal(d.resolve('nobody'), undefined);
});

test('bindTask + task:dispatched -> busy; task:completed -> idle again', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  d.bindTask('octavio', { taskId: 't-1', summary: 'refactor auth', swarmName: 'bold-falcon' });
  d.onEvent({ type: 'task:dispatched', taskId: 't-1', sessionName: 'task-t-1' });
  assert.equal(d.snapshot().find((p) => p.agent.id === 'octavio')?.status, 'busy');
  assert.equal(d.findByTask('t-1')?.agent.id, 'octavio');
  d.onEvent({ type: 'task:completed', taskId: 't-1', result: {} });
  assert.equal(d.snapshot().find((p) => p.agent.id === 'octavio')?.status, 'idle');
  assert.equal(d.findByTask('t-1'), undefined);
});

test('events for unknown tasks are ignored', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  d.onEvent({ type: 'task:failed', taskId: 'ghost', result: {} });
  assert.ok(d.snapshot().every((p) => p.status === 'idle'));
});

test('setMeeting marks membership; busy survives meeting flag; clearMeeting restores', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  d.bindTask('octavio', { taskId: 't-2' });
  d.onEvent({ type: 'task:dispatched', taskId: 't-2', sessionName: 's' });
  d.setMeeting(['manuel']);
  assert.equal(d.snapshot().find((p) => p.agent.id === 'manuel')?.status, 'in-meeting');
  assert.equal(d.snapshot().find((p) => p.agent.id === 'octavio')?.status, 'busy');
  d.clearMeeting();
  assert.equal(d.snapshot().find((p) => p.agent.id === 'manuel')?.status, 'idle');
});

test('describeForPrompt lists every agent with role and status', () => {
  const d = new AgentDirectory();
  d.seed(AGENTS);
  d.bindTask('octavio', { taskId: 't-3', summary: 'ship feature' });
  d.onEvent({ type: 'task:dispatched', taskId: 't-3', sessionName: 's' });
  const text = d.describeForPrompt();
  assert.match(text, /Manuel \(research lead\) — idle/);
  assert.match(text, /Octavio \(builder\) — busy: ship feature/);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd broker && npm test
```

Expected: FAIL — `Cannot find module './directory.ts'`.

- [ ] **Step 3: Implement AgentDirectory**

`broker/src/directory.ts`:

```ts
/**
 * AgentDirectory — the brain's live picture of who the agents are and where
 * they are. A READ-MODEL, not a source of truth: identity comes from the swarm
 * registry, work placement from swarm /ws events (joined via bindTask, since
 * the broker knows which agent it delegated for), meeting membership from the
 * broker's own LiveKit state.
 */
import type { RegistryAgent, SwarmEvent } from './swarm-client.ts';

export type AgentStatus = 'idle' | 'busy' | 'in-meeting' | 'offline';

export interface AgentPresence {
  agent: RegistryAgent;
  status: AgentStatus;
  taskId?: string;
  taskSummary?: string;
  swarmName?: string;
}

interface Placement {
  taskId: string;
  summary?: string;
  swarmName?: string;
  dispatched: boolean;
}

export class AgentDirectory {
  private agents = new Map<string, RegistryAgent>();
  private placements = new Map<string, Placement>(); // agentId -> placement
  private meetingIds = new Set<string>();

  seed(agents: RegistryAgent[]): void {
    this.agents = new Map(agents.map((a) => [a.id, a]));
  }

  resolve(nameOrId: string): RegistryAgent | undefined {
    const q = nameOrId.trim().toLowerCase();
    for (const a of this.agents.values()) {
      if (a.id.toLowerCase() === q || a.name.toLowerCase() === q) return a;
    }
    return undefined;
  }

  bindTask(agentId: string, bind: { taskId: string; summary?: string; swarmName?: string }): void {
    if (!this.agents.has(agentId)) return;
    this.placements.set(agentId, { ...bind, dispatched: false });
  }

  onEvent(e: SwarmEvent): void {
    if (e.type === 'task:dispatched') {
      const hit = this.entryByTask(e.taskId);
      if (hit) hit[1].dispatched = true;
      return;
    }
    if (e.type === 'task:completed' || e.type === 'task:failed' || e.type === 'task:quarantined') {
      const hit = this.entryByTask(e.taskId);
      if (hit) this.placements.delete(hit[0]);
    }
  }

  setMeeting(agentIds: string[]): void {
    this.meetingIds = new Set(agentIds);
  }

  clearMeeting(): void {
    this.meetingIds.clear();
  }

  findByTask(taskId: string): AgentPresence | undefined {
    const hit = this.entryByTask(taskId);
    if (!hit) return undefined;
    return this.snapshot().find((p) => p.agent.id === hit[0]);
  }

  snapshot(): AgentPresence[] {
    return [...this.agents.values()].map((agent) => {
      const placement = this.placements.get(agent.id);
      let status: AgentStatus = 'idle';
      if (placement) status = 'busy';
      else if (this.meetingIds.has(agent.id)) status = 'in-meeting';
      return {
        agent,
        status,
        taskId: placement?.taskId,
        taskSummary: placement?.summary,
        swarmName: placement?.swarmName,
      };
    });
  }

  /** Roster block injected into the brain's system prompt each turn. */
  describeForPrompt(): string {
    return this.snapshot()
      .map((p) => {
        const base = `${p.agent.name} (${p.agent.role}) — ${p.status}`;
        return p.status === 'busy' && p.taskSummary ? `${base}: ${p.taskSummary}` : base;
      })
      .join('\n');
  }

  private entryByTask(taskId: string): [string, Placement] | undefined {
    for (const entry of this.placements.entries()) {
      if (entry[1].taskId === taskId) return entry;
    }
    return undefined;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd broker && npm test && npx tsc --noEmit
```

Expected: all pass (13 total), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add broker/src/directory.ts broker/src/directory.test.ts
git commit -m "feat(broker): AgentDirectory — who/where/status read-model for the brain"
```

---

### Task 4: BrokerBrain — Haiku streaming + tool-use routing

**Files:**
- Create: `broker/src/brain.ts`
- Test: `broker/src/brain.test.ts`

**Interfaces:**
- Consumes: `SpeechChunker` from `./chunker.ts`.
- Produces:
  - `interface ToolExecutors { delegate(input: {agent: string; task: string}): Promise<string>; check_status(input: {agent: string}): Promise<string> }`
  - `interface BrainTurn { roster: string; onSpeech: (chunk: string) => void }`
  - `interface BrainStreamLike { on(event: 'text', cb: (delta: string) => void): void; finalMessage(): Promise<{ content: Array<{type: string; text?: string; id?: string; name?: string; input?: unknown}>; stop_reason: string | null }> }`
  - `type StreamFactory = (params: {model: string; max_tokens: number; system: string; messages: unknown[]; tools: unknown[]}) => BrainStreamLike`
  - `class BrokerBrain` — `new BrokerBrain(streamFactory: StreamFactory, executors: ToolExecutors, opts?: {model?: string; maxHistory?: number})`, `handleUtterance(text: string, turn: BrainTurn): Promise<void>`.
  - Production factory (in `main.ts`, Task 7): `(params) => new Anthropic({apiKey}).messages.stream(params)` — the SDK `MessageStream` satisfies `BrainStreamLike`.

- [ ] **Step 1: Install the SDK**

```bash
cd broker && npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Write the failing test**

`broker/src/brain.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrokerBrain, type BrainStreamLike, type StreamFactory, type ToolExecutors } from './brain.ts';

type FinalMsg = Awaited<ReturnType<BrainStreamLike['finalMessage']>>;

/** Scripted fake: each call to the factory pops the next scripted response. */
function scripted(responses: Array<{ textDeltas: string[]; final: FinalMsg }>): {
  factory: StreamFactory;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const factory: StreamFactory = (params) => {
    calls.push(params as unknown as Record<string, unknown>);
    const r = responses.shift();
    if (!r) throw new Error('no scripted response left');
    const textCbs: Array<(d: string) => void> = [];
    return {
      on(event, cb) {
        if (event === 'text') textCbs.push(cb);
      },
      async finalMessage() {
        for (const cb of textCbs) for (const d of r.textDeltas) cb(d);
        return r.final;
      },
    };
  };
  return { factory, calls };
}

const NOOP_EXEC: ToolExecutors = {
  delegate: async () => 'ok',
  check_status: async () => 'ok',
};

test('plain text answer streams to onSpeech as chunks', async () => {
  const { factory } = scripted([
    {
      textDeltas: ['Sure — the meeting orchestrator is healthy. ', 'All nine tests pass.'],
      final: { content: [{ type: 'text', text: 'Sure — ...' }], stop_reason: 'end_turn' },
    },
  ]);
  const spoken: string[] = [];
  const brain = new BrokerBrain(factory, NOOP_EXEC);
  await brain.handleUtterance('how are the tests?', { roster: 'Manuel — idle', onSpeech: (c) => spoken.push(c) });
  assert.ok(spoken.length >= 1);
  assert.match(spoken.join(' '), /nine tests pass/);
});

test('tool_use runs the executor and continues with tool_result', async () => {
  const { factory, calls } = scripted([
    {
      textDeltas: ['On it. '],
      final: {
        content: [
          { type: 'text', text: 'On it. ' },
          { type: 'tool_use', id: 'tu_1', name: 'delegate', input: { agent: 'Octavio', task: 'refactor auth' } },
        ],
        stop_reason: 'tool_use',
      },
    },
    {
      textDeltas: ['Octavio is on it — task queued.'],
      final: { content: [{ type: 'text', text: 'Octavio is on it — task queued.' }], stop_reason: 'end_turn' },
    },
  ]);
  const delegated: unknown[] = [];
  const exec: ToolExecutors = {
    delegate: async (input) => {
      delegated.push(input);
      return 'queued as task t-42';
    },
    check_status: async () => 'unused',
  };
  const spoken: string[] = [];
  const brain = new BrokerBrain(factory, exec);
  await brain.handleUtterance('have octavio refactor auth', { roster: 'Octavio — idle', onSpeech: (c) => spoken.push(c) });

  assert.deepEqual(delegated, [{ agent: 'Octavio', task: 'refactor auth' }]);
  assert.equal(calls.length, 2);
  const second = calls[1]!.messages as Array<{ role: string; content: unknown }>;
  const toolResult = second.at(-1)!;
  assert.equal(toolResult.role, 'user');
  assert.match(JSON.stringify(toolResult.content), /queued as task t-42/);
  assert.match(spoken.join(' '), /Octavio is on it/);
});

test('roster is injected into the system prompt; history is capped', async () => {
  const responses = Array.from({ length: 12 }, (_, i) => ({
    textDeltas: [`reply ${i}.`],
    final: { content: [{ type: 'text' as const, text: `reply ${i}.` }], stop_reason: 'end_turn' },
  }));
  const { factory, calls } = scripted(responses);
  const brain = new BrokerBrain(factory, NOOP_EXEC, { maxHistory: 6 });
  for (let i = 0; i < 12; i++) {
    await brain.handleUtterance(`utterance ${i}`, { roster: 'ROSTER-MARK', onSpeech: () => {} });
  }
  assert.match(String(calls.at(-1)!.system), /ROSTER-MARK/);
  assert.ok((calls.at(-1)!.messages as unknown[]).length <= 7); // 6 history + current user turn
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd broker && npm test
```

Expected: FAIL — `Cannot find module './brain.ts'`.

- [ ] **Step 4: Implement BrokerBrain**

`broker/src/brain.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd broker && npm test && npx tsc --noEmit
```

Expected: all pass (16 total), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add broker/src/brain.ts broker/src/brain.test.ts broker/package.json broker/package-lock.json
git commit -m "feat(broker): BrokerBrain — Haiku streaming coordinator with delegate/check_status tools"
```

---

### Task 5: DeepgramSttStream

**Files:**
- Create: `broker/src/stt.ts`
- Test: `broker/src/stt.test.ts`

**Interfaces:**
- Consumes: nothing broker-side.
- Produces:
  - `interface LiveLike { on(event: string, cb: (data?: unknown) => void): void; send(data: Uint8Array): void; requestClose(): void }`
  - `type LiveFactory = () => LiveLike`
  - `class DeepgramSttStream` — `new DeepgramSttStream(liveFactory: LiveFactory)`, `start(onUtterance: (text: string) => void): void`, `sendAudio(pcm: Uint8Array): void`, `stop(): void`.
  - Production factory (in `main.ts`, Task 7): `() => createClient(deepgramApiKey).listen.live({model: 'nova-3', encoding: 'linear16', sample_rate: 48000, channels: 1, interim_results: true, smart_format: true, endpointing: 300})`.
- **Implementer note:** the fake in tests defines the contract the wrapper relies on: Deepgram live emits `Results` events shaped `{is_final: boolean, speech_final: boolean, channel: {alternatives: [{transcript: string}]}}`. Verify the current event name/shape against `@deepgram/sdk` docs (context7 `/deepgram/deepgram-js-sdk`) when wiring `main.ts` — only the factory line should need adjusting, never this class.

- [ ] **Step 1: Install the SDK**

```bash
cd broker && npm install @deepgram/sdk
```

- [ ] **Step 2: Write the failing test**

`broker/src/stt.test.ts`:

```ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { DeepgramSttStream, type LiveLike } from './stt.ts';

function fakeLive(): { live: LiveLike & EventEmitter; sent: Uint8Array[]; closed: boolean[] } {
  const sent: Uint8Array[] = [];
  const closed: boolean[] = [];
  const em = new EventEmitter() as EventEmitter & LiveLike;
  em.send = (d: Uint8Array) => sent.push(d);
  em.requestClose = () => closed.push(true);
  return { live: em, sent, closed };
}

function results(transcript: string, opts: { is_final: boolean; speech_final: boolean }) {
  return { ...opts, channel: { alternatives: [{ transcript }] } };
}

test('accumulates is_final segments and emits one utterance on speech_final', () => {
  const { live } = fakeLive();
  const utterances: string[] = [];
  const stt = new DeepgramSttStream(() => live);
  stt.start((u) => utterances.push(u));

  live.emit('Results', results('hey manuel', { is_final: false, speech_final: false })); // interim — ignored
  live.emit('Results', results('hey manuel', { is_final: true, speech_final: false }));
  live.emit('Results', results('how are the tests', { is_final: true, speech_final: true }));

  assert.deepEqual(utterances, ['hey manuel how are the tests']);
});

test('empty transcripts never emit; buffer resets between utterances', () => {
  const { live } = fakeLive();
  const utterances: string[] = [];
  const stt = new DeepgramSttStream(() => live);
  stt.start((u) => utterances.push(u));

  live.emit('Results', results('', { is_final: true, speech_final: true }));
  assert.deepEqual(utterances, []);

  live.emit('Results', results('first', { is_final: true, speech_final: true }));
  live.emit('Results', results('second', { is_final: true, speech_final: true }));
  assert.deepEqual(utterances, ['first', 'second']);
});

test('sendAudio forwards to live; stop closes it', () => {
  const { live, sent, closed } = fakeLive();
  const stt = new DeepgramSttStream(() => live);
  stt.start(() => {});
  const pcm = new Uint8Array([1, 2, 3]);
  stt.sendAudio(pcm);
  assert.deepEqual(sent, [pcm]);
  stt.stop();
  assert.deepEqual(closed, [true]);
});

test('sendAudio before start is a safe no-op', () => {
  const { live } = fakeLive();
  const stt = new DeepgramSttStream(() => live);
  stt.sendAudio(new Uint8Array([9])); // must not throw
});
```

- [ ] **Step 3: Run to verify failure**

```bash
cd broker && npm test
```

Expected: FAIL — `Cannot find module './stt.ts'`.

- [ ] **Step 4: Implement DeepgramSttStream**

`broker/src/stt.ts`:

```ts
/**
 * DeepgramSttStream — live speech-to-text with utterance segmentation.
 * Deepgram does the hard part (endpointing): we accumulate `is_final`
 * transcript segments and emit one utterance when `speech_final` marks the
 * end of speech. The live connection is injected so tests run without the
 * service; production wires `createClient(key).listen.live({...})`.
 */
export interface LiveLike {
  on(event: string, cb: (data?: unknown) => void): void;
  send(data: Uint8Array): void;
  requestClose(): void;
}

export type LiveFactory = () => LiveLike;

interface ResultsEvent {
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

export class DeepgramSttStream {
  private live: LiveLike | null = null;
  private segments: string[] = [];

  constructor(private readonly liveFactory: LiveFactory) {}

  start(onUtterance: (text: string) => void): void {
    this.live = this.liveFactory();
    this.live.on('Results', (data) => {
      const ev = data as ResultsEvent;
      const transcript = ev.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
      if (ev.is_final && transcript.length > 0) this.segments.push(transcript);
      if (ev.speech_final) {
        const utterance = this.segments.join(' ').trim();
        this.segments = [];
        if (utterance.length > 0) onUtterance(utterance);
      }
    });
  }

  sendAudio(pcm: Uint8Array): void {
    this.live?.send(pcm);
  }

  stop(): void {
    this.live?.requestClose();
    this.live = null;
    this.segments = [];
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd broker && npm test && npx tsc --noEmit
```

Expected: all pass (20 total), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add broker/src/stt.ts broker/src/stt.test.ts broker/package.json broker/package-lock.json
git commit -m "feat(broker): DeepgramSttStream — live STT with utterance segmentation"
```

---

### Task 6: PCM helpers + LiveKitRoomBridge

**Files:**
- Create: `broker/src/pcm.ts`
- Test: `broker/src/pcm.test.ts`
- Create: `broker/src/room.ts`
- Test: `broker/src/room.test.ts`

**Interfaces:**
- Consumes: nothing broker-side.
- Produces:
  - `pcm.ts`: `interface PcmFrame { data: Int16Array; sampleRate: number; samplesPerChannel: number }`; `pcmBytesToFrames(bytes: Uint8Array, sampleRate: number, frameMs?: number): { frames: PcmFrame[]; remainder: Uint8Array }` (little-endian s16, mono; default frameMs 100; carries odd/partial bytes as remainder); `int16ToBytes(frame: Int16Array): Uint8Array`.
  - `room.ts`: `mintRoomToken(opts: {apiKey: string; apiSecret: string; roomName: string; identity: string}): Promise<string>` (livekit-server-sdk `AccessToken`, `roomJoin` + `canPublish` + `canSubscribe` grants, ttl `'2h'`); `class LiveKitRoomBridge` — `connect(opts: {url: string; token: string}): Promise<void>`, `onRemoteAudio(cb: (pcmBytes: Uint8Array) => void): void` (48kHz mono s16le from subscribed tracks), `publishPcm(bytes: Uint8Array, sampleRate: number): Promise<void>` (chunks through `pcmBytesToFrames` → `AudioSource.captureFrame`), `disconnect(): Promise<void>`.
- **Native-module rule:** `room.test.ts` imports ONLY `mintRoomToken` (via a separate export path — see Step 4) so tests never load `@livekit/rtc-node`'s native addon. The bridge itself is exercised in the Task 8 live smoke.
- **Implementer note:** `@livekit/rtc-node` surface used: `Room` (+ `connect(url, token, {autoSubscribe: true})`), `RoomEvent.TrackSubscribed`, `AudioStream(track, {sampleRate: 48000})` (async-iterable of `AudioFrame {data: Int16Array, sampleRate, samplesPerChannel}`), `AudioSource(sampleRate, 1)`, `LocalAudioTrack.createAudioTrack(name, source)`, `localParticipant.publishTrack(track, options)`. Verify exact names against current `@livekit/rtc-node` docs (context7 `/livekit/node-sdks`) while implementing; keep any drift inside `room.ts`.

- [ ] **Step 1: Install LiveKit deps**

```bash
cd broker && npm install @livekit/rtc-node livekit-server-sdk
```

- [ ] **Step 2: Write the failing pcm test**

`broker/src/pcm.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { int16ToBytes, pcmBytesToFrames } from './pcm.ts';

function bytesOf(...samples: number[]): Uint8Array {
  const i16 = new Int16Array(samples);
  return new Uint8Array(i16.buffer.slice(0));
}

test('splits bytes into frameMs-sized mono frames', () => {
  // 10ms frames at 1000Hz = 10 samples per frame; 25 samples -> 2 frames + 5-sample remainder
  const bytes = bytesOf(...Array.from({ length: 25 }, (_, i) => i));
  const { frames, remainder } = pcmBytesToFrames(bytes, 1000, 10);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.samplesPerChannel, 10);
  assert.equal(frames[0]!.sampleRate, 1000);
  assert.deepEqual([...frames[0]!.data], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([...frames[1]!.data], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(remainder.length, 10); // 5 samples * 2 bytes
});

test('odd trailing byte is carried in the remainder, never dropped', () => {
  const bytes = new Uint8Array([...bytesOf(1, 2, 3), 0x7f]); // 3 samples + 1 stray byte
  const { frames, remainder } = pcmBytesToFrames(bytes, 3000, 1); // 3 samples/frame
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!.data], [1, 2, 3]);
  assert.deepEqual([...remainder], [0x7f]);
});

test('int16ToBytes round-trips with pcmBytesToFrames', () => {
  const original = new Int16Array([100, -200, 32767, -32768]);
  const { frames } = pcmBytesToFrames(int16ToBytes(original), 4000, 1); // 4 samples/frame
  assert.deepEqual([...frames[0]!.data], [...original]);
});
```

- [ ] **Step 3: Run to verify failure, then implement pcm.ts**

```bash
cd broker && npm test
```

Expected: FAIL — `Cannot find module './pcm.ts'`.

`broker/src/pcm.ts`:

```ts
/**
 * Pure PCM plumbing (no native imports — unit-testable). Audio in this
 * system is s16le mono: LiveKit frames carry Int16Array, Deepgram wants raw
 * s16le bytes, ElevenLabs pcm output is s16le bytes. These helpers convert
 * between byte streams and fixed-duration frames, carrying partial frames
 * (and odd bytes) as a remainder so nothing is dropped across chunks.
 */
export interface PcmFrame {
  data: Int16Array;
  sampleRate: number;
  samplesPerChannel: number;
}

export function pcmBytesToFrames(
  bytes: Uint8Array,
  sampleRate: number,
  frameMs = 100,
): { frames: PcmFrame[]; remainder: Uint8Array } {
  const samplesPerFrame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const bytesPerFrame = samplesPerFrame * 2;
  const frames: PcmFrame[] = [];
  let offset = 0;
  while (bytes.length - offset >= bytesPerFrame) {
    const slice = bytes.slice(offset, offset + bytesPerFrame);
    frames.push({
      data: new Int16Array(slice.buffer, slice.byteOffset, samplesPerFrame),
      sampleRate,
      samplesPerChannel: samplesPerFrame,
    });
    offset += bytesPerFrame;
  }
  return { frames, remainder: bytes.slice(offset) };
}

export function int16ToBytes(frame: Int16Array): Uint8Array {
  return new Uint8Array(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
}
```

Run: `cd broker && npm test` — pcm tests pass.

- [ ] **Step 4: Write the failing token test**

Token mint lives in its own file so tests can import it without touching the native rtc module. Create the test first:

`broker/src/room.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
// NOTE: import from token.ts (pure) — never from room.ts, which loads @livekit/rtc-node native code.
import { mintRoomToken } from './token.ts';

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1]!;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
}

test('mints a joinable publish/subscribe token for the room', async () => {
  const jwt = await mintRoomToken({
    apiKey: 'devkey',
    apiSecret: 'secret',
    roomName: 'meeting-abc',
    identity: 'smith-broker',
  });
  const payload = decodeJwtPayload(jwt);
  assert.equal(payload.sub, 'smith-broker');
  const video = payload.video as Record<string, unknown>;
  assert.equal(video.room, 'meeting-abc');
  assert.equal(video.roomJoin, true);
  assert.equal(video.canPublish, true);
  assert.equal(video.canSubscribe, true);
});
```

Run: `cd broker && npm test` — FAIL: `Cannot find module './token.ts'`.

- [ ] **Step 5: Implement token.ts and room.ts**

`broker/src/token.ts`:

```ts
/** Room-token mint, separated from room.ts so tests avoid the native module. */
import { AccessToken } from 'livekit-server-sdk';

export async function mintRoomToken(opts: {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
}): Promise<string> {
  const at = new AccessToken(opts.apiKey, opts.apiSecret, { identity: opts.identity, ttl: '2h' });
  at.addGrant({ room: opts.roomName, roomJoin: true, canPublish: true, canSubscribe: true });
  return at.toJwt();
}
```

`broker/src/room.ts`:

```ts
/**
 * LiveKitRoomBridge — the broker's seat in the meeting room. Joins with a
 * minted token, exposes remote (human mic) audio as raw s16le bytes for STT,
 * and publishes TTS PCM back as the broker's voice. THIN by design: all
 * decisions live elsewhere; this file is the only one importing the native
 * @livekit/rtc-node module (exercised via the live smoke, not unit tests).
 */
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
} from '@livekit/rtc-node';
import { pcmBytesToFrames } from './pcm.ts';

export class LiveKitRoomBridge {
  private room: Room | null = null;
  private source: AudioSource | null = null;
  private remoteAudioCb: ((pcmBytes: Uint8Array) => void) | null = null;
  private publishRemainder = new Uint8Array(0);

  async connect(opts: { url: string; token: string }): Promise<void> {
    const room = new Room();
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      void (async () => {
        const stream = new AudioStream(track, { sampleRate: 48000 });
        for await (const frame of stream) {
          const bytes = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
          this.remoteAudioCb?.(bytes.slice(0));
        }
      })();
    });

    await room.connect(opts.url, opts.token, { autoSubscribe: true, dynacast: false });
  }

  onRemoteAudio(cb: (pcmBytes: Uint8Array) => void): void {
    this.remoteAudioCb = cb;
  }

  async publishPcm(bytes: Uint8Array, sampleRate: number): Promise<void> {
    if (!this.room) return;
    if (!this.source) {
      this.source = new AudioSource(sampleRate, 1);
      const track = LocalAudioTrack.createAudioTrack('broker-voice', this.source);
      await this.room.localParticipant?.publishTrack(track, undefined);
    }
    const joined = new Uint8Array(this.publishRemainder.length + bytes.length);
    joined.set(this.publishRemainder, 0);
    joined.set(bytes, this.publishRemainder.length);
    const { frames, remainder } = pcmBytesToFrames(joined, sampleRate);
    this.publishRemainder = remainder;
    for (const f of frames) {
      await this.source.captureFrame(new AudioFrame(f.data, f.sampleRate, 1, f.samplesPerChannel));
    }
  }

  async disconnect(): Promise<void> {
    await this.room?.disconnect();
    this.room = null;
    this.source = null;
    this.publishRemainder = new Uint8Array(0);
  }
}
```

- [ ] **Step 6: Run tests + typecheck**

```bash
cd broker && npm test && npx tsc --noEmit
```

Expected: all pass (24 total). Typecheck clean — if `@livekit/rtc-node` names drifted from the implementer note (e.g. `LocalAudioTrack.createAudioTrack` signature, `TrackKind` values, publish options type), consult current docs and fix `room.ts` only.

- [ ] **Step 7: Commit**

```bash
git add broker/src/pcm.ts broker/src/pcm.test.ts broker/src/token.ts broker/src/room.ts broker/src/room.test.ts broker/package.json broker/package-lock.json
git commit -m "feat(broker): PCM helpers + LiveKit room bridge with token mint"
```

---

### Task 7: Config + Broker core loop + composition root

**Files:**
- Create: `broker/src/config.ts`
- Test: `broker/src/config.test.ts`
- Create: `broker/src/broker.ts`
- Test: `broker/src/broker.test.ts`
- Create: `broker/src/main.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–6, plus from `@smithagents/voice`: `VoiceProvider` (`stream(req: SynthesisRequest): AsyncIterable<AudioChunk>`), `PersonaVoiceConfig`.
- Produces:
  - `config.ts`: `interface BrokerConfig { anthropicApiKey: string; deepgramApiKey: string; elevenlabsApiKey?: string; livekit: { url: string; apiKey: string; apiSecret: string }; swarm: { baseUrl: string; token?: string; repository: string }; voice: { voiceId?: string } }`; `loadBrokerConfig(env?: Record<string, string | undefined>): BrokerConfig` — required: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`; optional: `ELEVENLABS_API_KEY`, `SMITH_API_TOKEN`, `SWARM_URL` (default `http://127.0.0.1:7777`), `SWARM_REPO` (default `''`), `ELEVENLABS_VOICE_ID`. Throws naming the missing var.
  - `broker.ts`: `interface BrokerDeps { swarm: SwarmClientLike; directory: AgentDirectory; brain: BrainLike; makeStt: () => SttLike; makeBridge: () => BridgeLike; speak: (text: string) => AsyncIterable<Uint8Array>; mintToken: (roomName: string) => Promise<string>; livekitUrl: string; pollMs?: number }` with structural interfaces `SwarmClientLike` (`listMeetings`, `registry`, `subscribe`, `submitTask`, `getOutput`), `BrainLike` (`handleUtterance`, `handleSystemNote`), `SttLike` (`start`, `sendAudio`, `stop`), `BridgeLike` (`connect`, `onRemoteAudio`, `publishPcm`, `disconnect`); `class Broker` — `start(): Promise<void>`, `stop(): Promise<void>`, `pollOnce(): Promise<void>` (exposed for tests), `handleUtterance(text: string): Promise<void>` (exposed for tests + the stdin dev channel), and internal tool executors `delegate`/`check_status` wired from deps.
  - `main.ts`: composition root — builds real SDK clients, `ElevenLabsVoiceProvider`, `Broker`; also reads **stdin lines as utterances** (the mic-less dev channel: type text, get the full brain→TTS→room pipeline).

- [ ] **Step 1: Write the failing config test**

`broker/src/config.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBrokerConfig } from './config.ts';

const FULL = {
  ANTHROPIC_API_KEY: 'sk-ant',
  DEEPGRAM_API_KEY: 'dg',
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'devkey',
  LIVEKIT_API_SECRET: 'secret',
};

test('loads with defaults for optional vars', () => {
  const c = loadBrokerConfig(FULL);
  assert.equal(c.swarm.baseUrl, 'http://127.0.0.1:7777');
  assert.equal(c.swarm.repository, '');
  assert.equal(c.swarm.token, undefined);
  assert.equal(c.livekit.url, 'ws://127.0.0.1:7880');
});

test('throws naming the missing required var', () => {
  const { DEEPGRAM_API_KEY: _omit, ...rest } = FULL;
  assert.throws(() => loadBrokerConfig(rest), /DEEPGRAM_API_KEY/);
});

test('optional overrides are honored', () => {
  const c = loadBrokerConfig({ ...FULL, SWARM_URL: 'http://h:9999', SMITH_API_TOKEN: 't', ELEVENLABS_VOICE_ID: 'v1', SWARM_REPO: 'git@x:y.git' });
  assert.equal(c.swarm.baseUrl, 'http://h:9999');
  assert.equal(c.swarm.token, 't');
  assert.equal(c.voice.voiceId, 'v1');
  assert.equal(c.swarm.repository, 'git@x:y.git');
});
```

Run: `cd broker && npm test` — FAIL: `Cannot find module './config.ts'`.

- [ ] **Step 2: Implement config.ts**

`broker/src/config.ts`:

```ts
/** Broker configuration from environment (repo-root .env via --env-file). */
export interface BrokerConfig {
  anthropicApiKey: string;
  deepgramApiKey: string;
  elevenlabsApiKey?: string;
  livekit: { url: string; apiKey: string; apiSecret: string };
  swarm: { baseUrl: string; token?: string; repository: string };
  voice: { voiceId?: string };
}

export function loadBrokerConfig(env: Record<string, string | undefined> = process.env): BrokerConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };
  return {
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    deepgramApiKey: required('DEEPGRAM_API_KEY'),
    elevenlabsApiKey: env.ELEVENLABS_API_KEY || undefined,
    livekit: {
      url: required('LIVEKIT_URL'),
      apiKey: required('LIVEKIT_API_KEY'),
      apiSecret: required('LIVEKIT_API_SECRET'),
    },
    swarm: {
      baseUrl: env.SWARM_URL || 'http://127.0.0.1:7777',
      token: env.SMITH_API_TOKEN || undefined,
      repository: env.SWARM_REPO || '',
    },
    voice: { voiceId: env.ELEVENLABS_VOICE_ID || undefined },
  };
}
```

Run: `cd broker && npm test` — config tests pass.

- [ ] **Step 3: Write the failing broker core test**

`broker/src/broker.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Broker, type BridgeLike, type SttLike, type SwarmClientLike } from './broker.ts';
import { AgentDirectory } from './directory.ts';
import type { BrainLike } from './broker.ts';
import type { RegistryAgent, SwarmEvent, SwarmMeeting } from './swarm-client.ts';

const AGENTS: RegistryAgent[] = [
  { id: 'manuel', name: 'Manuel', role: 'lead', directives: 'Be Manuel.', engine: { cli: 'claude', model: 'claude-sonnet-5' } },
];

function makeFakes(meetings: SwarmMeeting[]) {
  const submitted: unknown[] = [];
  let eventSink: ((e: SwarmEvent) => void) | null = null;
  const swarm: SwarmClientLike = {
    listMeetings: async () => meetings,
    registry: async () => AGENTS,
    subscribe: (cb) => {
      eventSink = cb;
      return () => {};
    },
    submitTask: async (req) => {
      submitted.push(req);
      return { taskId: 't-77', agentName: 'bold-falcon' };
    },
    getOutput: async () => ({ taskId: 't-77', output: 'line1\nline2\nDONE building the thing' }),
  };

  const sttAudio: Uint8Array[] = [];
  let utteranceSink: ((t: string) => void) | null = null;
  const stt: SttLike = {
    start: (cb) => (utteranceSink = cb),
    sendAudio: (b) => sttAudio.push(b),
    stop: () => {},
  };

  const published: Array<{ bytes: Uint8Array; sampleRate: number }> = [];
  const bridge: BridgeLike & { remoteCb: ((b: Uint8Array) => void) | null; connected: string[] } = {
    remoteCb: null,
    connected: [],
    connect: async (opts) => void bridge.connected.push(opts.token),
    onRemoteAudio: (cb) => (bridge.remoteCb = cb),
    publishPcm: async (bytes, sampleRate) => void published.push({ bytes, sampleRate }),
    disconnect: async () => {},
  };

  const heard: string[] = [];
  const brain: BrainLike = {
    handleUtterance: async (text, turn) => {
      heard.push(text);
      turn.onSpeech('spoken reply');
    },
    handleSystemNote: async (note, turn) => {
      heard.push(`NOTE:${note}`);
      turn.onSpeech('narration');
    },
  };

  return {
    swarm, stt, bridge, brain, submitted, published, heard,
    emitEvent: (e: SwarmEvent) => eventSink?.(e),
    emitUtterance: (t: string) => utteranceSink?.(t),
  };
}

function makeBroker(f: ReturnType<typeof makeFakes>) {
  const directory = new AgentDirectory();
  return new Broker({
    swarm: f.swarm,
    directory,
    brain: f.brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    speak: async function* (text) {
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
  });
}

const MEETING: SwarmMeeting = {
  id: 'm-1', roomName: 'meeting-m-1', agentIds: ['manuel'], mode: 'solo', status: 'open', createdAt: 'now',
};

test('pollOnce joins an open meeting: token minted, bridge connected, mic wired to stt', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  assert.deepEqual(f.bridge.connected, ['jwt-for-meeting-m-1']);
  f.bridge.remoteCb!(new Uint8Array([1]));
  await b.stop();
});

test('utterance flows: stt -> brain -> speak -> publishPcm at 44100', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  f.emitUtterance('hello manuel');
  await new Promise((r) => setTimeout(r, 10)); // let the async turn settle
  assert.deepEqual(f.heard, ['hello manuel']);
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0]!.sampleRate, 44100);
  assert.match(Buffer.from(f.published[0]!.bytes).toString(), /AUDIO\(spoken reply\)/);
  await b.stop();
});

test('delegate executor resolves agent, prefixes directives, binds task in directory', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  const result = await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
  assert.match(result, /t-77/);
  const sent = f.submitted[0] as { prompt: string; agent: string };
  assert.equal(sent.agent, 'claude');
  assert.match(sent.prompt, /Be Manuel\./);
  assert.match(sent.prompt, /build the thing/);
  await b.stop();
});

test('delegate on unknown agent returns an error string (brain speaks it, no throw)', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  const result = await b.executors.delegate({ agent: 'Nobody', task: 'x' });
  assert.match(result, /no agent named/i);
  await b.stop();
});

test('task:completed for a bound task triggers a spoken system note', async () => {
  const f = makeFakes([MEETING]);
  const b = makeBroker(f);
  await b.start();
  await b.pollOnce();
  await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
  f.emitEvent({ type: 'task:dispatched', taskId: 't-77', sessionName: 's' });
  f.emitEvent({ type: 'task:completed', taskId: 't-77', result: { outcome: 'completed' } });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(f.heard.some((h) => h.startsWith('NOTE:') && /Manuel/.test(h)));
  await b.stop();
});
```

Run: `cd broker && npm test` — FAIL: `Cannot find module './broker.ts'`.

- [ ] **Step 4: Implement broker.ts**

`broker/src/broker.ts`:

```ts
/**
 * Broker — the conversation coordinator's event loop. Owns no policy beyond
 * wiring: swarm meetings appear -> join the room; room audio -> STT ->
 * utterances -> brain; brain speech -> TTS -> room; brain tools -> swarm
 * delegation; swarm events -> directory updates + spoken narration.
 * Every dependency is injected (structural interfaces) so the whole loop
 * unit-tests with fakes; main.ts builds the real ones.
 */
import type { AgentDirectory } from './directory.ts';
import type { BrainTurn } from './brain.ts';
import type { RegistryAgent, SwarmEvent, SwarmMeeting } from './swarm-client.ts';

export interface SwarmClientLike {
  listMeetings(): Promise<SwarmMeeting[]>;
  registry(): Promise<RegistryAgent[]>;
  subscribe(onEvent: (e: SwarmEvent) => void): () => void;
  submitTask(req: {
    prompt: string;
    agent: 'agy' | 'claude' | 'codex';
    repository: string;
    branch?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ taskId: string; agentName: string | null }>;
  getOutput(taskIdOrName: string): Promise<{ taskId: string; output: string }>;
}

export interface BrainLike {
  handleUtterance(text: string, turn: BrainTurn): Promise<void>;
  handleSystemNote(note: string, turn: BrainTurn): Promise<void>;
}

export interface SttLike {
  start(onUtterance: (text: string) => void): void;
  sendAudio(pcm: Uint8Array): void;
  stop(): void;
}

export interface BridgeLike {
  connect(opts: { url: string; token: string }): Promise<void>;
  onRemoteAudio(cb: (pcmBytes: Uint8Array) => void): void;
  publishPcm(bytes: Uint8Array, sampleRate: number): Promise<void>;
  disconnect(): Promise<void>;
}

export interface BrokerDeps {
  swarm: SwarmClientLike;
  directory: AgentDirectory;
  brain: BrainLike;
  makeStt: () => SttLike;
  makeBridge: () => BridgeLike;
  /** TTS: text -> s16le PCM bytes (44100 Hz mono). */
  speak: (text: string) => AsyncIterable<Uint8Array>;
  mintToken: (roomName: string) => Promise<string>;
  livekitUrl: string;
  pollMs?: number;
}

const TTS_SAMPLE_RATE = 44100;

interface ActiveMeeting {
  meeting: SwarmMeeting;
  bridge: BridgeLike;
  stt: SttLike;
}

export class Broker {
  private active: ActiveMeeting | null = null;
  private unsubscribe: (() => void) | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private speaking = Promise.resolve();

  /** Tool executors handed to the brain; public for tests + reuse. */
  readonly executors = {
    delegate: async (input: { agent: string; task: string }): Promise<string> => {
      const agent = this.deps.directory.resolve(input.agent);
      if (!agent) return `There is no agent named "${input.agent}". Offer one from the roster.`;
      const busy = this.deps.directory.snapshot().find((p) => p.agent.id === agent.id && p.status === 'busy');
      if (busy) return `${agent.name} is busy with: ${busy.taskSummary ?? busy.taskId}. Offer an idle agent instead.`;
      const { taskId, agentName } = await this.deps.swarm.submitTask({
        prompt: `${agent.directives}\n\n---\nTask from the live meeting:\n${input.task}`,
        agent: agent.engine.cli,
        repository: this.repository,
        metadata: { source: 'broker-meeting', composedAgentId: agent.id },
      });
      this.deps.directory.bindTask(agent.id, {
        taskId,
        summary: input.task.slice(0, 80),
        swarmName: agentName ?? undefined,
      });
      return `Delegated to ${agent.name}: task ${taskId} queued. They will work asynchronously; you will be notified on completion.`;
    },
    check_status: async (input: { agent: string }): Promise<string> => {
      const agent = this.deps.directory.resolve(input.agent);
      if (!agent) return `There is no agent named "${input.agent}".`;
      const presence = this.deps.directory.snapshot().find((p) => p.agent.id === agent.id);
      if (!presence || presence.status !== 'busy' || !presence.taskId) return `${agent.name} is not working on anything right now.`;
      const { output } = await this.deps.swarm.getOutput(presence.taskId);
      const tail = output.split('\n').slice(-25).join('\n');
      return `Live terminal tail for ${agent.name} (summarize for speech, do not read verbatim):\n${tail}`;
    },
  };

  private repository = '';

  constructor(
    private readonly deps: BrokerDeps,
    opts?: { repository?: string },
  ) {
    this.repository = opts?.repository ?? '';
  }

  async start(): Promise<void> {
    this.deps.directory.seed(await this.deps.swarm.registry());
    this.unsubscribe = this.deps.swarm.subscribe((e) => this.onSwarmEvent(e));
    const pollMs = this.deps.pollMs ?? 2000;
    this.pollTimer = setInterval(() => void this.pollOnce(), pollMs);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubscribe?.();
    await this.leaveMeeting();
  }

  /** One poll cycle: join the first open meeting; leave when it closes. */
  async pollOnce(): Promise<void> {
    let meetings: SwarmMeeting[];
    try {
      meetings = await this.deps.swarm.listMeetings();
    } catch {
      return; // swarm briefly unreachable — retry next tick
    }
    const open = meetings.find((m) => m.status === 'open');
    if (this.active && (!open || open.id !== this.active.meeting.id)) await this.leaveMeeting();
    if (open && !this.active) await this.joinMeeting(open);
  }

  /** Public so the stdin dev channel (and tests) can inject an utterance. */
  async handleUtterance(text: string): Promise<void> {
    await this.deps.brain.handleUtterance(text, this.makeTurn());
  }

  private async joinMeeting(meeting: SwarmMeeting): Promise<void> {
    const bridge = this.deps.makeBridge();
    const stt = this.deps.makeStt();
    stt.start((utterance) => void this.handleUtterance(utterance));
    bridge.onRemoteAudio((pcm) => stt.sendAudio(pcm));
    const token = await this.deps.mintToken(meeting.roomName);
    await bridge.connect({ url: this.deps.livekitUrl, token });
    this.active = { meeting, bridge, stt };
    this.deps.directory.setMeeting(meeting.agentIds);
  }

  private async leaveMeeting(): Promise<void> {
    if (!this.active) return;
    this.active.stt.stop();
    await this.active.bridge.disconnect();
    this.active = null;
    this.deps.directory.clearMeeting();
  }

  private onSwarmEvent(e: SwarmEvent): void {
    if (e.type === 'task:completed' || e.type === 'task:failed') {
      const presence = this.deps.directory.findByTask(e.taskId);
      if (presence && this.active) {
        const verdict = e.type === 'task:completed' ? 'finished' : 'FAILED';
        void this.deps.brain.handleSystemNote(
          `${presence.agent.name} ${verdict} the delegated task (${presence.taskSummary ?? e.taskId}). Tell the human in one short sentence.`,
          this.makeTurn(),
        );
      }
    }
    this.deps.directory.onEvent(e);
  }

  private makeTurn(): BrainTurn {
    return {
      roster: this.deps.directory.describeForPrompt(),
      onSpeech: (chunk) => this.enqueueSpeech(chunk),
    };
  }

  /** Serialize TTS chunks so audio never interleaves mid-sentence. */
  private enqueueSpeech(text: string): void {
    this.speaking = this.speaking.then(async () => {
      const bridge = this.active?.bridge;
      if (!bridge) return;
      for await (const bytes of this.deps.speak(text)) {
        await bridge.publishPcm(bytes, TTS_SAMPLE_RATE);
      }
    });
  }
}
```

- [ ] **Step 5: Run the broker tests**

```bash
cd broker && npm test && npx tsc --noEmit
```

Expected: all 32 tests pass (4 chunker + 4 swarm-client + 5 directory + 3 brain + 4 stt + 3 pcm + 1 token + 3 config + 5 broker), typecheck clean.

- [ ] **Step 6: Write the composition root**

`broker/src/main.ts`:

```ts
/**
 * Composition root — the only file that builds real SDK clients. Also runs
 * the stdin dev channel: every line typed is treated as a spoken utterance,
 * so the full brain -> delegate -> TTS pipeline is testable without a mic.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@deepgram/sdk';
import { createInterface } from 'node:readline';
import { ElevenLabsVoiceProvider } from '@smithagents/voice';
import { BrokerBrain, type StreamFactory } from './brain.ts';
import { Broker } from './broker.ts';
import { loadBrokerConfig } from './config.ts';
import { AgentDirectory } from './directory.ts';
import { LiveKitRoomBridge } from './room.ts';
import { DeepgramSttStream } from './stt.ts';
import { SwarmClient } from './swarm-client.ts';
import { mintRoomToken } from './token.ts';

const config = loadBrokerConfig();

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const streamFactory: StreamFactory = (params) =>
  anthropic.messages.stream(params as Parameters<typeof anthropic.messages.stream>[0]);

const swarm = new SwarmClient({ baseUrl: config.swarm.baseUrl, token: config.swarm.token });
const directory = new AgentDirectory();

const tts = config.elevenlabsApiKey ? new ElevenLabsVoiceProvider({ apiKey: config.elevenlabsApiKey }) : null;

async function* speak(text: string): AsyncIterable<Uint8Array> {
  if (!tts || !config.voice.voiceId) {
    console.log(`[speech-text] ${text}`); // no TTS configured — text-only mode
    return;
  }
  const stream = tts.stream({
    text,
    personaId: 'broker',
    format: 'pcm_s16le',
    sampleRate: 44100,
    voice: { provider: 'elevenlabs', voiceId: config.voice.voiceId },
  });
  for await (const chunk of stream) yield chunk.data;
}

const broker = new Broker(
  {
    swarm,
    directory,
    brain: new BrokerBrain(streamFactory, /* executors bound below */ {
      delegate: (input) => broker.executors.delegate(input),
      check_status: (input) => broker.executors.check_status(input),
    }),
    makeStt: () =>
      new DeepgramSttStream(() =>
        createClient(config.deepgramApiKey).listen.live({
          model: 'nova-3',
          encoding: 'linear16',
          sample_rate: 48000,
          channels: 1,
          interim_results: true,
          smart_format: true,
          endpointing: 300,
        }),
      ),
    makeBridge: () => new LiveKitRoomBridge(),
    speak,
    mintToken: (roomName) =>
      mintRoomToken({
        apiKey: config.livekit.apiKey,
        apiSecret: config.livekit.apiSecret,
        roomName,
        identity: 'smith-broker',
      }),
    livekitUrl: config.livekit.url,
  },
  { repository: config.swarm.repository },
);

await broker.start();
console.log('[broker] running — polling swarm for open meetings. Type a line to simulate an utterance.');

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (text) void broker.handleUtterance(text);
});

process.on('SIGINT', () => {
  void broker.stop().then(() => process.exit(0));
});
```

Note for the implementer: `main.ts` references `broker.executors` inside the `BrokerBrain` executor callbacks before `broker` is assigned — this is safe because the callbacks only run per-turn, long after startup. If `tsc` flags "used before assigned", declare `let broker: Broker` first and assign after constructing the brain, passing the brain into the deps object at construction.

The Deepgram `Results` event name: the SDK emits via `LiveTranscriptionEvents.Transcript` whose string value should be verified (context7 `/deepgram/deepgram-js-sdk`) — if it is not literally `'Results'`, adapt the `DeepgramSttStream` factory wiring by mapping: `live.on(LiveTranscriptionEvents.Transcript, ...)` — i.e. pass a small adapter object into `DeepgramSttStream` whose `.on('Results', cb)` subscribes the SDK's transcript event to `cb`. The stt.ts contract stays fixed.

- [ ] **Step 7: Typecheck everything**

```bash
cd broker && npx tsc --noEmit && npm test
```

Expected: clean typecheck (main.ts included), all tests green.

- [ ] **Step 8: Commit**

```bash
git add broker/src/config.ts broker/src/config.test.ts broker/src/broker.ts broker/src/broker.test.ts broker/src/main.ts
git commit -m "feat(broker): core meeting loop, tool executors, and composition root with stdin dev channel"
```

---

### Task 8: Live smoke — broker joins a real meeting (manual)

**Files:**
- Modify: `.superpowers/sdd/progress.md` (record smoke results)

No new code. This validates the real-SDK seams that unit tests deliberately faked. **Requires `ANTHROPIC_API_KEY` and `DEEPGRAM_API_KEY` pasted into `.env` (ask Edwin — do not proceed without them).** `ELEVENLABS_API_KEY` is already present; set `ELEVENLABS_VOICE_ID` to any voice from the ElevenLabs dashboard for audible output (without it, broker runs in text-only speech mode, which is still a valid smoke).

- [ ] **Step 1: Start the stack (three terminals or tmux panes)**

```bash
# 1 — LiveKit dev server
livekit-server --dev
# 2 — swarm API (from swarm/ so .smith/agents resolves)
cd swarm && npm run serve
# 3 — broker
cd broker && npm run serve
```

Expected: broker logs `[broker] running — polling swarm for open meetings.`

- [ ] **Step 2: Open a meeting and verify the broker joins**

```bash
curl -s -X POST http://127.0.0.1:7777/meetings -H 'content-type: application/json' -d '{"agent":"manuel"}' | jq
lk room participants list meeting-<meetingId-from-response> --url ws://127.0.0.1:7880 --api-key devkey --api-secret secret
```

Expected: participants include `smith-broker`.

- [ ] **Step 3: Drive a conversation through the stdin dev channel (no mic needed)**

In the broker terminal type:

```
what can the team do right now?
```

Expected: brain replies (speech-text lines or ElevenLabs audio published); reply mentions Manuel and idle status.

```
have manuel create a file named HELLO.md saying hi in the repo
```

Expected: broker logs a delegation; `curl -s http://127.0.0.1:7777/tasks | jq` shows the queued/active task; when it completes, the broker speaks a completion note (task:completed narration). If `SWARM_REPO` is unset, delegation fails at worktree prep — set `SWARM_REPO` in `.env` to this repo's path/URL and retry; record whichever behavior you observe.

- [ ] **Step 4: Verify STT path init (listening, no assertion on transcription quality)**

Confirm the broker connected to Deepgram without error at meeting join (no `Results`-handler exceptions, no 401 in logs). Full mic-in-room STT is exercised when the control-plane app joins (next plan) — record that this smoke covered: join, brain, delegation, TTS, events.

- [ ] **Step 5: Close the meeting; verify teardown**

```bash
curl -s -X DELETE http://127.0.0.1:7777/meetings/<meetingId> | jq
```

Expected: broker leaves the room (poll notices `closed`), `lk room participants list` no longer shows `smith-broker`, broker keeps polling without error.

- [ ] **Step 6: Record results + commit ledger update**

Append to `.superpowers/sdd/progress.md`: which steps passed, exact failures if any (these become fix tasks).

```bash
git add .superpowers/sdd/progress.md
git commit -m "test(broker): record live smoke results for the meeting loop"
```

---

## Verification (whole plan)

- `cd broker && npm test` — all unit tests green.
- `cd broker && npx tsc --noEmit` — clean.
- `cd swarm && npm run typecheck && npm test` — still green, **zero diffs in `swarm/`** (`git status` shows no swarm changes).
- Live smoke checklist (Task 8) executed and recorded.

## Execution notes for the controller

- Tasks 1→7 are strictly ordered (each consumes the previous task's interfaces). Task 8 needs Edwin's keys — if they're missing when you get there, stop and ask rather than skipping.
- The two external-API seams most likely to drift from this plan's assumptions are Deepgram event names and `@livekit/rtc-node` class names (both flagged with implementer notes + context7 pointers). Drift is contained to `stt.ts` factory wiring and `room.ts` respectively — the tests pin the broker-side contracts.
