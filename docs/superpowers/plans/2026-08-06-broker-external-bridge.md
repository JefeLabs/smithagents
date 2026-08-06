# Broker External Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude Code and GitHub Copilot, running locally, hand a PRD to the broker for delegation to an agent/squad and later check whether that delegation finished — via two new `broker/bin/*.mjs` CLI scripts plus two small, additive broker changes.

**Architecture:** The broker's text channel (`127.0.0.1:7790`) already accepts external input (`POST /utterance`, WS `/events`) — the bridge scripts are one more loopback client at that same trust tier, same as the Tauri app. Two additive broker changes close the round-trip gap: (1) a `task-dispatched` frame broadcast the instant `broker.ts`'s `delegate` tool handler binds a task, giving a caller a deterministic `taskId` instead of parsing LLM-authored prose; (2) a `GET /tasks/:taskId` passthrough to swarm's already-shipped status endpoint, giving a caller a stateless way to poll completion. No swarm changes; brain prompt untouched.

**Tech Stack:** TypeScript (broker/src, run via `tsx`, tested via Node's built-in `node:test` runner), plain Node ESM scripts (broker/bin, no build step, global `fetch` + the `ws` package already in broker's dependencies).

## Global Constraints

- Node >=24 (broker's `engines` field) — global `fetch` and top-level `await` are available with no polyfill.
- Broker tests run from `broker/`: `npm test` → `node --import tsx --test src/*.test.ts`. Typecheck: `npm run typecheck` → `tsc --noEmit`. Every task must leave both green.
- Follow `text-channel.ts`'s existing constructor style exactly: every new dependency is another **optional, positional** constructor parameter (never refactor the constructor to an options object — that's a larger, unrequested change to a file with 13 existing call sites in tests).
- Follow `broker.ts`'s existing DI-callback style exactly: new side effects are optional callbacks on `BrokerDeps` (`onTaskDispatched?`), fired from `broker.ts`, wired to real behavior only in `main.ts`. `broker.ts` itself never imports `text-channel.ts` or `swarm-client.ts`'s concrete types beyond the structural interfaces it already declares.
- All new broker HTTP surface is loopback-trusted like the rest of `text-channel.ts` (no new auth) — this is read/write on `127.0.0.1:7790` only, never exposed beyond localhost.
- No changes to `swarm/`. `GET /tasks/:taskId` already exists there and is reused as-is.
- Spec: `docs/superpowers/specs/2026-08-06-broker-external-bridge-design.md` — every task below implements one numbered section of it.

---

## File Structure

| File | Responsibility |
|---|---|
| `broker/src/broker.ts` | **Modify.** `BrokerDeps.onTaskDispatched` + fire it from the `delegate` executor. |
| `broker/src/broker.test.ts` | **Modify.** Test the new callback fires with the right payload. |
| `broker/src/text-channel.ts` | **Modify.** New `task-dispatched` `ChannelFrame` variant; new `tasks?` constructor param + `GET /tasks/:taskId` route. |
| `broker/src/text-channel.test.ts` | **Modify.** Test the broadcast shape and the new route's 200/404 paths. |
| `broker/src/swarm-client.ts` | **Modify.** New `SwarmClient.getTask(taskId)`, 404-aware (unlike the shared `http()` helper). |
| `broker/src/swarm-client.test.ts` | **Modify.** Test `getTask`'s 200/404/500 paths. |
| `broker/src/main.ts` | **Modify.** Wire `onTaskDispatched` → `textChannel.broadcast`; build the `tasks` shim and pass it into `new TextChannel(...)`. |
| `broker/src/smith-broker-bin.test.ts` | **Create.** Integration tests for both bin scripts, spawned as child processes against a real in-process `TextChannel`. |
| `broker/bin/smith-broker-send.mjs` | **Create.** Posts a tagged delegation instruction, waits for the `task-dispatched` frame (or times out with the brain's reply). |
| `broker/bin/smith-broker-check.mjs` | **Create.** Polls `GET /tasks/:taskId`, prints status/PR url. |

---

### Task 1: `onTaskDispatched` callback in the broker

**Files:**
- Modify: `broker/src/broker.ts:87-92` (BrokerDeps interface), `broker/src/broker.ts:167-187` (delegate executor)
- Test: `broker/src/broker.test.ts:89-112` (makeBroker helper), append new test after line 497

**Interfaces:**
- Produces: `BrokerDeps.onTaskDispatched?: (d: { taskId: string; agent: string; task: string }) => void` — fired synchronously inside the `delegate` tool executor, immediately after `directory.bindTask`, before `notifyRoster()`.

- [ ] **Step 1: Write the failing test**

In `broker/src/broker.test.ts`, extend `makeBroker`'s opts type and pass-through:

```ts
function makeBroker(
  f: ReturnType<typeof makeFakes>,
  opts?: {
    onSpeechText?: (text: string) => void;
    onRosterChange?: (roster: { agents: Array<{ status: string }>; squads: unknown[] }) => void;
    onTaskDispatched?: (d: { taskId: string; agent: string; task: string }) => void;
  },
) {
  const directory = new AgentDirectory();
  return new Broker({
    onRosterChange: opts?.onRosterChange,
    onTaskDispatched: opts?.onTaskDispatched,
    swarm: f.swarm,
    directory,
    brain: f.brain,
    makeStt: () => f.stt,
    makeBridge: () => f.bridge,
    onSpeechText: opts?.onSpeechText,
    speak: async function* (text) {
      yield new Uint8Array(Buffer.from(`AUDIO(${text})`));
    },
    mintToken: async (room) => `jwt-for-${room}`,
    livekitUrl: 'ws://test',
    pollMs: 999999,
  });
}
```

Append this test after `'roster notifications fire on seed and on delegation, carrying agents and squads'` (after line 497):

```ts
test('delegate fires onTaskDispatched with the taskId, agent name, and task text', async () => {
  const f = makeFakes([MEETING]);
  const dispatched: Array<{ taskId: string; agent: string; task: string }> = [];
  const b = makeBroker(f, { onTaskDispatched: (d) => dispatched.push(d) });
  await b.start();
  await b.pollOnce();
  await b.executors.delegate({ agent: 'Manuel', task: 'build the thing' });
  assert.deepEqual(dispatched, [{ taskId: 't-77', agent: 'Manuel', task: 'build the thing' }]);
  await b.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && npx tsx --test src/broker.test.ts`
Expected: FAIL on `delegate fires onTaskDispatched...` — `assert.deepEqual(dispatched, [...])` sees `dispatched` still `[]` (the callback is never invoked yet).

- [ ] **Step 3: Write minimal implementation**

In `broker/src/broker.ts`, add to the `BrokerDeps` interface, right after `onRosterChange` (after line 90, before the `memory?` doc-comment):

```ts
  /** Fired the moment a delegated task is bound in the directory — before any narration. Lets an external bridge (e.g. Copilot/Claude, see broker/bin) correlate its own utterance to the resulting taskId. */
  onTaskDispatched?: (d: { taskId: string; agent: string; task: string }) => void;
```

In the `delegate` executor, add one line right after `directory.bindTask(...)` and before `notifyRoster()`:

```ts
      this.deps.directory.bindTask(agent.id, {
        taskId,
        summary: input.task.slice(0, 80),
        swarmName: agentName ?? undefined,
      });
      this.deps.onTaskDispatched?.({ taskId, agent: agent.name, task: input.task });
      this.notifyRoster();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && npx tsx --test src/broker.test.ts`
Expected: PASS, all tests in the file green (confirms no regression in the other `delegate`/roster tests).

- [ ] **Step 5: Commit**

```bash
git add broker/src/broker.ts broker/src/broker.test.ts
git commit -m "feat(broker): onTaskDispatched callback fires on delegate, carrying taskId/agent/task"
```

---

### Task 2: `task-dispatched` frame + main.ts wiring

**Files:**
- Modify: `broker/src/text-channel.ts` (`ChannelFrame` union, near line 31-42)
- Modify: `broker/src/main.ts:918-920` (Broker instantiation)
- Test: `broker/src/text-channel.test.ts` (append new test)

**Interfaces:**
- Consumes: `BrokerDeps.onTaskDispatched` from Task 1.
- Produces: `ChannelFrame` variant `{ type: 'task-dispatched'; taskId: string; agent: string; task: string }`, broadcast over WS `/events` — this is what `smith-broker-send.mjs` (Task 5) listens for.

- [ ] **Step 1: Write the failing test**

In `broker/src/text-channel.test.ts`, append after `'broadcast fans speech frames out to connected clients'`:

```ts
test('broadcast fans a task-dispatched frame out to connected clients', async () => {
  const channel = new TextChannel(() => {});
  const port = await channel.start(0);
  try {
    const ws = await connect(port);
    const frame = nextFrame(ws);
    channel.broadcast({ type: 'task-dispatched', taskId: 't-1', agent: 'Manuel', task: 'build the thing' });
    assert.deepEqual(await frame, { type: 'task-dispatched', taskId: 't-1', agent: 'Manuel', task: 'build the thing' });
    ws.close();
  } finally {
    await channel.stop();
  }
});
```

- [ ] **Step 2: Run typecheck and the test to verify it fails**

Run: `cd broker && npm run typecheck`
Expected: FAIL — `Object literal may only specify known properties, and '"task-dispatched"' does not exist in type 'ChannelFrame'.` (This is a type-only addition: the union doesn't exist yet, so the compiler catches it before the runtime test would ever get a chance to fail on its own logic.)

- [ ] **Step 3: Write minimal implementation**

In `broker/src/text-channel.ts`, extend the `ChannelFrame` union (find the existing union starting `export type ChannelFrame =`), adding a new member after the `session` variant:

```ts
export type ChannelFrame =
  | { type: 'utterance' | 'speech'; text: string }
  | { type: 'roster'; agents: RosterEntry[] }
  /** Hello-frame capabilities: audio=true means the broker streams TTS audio frames. */
  | { type: 'config'; audio: boolean }
  /** One synthesized speech chunk (mp3), base64-encoded for the JSON channel. */
  | { type: 'audio'; speaker?: string; mime: string; dataB64: string }
  /** Active session changed (or hello): full transcript replay + the session list + workspaces. */
  | {
      type: 'session';
      session: { id: string; title: string; workspace: string };
      sessions: Array<{ id: string; title: string; workspace: string; updatedAt: string; active: boolean }>;
      transcript: Array<{ role: 'user' | 'broker'; text: string }>;
      workspaces: string[];
    }
  /** A delegated task was just bound to an agent — the deterministic handle an external bridge (broker/bin) correlates against, since the brain's own spoken confirmation is free-form prose. */
  | { type: 'task-dispatched'; taskId: string; agent: string; task: string };
```

In `broker/src/main.ts`, add one line to the `new Broker({...})` deps object, right after `onRosterChange` (line 920):

```ts
    onRosterChange: (roster) => textChannel.broadcast({ type: 'roster', agents: toRosterEntries(roster) }),
    onTaskDispatched: (d) => textChannel.broadcast({ type: 'task-dispatched', taskId: d.taskId, agent: d.agent, task: d.task }),
```

- [ ] **Step 4: Run typecheck and tests to verify they pass**

Run: `cd broker && npm run typecheck && npm test`
Expected: PASS — typecheck clean, full test suite green (including the new frame test and Task 1's callback test).

- [ ] **Step 5: Commit**

```bash
git add broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts
git commit -m "feat(broker): broadcast task-dispatched frame when a delegation is bound"
```

---

### Task 3: `SwarmClient.getTask`

**Files:**
- Modify: `broker/src/swarm-client.ts` (add method after `killTask`, ~line 158)
- Test: `broker/src/swarm-client.test.ts` (append new tests)

**Interfaces:**
- Produces: `SwarmClient.getTask(taskId: string): Promise<{ taskId: string; status: string; result?: unknown } | null>` — `null` on 404 (task not found), throws on any other non-2xx or network failure. This is what `main.ts`'s `tasks` shim (Task 4) calls.

- [ ] **Step 1: Write the failing test**

Append to `broker/src/swarm-client.test.ts`:

```ts
test('getTask hits GET /tasks/:taskId and returns the parsed record', async () => {
  const calls: string[] = [];
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url).replace('http://s', '')}`);
      return new Response(JSON.stringify({ taskId: 't-1', status: 'completed', result: { pullRequestUrl: 'https://github.com/x/y/pull/1' } }));
    }) as typeof fetch,
  });
  const task = await client.getTask('t-1');
  assert.deepEqual(calls, ['GET /tasks/t-1']);
  assert.deepEqual(task, { taskId: 't-1', status: 'completed', result: { pullRequestUrl: 'https://github.com/x/y/pull/1' } });
});

test('getTask returns null on 404 (unknown task) instead of throwing', async () => {
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async () => new Response(JSON.stringify({ error: 'Task t-9 not found' }), { status: 404 })) as typeof fetch,
  });
  assert.equal(await client.getTask('t-9'), null);
});

test('getTask throws on a genuine 500, unlike the 404 case', async () => {
  const client = new SwarmClient({
    baseUrl: 'http://s',
    fetchImpl: (async () => new Response(JSON.stringify({ error: 'swarm on fire' }), { status: 500 })) as typeof fetch,
  });
  await assert.rejects(client.getTask('t-1'), /swarm on fire/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && npx tsx --test src/swarm-client.test.ts`
Expected: FAIL with `client.getTask is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `broker/src/swarm-client.ts`, add right after `killTask` (after the method ending `~line 158`):

```ts
  /**
   * Task status passthrough for the external bridge (Copilot/Claude, see
   * broker/bin/smith-broker-check.mjs) — unlike every other method here,
   * this one must tell a genuine "task not found" (404) apart from a real
   * failure (network, 5xx), so it can't reuse the shared `http()` helper,
   * which flattens every non-2xx into a single thrown Error with no status
   * code attached.
   */
  async getTask(taskId: string): Promise<{ taskId: string; status: string; result?: unknown } | null> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}`, { method: 'GET', headers });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = await res
        .json()
        .then((b) => (b as { error?: string }).error)
        .catch(() => undefined);
      throw new Error(detail ?? `swarm GET /tasks/${taskId} -> ${res.status}`);
    }
    return (await res.json()) as { taskId: string; status: string; result?: unknown };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && npx tsx --test src/swarm-client.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add broker/src/swarm-client.ts broker/src/swarm-client.test.ts
git commit -m "feat(broker): SwarmClient.getTask, 404-aware unlike the shared http() helper"
```

---

### Task 4: `GET /tasks/:taskId` passthrough route

**Files:**
- Modify: `broker/src/text-channel.ts` (constructor param + route, ~lines 88-170 and ~line 241)
- Modify: `broker/src/main.ts` (`tasks` shim + wire into `new TextChannel(...)`, ~lines 519-836)
- Test: `broker/src/text-channel.test.ts` (`channelWith` helper + new test)

**Interfaces:**
- Consumes: `SwarmClient.getTask` from Task 3 (via the `tasks` shim in `main.ts`).
- Produces: `GET /tasks/:taskId` on the broker's text channel — `200 {taskId, status, result?}` or `404 {error}`. This is what `smith-broker-check.mjs` (Task 6) calls.

- [ ] **Step 1: Write the failing test**

In `broker/src/text-channel.test.ts`, extend `channelWith`'s opts type and positional pass-through (the 15th constructor arg):

```ts
function channelWith(opts: {
  removal?: ConstructorParameters<typeof TextChannel>[8];
  workspaces?: ConstructorParameters<typeof TextChannel>[9];
  creation?: ConstructorParameters<typeof TextChannel>[7];
  surfaces?: ConstructorParameters<typeof TextChannel>[10];
  me?: ConstructorParameters<typeof TextChannel>[11];
  channels?: ConstructorParameters<typeof TextChannel>[12];
  connectors?: ConstructorParameters<typeof TextChannel>[13];
  tasks?: ConstructorParameters<typeof TextChannel>[14];
}): TextChannel {
  return new TextChannel(
    () => {},
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.creation ?? stubCreation,
    opts.removal,
    opts.workspaces,
    opts.surfaces,
    opts.me,
    opts.channels,
    opts.connectors,
    opts.tasks,
  );
}
```

Append this test after the `GET /agents/:id/removal` test:

```ts
test('GET /tasks/:taskId returns the status; an unknown task 404s', async () => {
  const channel = channelWith({
    tasks: {
      get: async (taskId) =>
        taskId === 't-77'
          ? { taskId: 't-77', status: 'completed', result: { pullRequestUrl: 'https://github.com/x/y/pull/1' } }
          : null,
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tasks/t-77`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { taskId: 't-77', status: 'completed', result: { pullRequestUrl: 'https://github.com/x/y/pull/1' } });

    const missing = await fetch(`http://127.0.0.1:${port}/tasks/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'task nope not found' });
  } finally {
    await channel.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && npx tsx --test src/text-channel.test.ts`
Expected: FAIL — `fetch` to `/tasks/t-77` gets no matching route (falls through to a 404 with no body, or whatever the file's catch-all does), not the `200` this test expects. (Also a `tsc --noEmit` type error on the extra `tasks` positional argument until Step 3 lands.)

- [ ] **Step 3: Write minimal implementation**

In `broker/src/text-channel.ts`, add the new constructor param right after `connectors` (the last one), keeping the doc-comment style:

```ts
    /** Connector registry (Integrations settings group): vendor metadata, CRUD, and verify. Origin-restricted like /me and channels. */
    private readonly connectors?: {
      vendors(): Promise<Record<string, unknown>[]>;
      list(): Promise<Record<string, unknown>[]>;
      add(body: Record<string, unknown>): Promise<Record<string, unknown>>;
      update(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
      remove(id: string): Promise<Record<string, unknown>>;
      verify(id: string, extra?: Record<string, string>): Promise<Record<string, unknown>>;
    },
    /** Task status passthrough for the external bridge (Copilot/Claude, see broker/bin). Read-only, loopback-trusted like the rest of this file. */
    private readonly tasks?: {
      get(taskId: string): Promise<Record<string, unknown> | null>;
    },
  ) {}
```

Add the route right after the `/reset` block's closing `return; }` (after line 241, before `if (this.creation) {`):

```ts
      if (req.method === 'GET' && this.tasks) {
        const m = /^\/tasks\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname);
        if (m) {
          const taskId = decodeURIComponent(m[1]!);
          void this.tasks.get(taskId).then(
            (t) =>
              t
                ? res.writeHead(200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(t))
                : res.writeHead(404, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: `task ${taskId} not found` })),
            (err: unknown) =>
              res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message ?? err) })),
          );
          return;
        }
      }
```

In `broker/src/main.ts`, add the `tasks` shim right after the `connectors` const block (after line 535, before `const textChannel = new TextChannel(`):

```ts
// Task status passthrough for the external bridge (broker/bin/smith-broker-check.mjs).
const tasks = {
  get: (taskId: string) => swarm.getTask(taskId) as unknown as Promise<Record<string, unknown> | null>,
};
```

And add `tasks,` as the new last positional argument in the `new TextChannel(...)` call (after `connectors,` at line 835, before the closing `);` at line 836):

```ts
  me,
  channels,
  connectors,
  tasks,
);
```

- [ ] **Step 4: Run typecheck and tests to verify they pass**

Run: `cd broker && npm run typecheck && npm test`
Expected: PASS — typecheck clean, full suite green.

- [ ] **Step 5: Commit**

```bash
git add broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts
git commit -m "feat(broker): GET /tasks/:taskId passthrough for the external bridge"
```

---

### Task 5: `smith-broker-send.mjs`

**Files:**
- Create: `broker/bin/smith-broker-send.mjs`
- Test: `broker/src/smith-broker-bin.test.ts` (create — send tests only for now; Task 6 appends the check tests)

**Interfaces:**
- Consumes: `POST /utterance`, WS `/events` and the `task-dispatched` frame from Task 2, all on `SMITH_BROKER_URL` (default `http://127.0.0.1:7790`).
- Produces: stdout `{"taskId": string, "agent": string, "task": string}` + exit 0 on successful dispatch; stderr the brain's last spoken/utterance line + exit 1 on timeout with no dispatch; exit 2 on bad usage.

- [ ] **Step 1: Write the failing test**

Create `broker/src/smith-broker-bin.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TextChannel } from './text-channel.ts';

const execFileAsync = promisify(execFile);
const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');

/** promisify(execFile) rejects with this shape; typed once so the strict-mode
 * `assert.rejects` validators below can read code/stderr without casts inline. */
type ExecFailure = { code?: number; stdout?: string; stderr?: string };

test('smith-broker-send posts the tagged utterance and prints the task-dispatched handle', async () => {
  const channel = new TextChannel((text) => {
    // Stand in for the brain: any utterance immediately "dispatches" a task.
    channel.broadcast({ type: 'task-dispatched', taskId: 't-1', agent: 'Manuel', task: text });
  });
  const port = await channel.start(0);
  try {
    const { stdout } = await execFileAsync('node', [join(BIN_DIR, 'smith-broker-send.mjs'), 'docs/prd.md', 'ship it'], {
      env: { ...process.env, SMITH_BROKER_URL: `http://127.0.0.1:${port}`, SMITH_BRIDGE_SOURCE: 'claude-code' },
    });
    const handle = JSON.parse(stdout);
    assert.equal(handle.taskId, 't-1');
    assert.equal(handle.agent, 'Manuel');
    assert.match(handle.task, /docs\/prd\.md/);
    assert.match(handle.task, /ship it/);
    assert.match(handle.task, /via claude-code/);
  } finally {
    await channel.stop();
  }
});

test('smith-broker-send times out with the brain\'s reply and exits non-zero when nothing was dispatched', async () => {
  const channel = new TextChannel(() => {
    channel.broadcast({ type: 'utterance', text: 'Manuel: which repo is this for?' });
  });
  const port = await channel.start(0);
  try {
    await assert.rejects(
      execFileAsync('node', [join(BIN_DIR, 'smith-broker-send.mjs'), 'docs/prd.md'], {
        env: { ...process.env, SMITH_BROKER_URL: `http://127.0.0.1:${port}`, SMITH_BROKER_SEND_TIMEOUT_MS: '300' },
      }),
      (err: unknown) => {
        const e = err as ExecFailure;
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /which repo is this for/);
        return true;
      },
    );
  } finally {
    await channel.stop();
  }
});

test('smith-broker-send exits 2 with no prd-path argument', async () => {
  await assert.rejects(execFileAsync('node', [join(BIN_DIR, 'smith-broker-send.mjs')]), (err: unknown) => {
    assert.equal((err as ExecFailure).code, 2);
    return true;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && npx tsx --test src/smith-broker-bin.test.ts`
Expected: FAIL — `ENOENT` (`smith-broker-send.mjs` doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `broker/bin/smith-broker-send.mjs`:

```js
#!/usr/bin/env node
// smith-broker-send — hand a PRD to the broker for delegation, from an
// external tool (Claude Code, Copilot) running on the same machine as the
// broker. The PRD is sent as a file-path reference, never inlined — the
// delegated agent reads it itself once it has repo access in its worktree.
//
// Usage: smith-broker-send <prd-path> [instruction...]
// Env:   SMITH_BROKER_URL (default http://127.0.0.1:7790)
//        SMITH_BRIDGE_SOURCE (default "bridge") — tags the transcript with
//          the calling tool's identity, e.g. "claude-code" or "copilot".
//        SMITH_BROKER_SEND_TIMEOUT_MS (default 45000)
//
// On success: prints {"taskId","agent","task"} to stdout, exits 0. Pass
// taskId to smith-broker-check to poll for completion.
// On timeout with no delegation: prints the brain's last reply to stderr,
// exits 1 — the brain didn't delegate (declined, or asked a question).
import { WebSocket } from 'ws';

const BROKER_URL = (process.env.SMITH_BROKER_URL ?? 'http://127.0.0.1:7790').replace(/\/$/, '');
const BROKER_WS = `${BROKER_URL.replace(/^http/, 'ws')}/events`;
const SOURCE = process.env.SMITH_BRIDGE_SOURCE ?? 'bridge';
const TIMEOUT_MS = Number(process.env.SMITH_BROKER_SEND_TIMEOUT_MS ?? 45000);

const [prdPath, ...rest] = process.argv.slice(2);
if (!prdPath) {
  console.error('usage: smith-broker-send <prd-path> [instruction...]');
  process.exit(2);
}
const instruction = rest.join(' ');
const text = `Edwin (via ${SOURCE}): delegate ${prdPath}${instruction ? ` — ${instruction}` : ''}`;

const ws = new WebSocket(BROKER_WS);

const result = await new Promise((resolve, reject) => {
  let lastSpeech = null;
  const timer = setTimeout(() => resolve({ dispatched: null, reply: lastSpeech }), TIMEOUT_MS);

  ws.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });

  ws.on('message', (data) => {
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (frame.type === 'task-dispatched') {
      clearTimeout(timer);
      resolve({ dispatched: frame, reply: null });
    } else if (frame.type === 'utterance' || frame.type === 'speech') {
      lastSpeech = frame.text;
    }
  });

  ws.on('open', () => {
    fetch(`${BROKER_URL}/utterance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
});

ws.close();

if (result.dispatched) {
  console.log(JSON.stringify({ taskId: result.dispatched.taskId, agent: result.dispatched.agent, task: result.dispatched.task }));
  process.exit(0);
} else {
  console.error(result.reply ?? '(no reply from the broker within the timeout — is it running?)');
  process.exit(1);
}
```

Make it executable:

```bash
chmod +x broker/bin/smith-broker-send.mjs
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && npx tsx --test src/smith-broker-bin.test.ts`
Expected: PASS, all three tests green.

- [ ] **Step 5: Commit**

```bash
git add broker/bin/smith-broker-send.mjs broker/src/smith-broker-bin.test.ts
git commit -m "feat(broker): smith-broker-send — external bridge PRD delegation"
```

---

### Task 6: `smith-broker-check.mjs`

**Files:**
- Create: `broker/bin/smith-broker-check.mjs`
- Test: `broker/src/smith-broker-bin.test.ts` (append)

**Interfaces:**
- Consumes: `GET /tasks/:taskId` from Task 4, on `SMITH_BROKER_URL`.
- Produces: stdout `{"status": string, "prUrl": string | undefined, "raw": object}` + exit 0 for a known task (any status, including `'failed'`); stderr an error message + exit 1 for an unknown taskId or a broker/network failure; exit 2 on bad usage.

- [ ] **Step 1: Write the failing test**

Append to `broker/src/smith-broker-bin.test.ts` (add this helper near the top, after the existing imports, then the two tests below):

```ts
// Constructs a TextChannel with only the `tasks` handler wired in — mirrors
// text-channel.test.ts's channelWith helper, kept local since this file
// doesn't need any of the other 13 optional constructor slots.
function channelWithTasks(get: (taskId: string) => Promise<Record<string, unknown> | null>) {
  return new TextChannel(
    () => {},
    () => [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { get },
  );
}

test('smith-broker-check prints status and prUrl for a completed task, exits 0', async () => {
  const channel = channelWithTasks(async (taskId) =>
    taskId === 't-1' ? { taskId: 't-1', status: 'completed', result: { pullRequestUrl: 'https://github.com/x/y/pull/1' } } : null,
  );
  const port = await channel.start(0);
  try {
    const { stdout } = await execFileAsync('node', [join(BIN_DIR, 'smith-broker-check.mjs'), 't-1'], {
      env: { ...process.env, SMITH_BROKER_URL: `http://127.0.0.1:${port}` },
    });
    assert.deepEqual(JSON.parse(stdout), {
      status: 'completed',
      prUrl: 'https://github.com/x/y/pull/1',
      raw: { taskId: 't-1', status: 'completed', result: { pullRequestUrl: 'https://github.com/x/y/pull/1' } },
    });
  } finally {
    await channel.stop();
  }
});

test('smith-broker-check exits non-zero on an unknown taskId', async () => {
  const channel = channelWithTasks(async () => null);
  const port = await channel.start(0);
  try {
    await assert.rejects(
      execFileAsync('node', [join(BIN_DIR, 'smith-broker-check.mjs'), 'nope'], {
        env: { ...process.env, SMITH_BROKER_URL: `http://127.0.0.1:${port}` },
      }),
      (err: unknown) => {
        assert.equal((err as ExecFailure).code, 1);
        return true;
      },
    );
  } finally {
    await channel.stop();
  }
});

test('smith-broker-check exits 2 with no taskId argument', async () => {
  await assert.rejects(execFileAsync('node', [join(BIN_DIR, 'smith-broker-check.mjs')]), (err: unknown) => {
    assert.equal((err as ExecFailure).code, 2);
    return true;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd broker && npx tsx --test src/smith-broker-bin.test.ts`
Expected: FAIL — `ENOENT` (`smith-broker-check.mjs` doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `broker/bin/smith-broker-check.mjs`:

```js
#!/usr/bin/env node
// smith-broker-check — poll a delegation's status via the broker, using the
// taskId printed by smith-broker-send.
//
// Usage: smith-broker-check <taskId>
// Env:   SMITH_BROKER_URL (default http://127.0.0.1:7790)
//
// Prints {"status","prUrl","raw"} to stdout and exits 0 for any known task
// (including status:"failed" — that's a real answer, not an error). Exits 1
// on an unknown taskId or a broker/network failure; 2 on bad usage.
const BROKER_URL = (process.env.SMITH_BROKER_URL ?? 'http://127.0.0.1:7790').replace(/\/$/, '');

const [taskId] = process.argv.slice(2);
if (!taskId) {
  console.error('usage: smith-broker-check <taskId>');
  process.exit(2);
}

let res;
try {
  res = await fetch(`${BROKER_URL}/tasks/${encodeURIComponent(taskId)}`);
} catch (err) {
  console.error(`could not reach the broker at ${BROKER_URL}: ${err.message}`);
  process.exit(1);
}

const body = await res.json().catch(() => ({}));

if (!res.ok) {
  console.error(body.error ?? `broker GET /tasks/${taskId} -> ${res.status}`);
  process.exit(1);
}

const result = body.result ?? {};
console.log(JSON.stringify({ status: body.status, prUrl: result.pullRequestUrl, raw: body }));
process.exit(0);
```

Make it executable:

```bash
chmod +x broker/bin/smith-broker-check.mjs
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd broker && npx tsx --test src/smith-broker-bin.test.ts`
Expected: PASS, all six tests in the file green.

- [ ] **Step 5: Run the full broker suite and typecheck one last time**

Run: `cd broker && npm run typecheck && npm test`
Expected: PASS — every file green, no type errors, confirming Tasks 1-6 compose cleanly.

- [ ] **Step 6: Commit**

```bash
git add broker/bin/smith-broker-check.mjs broker/src/smith-broker-bin.test.ts
git commit -m "feat(broker): smith-broker-check — external bridge task status poll"
```

---

## Self-Review

**Spec coverage:** §1 (broker-side additions a/b/c) → Tasks 1, 2, 3, 4. §2 (bridge scripts, send/check behavior, timeout, PRD-as-file-path, no MCP for v1) → Tasks 5, 6. §3 (correlation soft spot — first-frame-wins, no threaded token) → implemented as designed in Task 5's `ws.on('message')` handler (resolves on the *first* `task-dispatched` frame). §4 (error handling — bad PRD path, broker down, brain declines, meeting etiquette) → bad path and brain-declines covered by Task 5's timeout branch and Task 6's 404/error branches; broker-down covered by both scripts' `ws.on('error')`/`catch` paths; meeting etiquette needed no code (ordinary chat text, confirmed in the design — no task required). §5 (testing) → each task's own Step 1/2/4, plus Task 6 Step 5 for the full-suite pass.

**Placeholder scan:** No TBD/TODO; every step has literal code, not a description of code.

**Type consistency:** `onTaskDispatched`'s payload shape `{ taskId: string; agent: string; task: string }` is identical across `broker.ts` (BrokerDeps + call site), `broker.test.ts` (assertion), `text-channel.ts` (ChannelFrame variant), and `main.ts` (wiring) — checked word-for-word. `SwarmClient.getTask`'s return type `{ taskId: string; status: string; result?: unknown } | null` matches the `tasks.get` shim's cast in `main.ts` and the `tasks?` constructor param's type in `text-channel.ts`. The bin scripts consume the wire JSON (parsed via `JSON.parse`/`res.json()`), not the TS types directly, so there's no cross-language type to drift — their tests assert against the literal frame/response shapes each earlier task produces.

**Scope check:** One subsystem (the bridge + its two enabling broker changes), six tightly-ordered tasks, each independently testable and committable. Right-sized for one plan.

---

**Plan complete and saved to `docs/superpowers/plans/2026-08-06-broker-external-bridge.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
