# Talk-to-Agents v1 — Plan 1: Swarm Meeting Backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the swarm a composed-agent registry and a meeting orchestrator that opens a self-hosted LiveKit room, seats a chosen agent as a real-time voice participant (STT → its model → MLX TTS), and closes it — drivable end-to-end before any UI exists.

**Architecture:** New swarm modules — `agents.ts` (registry over `.smith/agents/*.json`), `meetings.ts` (orchestrator using `livekit-server-sdk` to create rooms + mint tokens), meeting routes on the existing Fastify server, and a `@livekit/agents` worker process that joins a room and runs the STT/LLM/TTS pipeline with the agent's directives. LiveKit runs locally via docker-compose. TTS starts on a LiveKit inference model to prove the loop, then swaps to a custom plugin wrapping the `voice/` VoiceProvider → MLX voice-engine.

**Tech Stack:** Node 24 + TypeScript (NodeNext, ES2024), `tsx`, Fastify (existing), `livekit-server-sdk`, `@livekit/agents` (+ a plugin/inference model set), self-hosted `livekit/livekit-server` (docker), `node:test` for unit tests.

**Spec:** `docs/superpowers/specs/2026-07-25-talk-to-agents-livekit-meetings-design.md`. This plan covers the spec's v1 items 1–4 (registry, meeting orchestrator, LiveKit, agent participant). Plan 2 covers items 5–6 (Tauri app + wake-command gate).

## Global Constraints

- All swarm commands run in `swarm/` (package `@smithagents/swarm`).
- Module system NodeNext: every relative import ends in `.js` (even from `.ts` sources).
- No client-supplied identifiers into shell/paths (established in `server.ts`): meeting ids are server-generated `randomUUID()`.
- LiveKit API key/secret and URL come from env (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`), never committed. Dev defaults live in a git-ignored `.env`.
- Registry files live in `swarm/.smith/agents/*.json`; the `.smith/` dir is git-ignored except the seed agents (force-added).
- Unit tests use `node:test` run via `tsx`; add `"test": "node --import tsx --test src/**/*.test.ts"` to `swarm/package.json`. Integration steps that need LiveKit are manual smoke tests with the docker server running.
- Commit after every task, trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verify no regressions each task: `npm run typecheck` (swarm) stays green.

---

### Task 1: Composed-agent registry

**Files:**
- Create: `swarm/src/agents.ts`
- Create: `swarm/src/agents.test.ts`
- Create: `swarm/.smith/agents/manuel.json`, `octavio.json`, `aurelio.json`
- Modify: `swarm/package.json` (add `test` script)
- Modify: `swarm/src/index.ts` (export the registry API)
- Modify: root `.gitignore` (allow the seed agent files past a `.smith/` ignore)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface AgentEngine { cli: 'agy' | 'claude' | 'codex'; model: string }`
  - `interface AgentVoice { provider: string; voiceId?: string }`
  - `interface ComposedAgent { id: string; name: string; role: string; directives: string; engine: AgentEngine; voice?: AgentVoice; avatarRing?: string; channels?: string[] }`
  - `loadAgents(dir: string): Promise<ComposedAgent[]>` — reads every `*.json` in `dir`, validates required fields, throws on a malformed file naming the file.
  - `findAgent(agents: ComposedAgent[], nameOrId: string): ComposedAgent | undefined` — case-insensitive match on `id` then `name`.

- [ ] **Step 1: Add the test script** to `swarm/package.json` scripts:

```json
"test": "node --import tsx --test src/**/*.test.ts",
```

- [ ] **Step 2: Write the failing test** `swarm/src/agents.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgents, findAgent } from './agents.js';

async function seedDir(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agents-'));
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(body));
  }
  return dir;
}

test('loadAgents parses valid agent files', async () => {
  const dir = await seedDir({
    'manuel.json': {
      id: 'manuel', name: 'Manuel', role: 'Architect',
      directives: 'Own multi-tenant routing.',
      engine: { cli: 'claude', model: 'claude-opus' },
    },
  });
  const agents = await loadAgents(dir);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'Manuel');
  assert.equal(agents[0].engine.model, 'claude-opus');
});

test('loadAgents throws on a malformed file, naming it', async () => {
  const dir = await seedDir({ 'broken.json': { name: 'x' } }); // missing id/role/directives/engine
  await assert.rejects(() => loadAgents(dir), /broken\.json/);
});

test('findAgent matches id or name case-insensitively', async () => {
  const dir = await seedDir({
    'a.json': { id: 'manuel', name: 'Manuel', role: 'Architect', directives: 'x', engine: { cli: 'claude', model: 'm' } },
  });
  const agents = await loadAgents(dir);
  assert.equal(findAgent(agents, 'MANUEL')?.id, 'manuel');
  assert.equal(findAgent(agents, 'manuel')?.id, 'manuel');
  assert.equal(findAgent(agents, 'nobody'), undefined);
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `cd swarm && npm test`
Expected: FAIL — `Cannot find module './agents.js'`.

- [ ] **Step 4: Implement `swarm/src/agents.ts`**

```ts
// Composed-agent registry — the swarm owns agent identity as data.
// One JSON file per agent under .smith/agents/. Replaces the old anonymous
// name pool + hardcoded squad rosters (see the v1 design spec).
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AgentEngine {
  cli: 'agy' | 'claude' | 'codex';
  model: string;
}

export interface AgentVoice {
  provider: string;
  voiceId?: string;
}

export interface ComposedAgent {
  id: string;
  name: string;
  role: string;
  directives: string;
  engine: AgentEngine;
  voice?: AgentVoice;
  avatarRing?: string;
  channels?: string[];
}

function assertAgent(file: string, v: unknown): ComposedAgent {
  const o = v as Record<string, unknown>;
  const engine = o.engine as Record<string, unknown> | undefined;
  const ok =
    o &&
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    typeof o.role === 'string' &&
    typeof o.directives === 'string' &&
    engine &&
    typeof engine.cli === 'string' &&
    typeof engine.model === 'string';
  if (!ok) {
    throw new Error(`Invalid composed-agent file ${file}: requires id, name, role, directives, engine{cli,model}`);
  }
  return o as unknown as ComposedAgent;
}

/** Load every *.json in `dir` as a ComposedAgent. Throws (naming the file) on malformed input. */
export async function loadAgents(dir: string): Promise<ComposedAgent[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith('.json'));
  const agents: ComposedAgent[] = [];
  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON in composed-agent file ${file}: ${(e as Error).message}`);
    }
    agents.push(assertAgent(file, parsed));
  }
  return agents;
}

/** Resolve an agent by id (preferred) or name, case-insensitive. */
export function findAgent(agents: ComposedAgent[], nameOrId: string): ComposedAgent | undefined {
  const q = nameOrId.trim().toLowerCase();
  return agents.find((a) => a.id.toLowerCase() === q) ?? agents.find((a) => a.name.toLowerCase() === q);
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd swarm && npm test`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the three seed agents.** `swarm/.smith/agents/manuel.json` (directives condensed from the removed `personas/prompts/manuel.md`, recoverable at `git show ae691c7~1:personas/src/main/resources/prompts/manuel.md`):

```json
{
  "id": "manuel",
  "name": "Manuel",
  "role": "The Architect",
  "directives": "You command overarching multi-tenant routing and infrastructure. Evaluate the blast radius of any change across tenant boundaries. Own templates and pages — the structural composition layers where routing and tenancy manifest. Voice: warm, human, conversational.",
  "engine": { "cli": "claude", "model": "claude-opus" },
  "voice": { "provider": "local" },
  "avatarRing": "#6f8dff",
  "channels": ["tauri"]
}
```

`swarm/.smith/agents/octavio.json`:

```json
{
  "id": "octavio",
  "name": "Octavio",
  "role": "Security / Integration Auditor",
  "directives": "You are the guardian of API integration boundaries and page-level compositions. Audit integration surfaces where data crosses a trust boundary; own organisms and pages. Voice: coldly analytical, clipped.",
  "engine": { "cli": "claude", "model": "claude-sonnet" },
  "voice": { "provider": "local" },
  "avatarRing": "#e0a15a",
  "channels": ["tauri"]
}
```

`swarm/.smith/agents/aurelio.json`:

```json
{
  "id": "aurelio",
  "name": "Aurelio",
  "role": "UI Purist",
  "directives": "You are the absolute enforcer of atomic design patterns. Own atoms and molecules; guard visual isolation. Voice: arrogant, exacting.",
  "engine": { "cli": "claude", "model": "claude-sonnet" },
  "voice": { "provider": "local" },
  "avatarRing": "#d977c8",
  "channels": ["tauri"]
}
```

- [ ] **Step 7: Export from the barrel.** Add to `swarm/src/index.ts`:

```ts
export { loadAgents, findAgent } from './agents.js';
export type { ComposedAgent, AgentEngine, AgentVoice } from './agents.js';
```

- [ ] **Step 8: Un-ignore the seed files.** Append to root `.gitignore`:

```gitignore
# Swarm runtime state is ignored, but the seed composed-agents are committed.
swarm/.smith/
!swarm/.smith/agents/
!swarm/.smith/agents/*.json
```

- [ ] **Step 9: Typecheck + commit**

```bash
cd swarm && npm run typecheck
cd .. && git add -f swarm/.smith/agents/*.json
git add swarm/src/agents.ts swarm/src/agents.test.ts swarm/src/index.ts swarm/package.json .gitignore
git commit -m "feat(swarm): composed-agent registry + seed agents (Manuel/Octavio/Aurelio)"
```

---

### Task 2: LiveKit dev server + env config

LiveKit is self-hosted via the native `livekit-server` binary (installed: brew
`livekit`, v1.13.4). For dev we use `livekit-server --dev`, which binds `:7880`
with well-known placeholder credentials — **API key `devkey`, secret `secret`**
(verified from its boot log) — so no config file or docker is needed. (Production
self-host would pass a real `--config` with rotated keys; out of v1 scope.)

**Files:**
- Create: `swarm/.env.example`
- Create: `swarm/RUN-LIVEKIT.md` (one-liner run note)
- Modify: `swarm/src/config.ts` (add a `livekit` config block loader)
- Create: `swarm/src/livekit-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface LiveKitConfig { url: string; apiKey: string; apiSecret: string }` and `loadLiveKitConfig(env?: NodeJS.ProcessEnv): LiveKitConfig` (throws if any of the three env vars is missing).

- [ ] **Step 1: Write `swarm/RUN-LIVEKIT.md`**:

```markdown
# Local LiveKit (dev)

Run the self-hosted media server in dev mode (placeholder keys, port 7880):

    livekit-server --dev

Credentials it uses (match `.env`): API key `devkey`, secret `secret`,
URL `ws://127.0.0.1:7880`. The `lk` CLI (brew `livekit-cli`) can mint tokens and
join rooms for smoke tests, e.g. `lk token create --api-key devkey --api-secret secret --join --room r --identity me`.
```

- [ ] **Step 2: Write `swarm/.env.example`** (dev values match `livekit-server --dev`):

```bash
# LiveKit — self-hosted dev server (`livekit-server --dev`)
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret

# Swarm HTTP API auth (see server.ts). Blank = loopback dev mode.
SMITH_API_TOKEN=
```

- [ ] **Step 3: Write the failing test** `swarm/src/livekit-config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLiveKitConfig } from './config.js';

test('loadLiveKitConfig reads the three env vars', () => {
  const cfg = loadLiveKitConfig({
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.url, 'ws://127.0.0.1:7880');
  assert.equal(cfg.apiKey, 'devkey');
});

test('loadLiveKitConfig throws when a var is missing', () => {
  assert.throws(() => loadLiveKitConfig({ LIVEKIT_URL: 'x' } as NodeJS.ProcessEnv), /LIVEKIT_API_KEY/);
});
```

- [ ] **Step 4: Run it, verify it fails** — `cd swarm && npm test` → FAIL (`loadLiveKitConfig` not exported).

- [ ] **Step 5: Implement `loadLiveKitConfig`** — append to `swarm/src/config.ts`:

```ts
export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** Read LiveKit connection config from the environment. Throws naming the first missing var. */
export function loadLiveKitConfig(env: NodeJS.ProcessEnv = process.env): LiveKitConfig {
  const url = env.LIVEKIT_URL;
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  if (!url) throw new Error('LIVEKIT_URL is required');
  if (!apiKey) throw new Error('LIVEKIT_API_KEY is required');
  if (!apiSecret) throw new Error('LIVEKIT_API_SECRET is required');
  return { url, apiKey, apiSecret };
}
```

- [ ] **Step 6: Run it, verify it passes** — `cd swarm && npm test` → PASS.

- [ ] **Step 7: Smoke-test the dev server boots.** Run: `livekit-server --dev >/tmp/lk.log 2>&1 & sleep 3; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7880; lsof -ti :7880 | xargs kill`
Expected: prints `200`; the boot log shows `API Key: devkey, API Secret: secret`.

- [ ] **Step 8: Commit**

```bash
git add swarm/RUN-LIVEKIT.md swarm/.env.example swarm/src/config.ts swarm/src/livekit-config.test.ts
git commit -m "feat(swarm): LiveKit dev-server run notes + LiveKit env config"
```

---

### Task 3: Meeting orchestrator + HTTP routes

**Files:**
- Create: `swarm/src/meetings.ts`
- Create: `swarm/src/meetings.test.ts`
- Modify: `swarm/package.json` (add `livekit-server-sdk` dependency)
- Modify: `swarm/src/server.ts` (register meeting routes; construct the orchestrator)
- Modify: `swarm/src/index.ts` (export the orchestrator)

**Interfaces:**
- Consumes: `ComposedAgent`, `loadAgents`, `findAgent` (Task 1); `LiveKitConfig`, `loadLiveKitConfig` (Task 2).
- Produces:
  - `interface Meeting { id: string; roomName: string; agentIds: string[]; mode: 'solo' | 'council'; status: 'open' | 'closed'; createdAt: string }`
  - `interface MeetingJoin { meetingId: string; roomName: string; serverUrl: string; participantToken: string }` — field names match LiveKit's token-endpoint convention (`server_url`/`participant_token`) so Plan 2's client SDK `TokenSource` consumes it directly. `participantToken` = the **human** join JWT.
  - `class MeetingOrchestrator` with `constructor(cfg: LiveKitConfig, agents: ComposedAgent[], deps?: { roomService?: RoomServiceLike; mintToken?: MintToken })`, `open(scope: { agent?: string; all?: boolean }): Promise<MeetingJoin>`, `close(id: string): Promise<void>`, `list(): Meeting[]`, `get(id: string): Meeting | undefined`.
  - Test seams: `interface RoomServiceLike { createRoom(opts: { name: string }): Promise<unknown>; deleteRoom(name: string): Promise<void> }` and `type MintToken = (identity: string, room: string) => Promise<string>`.

- [ ] **Step 1: Add the dependencies** — `cd swarm && npm install livekit-server-sdk @livekit/protocol` (the latter provides `RoomConfiguration`/`RoomAgentDispatch` for agent dispatch; pin whatever resolves; commit the lockfile in Step 9).

- [ ] **Step 2: Write the failing test** `swarm/src/meetings.test.ts` (fakes the LiveKit seams, so no server needed):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingOrchestrator } from './meetings.js';
import type { ComposedAgent } from './agents.js';

const AGENTS: ComposedAgent[] = [
  { id: 'manuel', name: 'Manuel', role: 'Architect', directives: 'x', engine: { cli: 'claude', model: 'm' } },
  { id: 'octavio', name: 'Octavio', role: 'Auditor', directives: 'y', engine: { cli: 'claude', model: 'm' } },
];

function makeOrchestrator() {
  const created: string[] = [];
  const deleted: string[] = [];
  const roomService = {
    async createRoom(opts: { name: string }) { created.push(opts.name); return {}; },
    async deleteRoom(name: string) { deleted.push(name); },
  };
  const mintToken = async (identity: string, room: string, _agentIds: string[]) => `token:${identity}:${room}`;
  const orch = new MeetingOrchestrator(
    { url: 'ws://x', apiKey: 'k', apiSecret: 's' },
    AGENTS,
    { roomService, mintToken },
  );
  return { orch, created, deleted };
}

test('open(solo) creates a room and returns a human join token', async () => {
  const { orch, created } = makeOrchestrator();
  const join = await orch.open({ agent: 'Manuel' });
  assert.equal(created.length, 1);
  assert.equal(join.roomName, created[0]);
  assert.match(join.participantToken, /^token:human:/);
  const m = orch.get(join.meetingId)!;
  assert.equal(m.mode, 'solo');
  assert.deepEqual(m.agentIds, ['manuel']);
  assert.equal(m.status, 'open');
});

test('open(all) is a council of every agent', async () => {
  const { orch } = makeOrchestrator();
  const join = await orch.open({ all: true });
  const m = orch.get(join.meetingId)!;
  assert.equal(m.mode, 'council');
  assert.deepEqual(m.agentIds.sort(), ['manuel', 'octavio']);
});

test('open with an unknown agent rejects', async () => {
  const { orch } = makeOrchestrator();
  await assert.rejects(() => orch.open({ agent: 'nobody' }), /unknown agent/i);
});

test('close deletes the room and marks the meeting closed', async () => {
  const { orch, deleted } = makeOrchestrator();
  const join = await orch.open({ agent: 'manuel' });
  await orch.close(join.meetingId);
  assert.equal(deleted[0], join.roomName);
  assert.equal(orch.get(join.meetingId)!.status, 'closed');
});
```

- [ ] **Step 3: Run it, verify it fails** — `cd swarm && npm test` → FAIL (`./meetings.js` missing).

- [ ] **Step 4: Implement `swarm/src/meetings.ts`** (production path builds the real seams from `livekit-server-sdk`; tests inject fakes):

```ts
import { randomUUID } from 'node:crypto';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
// Agent dispatch types — verify the exact import path/shape against the installed
// @livekit/protocol version at build time (Task 4 pulls current docs).
import { RoomConfiguration, RoomAgentDispatch } from '@livekit/protocol';
import type { ComposedAgent } from './agents.js';
import { findAgent } from './agents.js';
import type { LiveKitConfig } from './config.js';

// The name the LiveKit agent worker registers under (Task 4 `cli.runApp`).
// Explicit dispatch (below) uses it to route our worker into a meeting room.
const AGENT_NAME = 'smith-agent';

export interface Meeting {
  id: string;
  roomName: string;
  agentIds: string[];
  mode: 'solo' | 'council';
  status: 'open' | 'closed';
  createdAt: string;
}

// Field names match LiveKit's token-endpoint convention so Plan 2's client SDK
// TokenSource consumes this response directly.
export interface MeetingJoin {
  meetingId: string;
  roomName: string;
  serverUrl: string;
  participantToken: string;
}

export interface RoomServiceLike {
  createRoom(opts: { name: string }): Promise<unknown>;
  deleteRoom(name: string): Promise<void>;
}

export type MintToken = (identity: string, room: string, agentIds: string[]) => Promise<string>;

/**
 * Opens/closes voice meetings backed by LiveKit rooms. A meeting seats one agent
 * (solo) or all agents (council) plus the human. Real-time media exists only
 * while a meeting is open — this is the "meeting mode only" activation boundary.
 */
export class MeetingOrchestrator {
  private readonly meetings = new Map<string, Meeting>();
  private readonly roomService: RoomServiceLike;
  private readonly mintToken: MintToken;

  constructor(
    private readonly cfg: LiveKitConfig,
    private readonly agents: ComposedAgent[],
    deps?: { roomService?: RoomServiceLike; mintToken?: MintToken },
  ) {
    // livekit-server-sdk's RoomServiceClient takes an HTTP(S) host; LIVEKIT_URL is ws(s).
    const httpUrl = cfg.url.replace(/^ws/, 'http');
    this.roomService =
      deps?.roomService ?? (new RoomServiceClient(httpUrl, cfg.apiKey, cfg.apiSecret) as unknown as RoomServiceLike);
    this.mintToken =
      deps?.mintToken ??
      (async (identity, room, agentIds) => {
        const at = new AccessToken(cfg.apiKey, cfg.apiSecret, { identity, ttl: '2h' });
        at.addGrant({ roomJoin: true, room });
        // Explicit agent dispatch: LiveKit sends our worker into this room and
        // hands it the chosen composed-agent ids as metadata (Task 4 reads them).
        at.roomConfig = new RoomConfiguration({
          agents: [new RoomAgentDispatch({ agentName: AGENT_NAME, metadata: JSON.stringify({ agentIds }) })],
        });
        return at.toJwt();
      });
  }

  async open(scope: { agent?: string; all?: boolean }): Promise<MeetingJoin> {
    let agentIds: string[];
    let mode: Meeting['mode'];
    if (scope.all) {
      agentIds = this.agents.map((a) => a.id);
      mode = 'council';
    } else {
      const found = scope.agent ? findAgent(this.agents, scope.agent) : undefined;
      if (!found) throw new Error(`unknown agent: ${scope.agent}`);
      agentIds = [found.id];
      mode = 'solo';
    }

    const id = randomUUID();
    const roomName = `meeting-${id}`;
    // Rooms auto-create on first join; we create it up front so it exists
    // immediately and so close() can deleteRoom to end the meeting.
    await this.roomService.createRoom({ name: roomName });

    const meeting: Meeting = {
      id,
      roomName,
      agentIds,
      mode,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.meetings.set(id, meeting);

    const participantToken = await this.mintToken('human', roomName, agentIds);
    return { meetingId: id, roomName, serverUrl: this.cfg.url, participantToken };
  }

  async close(id: string): Promise<void> {
    const meeting = this.meetings.get(id);
    if (!meeting || meeting.status === 'closed') return;
    await this.roomService.deleteRoom(meeting.roomName);
    meeting.status = 'closed';
  }

  list(): Meeting[] {
    return [...this.meetings.values()];
  }

  get(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }
}
```

- [ ] **Step 5: Run it, verify it passes** — `cd swarm && npm test` → PASS (all meetings tests + prior).

- [ ] **Step 6: Wire routes into `swarm/src/server.ts`.** In the constructor, after `this.orchConfig = ...`, build the orchestrator lazily (agents loaded from disk); add a private field `private meetingOrchestrator: MeetingOrchestrator | null = null;` and a loader:

```ts
// near the other imports
import { loadAgents } from './agents.js';
import { MeetingOrchestrator } from './meetings.js';
import { loadLiveKitConfig } from './config.js';
import { resolve } from 'node:path';

// private method on OrchestratorServer:
private async meetings(): Promise<MeetingOrchestrator> {
  if (!this.meetingOrchestrator) {
    const agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
    this.meetingOrchestrator = new MeetingOrchestrator(loadLiveKitConfig(), agents);
  }
  return this.meetingOrchestrator;
}
```

Then inside `registerRoutes()`, add:

```ts
// ── Agents registry ───────────────────────────────────────────────
this.app.get('/agents/registry', async () => {
  const agents = await loadAgents(resolve(process.cwd(), '.smith/agents'));
  return { agents };
});

// ── Meetings ──────────────────────────────────────────────────────
this.app.post('/meetings', async (req, reply) => {
  const body = (req.body ?? {}) as { agent?: string; all?: boolean };
  if (!body.agent && !body.all) {
    return reply.status(400).send({ error: 'provide "agent" (name/id) or "all": true' });
  }
  try {
    const join = await (await server.meetings()).open(body);
    return reply.status(201).send(join);
  } catch (e) {
    return reply.status(400).send({ error: (e as Error).message });
  }
});

this.app.get('/meetings', async () => ({ meetings: (await server.meetings()).list() }));

this.app.delete<{ Params: { id: string } }>('/meetings/:id', async (req) => {
  await (await server.meetings()).close(req.params.id);
  return { id: req.params.id, status: 'closed' };
});
```

(The existing `/agents` route stays; `/agents/registry` returns the composed-agent definitions.)

- [ ] **Step 7: Export the orchestrator.** Add to `swarm/src/index.ts`:

```ts
export { MeetingOrchestrator } from './meetings.js';
export type { Meeting, MeetingJoin } from './meetings.js';
```

- [ ] **Step 8: Smoke test the live path** (LiveKit running). Run:

```bash
cd swarm && livekit-server --dev >/tmp/lk.log 2>&1 & sleep 3
export LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret
npx tsx src/server.ts --port 7777 --udp-port 7778 & SERVER=$!
sleep 2
curl -s -X POST localhost:7777/meetings -H 'content-type: application/json' -d '{"agent":"Manuel"}'
echo; curl -s localhost:7777/meetings
kill $SERVER; lsof -ti :7880 | xargs kill
```

Expected: the POST returns `{meetingId, roomName:"meeting-…", url:"ws://127.0.0.1:7880", token:"ey…"}`; the GET lists one open meeting.

- [ ] **Step 9: Commit**

```bash
git add swarm/src/meetings.ts swarm/src/meetings.test.ts swarm/src/server.ts swarm/src/index.ts swarm/package.json swarm/package-lock.json
git commit -m "feat(swarm): meeting orchestrator + /meetings routes (LiveKit rooms + join tokens)"
```

---

### Task 4: Agent participant (LiveKit Agents worker)

**Files:**
- Create: `swarm/src/agent-worker.ts`
- Create: `swarm/AGENT-WORKER.md` (run notes)
- Modify: `swarm/package.json` (add `@livekit/agents` + a starter model plugin; add a `worker` script)

**Interfaces:**
- Consumes: `ComposedAgent`, `loadAgents`, `findAgent` (Task 1); a running meeting room (Task 3).
- Produces: a worker process that, dispatched to a `meeting-*` room, joins as the agent participant and runs an STT → LLM → TTS loop whose system instructions are the agent's `directives`.

> Note: `@livekit/agents` internals (exact plugin/inference class names, the custom-TTS base interface) move fast. Each code step below begins by pulling the **current** API via context7 (`/websites/livekit_io_agents`) and matching the verified shape — do not code these from memory.

- [ ] **Step 1: Verify + add deps.** Query context7 `/websites/livekit_io_agents` for "Node.js quickstart: minimum packages for an STT-LLM-TTS AgentSession and how the worker connects to a specific room." Then install the packages it names (baseline: `@livekit/agents` plus an inference/plugin set for STT+LLM+TTS to prove the loop). Record exact versions in `AGENT-WORKER.md`.

- [ ] **Step 2: Implement `swarm/src/agent-worker.ts`** against the verified API. The worker must:
  1. On job entry, read the room name; the room is `meeting-<uuid>`.
  2. Load the composed agents from `.smith/agents`, pick the one for this meeting — for v1, pass the agent id as job metadata when dispatching (extend Task 3's `open()` to include `RoomConfiguration`/agent-dispatch metadata per the token-with-agent-dispatch example), or fall back to the first agent if metadata is absent.
  3. Build a `voice.AgentSession({ stt, llm, tts, turnHandling })` using the inference/plugin models, and `voice.Agent.create({ instructions: agent.directives, onEnter → generateReply greeting })`.
  4. `await session.start({ agent, room })` then `await ctx.connect()`.

  Use the verified quickstart shape from Step 1 as the skeleton (structure it exactly like the `defineAgent`/`cli.runApp` example returned by context7), substituting `instructions: agent.directives` and a greeting that says the agent's name/role.

- [ ] **Step 3: Add the `worker` script** to `swarm/package.json`:

```json
"worker": "node --import tsx src/agent-worker.ts start",
```

(Confirm the subcommand — `start`/`dev` — against the context7 CLI docs from Step 1.)

- [ ] **Step 4: Manual end-to-end smoke.** With LiveKit up and the swarm server running (Task 3 Step 8 env), in one terminal `cd swarm && npm run worker`; in another, `POST /meetings {"agent":"Manuel"}`, then open the LiveKit room in the [Agents Playground / a `livekit-client` test page] using the returned `url`+`token`. Expected: the "Manuel" participant joins, greets you by voice/text, and answers when you speak. Document the exact playground/test-client steps used in `AGENT-WORKER.md`.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/agent-worker.ts swarm/AGENT-WORKER.md swarm/package.json swarm/package-lock.json
git commit -m "feat(swarm): LiveKit agent worker — composed agent joins a meeting as a voice participant"
```

---

### Task 5: Per-agent voice — MLX (local) or ElevenLabs, chosen by `agent.voice`

Each agent's `voice.provider` picks its TTS: `local` → MLX voice-engine (free), or
`elevenlabs` → the ElevenLabs voice (metered, high quality — reserve for the
scrum-master agents). Both route through the existing `voice/` `VoiceProvider`
abstraction (`LocalVoiceProvider`, `ElevenLabsVoiceProvider`, and the
`CachingVoiceProvider` decorator that replays fixed lines from `audio-cache/` so
recurring phrases are synthesized once). Cost analysis in this repo's chat history:
self-host + local ≈ ~$0; ElevenLabs ≈ ~$0.07–0.15 per minute of actual speech, cut
by caching + Flash/Turbo models.

**Files:**
- Create: `swarm/src/livekit-tts.ts` (a LiveKit custom TTS backed by a `voice/` VoiceProvider)
- Modify: `swarm/src/agent-worker.ts` (build the TTS from `agent.voice`)
- Modify: `swarm/.env.example` (add `ELEVENLABS_API_KEY=`)
- Modify: `voice/` and/or `voice-engine/` only if a callable synth entrypoint is missing (see Step 1)

**Interfaces:**
- Consumes: the agent worker (Task 4); the `voice/` `VoiceProvider` (`synthesize`/`stream`) — `LocalVoiceProvider` (MLX), `ElevenLabsVoiceProvider`, `CachingVoiceProvider`; the `voice-engine/` MLX synth.
- Produces: `ttsForAgent(agent: ComposedAgent): LiveKitTTS` — resolves `agent.voice.provider` to a VoiceProvider (wrapped in `CachingVoiceProvider`) and adapts it to LiveKit's custom-TTS interface.

- [ ] **Step 1: Confirm the synth entrypoints.** In `voice/src/*` verify `LocalVoiceProvider` and `ElevenLabsVoiceProvider` expose a callable `synthesize(text, opts): audio` (and that Local can reach the MLX `voice-engine/`). If the MLX path isn't callable yet, add only a minimal `voice-engine/` HTTP endpoint (`POST /tts {text,voice} → wav bytes`). Record what exists vs what you added.

- [ ] **Step 2: Verify the custom-TTS interface.** Query context7 `/websites/livekit_io_agents` for "Node.js: implement a custom TTS plugin (base class / interface, streaming vs non-streaming, expected audio frame format/sample rate)." Match `livekit-tts.ts` to that exact interface.

- [ ] **Step 3: Implement `swarm/src/livekit-tts.ts`** against the verified interface. Export `ttsForAgent(agent)` that: (a) builds the base provider from `agent.voice.provider` (`local` → `LocalVoiceProvider`; `elevenlabs` → `ElevenLabsVoiceProvider` using `process.env.ELEVENLABS_API_KEY` and `agent.voice.voiceId`); (b) wraps it in `CachingVoiceProvider` keyed on `audio-cache/`; (c) adapts it to LiveKit's custom-TTS class, yielding frames in LiveKit's expected format (resample if needed).

- [ ] **Step 4: Wire it into the worker** — in `agent-worker.ts`, construct the `AgentSession` TTS via `ttsForAgent(agent)` instead of the fixed inference TTS. Add `ELEVENLABS_API_KEY=` to `.env.example`.

- [ ] **Step 5: Manual smoke (both providers).** With one seed agent set to `voice.provider:"local"` and one to `"elevenlabs"` (a real voiceId + key), repeat Task 4 Step 4 for each. Expected: the `local` agent speaks in the MLX voice; the `elevenlabs` agent in the ElevenLabs voice; a repeated fixed greeting is served from cache on the second meeting. Note latency per provider in `AGENT-WORKER.md`.

- [ ] **Step 6: Commit**

```bash
git add swarm/src/livekit-tts.ts swarm/src/agent-worker.ts swarm/.env.example voice voice-engine
git commit -m "feat(swarm): per-agent voice (MLX local or ElevenLabs, cached) in meetings"
```

---

## Self-Review

**1. Spec coverage (v1 items 1–4):**
- Registry (item 1) → Task 1. ✓
- Meeting orchestrator + LiveKit rooms/tokens, meeting-mode-only (items 2–3) → Tasks 2–3. ✓
- Agent participant STT→model→TTS, MLX voice via VoiceProvider (item 4) → Tasks 4–5. ✓
- Items 5–6 (Tauri app, wake-command gate) → deferred to Plan 2, stated up front. ✓
- Decisions honored: self-hosted LiveKit (Task 2), local voice (Task 5), server-generated meeting ids (Task 3), registry at `.smith/agents/*.json` (Task 1). ✓

**2. Placeholder scan:** Tasks 1–3 carry complete code + real tests. Tasks 4–5 intentionally gate LiveKit-Agents/custom-TTS code behind a context7 verify step (the API is fast-moving) — each step names the exact concept to look up and the exact wiring to produce, which is a concrete instruction, not a "figure it out." Acceptable and called out.

**3. Type consistency:** `ComposedAgent`/`AgentEngine`/`AgentVoice` consistent Tasks 1→3→4→5. `MeetingJoin{meetingId,roomName,url,token}` consistent Task 3 ↔ smoke tests ↔ Plan 2 handoff. `LiveKitConfig{url,apiKey,apiSecret}` consistent Tasks 2→3. `RoomServiceLike`/`MintToken` seams used only in Task 3. ✓

## Handoff to Plan 2

Plan 2 (Tauri app + wake activation) consumes the swarm's `POST /meetings {agent|all} → MeetingJoin{serverUrl,participantToken}`, `DELETE /meetings/:id`, and `GET /agents/registry`. The app connects to `serverUrl` with `participantToken` via `livekit-client` in the webview (mic + remote audio), brokered by a thin Rust command; the wake-command gate calls `POST /meetings` with the resolved scope. The agent auto-joins via the token's `RoomConfiguration` dispatch (no separate join call needed).
