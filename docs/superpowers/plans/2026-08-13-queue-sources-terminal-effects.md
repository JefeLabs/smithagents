# Queue Sources + Terminal Side-Effects Implementation Plan

> **CLAIMED:** 2026-08-13 by session 93b80eca (Edwin's interactive session) — executing via subagent-driven development on branch `queue-sources-terminal-effects` (worktree). Do not execute this plan from another session.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boards' edge columns become configurable — the Queue binds to pollable "context sources" (Jira, releases, topics, observability, custom) owned by the workspace record, and the terminal column fires side-effects (publish to Jira, route a copy onward) when a card lands there, with a hover gear on each edge column opening the config sheet.

**Architecture:** Sources live on the one-context `Workspace` record; the **broker** polls them (its feeds engine generalizes: per-source cadence in the `dueSources` seam, new jira/http kinds, binding-driven carding replacing `boardTypeFor`); the **swarm** fires terminal effects synchronously inside the card-PATCH route it already owns, beside the existing jira push-on-move precedent. Empty config = today's behavior byte-for-byte.

**Tech Stack:** TypeScript everywhere. Swarm: Fastify + node:test (flat tests, exported pure helpers ONLY — no route-boot harness exists). Broker: node:test, pure feeds modules + thin main.ts wiring (main.ts feeds wiring is untested by convention — keep additions <40 lines per site, logic in tested modules). Control plane: React 19 + TanStack Query + RHF + HeroUI ModalShell, vitest/jsdom with the `stubFetch` pattern.

**Spec:** `docs/superpowers/specs/2026-08-13-queue-sources-terminal-effects-design.md`

**Spec deviations (discovered in exploration, encoded here):**
1. There is NO nightly cron in the broker — the engine is three `setInterval` timers. "Per-source cadence" is implemented as an override in `ingest.ts`'s `dueSources` seam (`CADENCE_MS[source.kind]` is today's only cadence input). Behavior identical to the spec's intent.
2. Atlassian connector credentials resolve only inside the swarm (`.smith/users` + `resolveAtlassianConnector`). The broker's jira poll therefore calls a new narrow swarm endpoint `POST /atlassian/search` rather than holding credentials. Option A is preserved: broker owns scheduling/transform/carding; swarm proxies its existing `searchIssues`.
3. The broker's "analyze" LLM path is the existing raw `anthropic.messages.create` deps-injection pattern (feeds `plan()` precedent, model `claude-haiku-4-5`) — not brain.ts, not ApiRuntime.
4. Terminal `route` effect COPIES (spec: original completed where it is) — `routeCard` MOVES, so the copy is a new pure function; the copy carries a fresh id (card ids are unique across boards — `findCardByRef` keys on cardId alone) and dedups via `sourceRef {sourceId: "terminal:<boardId>", itemKey: <originalCardId>}`.

## Global Constraints

- Node >= 24, TS ~6.0.0, biome 2.5.3; lint baseline is ZERO diagnostics — run `pnpm biome check <files>` (from repo root) on every changed file before each commit; measure exit codes by redirect, never `$?` after a pipe.
- Swarm tests: `cd swarm && pnpm test` (node:test over `src/*.test.ts`). Broker tests: `cd broker && pnpm test`. Control plane: `cd control-plane && pnpm vitest run <file>`.
- Swarm route-body logic MUST live in exported pure functions (no server-boot test harness exists). Trailing injectable `fetchImpl: typeof fetch = fetch` on every new HTTP function.
- `assertContext`/`assertBoard` pass unknown fields through — but `saveWorkspace` and the three server projections (`POST /workspaces` :1714, `PUT /workspaces/:name` :1755, `GET /workspaces` :1843) are explicit allowlists: `sources` needs a line in each.
- Control plane: `api/work.ts` functions THROW on failure; `api/broker.ts` functions resolve `{error}` — preserve per-file convention. New board UI CSS goes beside the existing `.board-column` rules in `styles/components.css` (layer(legacy)); tokens only, no per-theme branches (sand is the fourth theme).
- Commits: small, per-task, message style `feat(swarm|broker|cp): ...`, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Work in the main checkout (shared!) — `git status` + diff review before every staging; stage only your files.
- Broker/swarm are LIVE in tmux (`smith-broker`, `smith-swarm`) — never restart them mid-plan; restarts happen once at the end with Edwin aware.

---

### Task 1: ContextSource type + workspace-record plumbing (swarm)

**Files:**
- Modify: `swarm/src/workspaces.ts` (interface at :22-52, add validator near `validSprint`-style helpers)
- Modify: `swarm/src/server.ts` (`POST /workspaces` mapping :1714-1729, `PUT /workspaces/:name` merge :1755-1768, `GET /workspaces` projection :1843-1859)
- Test: `swarm/src/workspaces.test.ts`, `swarm/src/server.test.ts`

**Interfaces:**
- Produces: `ContextSource` interface (exported from `workspaces.ts`), `Workspace.sources?: ContextSource[]`, `validSources(v: unknown): boolean` (exported), sources surviving POST/PUT/GET round-trips.
- Consumed by: Task 6 (migration seeding), Task 8 (broker reads sources off `GET /workspaces`), Task 12 (control-plane types).

- [ ] **Step 1: Write the failing tests** — append to `swarm/src/workspaces.test.ts`:

```ts
test("a workspace record with sources round-trips through save and load untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ws-"));
  const ws: Workspace = {
    name: "acme",
    repos: [{ name: "app", path: "/tmp/app" }],
    sources: [
      {
        id: "jira-plan",
        name: "PROJ tickets",
        preset: "jira",
        origin: { connectorId: "atl-1", url: "https://acme.atlassian.net", query: "project = PROJ" },
        cadence: "nightly",
        transform: { mode: "map" },
        enabled: true,
      },
    ],
  };
  await saveWorkspace(dir, ws);
  const [loaded] = await loadWorkspacesFromDir(dir);
  assert.deepEqual(loaded.sources, ws.sources);
});

test("validSources accepts absent, rejects rows missing id/name/preset/cadence/transform/enabled", () => {
  assert.equal(validSources(undefined), true);
  assert.equal(validSources([]), true);
  assert.equal(
    validSources([
      { id: "s1", name: "n", preset: "custom", origin: {}, cadence: "6h", transform: { mode: "analyze" }, enabled: true },
    ]),
    true,
  );
  assert.equal(validSources([{ id: "s1" }]), false);
  assert.equal(validSources([{ id: "s1", name: "n", preset: "nope", origin: {}, cadence: "6h", transform: { mode: "map" }, enabled: true }]), false);
  assert.equal(validSources([{ id: "s1", name: "n", preset: "jira", origin: {}, cadence: "weekly", transform: { mode: "map" }, enabled: true }]), false);
  assert.equal(validSources("x"), false);
});
```

Add `ContextSource, validSources` to the existing `workspaces.js` import line.

- [ ] **Step 2: Run to verify failure**

Run: `cd swarm && pnpm test 2>&1 | tail -20`
Expected: FAIL — `validSources` is not exported / type error on `sources`.

- [ ] **Step 3: Implement** — in `swarm/src/workspaces.ts`:

Add above the `Workspace` interface:

```ts
/** A pollable external origin owned by this context (spec 2026-08-13
    queue-sources): the BROKER polls it, the queue bindings on boards decide
    where its findings card. `preset` is UI sugar — executors read origin/transform. */
export interface ContextSource {
  id: string;
  name: string;
  preset: "jira" | "releases" | "topic" | "observability" | "support" | "custom";
  origin: { connectorId?: string; url?: string; query?: string };
  cadence: "hourly" | "6h" | "nightly";
  transform: { mode: "map" } | { mode: "analyze"; prompt?: string };
  enabled: boolean;
}

const SOURCE_PRESETS = new Set(["jira", "releases", "topic", "observability", "support", "custom"]);
const SOURCE_CADENCES = new Set(["hourly", "6h", "nightly"]);

/** Absent or a valid array — never half-checked, same contract as validSprint. */
export function validSources(v: unknown): boolean {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every((s) => {
    const o = s as Partial<ContextSource>;
    return (
      o !== null &&
      typeof o === "object" &&
      typeof o.id === "string" &&
      o.id.length > 0 &&
      typeof o.name === "string" &&
      SOURCE_PRESETS.has(o.preset as string) &&
      typeof o.origin === "object" &&
      o.origin !== null &&
      SOURCE_CADENCES.has(o.cadence as string) &&
      (o.transform?.mode === "map" || o.transform?.mode === "analyze") &&
      typeof o.enabled === "boolean"
    );
  });
}
```

Add to the `Workspace` interface (after `sprint`): `sources?: ContextSource[];`

In `swarm/src/server.ts` add one line to each of the three explicit mappings (mirror how `sprint` is carried in each):
- POST mapping (~:1714 block): `sources: body.sources,`
- PUT merge (~:1755 block): `sources: body.sources ?? existing.sources,`
- GET projection (~:1843 block): `sources: w.sources,`

In both POST and PUT handlers, next to the existing `validSprint` checks, add: `if (!validSources(body.sources)) return reply.code(400).send({ error: "invalid sources" });` (match the surrounding error-shape convention — read the neighboring `validSprint` rejection and copy its exact reply shape).

- [ ] **Step 4: Run tests**

Run: `cd swarm && pnpm test 2>&1 | tail -5`
Expected: PASS (all suites).

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check swarm/src/workspaces.ts swarm/src/workspaces.test.ts swarm/src/server.ts
git add swarm/src/workspaces.ts swarm/src/workspaces.test.ts swarm/src/server.ts
git commit -m "feat(swarm): context sources on the workspace record

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Board edge blocks + column resolvers (swarm)

**Files:**
- Modify: `swarm/src/work-items.ts` (WorkBoard :52-64, WorkCard :31-50, `addCard` :430, PATCH body type is in server.ts)
- Modify: `swarm/src/server.ts` (`PATCH /work/boards/:id` Pick :2532, `POST /work/boards/:id/cards` body :2556)
- Test: `swarm/src/work-items.test.ts`

**Interfaces:**
- Produces: `WorkBoard.queue?: { sourceIds: string[] }`, `WorkBoard.terminal?: { columnId?: string; effects: TerminalEffect[] }`, `TerminalEffect` type, `WorkCard.sourceRef?: { sourceId: string; itemKey: string }`, exported `terminalColumnId(board: WorkBoard): string | undefined`, `intakeColumnId(board: WorkBoard): string | undefined`, `hasSourceRef(board: WorkBoard, ref: { sourceId: string; itemKey: string }): boolean`; `addCard` input gains `sourceRef?`.
- Consumed by: Tasks 3-6 (effects, migration), Task 11 (broker carding via POST body), Tasks 12-15 (cp types/UI).

- [ ] **Step 1: Failing tests** — append to `swarm/src/work-items.test.ts`:

```ts
test("terminalColumnId is the explicit terminal.columnId, else the last column — Release's Rollback trap", () => {
  const board = createBoard("release", "acme"); // columns end in rollback
  assert.equal(terminalColumnId(board), board.columns[board.columns.length - 1].id);
  board.terminal = { columnId: "ship", effects: [] };
  assert.equal(terminalColumnId(board), "ship");
});

test("intakeColumnId prefers the queue column and falls back to the first column (Plan has no queue)", () => {
  const maintain = createBoard("maintenance", "acme");
  assert.equal(intakeColumnId(maintain), "queue");
  const plan = createBoard("plan", "acme");
  assert.equal(plan.columns.some((c) => c.id === "queue"), true); // normalizeBoard adds queue to plan
  const ideation = createBoard("ideation", "acme");
  assert.equal(intakeColumnId(ideation), ideation.columns[0].id);
});

test("a board with queue/terminal blocks and a card with sourceRef round-trips through save/load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "work-"));
  const board = createBoard("plan", "acme");
  board.queue = { sourceIds: ["jira-plan"] };
  board.terminal = { columnId: "ready", effects: [{ kind: "publish-jira", connectorId: "atl-1", projectKey: "PROJ" }] };
  const card = addCard(board, { title: "t", sourceRef: { sourceId: "jira-plan", itemKey: "PROJ-1" } });
  await saveBoard(dir, board);
  const { boards } = await loadBoards(dir);
  assert.deepEqual(boards[0].queue, board.queue);
  assert.deepEqual(boards[0].terminal, board.terminal);
  assert.deepEqual(boards[0].cards.find((c) => c.id === card.id)?.sourceRef, { sourceId: "jira-plan", itemKey: "PROJ-1" });
  assert.equal(hasSourceRef(boards[0], { sourceId: "jira-plan", itemKey: "PROJ-1" }), true);
  assert.equal(hasSourceRef(boards[0], { sourceId: "jira-plan", itemKey: "PROJ-2" }), false);
});
```

NOTE for the implementer: check `createBoard("plan")`'s template — if plan's template lacks a queue column, `normalizeBoard` (QUEUE_TYPES) prepends it; `createBoard` may or may not normalize. Read `createBoard` first and adjust the intake test's plan-board expectation to the actual template (the invariant under test is: queue column when present wins, first column otherwise — ideation covers the no-queue path either way).

- [ ] **Step 2: Verify failure** — `cd swarm && pnpm test 2>&1 | tail -20` → FAIL (missing exports/types).

- [ ] **Step 3: Implement** — in `swarm/src/work-items.ts`:

```ts
/** Terminal side-effect config (spec 2026-08-13 queue-sources). */
export type TerminalEffect =
  | { kind: "publish-jira"; connectorId: string; projectKey: string }
  | { kind: "route"; toType: BoardType; toColumn: string };
```

WorkBoard additions (after `jira?`): `queue?: { sourceIds: string[] };` and `terminal?: { columnId?: string; effects: TerminalEffect[] };`
WorkCard addition (after `routedFrom?`): `sourceRef?: { sourceId: string; itemKey: string };`

```ts
/** The column whose entry fires terminal effects. Explicit beats positional:
    Release ends in Rollback, and rollbacks must not publish. */
export function terminalColumnId(board: WorkBoard): string | undefined {
  return board.terminal?.columnId ?? board.columns[board.columns.length - 1]?.id;
}

/** Where bound sources card into: the queue lane when the board has one,
    else the first column (Plan/Ideate have no queue lane). */
export function intakeColumnId(board: WorkBoard): string | undefined {
  return (board.columns.find((c) => c.id === "queue") ?? board.columns[0])?.id;
}

/** Source-item dedup: has this board already carded this item? */
export function hasSourceRef(board: WorkBoard, ref: { sourceId: string; itemKey: string }): boolean {
  return board.cards.some((c) => c.sourceRef?.sourceId === ref.sourceId && c.sourceRef.itemKey === ref.itemKey);
}
```

`addCard` input type gains `sourceRef?: { sourceId: string; itemKey: string }` and the created card carries it (`sourceRef: input.sourceRef,` — undefined stays absent in JSON).

In `swarm/src/server.ts`:
- PATCH board Pick (:2532) becomes `Partial<Pick<WorkBoard, "name" | "columns" | "jira" | "queue" | "terminal">>`; in the handler add, beside the `b.jira` line: `if (b.queue !== undefined) board.queue = b.queue ?? undefined;` and `if (b.terminal !== undefined) board.terminal = b.terminal ?? undefined;` with a guard rejecting a `terminal.columnId` naming no column: `if (b.terminal?.columnId && !board.columns.some((c) => c.id === b.terminal!.columnId)) return reply.code(400).send({ error: "terminal.columnId names no column" });` (copy the surrounding 400 reply shape).
- cards POST body cast (:2556) gains `sourceRef?: { sourceId: string; itemKey: string }` and passes it to `addCard`.

- [ ] **Step 4: Run** — `cd swarm && pnpm test 2>&1 | tail -5` → PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check swarm/src/work-items.ts swarm/src/work-items.test.ts swarm/src/server.ts
git add swarm/src/work-items.ts swarm/src/work-items.test.ts swarm/src/server.ts
git commit -m "feat(swarm): queue/terminal edge blocks on boards, sourceRef on cards

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Jira createIssue + search endpoint (swarm)

**Files:**
- Modify: `swarm/src/jira-sync.ts`
- Modify: `swarm/src/server.ts` (new route + exported handler-core)
- Test: `swarm/src/jira-sync.test.ts`, `swarm/src/server.test.ts`

**Interfaces:**
- Produces: `createIssue(siteUrl: string, email: string, apiToken: string, projectKey: string, summary: string, description: string, fetchImpl: typeof fetch = fetch): Promise<{ key: string; url: string }>` (jira-sync.ts); route `POST /atlassian/search` body `{ connectorId: string; siteUrl: string; jql: string }` → `{ issues: Array<{key, summary, url}> } | 4xx {error}`, with exported core `runJiraSearch(resolve: (connectorId: string) => { email: string; apiToken: string } | { error: string }, body: { connectorId?: string; siteUrl?: string; jql?: string }, search: typeof searchIssues): Promise<{ status: number; payload: unknown }>`.
- Consumed by: Task 4 (publish effect calls createIssue), Task 9 (broker polls via the endpoint).

- [ ] **Step 1: Failing tests** — append to `swarm/src/jira-sync.test.ts` (reuse its `fetchStub` helper at :6-21):

```ts
test("createIssue POSTs the v3 issue shape and returns key + browse url", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchImpl = fetchStub([
    {
      match: /\/rest\/api\/3\/issue$/,
      body: { key: "PROJ-7" },
      capture: (url, init) => void (captured = { url, init }),
    },
  ]);
  const res = await createIssue("https://acme.atlassian.net", "e@x.com", "tok", "PROJ", "Fix login", "Details here", fetchImpl);
  assert.deepEqual(res, { key: "PROJ-7", url: "https://acme.atlassian.net/browse/PROJ-7" });
  const sent = JSON.parse(String(captured!.init.body));
  assert.equal(sent.fields.project.key, "PROJ");
  assert.equal(sent.fields.summary, "Fix login");
  assert.equal(sent.fields.issuetype.name, "Task");
});

test("createIssue throws on a non-2xx response with the status in the message", async () => {
  const fetchImpl = fetchStub([{ match: /issue$/, status: 403, body: { errorMessages: ["nope"] } }]);
  await assert.rejects(
    () => createIssue("https://acme.atlassian.net", "e@x.com", "tok", "PROJ", "t", "d", fetchImpl),
    /403/,
  );
});
```

And to `swarm/src/server.test.ts` (module-level helper import style — NO server boot):

```ts
test("runJiraSearch resolves the connector then searches; a resolve error is a 400", async () => {
  const ok = await runJiraSearch(
    () => ({ email: "e@x.com", apiToken: "tok" }),
    { connectorId: "atl-1", siteUrl: "https://acme.atlassian.net", jql: "project = PROJ" },
    async () => [{ key: "PROJ-1", summary: "s", url: "u" }],
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.payload, { issues: [{ key: "PROJ-1", summary: "s", url: "u" }] });

  const bad = await runJiraSearch(() => ({ error: "no such connector" }), { connectorId: "x", siteUrl: "https://a", jql: "j" }, async () => []);
  assert.equal(bad.status, 400);

  const missing = await runJiraSearch(() => ({ email: "e", apiToken: "t" }), { jql: "j" }, async () => []);
  assert.equal(missing.status, 400);
});
```

- [ ] **Step 2: Verify failure** — `cd swarm && pnpm test 2>&1 | tail -20` → FAIL (not exported).

- [ ] **Step 3: Implement**

`swarm/src/jira-sync.ts` — follow `searchIssues`'s auth/url style exactly (read :11-33 first); description as minimal ADF:

```ts
/** Create one issue. Description is wrapped in the minimal ADF paragraph the
    v3 API requires — callers pass plain text. Throws with the status on any
    non-2xx, mirroring transitionIssue's failure style. */
export async function createIssue(
  siteUrl: string,
  email: string,
  apiToken: string,
  projectKey: string,
  summary: string,
  description: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ key: string; url: string }> {
  const base = siteUrl.replace(/\/$/, "");
  const res = await fetchImpl(`${base}/rest/api/3/issue`, {
    method: "POST",
    headers: { authorization: basicAuth(email, apiToken), "content-type": "application/json" },
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        summary,
        issuetype: { name: "Task" },
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: description || summary }] }],
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`jira create failed (${res.status})`);
  const body = (await res.json()) as { key: string };
  return { key: body.key, url: `${base}/browse/${body.key}` };
}
```

(If `basicAuth` is private to `atlassian-client.ts`, replicate the one-liner locally the way jira-sync already handles auth — READ jira-sync's existing auth first and match it.)

`swarm/src/server.ts` — exported core + thin route (place the core near `resolveAtlassianConnector`'s exported friends):

```ts
/** Handler-core for POST /atlassian/search — exported for tests (no route-boot
    harness exists; see server.test.ts header). The broker polls jira context
    sources through this rather than holding Atlassian credentials itself. */
export async function runJiraSearch(
  resolve: (connectorId: string) => { email: string; apiToken: string } | { error: string },
  body: { connectorId?: string; siteUrl?: string; jql?: string },
  search: typeof searchIssues,
): Promise<{ status: number; payload: unknown }> {
  if (!body.connectorId || !body.siteUrl || !body.jql) return { status: 400, payload: { error: "connectorId, siteUrl, jql required" } };
  const creds = resolve(body.connectorId);
  if ("error" in creds) return { status: 400, payload: { error: creds.error } };
  try {
    const issues = await search(body.siteUrl, creds.email, creds.apiToken, body.jql);
    return { status: 200, payload: { issues } };
  } catch (err) {
    return { status: 502, payload: { error: String((err as Error).message ?? err) } };
  }
}
```

Route (inside `registerRoutes`, near the other atlassian routes ~:2213): resolve via the existing `resolveAtlassianConnector` chain (read :3302-3328 and reuse: `const resolved = this.resolveAtlassianConnector(connectorId, ...)` adapting to its actual shape — the resolver returns `{instance, field} | {error}`, so the adapter closure is `(id) => { const r = ...; return "error" in r ? r : { email: r.instance.fields.email ?? "", apiToken: r.instance.fields.apiToken ?? "" }; }`), then `const { status, payload } = await runJiraSearch(adapter, req.body as ..., searchIssues); return reply.code(status).send(payload);`

NOTE: both jira HTTP files now exist — add the shared drift comment to BOTH `searchIssues` and the new endpoint core: `// Jira REST v3. /rest/api/3/search is deprecated in favor of /search/jql (token pagination) — if search breaks, migrate BOTH this and <other site> together.`

- [ ] **Step 4: Run** — `cd swarm && pnpm test 2>&1 | tail -5` → PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check swarm/src/jira-sync.ts swarm/src/jira-sync.test.ts swarm/src/server.ts swarm/src/server.test.ts
git add swarm/src/jira-sync.ts swarm/src/jira-sync.test.ts swarm/src/server.ts swarm/src/server.test.ts
git commit -m "feat(swarm): jira createIssue + credential-holding search endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: applyTerminalEffects (swarm, pure)

**Files:**
- Create: `swarm/src/terminal-effects.ts`
- Test: `swarm/src/terminal-effects.test.ts`

**Interfaces:**
- Consumes: `WorkBoard`, `WorkCard`, `TerminalEffect`, `terminalColumnId`, `hasSourceRef`, `findRouteDestination` from `./work-items.js` (Task 2); `createIssue` shape from Task 3 (injected, never imported here).
- Produces:

```ts
export interface EffectDeps {
  createIssue(connectorId: string, projectKey: string, summary: string, description: string): Promise<{ key: string; url: string }>;
  newId(): string;
  now(): string;
}
export async function applyTerminalEffects(
  board: WorkBoard,
  card: WorkCard,
  allBoards: WorkBoard[],
  deps: EffectDeps,
): Promise<{ changed: WorkBoard[]; errors: string[] }>
```

- [ ] **Step 1: Failing tests** — create `swarm/src/terminal-effects.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTerminalEffects } from "./terminal-effects.ts";
import { addCard, createBoard, type WorkBoard } from "./work-items.ts";

function deps(overrides: Partial<Parameters<typeof applyTerminalEffects>[3]> = {}) {
  return {
    createIssue: async () => ({ key: "PROJ-9", url: "https://a/browse/PROJ-9" }),
    newId: () => "copy-1",
    now: () => "2026-08-13T12:00:00Z",
    ...overrides,
  };
}

test("publish-jira stamps card.jira and never re-publishes an already-linked card", async () => {
  const board = createBoard("ideation", "acme");
  board.terminal = { columnId: board.columns[board.columns.length - 1].id, effects: [{ kind: "publish-jira", connectorId: "atl-1", projectKey: "PROJ" }] };
  const card = addCard(board, { title: "Great idea" });
  const first = await applyTerminalEffects(board, card, [board], deps());
  assert.deepEqual(card.jira, { key: "PROJ-9", url: "https://a/browse/PROJ-9" });
  assert.deepEqual(first.changed.map((b) => b.id), [board.id]);
  let called = 0;
  await applyTerminalEffects(board, card, [board], deps({ createIssue: async () => (called++, { key: "X-1", url: "u" }) }));
  assert.equal(called, 0); // card.jira presence is the idempotency guard
});

test("publish-jira failure lands in errors + lastPushError and changes nothing else", async () => {
  const board = createBoard("ideation", "acme");
  board.terminal = { columnId: board.columns[board.columns.length - 1].id, effects: [{ kind: "publish-jira", connectorId: "atl-1", projectKey: "PROJ" }] };
  const card = addCard(board, { title: "t" });
  const res = await applyTerminalEffects(board, card, [board], deps({ createIssue: async () => { throw new Error("403"); } }));
  assert.equal(res.errors.length, 1);
  assert.match(card.jira?.lastPushError ?? "", /403/);
  assert.equal(card.jira?.key, ""); // errored placeholder, no phantom link
});

test("route copies the card into the target board's configured column with a fresh id, routedFrom, and a terminal sourceRef; re-entry does not duplicate", async () => {
  const plan = createBoard("plan", "acme");
  const deliver = createBoard("deliver", "acme");
  plan.terminal = { columnId: plan.columns[plan.columns.length - 1].id, effects: [{ kind: "route", toType: "deliver", toColumn: "queue" }] };
  const card = addCard(plan, { title: "ship me" });
  const res = await applyTerminalEffects(plan, card, [plan, deliver], deps());
  const copy = deliver.cards.find((c) => c.id === "copy-1");
  assert.ok(copy);
  assert.equal(copy.columnId, "queue");
  assert.equal(copy.title, "ship me");
  assert.deepEqual(copy.sourceRef, { sourceId: `terminal:${plan.id}`, itemKey: card.id });
  assert.equal(copy.routedFrom?.[0]?.boardId, plan.id);
  assert.deepEqual(res.changed.map((b) => b.id).sort(), [deliver.id].sort()); // plan itself unchanged by route
  // original stays where it completed
  assert.ok(plan.cards.some((c) => c.id === card.id));
  const again = await applyTerminalEffects(plan, card, [plan, deliver], deps({ newId: () => "copy-2" }));
  assert.equal(deliver.cards.filter((c) => c.sourceRef?.itemKey === card.id).length, 1);
  assert.equal(again.changed.length, 0);
});

test("a route effect with no matching board is an error entry, never a throw", async () => {
  const plan = createBoard("plan", "acme");
  plan.terminal = { columnId: plan.columns[plan.columns.length - 1].id, effects: [{ kind: "route", toType: "release", toColumn: "queue" }] };
  const card = addCard(plan, { title: "t" });
  const res = await applyTerminalEffects(plan, card, [plan], deps());
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /no release board/i);
});
```

- [ ] **Step 2: Verify failure** — `cd swarm && pnpm test 2>&1 | tail -20` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `swarm/src/terminal-effects.ts`:

```ts
// Terminal side-effects (spec 2026-08-13 queue-sources): fire when a card
// ENTERS a board's terminal column. Pure per the swarm test law — the route
// handler injects createIssue/newId/now. Effects NEVER throw out of here: the
// move that triggered them must always succeed.
import {
  findRouteDestination,
  hasSourceRef,
  type WorkBoard,
  type WorkCard,
} from "./work-items.js";

export interface EffectDeps {
  createIssue(connectorId: string, projectKey: string, summary: string, description: string): Promise<{ key: string; url: string }>;
  newId(): string;
  now(): string;
}

export async function applyTerminalEffects(
  board: WorkBoard,
  card: WorkCard,
  allBoards: WorkBoard[],
  deps: EffectDeps,
): Promise<{ changed: WorkBoard[]; errors: string[] }> {
  const changed = new Set<WorkBoard>();
  const errors: string[] = [];
  for (const effect of board.terminal?.effects ?? []) {
    if (effect.kind === "publish-jira") {
      if (card.jira?.key) continue; // linked already — idempotent
      try {
        card.jira = await deps.createIssue(effect.connectorId, effect.projectKey, card.title, card.notes ?? "");
        changed.add(board);
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        card.jira = { key: "", url: "", lastPushError: msg };
        changed.add(board);
        errors.push(`publish-jira: ${msg}`);
      }
    } else {
      // route: COPY onward — the original completed here and stays. routeCard
      // MOVES, so this is its own stamp site (the second after work-items:259).
      const dest = findRouteDestination(allBoards, board, { from: card.columnId, toType: effect.toType, toColumn: effect.toColumn, label: "" });
      if (!dest) {
        errors.push(`route: no ${effect.toType} board for ${board.workspaceId ?? "personal"}`);
        continue;
      }
      const ref = { sourceId: `terminal:${board.id}`, itemKey: card.id };
      if (hasSourceRef(dest, ref)) continue; // re-entry — copied already
      const order = dest.cards.filter((c) => c.columnId === effect.toColumn).length;
      dest.cards.push({
        ...card,
        id: deps.newId(),
        columnId: effect.toColumn,
        order,
        updatedAt: deps.now(),
        sourceRef: ref,
        jira: undefined,
        delegation: undefined,
        routedFrom: [...(card.routedFrom ?? []), { boardId: board.id, boardType: board.type, columnId: card.columnId, at: deps.now() }],
      });
      changed.add(dest);
    }
  }
  return { changed: [...changed], errors };
}
```

NOTE: check `findRouteDestination`'s exact signature (work-items.ts:244) — it may take `(boards, source, exit)` with exit's `toColumn` unused for destination lookup; adapt the call if its shape differs. If `toColumn` must exist on the destination, add a guard: destination lacking the column → error entry `route: ${dest.id} has no column ${effect.toColumn}`.

- [ ] **Step 4: Run** — `cd swarm && pnpm test 2>&1 | tail -5` → PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check swarm/src/terminal-effects.ts swarm/src/terminal-effects.test.ts
git add swarm/src/terminal-effects.ts swarm/src/terminal-effects.test.ts
git commit -m "feat(swarm): applyTerminalEffects — publish-jira + route-copy, idempotent

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire effects into the card-PATCH route (swarm)

**Files:**
- Modify: `swarm/src/server.ts` (card PATCH handler :2568-2658)
- Test: `swarm/src/terminal-effects.test.ts` (one more pure test), manual curl check

**Interfaces:**
- Consumes: `applyTerminalEffects`, `terminalColumnId` (Tasks 2/4), `createIssue` + connector resolution (Task 3).
- Produces: terminal effects firing on `PATCH /work/boards/:id/cards/:cardId` with a `columnId` landing on the terminal column; changed sibling boards persisted.

- [ ] **Step 1: Failing test** — the route body itself is untestable (no boot harness); pin the ONE remaining pure decision, the trigger predicate. Append to `swarm/src/terminal-effects.test.ts`:

```ts
test("shouldFireTerminal: only a columnId patch that LANDS on the terminal column fires", () => {
  const board = createBoard("ideation", "acme");
  const terminal = board.columns[board.columns.length - 1].id;
  assert.equal(shouldFireTerminal(board, terminal), true);
  assert.equal(shouldFireTerminal(board, board.columns[0].id), false);
  assert.equal(shouldFireTerminal(board, undefined), false); // title-only patch
  board.terminal = { columnId: board.columns[0].id, effects: [] };
  assert.equal(shouldFireTerminal(board, board.columns[0].id), true);
});
```

- [ ] **Step 2: Verify failure** — `cd swarm && pnpm test 2>&1 | tail -10` → FAIL.

- [ ] **Step 3: Implement** — in `terminal-effects.ts`:

```ts
/** The trigger: a patch that moves the card INTO the terminal column. */
export function shouldFireTerminal(board: WorkBoard, movedTo: string | undefined): boolean {
  return movedTo !== undefined && movedTo === terminalColumnId(board);
}
```

(import `terminalColumnId` from `./work-items.js`). Then in `server.ts`'s card PATCH handler, AFTER the existing jira push-on-move block (:2622-2646) and BEFORE persistence (:2651): read the existing block's shape first, then add:

```ts
// Terminal side-effects (spec 2026-08-13): fire on landing in the terminal
// column, beside the jira push precedent above — same rule, effects never
// fail the move. Sibling boards changed by a route-copy are saved before the
// own-board save below, mirroring routeCard's destination-first order.
const movedToColumn = (req.body as { columnId?: string }).columnId;
if (shouldFireTerminal(board, movedToColumn)) {
  const { changed, errors } = await applyTerminalEffects(board, card, all.boards, {
    createIssue: async (connectorId, projectKey, summary, description) => {
      const resolved = /* resolveAtlassianConnector chain — same adapter as Task 3's route */;
      if ("error" in resolved) throw new Error(resolved.error);
      return createIssue(siteUrlFor(resolved) /* read Task 3 adapter */, resolved.email, resolved.apiToken, projectKey, summary, description);
    },
    newId: () => randomUUID(),
    now: () => new Date().toISOString(),
  });
  for (const b of changed) if (b.id !== board.id) await saveBoard(this.workDir(), b);
  for (const e of errors) this.log?.warn?.(`[terminal-effects] ${e}`) ?? console.warn(`[terminal-effects] ${e}`);
}
```

IMPLEMENTER NOTES (read before writing): (a) the publish-jira effect needs a siteUrl — the connector resolution used by push-on-move reads `board.jira.siteUrl`; for effects, the siteUrl must come from the workspace's `atlassian.siteUrl` or the effect's connector — read how `resolveAtlassianConnector` call sites obtain siteUrl (server.ts:2622-2646 and :2737-2762) and follow the same source; if none is derivable without `board.jira`, extend the `publish-jira` effect shape check in Task 2 review — the spec's effect carries `connectorId + projectKey`, and the workspace record's `atlassian.siteUrl` is the documented lookup: load the board's workspace record and use `ws.atlassian?.siteUrl`, erroring the effect (never the move) when absent. (b) how card ids are minted today: read `addCard` — reuse the same id helper instead of `randomUUID` if one exists. (c) match `this.log` reality — read how the file logs elsewhere and copy it.

- [ ] **Step 4: Run + smoke** — `cd swarm && pnpm test 2>&1 | tail -5` → PASS. Then typecheck-only confirmation the route compiles: `cd swarm && pnpm build 2>&1 | tail -5` (or the package's check script — read package.json) → clean.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check swarm/src/server.ts swarm/src/terminal-effects.ts swarm/src/terminal-effects.test.ts
git add swarm/src/server.ts swarm/src/terminal-effects.ts swarm/src/terminal-effects.test.ts
git commit -m "feat(swarm): terminal effects fire on card-PATCH into the terminal column

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Boot migration — seed bindings + source rows (swarm)

**Files:**
- Create: `swarm/src/source-migration.ts`
- Modify: `swarm/src/server.ts` (call at boot, near where boards/workspaces first load)
- Test: `swarm/src/source-migration.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `ContextSource` (Task 1), `WorkBoard` blocks (Task 2).
- Produces: `seedSourceMigration(workspaces: Workspace[], boards: WorkBoard[]): { workspaceWrites: Workspace[]; boardWrites: WorkBoard[] }` — pure, idempotent (second run returns empty writes).

- [ ] **Step 1: Failing tests** — create `swarm/src/source-migration.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { seedSourceMigration } from "./source-migration.ts";
import { createBoard } from "./work-items.ts";
import type { Workspace } from "./workspaces.ts";

const WS: Workspace = { name: "acme", repos: [{ name: "app", path: "/tmp/app" }] };

test("a repo-bearing workspace gains a releases source; its react/maintain queues bind to it", () => {
  const reactive = createBoard("reactive", "acme");
  const maintenance = createBoard("maintenance", "acme");
  const { workspaceWrites, boardWrites } = seedSourceMigration([structuredClone(WS)], [reactive, maintenance]);
  assert.equal(workspaceWrites.length, 1);
  const src = workspaceWrites[0].sources?.find((s) => s.id === "releases");
  assert.ok(src);
  assert.equal(src.preset, "releases");
  assert.equal(src.cadence, "nightly");
  assert.deepEqual(boardWrites.map((b) => b.queue?.sourceIds), [["releases"], ["releases"]]);
});

test("board.jira becomes a jira source bound to that board's queue", () => {
  const plan = createBoard("plan", "acme");
  plan.jira = { connectorId: "atl-1", siteUrl: "https://acme.atlassian.net", projectKey: "PROJ" };
  const { workspaceWrites, boardWrites } = seedSourceMigration([structuredClone(WS)], [plan]);
  const src = workspaceWrites[0].sources?.find((s) => s.id === "jira-plan");
  assert.ok(src);
  assert.equal(src.preset, "jira");
  assert.equal(src.origin.connectorId, "atl-1");
  assert.equal(src.origin.query, "project = PROJ ORDER BY updated DESC");
  assert.equal(src.transform.mode, "map");
  assert.deepEqual(boardWrites.find((b) => b.id === plan.id)?.queue?.sourceIds, ["jira-plan"]);
});

test("the migration is idempotent — a seeded state produces zero writes", () => {
  const reactive = createBoard("reactive", "acme");
  const first = seedSourceMigration([structuredClone(WS)], [reactive]);
  const again = seedSourceMigration(first.workspaceWrites, first.boardWrites);
  assert.equal(again.workspaceWrites.length, 0);
  assert.equal(again.boardWrites.length, 0);
});

test("groupish records and repo-less workspaces gain nothing", () => {
  const group: Workspace = { name: "core", repos: [], members: ["acme"] };
  const { workspaceWrites } = seedSourceMigration([group], []);
  assert.equal(workspaceWrites.length, 0);
});
```

- [ ] **Step 2: Verify failure** — `cd swarm && pnpm test 2>&1 | tail -10` → FAIL.

- [ ] **Step 3: Implement** — create `swarm/src/source-migration.ts`:

```ts
// One-way boot seeding (spec 2026-08-13 queue-sources Part 4): existing
// pipelines become visible source rows + bindings so day-one behavior is
// unchanged. Pure and idempotent — the server loops the writes into
// saveWorkspace/saveBoard and logs each one.
import { isGroupRecord, type ContextSource, type Workspace } from "./workspaces.js";
import type { WorkBoard } from "./work-items.js";

const RELEASES: Omit<ContextSource, "id"> = {
  name: "Repo releases",
  preset: "releases",
  origin: {},
  cadence: "nightly",
  transform: { mode: "analyze" },
  enabled: true,
};

export function seedSourceMigration(
  workspaces: Workspace[],
  boards: WorkBoard[],
): { workspaceWrites: Workspace[]; boardWrites: WorkBoard[] } {
  const workspaceWrites: Workspace[] = [];
  const boardWrites: WorkBoard[] = [];
  for (const ws of workspaces) {
    if (isGroupRecord(ws)) continue;
    let changed = false;
    const sources = [...(ws.sources ?? [])];
    const wsBoards = boards.filter((b) => b.workspaceId === ws.name);

    if (ws.repos.length > 0 && !sources.some((s) => s.id === "releases")) {
      sources.push({ id: "releases", ...RELEASES });
      changed = true;
    }
    for (const board of wsBoards) {
      if (board.jira && !sources.some((s) => s.id === `jira-${board.type}`)) {
        sources.push({
          id: `jira-${board.type}`,
          name: `${board.jira.projectKey} tickets`,
          preset: "jira",
          origin: {
            connectorId: board.jira.connectorId,
            url: board.jira.siteUrl,
            query: board.jira.jql?.trim() || `project = ${board.jira.projectKey} ORDER BY updated DESC`,
          },
          cadence: "nightly",
          transform: { mode: "map" },
          enabled: true,
        });
        changed = true;
      }
    }
    if (changed) workspaceWrites.push({ ...ws, sources });

    for (const board of wsBoards) {
      const want: string[] = [];
      if (ws.repos.length > 0 && (board.type === "reactive" || board.type === "maintenance")) want.push("releases");
      if (board.jira) want.push(`jira-${board.type}`);
      const have = board.queue?.sourceIds ?? [];
      const missing = want.filter((id) => !have.includes(id));
      if (missing.length > 0) {
        board.queue = { sourceIds: [...have, ...missing] };
        boardWrites.push(board);
      }
    }
  }
  return { workspaceWrites, boardWrites };
}
```

Boot wiring in `server.ts`: find where boards + workspaces are both first available at startup (near the midnight-sweep setup ~:494 or the constructor's initial load — READ the boot sequence first); add:

```ts
const migration = seedSourceMigration(await loadAllContextsFromDir(this.workspacesDir()), (await loadBoards(this.workDir())).boards);
for (const ws of migration.workspaceWrites) { await saveWorkspace(this.workspacesDir(), ws); console.log(`[source-migration] seeded sources on ${ws.name}`); }
for (const b of migration.boardWrites) { await saveBoard(this.workDir(), b); console.log(`[source-migration] bound queue on ${b.id}`); }
```

(adapt dir-helper names to the file's actual ones — read how neighboring boot code resolves `.smith/workspaces` and `.smith/work`).

- [ ] **Step 4: Run** — `cd swarm && pnpm test 2>&1 | tail -5` → PASS; `pnpm build`/check clean.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check swarm/src/source-migration.ts swarm/src/source-migration.test.ts swarm/src/server.ts
git add swarm/src/source-migration.ts swarm/src/source-migration.test.ts swarm/src/server.ts
git commit -m "feat(swarm): boot migration seeds source rows + queue bindings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Per-source cadence in the due-source seam (broker)

**Files:**
- Modify: `broker/src/feeds/types.ts` (FeedSource), `broker/src/feeds/ingest.ts`
- Test: `broker/src/feeds/ingest.test.ts`

**Interfaces:**
- Produces: `FeedSource` gains `cadence?: "hourly" | "6h" | "nightly"` plus (for later tasks, add now in one pass) `contextId?: string`, `connectorId?: string`, `query?: string`, `analyzePrompt?: string`, and `kind` union extended with `"jira" | "http"`; exported `cadenceMs(source: FeedSource): number`.
- Consumed by: Tasks 8-11.

- [ ] **Step 1: Failing tests** — append to `broker/src/feeds/ingest.test.ts` (it has `const NOW = Date.parse("2026-08-11T12:00:00Z")` and an `EMPTY` FeedState literal — reuse them):

```ts
test("cadenceMs prefers the source's own cadence and falls back to the kind default", () => {
  const base: FeedSource = { id: "s", label: "s", kind: "rss", locator: "https://x/f.xml", tag: "tech", origin: "manual", enabled: true };
  assert.equal(cadenceMs(base), 20 * 60_000);
  assert.equal(cadenceMs({ ...base, cadence: "hourly" }), 3_600_000);
  assert.equal(cadenceMs({ ...base, cadence: "6h" }), 21_600_000);
  assert.equal(cadenceMs({ ...base, cadence: "nightly" }), 86_400_000);
  assert.equal(cadenceMs({ ...base, kind: "jira", cadence: "nightly" }), 86_400_000);
});

test("a nightly source fetched two hours ago is not due; a stale one is", () => {
  const src: FeedSource = { id: "n", label: "n", kind: "http", locator: "https://x", tag: "tech", origin: "derived", enabled: true, cadence: "nightly" };
  const fresh = { ...EMPTY, sources: { n: { lastFetchedAt: new Date(NOW - 2 * 3_600_000).toISOString(), consecutiveFailures: 0 } } };
  assert.deepEqual(dueSources([src], fresh, NOW), []);
  const stale = { ...EMPTY, sources: { n: { lastFetchedAt: new Date(NOW - 26 * 3_600_000).toISOString(), consecutiveFailures: 0 } } };
  assert.deepEqual(dueSources([src], stale, NOW).map((s) => s.id), ["n"]);
});
```

NOTE: `kind: "jira" | "http"` needs a `CADENCE_MS` entry too (they're `Record<kind, number>`): jira 60 * 60_000, http 60 * 60_000 — the per-source cadence normally overrides these.

- [ ] **Step 2: Verify failure** — `cd broker && pnpm test 2>&1 | tail -20` → FAIL.

- [ ] **Step 3: Implement**

`types.ts` FeedSource additions (after `topicId?`):

```ts
  /** Context-source polling (spec 2026-08-13 queue-sources): the workspace-record
      source this row mirrors. Absent on manual/manifest/topic rows. */
  contextId?: string;
  /** Per-source cadence override; absent = the kind's CADENCE_MS default. */
  cadence?: "hourly" | "6h" | "nightly";
  connectorId?: string;
  query?: string;
  analyzePrompt?: string;
```

and `kind: "rss" | "weather" | "x" | "registry" | "jira" | "http";`

`ingest.ts`:

```ts
const CADENCE_OVERRIDE_MS: Record<NonNullable<FeedSource["cadence"]>, number> = {
  hourly: 3_600_000,
  "6h": 21_600_000,
  nightly: 86_400_000,
};

/** The one cadence input (spec deviation note: no cron exists — cadence IS this seam). */
export function cadenceMs(source: FeedSource): number {
  return source.cadence ? CADENCE_OVERRIDE_MS[source.cadence] : CADENCE_MS[source.kind];
}
```

Extend `CADENCE_MS` with `jira: 60 * 60_000, http: 60 * 60_000`; replace the `CADENCE_MS[source.kind]` read inside `dueSources` with `cadenceMs(source)` (keep the jitter exactly as-is).

- [ ] **Step 4: Run** — `cd broker && pnpm test 2>&1 | tail -5` → PASS (FeedState `EMPTY` literals in other test files may need no change — FeedState is untouched).

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check broker/src/feeds/types.ts broker/src/feeds/ingest.ts broker/src/feeds/ingest.test.ts
git add broker/src/feeds/types.ts broker/src/feeds/ingest.ts broker/src/feeds/ingest.test.ts
git commit -m "feat(broker): per-source cadence override in the due-source seam

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Context-source sync into the feeds store (broker)

**Files:**
- Create: `broker/src/feeds/context-sources.ts`
- Modify: `broker/src/main.ts` (derive tick wiring, beside `deriveFromManifests` :1837), `broker/src/swarm-client.ts` (`WorkspaceBody` :85-100 + `listWorkspaces` return type)
- Test: `broker/src/feeds/context-sources.test.ts`

**Interfaces:**
- Consumes: `GET /workspaces` now returning `sources` (Task 1); `FeedSource` fields (Task 7).
- Produces: `contextSourceId(workspace: string, id: string): string` (`ctx:${workspace}:${id}`), `fromContextSources(workspaces: Array<{ name: string; sources?: ContextSourceWire[] }>, existing: FeedSource[]): FeedSource[]` where `ContextSourceWire` is a local structural type mirroring swarm's `ContextSource`. Only presets `jira | observability | support | custom` produce rows (kind `jira` for jira preset, `http` otherwise); `releases`/`topic` presets are EXECUTED by the existing pipelines and produce no row (their binding changes targeting only, Task 11). Dismissed rows stay dismissed like `derive.ts:21`.

- [ ] **Step 1: Failing tests** — create `broker/src/feeds/context-sources.test.ts` (copy the import/style header of `derive.test.ts`):

```ts
test("jira preset becomes a jira row carrying connector, query, cadence, workspace, contextId", () => {
  const rows = fromContextSources(
    [{ name: "acme", sources: [{ id: "jira-plan", name: "PROJ", preset: "jira", origin: { connectorId: "atl-1", url: "https://a.atlassian.net", query: "project = PROJ" }, cadence: "6h", transform: { mode: "map" }, enabled: true }] }],
    [],
  );
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.id, "ctx:acme:jira-plan");
  assert.equal(r.kind, "jira");
  assert.equal(r.locator, "https://a.atlassian.net");
  assert.equal(r.query, "project = PROJ");
  assert.equal(r.connectorId, "atl-1");
  assert.equal(r.cadence, "6h");
  assert.equal(r.workspace, "acme");
  assert.equal(r.contextId, "jira-plan");
  assert.equal(r.origin, "derived");
});

test("releases and topic presets produce no rows — their executors already exist", () => {
  const rows = fromContextSources(
    [{ name: "acme", sources: [
      { id: "releases", name: "r", preset: "releases", origin: {}, cadence: "nightly", transform: { mode: "analyze" }, enabled: true },
      { id: "t1", name: "t", preset: "topic", origin: { query: "spring boot" }, cadence: "nightly", transform: { mode: "analyze" }, enabled: true },
    ] }],
    [],
  );
  assert.deepEqual(rows, []);
});

test("disabled sources drop out; a previously dismissed row stays dismissed", () => {
  const ws = [{ name: "acme", sources: [
    { id: "s1", name: "s1", preset: "custom", origin: { url: "https://o.example/api" }, cadence: "hourly", transform: { mode: "analyze", prompt: "watch errors" }, enabled: true },
    { id: "s2", name: "s2", preset: "custom", origin: { url: "https://x.example" }, cadence: "hourly", transform: { mode: "analyze" }, enabled: false },
  ] }];
  const existing: FeedSource[] = [{ id: "ctx:acme:s1", label: "s1", kind: "http", locator: "https://o.example/api", tag: "tech", origin: "derived", enabled: true, dismissed: true }];
  const rows = fromContextSources(ws, existing);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dismissed, true);
  assert.equal(rows[0].analyzePrompt, "watch errors");
});
```

- [ ] **Step 2: Verify failure** — `cd broker && pnpm test 2>&1 | tail -10` → FAIL.

- [ ] **Step 3: Implement** — create `broker/src/feeds/context-sources.ts`:

```ts
// Context sources → FeedSource rows (spec 2026-08-13 queue-sources). The
// swarm's workspace records own the definitions; this mirrors the pollable
// ones into the feeds store on the hourly derive tick, the exact pattern
// deriveSources uses for manifests. releases/topic presets produce NO row:
// their executors (registry derivation, topic machinery) already exist and
// only their TARGETING moves to bindings.
import type { FeedSource } from "./types.ts";

export interface ContextSourceWire {
  id: string;
  name: string;
  preset: "jira" | "releases" | "topic" | "observability" | "support" | "custom";
  origin: { connectorId?: string; url?: string; query?: string };
  cadence: "hourly" | "6h" | "nightly";
  transform: { mode: "map" } | { mode: "analyze"; prompt?: string };
  enabled: boolean;
}

export function contextSourceId(workspace: string, id: string): string {
  return `ctx:${workspace}:${id}`;
}

export function fromContextSources(
  workspaces: Array<{ name: string; sources?: ContextSourceWire[] }>,
  existing: FeedSource[],
): FeedSource[] {
  const dismissed = new Set(existing.filter((s) => s.dismissed).map((s) => s.id));
  const rows: FeedSource[] = [];
  for (const ws of workspaces) {
    for (const src of ws.sources ?? []) {
      if (!src.enabled) continue;
      if (src.preset === "releases" || src.preset === "topic") continue;
      const id = contextSourceId(ws.name, src.id);
      rows.push({
        id,
        label: src.name,
        kind: src.preset === "jira" ? "jira" : "http",
        locator: src.origin.url ?? "",
        tag: "tech",
        origin: "derived",
        reason: `context source of ${ws.name}`,
        enabled: true,
        dismissed: dismissed.has(id) ? true : undefined,
        workspace: ws.name,
        contextId: src.id,
        cadence: src.cadence,
        connectorId: src.origin.connectorId,
        query: src.origin.query,
        analyzePrompt: src.transform.mode === "analyze" ? src.transform.prompt : undefined,
      });
    }
  }
  return rows;
}
```

`swarm-client.ts`: extend `WorkspaceBody` (:85-100) with `sources?: unknown[];` and make `listWorkspaces`'s return type carry `sources?: ContextSourceWire[]`-shaped rows (read its current declared return; if it's a loose `unknown`/mapped type, extend minimally — the broker only READS sources, never writes them through this client; but the PUT body dropping `sources` would WIPE them on any broker-side workspace write, so the `WorkspaceBody` extension is mandatory, with a comment: `// sources ride through untouched — dropping them here would wipe context sources on every workspace save`).

`main.ts` wiring beside `:1837`:

```ts
const syncContextSources = async () => {
  try {
    const workspaces = await swarm.listWorkspaces();
    const rows = fromContextSources(workspaces, feedStore.sources());
    for (const row of rows) feedStore.putSource(row);
    // remove ctx: rows whose context source vanished
    const live = new Set(rows.map((r) => r.id));
    for (const s of feedStore.sources()) if (s.id.startsWith("ctx:") && !live.has(s.id)) feedStore.removeSource(s.id);
  } catch (err) {
    console.warn(`[feeds] context-source sync failed: ${String(err)}`);
  }
};
void syncContextSources();
setInterval(() => void syncContextSources(), DERIVE_TICK_MS).unref();
```

TDZ NOTE: this boot call touches `feedStore` — place the wiring AFTER `feedStore`'s construction at main.ts:2053, NOT beside deriveFromManifests' :1837 registration (which predates the store and survives only via its leading await; see explorer note). Put both the function and its timer after :2053.

- [ ] **Step 4: Run** — `cd broker && pnpm test 2>&1 | tail -5` → PASS; broker typecheck/build clean.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check broker/src/feeds/context-sources.ts broker/src/feeds/context-sources.test.ts broker/src/main.ts broker/src/swarm-client.ts
git add broker/src/feeds/context-sources.ts broker/src/feeds/context-sources.test.ts broker/src/main.ts broker/src/swarm-client.ts
git commit -m "feat(broker): context sources sync into the feeds store on the derive tick

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Jira polling — map transform (broker)

**Files:**
- Create: `broker/src/feeds/jira-poll.ts`
- Modify: `broker/src/main.ts` (`fetchSource` branch)
- Test: `broker/src/feeds/jira-poll.test.ts`

**Interfaces:**
- Consumes: swarm `POST /atlassian/search` (Task 3) via `swarm.work(method, path, body)` (swarm-client.ts:657); `FeedSource` jira fields (Tasks 7/8).
- Produces: `jiraItemsFrom(issues: Array<{ key: string; summary: string; url: string }>, sourceId: string, publishedAt: string): FeedItem[]` — id `${sourceId}-${key}`, tag `"tech"`, title `[${key}] ${summary}`, summary = issue summary, url.

- [ ] **Step 1: Failing tests** — create `broker/src/feeds/jira-poll.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { jiraItemsFrom } from "./jira-poll.ts";

test("issues map to items keyed by source+issue so a re-poll dedups in addItems", () => {
  const items = jiraItemsFrom(
    [{ key: "PROJ-1", summary: "Fix login", url: "https://a/browse/PROJ-1" }],
    "ctx:acme:jira-plan",
    "2026-08-13T12:00:00Z",
  );
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: "ctx:acme:jira-plan-PROJ-1",
    sourceId: "ctx:acme:jira-plan",
    tag: "tech",
    title: "[PROJ-1] Fix login",
    url: "https://a/browse/PROJ-1",
    publishedAt: "2026-08-13T12:00:00Z",
    summary: "Fix login",
  });
});
```

- [ ] **Step 2: Verify failure** → FAIL (module missing).

- [ ] **Step 3: Implement** — `broker/src/feeds/jira-poll.ts`:

```ts
// Jira context sources, map transform (spec 2026-08-13 queue-sources): the
// swarm runs the JQL (it holds the credentials — POST /atlassian/search);
// this module only shapes the wire result into FeedItems. Item id reuses the
// addItems dedup: a re-poll of known issues yields no fresh items, no cards.
import type { FeedItem } from "./types.ts";

export function jiraItemsFrom(
  issues: Array<{ key: string; summary: string; url: string }>,
  sourceId: string,
  publishedAt: string,
): FeedItem[] {
  return issues.map((i) => ({
    id: `${sourceId}-${i.key}`,
    sourceId,
    tag: "tech",
    title: `[${i.key}] ${i.summary}`,
    url: i.url,
    publishedAt,
    summary: i.summary,
  }));
}
```

`main.ts` — add a branch to `fetchSource` (before the fallthrough, matching the existing branch style):

```ts
if (source.kind === "jira") {
  if (!source.connectorId || !source.locator || !source.query) return { ok: false, error: "jira source missing connector/site/query" };
  const res = await swarm.work("POST", "/atlassian/search", { connectorId: source.connectorId, siteUrl: source.locator, jql: source.query });
  if (res.status >= 400) return { ok: false, error: `search ${res.status}` };
  const issues = (res.payload as { issues?: Array<{ key: string; summary: string; url: string }> }).issues ?? [];
  const fresh = feedStore.addItems(jiraItemsFrom(issues, source.id, new Date().toISOString()));
  for (const item of fresh) await cardContextItem(source, item); // Task 11 provides cardContextItem; until then leave a `// carded in Task 11` no-op loop OUT and just return
  return { ok: true };
}
```

SEQUENCING NOTE: Tasks 9 and 10 both reference `cardContextItem` which Task 11 creates. To keep every task green on its own: in THIS task, stop at `feedStore.addItems(...)` (items land in the store, digest may surface them) and add `// TODO(task-11): card fresh items — bindings land with cardForSource` — this is the ONE sanctioned deferred wire-up, closed by Task 11 which deletes the comment.

- [ ] **Step 4: Run** — `cd broker && pnpm test 2>&1 | tail -5` → PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check broker/src/feeds/jira-poll.ts broker/src/feeds/jira-poll.test.ts broker/src/main.ts
git add broker/src/feeds/jira-poll.ts broker/src/feeds/jira-poll.test.ts broker/src/main.ts
git commit -m "feat(broker): jira context sources poll via the swarm search endpoint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: HTTP polling — analyze transform (broker)

**Files:**
- Create: `broker/src/feeds/analyze.ts`
- Modify: `broker/src/main.ts` (`fetchSource` http branch)
- Test: `broker/src/feeds/analyze.test.ts`

**Interfaces:**
- Produces: `analyzeBrief(source: { label: string; analyzePrompt?: string }, raw: string): string` (prompt builder, raw capped at 6000 chars) and `workItemsFrom(text: string): Array<{ title: string; notes: string }>` (parses the model's `WORK ITEM: <title>` / following-lines-as-notes format; empty array for "NOTHING" or unparseable).
- Consumes: url-guard (`urlRejectionReason`), the anthropic client pattern (main.ts:1688 precedent).

- [ ] **Step 1: Failing tests** — create `broker/src/feeds/analyze.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeBrief, workItemsFrom } from "./analyze.ts";

test("the brief carries the source's own prompt and caps the raw payload", () => {
  const brief = analyzeBrief({ label: "Sentry acme", analyzePrompt: "only real incidents" }, "x".repeat(10_000));
  assert.match(brief, /only real incidents/);
  assert.match(brief, /Sentry acme/);
  assert.ok(brief.length < 7_000);
});

test("workItemsFrom parses WORK ITEM blocks and returns [] for NOTHING", () => {
  const parsed = workItemsFrom("WORK ITEM: Fix payment webhook 500s\nSeen 42 times since Tuesday.\nWORK ITEM: Rotate expiring cert\nExpires in 6 days.");
  assert.deepEqual(parsed, [
    { title: "Fix payment webhook 500s", notes: "Seen 42 times since Tuesday." },
    { title: "Rotate expiring cert", notes: "Expires in 6 days." },
  ]);
  assert.deepEqual(workItemsFrom("NOTHING"), []);
  assert.deepEqual(workItemsFrom(""), []);
});
```

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement** — `broker/src/feeds/analyze.ts`:

```ts
// Analyze transform (spec 2026-08-13 queue-sources): an LLM judges a polled
// payload into zero or more work items. Pure prompt/parse halves — the LLM
// call itself is injected in main.ts exactly like cards.ts's plan() dep.
const RAW_CAP = 6_000;

export function analyzeBrief(source: { label: string; analyzePrompt?: string }, raw: string): string {
  return [
    `You triage a monitoring feed ("${source.label}") for a working engineer.`,
    source.analyzePrompt ? `Operator instruction: ${source.analyzePrompt}` : "",
    'Findings that deserve action become work items. Output each as a line "WORK ITEM: <imperative title>" followed by 1-3 lines of notes. If nothing deserves action, output exactly "NOTHING".',
    "",
    raw.slice(0, RAW_CAP),
  ]
    .filter(Boolean)
    .join("\n");
}

export function workItemsFrom(text: string): Array<{ title: string; notes: string }> {
  const items: Array<{ title: string; notes: string }> = [];
  let current: { title: string; notes: string[] } | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s*WORK ITEM:\s*(.+)$/.exec(line);
    if (m) {
      if (current) items.push({ title: current.title, notes: current.notes.join("\n").trim() });
      current = { title: m[1].trim(), notes: [] };
    } else if (current && line.trim()) {
      current.notes.push(line.trim());
    }
  }
  if (current) items.push({ title: current.title, notes: current.notes.join("\n").trim() });
  return items;
}
```

`main.ts` http branch in `fetchSource` (before the fallthrough; mirror the generic-rss branch's url-guard usage at :1888):

```ts
if (source.kind === "http") {
  const rejection = urlRejectionReason(source.locator);
  if (rejection) return { ok: false, error: rejection };
  const res = await fetch(source.locator);
  if (!res.ok) return { ok: false, error: `http ${res.status}` };
  const raw = await res.text();
  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 700,
    messages: [{ role: "user", content: analyzeBrief(source, raw) }],
  });
  const found = workItemsFrom(message.content.map((b) => ("text" in b ? b.text : "")).join(""));
  const stamp = new Date().toISOString();
  const fresh = feedStore.addItems(
    found.map((w, i) => ({
      id: `${source.id}-${stamp}-${i}`,
      sourceId: source.id,
      tag: "tech" as const,
      title: w.title,
      publishedAt: stamp,
      summary: w.notes.slice(0, 400),
    })),
  );
  // TODO(task-11): card fresh items — bindings land with cardForSource
  void fresh;
  return { ok: true };
}
```

DEDUP NOTE (encode as a comment in the branch): analyze items are stamped per run, so `addItems` can't dedup them across polls — cross-poll dedup for analyze sources is the CARD-side `sourceRef` check (Task 11) with `itemKey = title` (a stable-enough key for judged items; an identical title on a bound board means it's already tracked).

- [ ] **Step 4: Run** — `cd broker && pnpm test 2>&1 | tail -5` → PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check broker/src/feeds/analyze.ts broker/src/feeds/analyze.test.ts broker/src/main.ts
git add broker/src/feeds/analyze.ts broker/src/feeds/analyze.test.ts broker/src/main.ts
git commit -m "feat(broker): http context sources — LLM analyze transform

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Binding-driven carding (broker) — replaces boardTypeFor

**Files:**
- Modify: `broker/src/feeds/cards.ts`, `broker/src/main.ts` (makeCard + the two TODO(task-11) sites + topics boot ensure)
- Test: `broker/src/feeds/cards.test.ts`

**Interfaces:**
- Consumes: boards now carrying `queue?/columns` over the wire (`GET /work/boards` returns full boards); `contextSourceId` (Task 8); cards POST body accepting `sourceRef` + `columnId` (Task 2).
- Produces:

```ts
export interface BoundBoard { id: string; type: string; workspaceId?: string; columns: Array<{ id: string }>; queue?: { sourceIds: string[] }; cards: Array<{ sourceRef?: { sourceId: string; itemKey: string } }>; }
export function boardsBoundTo(boards: BoundBoard[], workspace: string | undefined, contextId: string): BoundBoard[]
export function intakeColumnIdOf(board: BoundBoard): string | undefined   // queue lane else first column (broker-side copy of swarm's resolver — cannot import across packages; keep in lockstep, both cite the spec)
export function releaseTargetBoards(boards: BoundBoard[], item: FeedItem, workspace: string): BoundBoard[]  // bound boards of the right type; [] falls back to legacy boardTypeFor pair
export async function cardForSource(deps: { addCard(boardId: string, card: { title: string; notes: string; columnId: string; sourceRef: { sourceId: string; itemKey: string } }): Promise<void> }, boards: BoundBoard[], source: { id: string; workspace?: string; contextId?: string }, items: Array<{ title: string; summary: string; itemKey: string }>): Promise<{ carded: number }>
```

- [ ] **Step 1: Failing tests** — append to `broker/src/feeds/cards.test.ts` (reuse its fixture style):

```ts
const BOUND: BoundBoard[] = [
  { id: "acme-plan", type: "plan", workspaceId: "acme", columns: [{ id: "queue" }, { id: "backlog" }], queue: { sourceIds: ["jira-plan"] }, cards: [] },
  { id: "acme-maintenance", type: "maintenance", workspaceId: "acme", columns: [{ id: "queue" }, { id: "triage" }], queue: { sourceIds: ["releases"] }, cards: [] },
  { id: "acme-reactive", type: "reactive", workspaceId: "acme", columns: [{ id: "queue" }, { id: "triage" }], queue: { sourceIds: ["releases"] }, cards: [] },
];

test("boardsBoundTo matches workspace + binding; intake prefers the queue lane", () => {
  const bound = boardsBoundTo(BOUND, "acme", "jira-plan");
  assert.deepEqual(bound.map((b) => b.id), ["acme-plan"]);
  assert.equal(intakeColumnIdOf(bound[0]), "queue");
  assert.equal(intakeColumnIdOf({ ...bound[0], columns: [{ id: "intake" }] }), "intake");
});

test("cardForSource cards each unseen item into every bound intake and skips sourceRef-known ones", async () => {
  const sink: unknown[] = [];
  const boards = structuredClone(BOUND);
  boards[0].cards.push({ sourceRef: { sourceId: "ctx:acme:jira-plan", itemKey: "PROJ-1" } });
  const res = await cardForSource(
    { addCard: async (boardId, card) => void sink.push({ boardId, ...card }) },
    boards,
    { id: "ctx:acme:jira-plan", workspace: "acme", contextId: "jira-plan" },
    [
      { title: "[PROJ-1] known", summary: "s", itemKey: "PROJ-1" },
      { title: "[PROJ-2] new", summary: "s2", itemKey: "PROJ-2" },
    ],
  );
  assert.equal(res.carded, 1);
  assert.deepEqual(sink, [
    { boardId: "acme-plan", title: "[PROJ-2] new", notes: "s2", columnId: "queue", sourceRef: { sourceId: "ctx:acme:jira-plan", itemKey: "PROJ-2" } },
  ]);
});

test("releaseTargetBoards: security → bound reactive, else bound maintenance; unbound falls back to boardTypeFor equivalence", () => {
  const sec = { release: { name: "x", version: "1", bump: "patch", security: true } } as unknown as FeedItem;
  const plain = { release: { name: "x", version: "1", bump: "patch", security: false } } as unknown as FeedItem;
  assert.deepEqual(releaseTargetBoards(BOUND, sec, "acme").map((b) => b.id), ["acme-reactive"]);
  assert.deepEqual(releaseTargetBoards(BOUND, plain, "acme").map((b) => b.id), ["acme-maintenance"]);
  const unbound = BOUND.map((b) => ({ ...b, queue: undefined }));
  // regression: with no bindings the pick must equal boardTypeFor's board
  assert.deepEqual(releaseTargetBoards(unbound, sec, "acme").map((b) => b.type), ["reactive"]);
  assert.deepEqual(releaseTargetBoards(unbound, plain, "acme").map((b) => b.type), ["maintenance"]);
});
```

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement** in `cards.ts` (keep `cardForRelease`/`boardTypeFor` exported — release path still calls through them):

```ts
export interface BoundBoard {
  id: string;
  type: string;
  workspaceId?: string;
  columns: Array<{ id: string }>;
  queue?: { sourceIds: string[] };
  cards: Array<{ sourceRef?: { sourceId: string; itemKey: string } }>;
}

export function boardsBoundTo(boards: BoundBoard[], workspace: string | undefined, contextId: string): BoundBoard[] {
  return boards.filter((b) => b.workspaceId === workspace && (b.queue?.sourceIds ?? []).includes(contextId));
}

/** Broker-side copy of the swarm's intake resolver (cannot import across
    packages) — queue lane when present, else first column. Spec 2026-08-13. */
export function intakeColumnIdOf(board: BoundBoard): string | undefined {
  return (board.columns.find((c) => c.id === "queue") ?? board.columns[0])?.id;
}

/** Release targeting: bindings first, legacy boardTypeFor as the unbound
    fallback — migrated installs behave byte-for-byte (regression-tested). */
export function releaseTargetBoards(boards: BoundBoard[], item: FeedItem, workspace: string): BoundBoard[] {
  const wanted = boardTypeFor(item);
  const bound = boardsBoundTo(boards, workspace, "releases").filter((b) => b.type === wanted);
  if (bound.length > 0) return bound;
  const legacy = boards.find((b) => b.type === wanted && b.workspaceId === workspace);
  return legacy ? [legacy] : [];
}

export async function cardForSource(
  deps: { addCard(boardId: string, card: { title: string; notes: string; columnId: string; sourceRef: { sourceId: string; itemKey: string } }): Promise<void> },
  boards: BoundBoard[],
  source: { id: string; workspace?: string; contextId?: string },
  items: Array<{ title: string; summary: string; itemKey: string }>,
): Promise<{ carded: number }> {
  if (!source.contextId) return { carded: 0 };
  let carded = 0;
  for (const board of boardsBoundTo(boards, source.workspace, source.contextId)) {
    const column = intakeColumnIdOf(board);
    if (!column) continue;
    for (const item of items) {
      const ref = { sourceId: source.id, itemKey: item.itemKey };
      if (board.cards.some((c) => c.sourceRef?.sourceId === ref.sourceId && c.sourceRef.itemKey === ref.itemKey)) continue;
      await deps.addCard(board.id, { title: item.title, notes: item.summary, columnId: column, sourceRef: ref });
      carded++;
    }
  }
  return { carded };
}
```

`main.ts`:
- Add `cardContextItem` helper (after makeCard): fetches boards via the existing GET (reuse the deps.boards() pattern but request FULL boards — read main.ts:1679-1682 and widen the pluck to `{id,type,workspaceId,columns,queue,cards}`), calls `cardForSource` with a single item (`itemKey` = jira issue key parsed from item.id suffix for jira sources — pass it explicitly from the Task 9/10 branches instead of re-parsing: change both TODO sites to call `cardContextItem(source, [{ title: item.title, summary: item.summary, itemKey }])` where Task 9 passes the issue `key` and Task 10 passes `w.title`), addCard POST body now includes `columnId` + `sourceRef`. Delete both `// TODO(task-11)` comments.
- makeCard's release path: replace the `boardTypeFor` find (:in makeCard's deps `boards()` usage inside cards.ts — `cardForRelease` keeps its legacy behavior for compat; instead REPLACE makeCard's call with a small wrapper that uses `releaseTargetBoards` + `cardForRelease`'s plan dep: concretely, change `cardForRelease`'s board-find line from `(await deps.boards()).find((b) => b.type === wanted && b.workspaceId === ctx.workspace)` to `releaseTargetBoards(await deps.boards() as BoundBoard[], item, ctx.workspace)[0]` and keep `columnId: "triage"` for releases (spec: migrated rows keep landing where today's engine puts them). Update `cardForRelease`'s deps.boards() return type to BoundBoard[].
- Topics boot ensure: after `syncContextSources` definition add a one-shot `ensureTopicRows()`: for each `topicStore.all()` topic with status active, if the default workspace's record lacks source id `topic-${topic.id}`, PUT the workspace with the row appended (`preset: "topic"`, `origin: { query: topic.name }`, cadence nightly, transform analyze, enabled true) via `swarm.updateWorkspace`-equivalent (read swarm-client's workspace update fn name) — log each seed; failures warn and continue. Call `void ensureTopicRows();` once after the store exists.

- [ ] **Step 4: Run** — `cd broker && pnpm test 2>&1 | tail -5` → PASS (existing cards.test.ts release tests must still pass — the fallback keeps them green).

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check broker/src/feeds/cards.ts broker/src/feeds/cards.test.ts broker/src/main.ts
git add broker/src/feeds/cards.ts broker/src/feeds/cards.test.ts broker/src/main.ts
git commit -m "feat(broker): binding-driven carding with sourceRef dedup replaces boardTypeFor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Control-plane types + clients + hooks

**Files:**
- Modify: `control-plane/src/api/types.ts` (WorkspaceRecord :227-247), `control-plane/src/api/work.ts`, `control-plane/src/queries/work.ts`, `control-plane/src/organisms/BoardStage.tsx` (WorkBoardT/WorkCardT), `control-plane/src/organisms/WorkspaceManagerModal.tsx` (`toRecord` allowlist ~:155)
- Test: `control-plane/src/organisms/WorkspaceManagerModal.test.tsx` (or its existing test file — find it), `control-plane/src/queries/work.test.ts` if one exists (else the api call is covered by Task 14's stubFetch flows)

**Interfaces:**
- Produces:

```ts
// api/types.ts
export interface ContextSourceT {
  id: string; name: string;
  preset: "jira" | "releases" | "topic" | "observability" | "support" | "custom";
  origin: { connectorId?: string; url?: string; query?: string };
  cadence: "hourly" | "6h" | "nightly";
  transform: { mode: "map" } | { mode: "analyze"; prompt?: string };
  enabled: boolean;
}
export type TerminalEffectT =
  | { kind: "publish-jira"; connectorId: string; projectKey: string }
  | { kind: "route"; toType: string; toColumn: string };
// WorkspaceRecord gains: sources?: ContextSourceT[];
// BoardStage WorkBoardT gains: queue?: { sourceIds: string[] }; terminal?: { columnId?: string; effects: TerminalEffectT[] };
// WorkCardT gains: sourceRef?: { sourceId: string; itemKey: string };

// api/work.ts (throws-on-failure convention)
export async function patchBoard(boardId: string, body: { queue?: { sourceIds: string[] }; terminal?: { columnId?: string; effects: TerminalEffectT[] } }, base: string = BROKER_BASE): Promise<void>

// queries/work.ts
export function useUpdateBoard() // mutationFn ({boardId, body}) => api.patchBoard(boardId, body); onSuccess invalidates qk.boards
```

- Consumed by: Tasks 13-15.

- [ ] **Step 1: Failing test** — the load-bearing regression is the `toRecord` wipe. Find WorkspaceManagerModal's test file (`grep -l "toRecord\|WorkspaceManagerModal" control-plane/src/**/*.test.tsx`); add:

```tsx
it("saving a workspace from the manager preserves sources it does not edit", async () => {
  // Render the manager with a record carrying sources; drive one ordinary save
  // (e.g. edit description) using the existing test's helpers; assert the
  // save function receives body.sources deep-equal to the seeded sources.
  // COPY the file's existing save-flow test and add the sources field to its
  // fixture + the deep-equal assertion on the captured body.
});
```

(The implementer copies the file's own established save-flow test verbatim and extends fixture + assertion — the test's exact helpers vary and the file is the source of truth. The assertion that matters: `expect(saved.sources).toEqual(fixture.sources)`.)

- [ ] **Step 2: Verify failure** — `cd control-plane && pnpm vitest run src/organisms/WorkspaceManagerModal.test.tsx` → FAIL (`sources` dropped by toRecord).

- [ ] **Step 3: Implement** — types as in Interfaces above; `toRecord` gains a passthrough line `sources: existing?.sources,` (read the function: it builds from form values + the record being edited — carry the UNEDITED field from that record, with the comment `// not edited here — the queue gear owns sources; dropping this line wipes them on every save`). `api/work.ts`:

```ts
/** PATCH /work/boards/:id — edge-column config only. First board-patch client:
    name/columns/jira stay unexposed here until a UI needs them. */
export async function patchBoard(
  boardId: string,
  body: { queue?: { sourceIds: string[] }; terminal?: { columnId?: string; effects: TerminalEffectT[] } },
  base: string = BROKER_BASE,
): Promise<void> {
  const res = await brokerFetch(`/work/boards/${encodeURIComponent(boardId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, base);
  if (!res.ok) throw new Error(`patch board failed (${res.status})`);
}
```

(READ api/work.ts:83-98's `patchCard` first and mirror its exact fetch helper/headers/error style — the snippet above approximates; the file's own idiom wins.) `queries/work.ts`:

```ts
export function useUpdateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ boardId, body }: { boardId: string; body: Parameters<typeof api.patchBoard>[1] }) => api.patchBoard(boardId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.boards }),
  });
}
```

- [ ] **Step 4: Run** — `cd control-plane && pnpm vitest run src/organisms/WorkspaceManagerModal.test.tsx src/queries` → PASS; `pnpm vitest run` full suite green.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check control-plane/src/api/types.ts control-plane/src/api/work.ts control-plane/src/queries/work.ts control-plane/src/organisms/BoardStage.tsx control-plane/src/organisms/WorkspaceManagerModal.tsx
git add -A control-plane/src
git status --short   # verify ONLY the files above are staged; unstage anything else
git commit -m "feat(cp): edge-block types, patchBoard client, sources survive the manager

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: The edge-column gear (control plane)

**Files:**
- Modify: `control-plane/src/molecules/BoardColumn.tsx`, `control-plane/src/organisms/BoardStage.tsx`, `control-plane/src/styles/components.css` (beside .board-column rules ~:2631)
- Test: Create `control-plane/src/molecules/BoardColumn.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BoardColumn` gains optional prop `onConfigure?: () => void`; when present, the header renders `<button type="button" className="board-column__config" aria-label={`Configure ${col.name} column`}>` with lucide `Settings size={12} strokeWidth={2}`. BoardStage passes it ONLY when the tab maps to a single board (`tab.boardIds.length === 1` — config is per-board; aggregate hides gears) and only for the intake column (`col.id === "queue"`, or the first column when the board has no queue lane) and the terminal column (`board.terminal?.columnId ?? last`), setting parent-owned state `configOpen: { boardId: string; column: "queue" | "terminal" } | null`.

- [ ] **Step 1: Failing test** — create `control-plane/src/molecules/BoardColumn.test.tsx` (bare render like CardSheet.test.tsx — BoardColumn needs DndContext? It calls `useDroppable`/`SortableContext`: wrap render in `<DndContext>` from @dnd-kit/core; copy BoardStage.test.tsx's imports):

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DndContext } from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardColumn } from "./BoardColumn";

afterEach(cleanup);

const COL = { id: "queue", name: "Queue" };
const PROPS = {
  col: COL,
  clusters: [{ label: null, cards: [] }],
  colorFor: () => undefined,
  agentFor: () => undefined,
  onOpenCard: () => {},
};

describe("BoardColumn config gear", () => {
  it("renders the gear only when onConfigure is provided, labeled for the column", async () => {
    const { rerender } = render(<DndContext><BoardColumn {...PROPS} /></DndContext>);
    expect(screen.queryByRole("button", { name: "Configure Queue column" })).toBeNull();
    const onConfigure = vi.fn();
    rerender(<DndContext><BoardColumn {...PROPS} onConfigure={onConfigure} /></DndContext>);
    await userEvent.click(screen.getByRole("button", { name: "Configure Queue column" }));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Verify failure** — `cd control-plane && pnpm vitest run src/molecules/BoardColumn.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

BoardColumn: add `onConfigure?: () => void` to the props type; replace the bare h3 with a header row:

```tsx
      <div className="board-column__head">
        <h3 className="board-column__name">{col.name}</h3>
        {onConfigure && (
          <button
            type="button"
            className="board-column__config"
            aria-label={`Configure ${col.name} column`}
            onClick={onConfigure}
          >
            <Settings size={12} strokeWidth={2} />
          </button>
        )}
      </div>
```

(`import { Settings } from "lucide-react";`). CSS beside the .board-column block (session-row__delete is the canonical hover-reveal — copy its opacity/:focus-visible/reduced-motion shape):

```css
.board-column__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
/* Config gear: hover-revealed like .session-row__delete — opacity not display,
   so no reflow and keyboard users reveal it with :focus-visible. */
.board-column__config {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms ease;
}
.board-column:hover .board-column__config,
.board-column__config:focus-visible {
  opacity: 1;
}
.board-column__config:hover {
  color: var(--text);
  border-color: var(--pill-br);
  background: rgba(255, 255, 255, 0.04);
}
@media (prefers-reduced-motion: reduce) {
  .board-column__config { transition: none; }
}
```

BoardStage: add `const [configOpen, setConfigOpen] = useState<{ boardId: string; column: "queue" | "terminal" } | null>(null);` beside the `open` state (:205). In the columns map, compute per column (single-board tabs only):

```tsx
const configBoard = tab.boardIds.length === 1 ? (boardOf(tab.boardIds[0]) ?? null) : null;
// inside columns.map: intake = queue col if the board has one, else first column; terminal = explicit ?? last
const intakeId = configBoard ? (configBoard.columns.some((c) => c.id === "queue") ? "queue" : configBoard.columns[0]?.id) : null;
const terminalId = configBoard ? (configBoard.terminal?.columnId ?? configBoard.columns[configBoard.columns.length - 1]?.id) : null;
```

and pass `onConfigure={col.id === intakeId ? () => setConfigOpen({ boardId: configBoard.id, column: "queue" }) : col.id === terminalId ? () => setConfigOpen({ boardId: configBoard.id, column: "terminal" }) : undefined}`. (Place the two derived ids ABOVE the map, not inline per column. Reset `configOpen` in the existing scope/tab-keyed reset effect at :253-258 — read it and add `setConfigOpen(null)` beside its `setOpen(null)`.) Sheets mount in Task 14/15 — until then `configOpen` is set but renders nothing; add `void configOpen;` ONLY if lint complains, and remove it in Task 14.

- [ ] **Step 4: Run** — `cd control-plane && pnpm vitest run src/molecules/BoardColumn.test.tsx src/organisms/BoardStage.test.tsx` → PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check control-plane/src/molecules/BoardColumn.tsx control-plane/src/molecules/BoardColumn.test.tsx control-plane/src/organisms/BoardStage.tsx control-plane/src/styles/components.css
git add control-plane/src/molecules/BoardColumn.tsx control-plane/src/molecules/BoardColumn.test.tsx control-plane/src/organisms/BoardStage.tsx control-plane/src/styles/components.css
git commit -m "feat(cp): hover-revealed config gear on the edge columns

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Queue sources sheet (control plane)

**Files:**
- Create: `control-plane/src/organisms/QueueSourcesSheet.tsx`
- Modify: `control-plane/src/organisms/BoardStage.tsx` (mount)
- Test: `control-plane/src/organisms/QueueSourcesSheet.test.tsx`

**Interfaces:**
- Consumes: `useWorkspaceRecords`, `useSaveWorkspace` (queries/http.ts), `useUpdateBoard` (Task 12), `ModalShell` + `FormTextField`/`FormSelect` (molecules/form/), `ContextSourceT`, `BOARD_ROUTES_UI` (lib/board-aggregate).
- Produces: `<QueueSourcesSheet board={WorkBoardT} open={boolean} onClose={() => void} />` — Pattern B (hooks directly). Content: (1) toggle list of the board's workspace's sources — checked = bound (`board.queue.sourceIds`), toggling calls `useUpdateBoard` with the new array; (2) "Add source" form (preset select → prefills cadence/transform defaults; name, url, query, connectorId, cadence, analyze prompt fields; `mode: "onChange"`, create button gated on isValid) saving via `useSaveWorkspace` with `{...record, sources: [...(record.sources ?? []), next]}`, `isNew: false`; (3) read-only "Arrives from" list: `BOARD_ROUTES_UI` entries whose `toType === board.type`, rendered as `${fromBoardType}: ${exit.label}` lines.

- [ ] **Step 1: Failing tests** — create the test with the BoardStage stubFetch pattern (copy stubFetch + afterEach from BoardStage.test.tsx :53-79; renderWithProviders for the Query hooks):

```tsx
const RECORD = {
  name: "acme", default: false, repos: [{ name: "app", path: "/a", branch: "main" }],
  sources: [
    { id: "jira-plan", name: "PROJ tickets", preset: "jira", origin: { connectorId: "atl-1", url: "https://a.atlassian.net", query: "project = PROJ" }, cadence: "nightly", transform: { mode: "map" }, enabled: true },
    { id: "s2", name: "Sentry", preset: "observability", origin: { url: "https://sentry.example/api" }, cadence: "hourly", transform: { mode: "analyze" }, enabled: true },
  ],
};
const BOARD = { id: "acme-plan", name: "Plan", type: "plan", workspaceId: "acme", columns: [{ id: "queue", name: "Queue" }], cards: [], queue: { sourceIds: ["jira-plan"] } };

it("lists the workspace's sources with bound ones checked; toggling patches the board's sourceIds", async () => {
  stubFetch({ workspaces: [RECORD] });
  renderWithProviders(<QueueSourcesSheet board={BOARD as never} open onClose={() => {}} />);
  const bound = await screen.findByRole("checkbox", { name: /PROJ tickets/ });
  expect(bound).toBeChecked();
  const unbound = screen.getByRole("checkbox", { name: /Sentry/ });
  expect(unbound).not.toBeChecked();
  await userEvent.click(unbound);
  const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/work/boards/acme-plan"));
  expect(patch?.body).toEqual({ queue: { sourceIds: ["jira-plan", "s2"] } });
});

it("adding a source PUTs the whole workspace record with the new row appended", async () => {
  stubFetch({ workspaces: [RECORD] });
  renderWithProviders(<QueueSourcesSheet board={BOARD as never} open onClose={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: /add source/i }));
  await userEvent.selectOptions(screen.getByLabelText(/preset/i), "custom");
  await userEvent.type(screen.getByLabelText(/^name/i), "Support inbox");
  await userEvent.type(screen.getByLabelText(/url/i), "https://support.example/feed");
  await userEvent.click(screen.getByRole("button", { name: /create source/i }));
  const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/workspaces/acme"));
  const sources = (put?.body as { sources: Array<{ name: string }> }).sources;
  expect(sources).toHaveLength(3);
  expect(sources[2]).toMatchObject({ name: "Support inbox", preset: "custom", cadence: "nightly", enabled: true });
});

it("shows where cards arrive from via routes, read-only", async () => {
  stubFetch({ workspaces: [RECORD] });
  renderWithProviders(<QueueSourcesSheet board={{ ...BOARD, type: "deliver" } as never} open onClose={() => {}} />);
  // BOARD_ROUTES_UI: plan.ready → deliver/ready
  expect(await screen.findByText(/plan/i)).toBeDefined();
});
```

(stubFetch needs `workspaces` + PATCH/PUT catch-alls — extend the local copy: match `GET /workspaces` → RECORD list, `PATCH /work/boards/...` → `{}`, `PUT /workspaces/...` → `{}`. `calls` is the recorded array from the pattern.)

- [ ] **Step 2: Verify failure** → FAIL (module missing).

- [ ] **Step 3: Implement** `QueueSourcesSheet.tsx` — ModalShell wrapper (`<ModalShell open={open} onClose={onClose} title={`${board.name} · queue sources`}>`), body:

- `const { data: records = [] } = useWorkspaceRecords(open);` — `const record = records.find((r) => r.name === board.workspaceId);` (workspace-less personal board: render "Personal boards have no context sources." and nothing else).
- Toggle list: for each `record.sources ?? []`, a labeled checkbox (`<label><input type="checkbox" checked={bound} onChange={...} /> {s.name} <span className="q-sheet__preset">{s.preset}</span></label>`); onChange builds `next = checked ? [...ids, s.id] : ids.filter((x) => x !== s.id)` and `updateBoard.mutate({ boardId: board.id, body: { queue: { sourceIds: next } } })`.
- Add-source form: RHF `useForm({ mode: "onChange", defaultValues: { preset: "jira", name: "", url: "", query: "", connectorId: "", cadence: "nightly", prompt: "" } })`; preset select options are the six presets; on create: `save.mutate({ body: { ...record, sources: [...(record.sources ?? []), row] }, isNew: false })` where `row` maps form → ContextSourceT (`transform: preset === "jira" ? { mode: "map" } : { mode: "analyze", prompt: prompt || undefined }`, `id: slugified name + suffix if colliding` — write a tiny `sourceIdFor(name, existing)` helper in the file: lowercase, non-alnum → `-`, append `-2`, `-3`… while colliding).
- Arrives-from list: `Object.entries(BOARD_ROUTES_UI).flatMap(([fromType, exits]) => exits.filter((e) => e.toType === board.type).map((e) => `${fromType} · ${e.label}`))` rendered as muted lines under a "Cards also arrive from" heading; plus, when other boards' terminal route effects exist targeting this type, they arrive on the boards frame — v1 renders the static route table only (comment this).
- Error surface: mutation failures → local `error` state line, ModalShell body bottom (both hooks' mutateAsync try/catch — mirror CardSheet's error pattern).

Mount in BoardStage beside CardSheet:

```tsx
{configOpen?.column === "queue" && boardOf(configOpen.boardId) && (
  <QueueSourcesSheet board={boardOf(configOpen.boardId) as WorkBoardT} open onClose={() => setConfigOpen(null)} />
)}
```

- [ ] **Step 4: Run** — `cd control-plane && pnpm vitest run src/organisms/QueueSourcesSheet.test.tsx src/organisms/BoardStage.test.tsx` → PASS.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check control-plane/src/organisms/QueueSourcesSheet.tsx control-plane/src/organisms/QueueSourcesSheet.test.tsx control-plane/src/organisms/BoardStage.tsx
git add control-plane/src/organisms/QueueSourcesSheet.tsx control-plane/src/organisms/QueueSourcesSheet.test.tsx control-plane/src/organisms/BoardStage.tsx
git commit -m "feat(cp): queue sources sheet — bindings, source CRUD, arrival routes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: Terminal effects sheet (control plane)

**Files:**
- Create: `control-plane/src/organisms/TerminalEffectsSheet.tsx`
- Modify: `control-plane/src/organisms/BoardStage.tsx` (mount)
- Test: `control-plane/src/organisms/TerminalEffectsSheet.test.tsx`

**Interfaces:**
- Consumes: `useUpdateBoard` (Task 12), `ModalShell`, `TerminalEffectT`, `BOARD_ROUTES_UI`.
- Produces: `<TerminalEffectsSheet board={WorkBoardT} open onClose />`: (1) terminal-column select over `board.columns` (value = `board.terminal?.columnId ?? last`; change patches `terminal: { ...current, columnId }`); (2) effects list with remove buttons; (3) add-effect form — kind select (`publish-jira` | `route`); publish-jira → connectorId + projectKey text fields; route → toType select over board types + toColumn text field (validated non-empty; the swarm validates existence). Every write is `useUpdateBoard` with the full `terminal` block.

- [ ] **Step 1: Failing tests** — same stubFetch pattern:

```tsx
const BOARD = {
  id: "acme-ideation", name: "Ideate", type: "ideation", workspaceId: "acme",
  columns: [{ id: "scoping", name: "Scoping" }, { id: "killed", name: "Killed" }],
  cards: [],
  terminal: { effects: [{ kind: "route", toType: "plan", toColumn: "queue" }] },
};

it("shows the terminal column defaulting to the last column and patches on change", async () => {
  stubFetch({});
  renderWithProviders(<TerminalEffectsSheet board={BOARD as never} open onClose={() => {}} />);
  const select = await screen.findByLabelText(/terminal column/i);
  expect(select).toHaveValue("killed");
  await userEvent.selectOptions(select, "scoping");
  const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/work/boards/acme-ideation"));
  expect(patch?.body).toEqual({ terminal: { columnId: "scoping", effects: BOARD.terminal.effects } });
});

it("adds a publish-jira effect with connector and project", async () => {
  stubFetch({});
  renderWithProviders(<TerminalEffectsSheet board={BOARD as never} open onClose={() => {}} />);
  await userEvent.selectOptions(await screen.findByLabelText(/effect kind/i), "publish-jira");
  await userEvent.type(screen.getByLabelText(/connector/i), "atl-1");
  await userEvent.type(screen.getByLabelText(/project key/i), "PROJ");
  await userEvent.click(screen.getByRole("button", { name: /add effect/i }));
  const patch = calls.find((c) => c.method === "PATCH");
  expect((patch?.body as { terminal: { effects: unknown[] } }).terminal.effects).toHaveLength(2);
});

it("removes an effect", async () => {
  stubFetch({});
  renderWithProviders(<TerminalEffectsSheet board={BOARD as never} open onClose={() => {}} />);
  await userEvent.click(await screen.findByRole("button", { name: /remove route to plan/i }));
  const patch = calls.find((c) => c.method === "PATCH");
  expect((patch?.body as { terminal: { effects: unknown[] } }).terminal.effects).toHaveLength(0);
});
```

- [ ] **Step 2: Verify failure** → FAIL.

- [ ] **Step 3: Implement** — ModalShell titled `` `${board.name} · completion effects` ``; local `const effects = board.terminal?.effects ?? []; const columnId = board.terminal?.columnId ?? board.columns[board.columns.length - 1]?.id;`; every mutation sends the complete block: `update.mutate({ boardId: board.id, body: { terminal: { columnId: nextColumnId, effects: nextEffects } } })` — when only defaulted (`board.terminal?.columnId` absent and unchanged) omit `columnId` from the sent block so the default stays live (`terminal: { ...(board.terminal?.columnId ? { columnId: board.terminal.columnId } : {}), effects: next }`). Effect rows render as `route → plan/queue` / `publish-jira → PROJ (atl-1)` with `aria-label={`Remove ${kind} to ${target}`}` remove buttons. Add-effect kind select drives conditional fields (`hidden={...}`, never unmount — the modals' documented RHF rule). RHF `mode: "onChange"`, add gated on the kind's required fields.

Mount in BoardStage: `{configOpen?.column === "terminal" && ...}` mirroring Task 14.

- [ ] **Step 4: Run** — `cd control-plane && pnpm vitest run src/organisms/TerminalEffectsSheet.test.tsx` → PASS; then the FULL suite: `pnpm vitest run 2>&1 | tail -5` → green.

- [ ] **Step 5: Lint + commit**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check control-plane/src/organisms/TerminalEffectsSheet.tsx control-plane/src/organisms/TerminalEffectsSheet.test.tsx control-plane/src/organisms/BoardStage.tsx
git add control-plane/src/organisms/TerminalEffectsSheet.tsx control-plane/src/organisms/TerminalEffectsSheet.test.tsx control-plane/src/organisms/BoardStage.tsx
git commit -m "feat(cp): terminal effects sheet — column picker, publish-jira, route

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: Full-suite verification + live smoke + memory

**Files:** none new (fixes only if suites fail)

- [ ] **Step 1: All three suites**

```bash
cd swarm && pnpm test 2>&1 | tail -3
cd ../broker && pnpm test 2>&1 | tail -3
cd ../control-plane && pnpm vitest run 2>&1 | tail -3
```
Expected: all green. Any failure → fix in the owning task's files, commit as `fix(...)`.

- [ ] **Step 2: Whole-branch lint** — `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents && pnpm biome check . 2>&1 | tail -3` → zero diagnostics.

- [ ] **Step 3: Live smoke (coordinate with Edwin — services restart REQUIRED and are live in tmux)**
This step is performed by the MAIN session, not a subagent, with Edwin aware:
1. Restart swarm + broker in their tmux sessions (`smith-swarm`, `smith-broker`) — never `pkill -f` unscoped.
2. Boot logs show `[source-migration]` seeding lines once; second restart shows none (idempotency live-check).
3. Gear: hover the Queue column on a single-board tab → gear appears top-right, opens the sources sheet; hover the terminal column → effects sheet. (Playwright shared tab; CSS hover verified visually.)
4. Jira source → Plan queue: add a jira source in the sheet (real connector), set cadence hourly, wait for/force a tick, confirm cards land in Plan's queue with the jira title, and a re-poll adds no duplicates.
5. Terminal publish: add publish-jira to a test board's terminal, walk a card there, confirm the issue exists in Jira and the card wears the key chip; move it out and back — no second issue.
6. Route effect: terminal route on Plan → Deliver queue; walk a card to Plan's terminal; the copy appears in Deliver's queue with `routedFrom`.

- [ ] **Step 4: Memory + push** — update the project memory (new file `queue-sources-terminal-effects-shipped`) with commit hash, the two executors' split, live-smoke results, and any deferred findings; push via the ecruz165 account dance; mark the spec's plan as executed.

## Self-Review Notes (already applied)

- Spec coverage: Part 1 → Tasks 1-2; Part 2 inflow → 7-11, outflow → 3-5; Part 3 → 12-15; Part 4 migration → 6 (+11 topics), testing → per-task + 16. Out-of-v1 list untouched by any task. ✓
- The one sanctioned cross-task deferral (`TODO(task-11)`) is explicitly opened in Tasks 9/10 and closed in Task 11. ✓
- Type consistency: `ContextSource`/`ContextSourceT`/`ContextSourceWire` are three declarations of one wire shape (swarm/cp/broker) — field-identical by construction; Tasks 1, 8, 12 each carry the full literal so drift is visible in review. `terminalColumnId`/`intakeColumnId` (swarm) vs `intakeColumnIdOf` (broker copy) — the broker name differs deliberately to flag it as a copy. ✓
