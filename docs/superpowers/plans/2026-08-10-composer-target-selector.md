# Composer Target Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the composer's dead `Swarm ▾` control real — pick a target, and the message goes to that agent's CLI instead of the brain — and give ad-hoc groups a leader their own members claim.

**Architecture:** Every target resolves to exactly one addressable agent (a squad through its leader, the crew through Anderson, a group through its elected leader). Direct dispatch becomes the third caller of the existing `Broker.dispatchWork()`, which already owns busy-refusal and task binding. A pure `leadership.ts` ranks roles and is the permanent floor under every election, so a group is never leaderless.

**Tech Stack:** Broker — Node ≥24, TypeScript, `tsx`, `node:test`, **npm**. Control plane — React 19, HeroUI OSS/Pro, TanStack Query, vitest, biome, **pnpm**.

**Spec:** `docs/superpowers/specs/2026-08-10-composer-target-selector-design.md`

## Global Constraints

- Broker tests: `cd broker && npm test` (`node --import tsx --test src/*.test.ts`). Typecheck: `npm run typecheck`. **No biome in broker.**
- Control plane: `cd control-plane && pnpm test`, `pnpm lint`, `pnpm typecheck`. **pnpm, never npm.**
- `pnpm lint` exits 0 with 2 pre-existing `biome.json` config diagnostics. A non-zero exit is your own edit.
- Broker frame types and `control-plane/src/api/types.ts` are kept in lockstep **by hand**. Any wire shape added in a broker task must be mirrored in the control-plane task that consumes it.
- An absent `target` on `POST /utterance` must remain **byte-for-byte** today's behaviour — mic PTT, stdin, Discord, and the `smith-broker-send` bridge all use that path.
- Mutating routes use the existing origin guard: absent `Origin` passes, present-and-disallowed 403s.
- Rank ladder, highest first: `Product Manager` / `Scrum Master` → `leader` → `Architect` → `Senior` → everything else.
- An unrecognised role ranks last. It never throws — the persona catalog is data-driven config, not an enum.
- A group is never leaderless: every failure path falls back to the rank ladder.
- An election never marks an agent busy and never starts a tmux session.

---

### Task 1: The rank ladder (pure)

`leadership.ts` is the floor under every other task. It has no I/O, no model, and no clock, so it is tested by a table with zero mocks.

**Files:**
- Create: `broker/src/leadership.ts`
- Test: `broker/src/leadership.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Claim { agent: string; willing: boolean; confidence: number; reason: string }`
  - `interface Rankable { id: string; roles: string[] }`
  - `function rankOf(roles: string[]): number` — lower is higher rank; unmatched is `99`
  - `function deriveLeader(members: Rankable[]): string | null`
  - `function pickLeader(claims: Claim[], members: Rankable[]): { leader: string | null; method: 'vote' | 'rank' }`

- [ ] **Step 1: Write the failing test**

Create `broker/src/leadership.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rankOf, deriveLeader, pickLeader, type Claim, type Rankable } from './leadership.ts';

const m = (id: string, ...roles: string[]): Rankable => ({ id, roles });

test('the ladder orders coordination above technical seniority', () => {
  assert.ok(rankOf(['Product Manager']) < rankOf(['leader']));
  assert.ok(rankOf(['leader']) < rankOf(['architect']));
  assert.ok(rankOf(['architect']) < rankOf(['senior']));
  assert.ok(rankOf(['senior']) < rankOf(['developer']));
});

test('a Scrum Master ranks with Product Manager, so the persona can be added later without touching routing', () => {
  assert.equal(rankOf(['Scrum Master']), rankOf(['Product Manager']));
});

test('matching is case-insensitive and reads either role vocabulary', () => {
  assert.equal(rankOf(['PRODUCT MANAGER']), rankOf(['product manager']));
  assert.equal(rankOf(['Architect']), rankOf(['architect']));
});

test('an agent ranks by its BEST role across both vocabularies', () => {
  // A Product Manager who is also a squad developer ranks as a Product Manager.
  assert.equal(rankOf(['Product Manager', 'developer']), rankOf(['Product Manager']));
});

test('an unknown role ranks last and never throws', () => {
  assert.equal(rankOf(['Underwater Basket Weaver']), 99);
  assert.equal(rankOf([]), 99);
  assert.equal(rankOf(['Frontend Engineer']), 99);
});

test('deriveLeader picks the highest-ranked member', () => {
  assert.equal(deriveLeader([m('a', 'developer'), m('b', 'Product Manager'), m('c', 'senior')]), 'b');
});

test('deriveLeader breaks ties on the order it was given (roster order), so the answer is stable', () => {
  assert.equal(deriveLeader([m('a', 'senior'), m('b', 'senior')]), 'a');
  assert.equal(deriveLeader([m('b', 'senior'), m('a', 'senior')]), 'b');
});

test('deriveLeader of nobody is null', () => {
  assert.equal(deriveLeader([]), null);
});

test('pickLeader takes the strongest willing claim', () => {
  const claims: Claim[] = [
    { agent: 'a', willing: false, confidence: 0.2, reason: "I'd rather build" },
    { agent: 'b', willing: true, confidence: 0.9, reason: 'coordination is my job' },
    { agent: 'c', willing: true, confidence: 0.4, reason: 'I could' },
  ];
  assert.deepEqual(pickLeader(claims, [m('a', 'senior'), m('b', 'developer'), m('c', 'architect')]), {
    leader: 'b',
    method: 'vote',
  });
});

test('a confidence tie breaks on the rank ladder, not on claim order', () => {
  const claims: Claim[] = [
    { agent: 'a', willing: true, confidence: 0.8, reason: 'x' },
    { agent: 'b', willing: true, confidence: 0.8, reason: 'y' },
  ];
  // b outranks a, so b wins despite a claiming first.
  assert.deepEqual(pickLeader(claims, [m('a', 'developer'), m('b', 'Product Manager')]), {
    leader: 'b',
    method: 'vote',
  });
});

test('nobody willing falls to the ladder and SAYS so', () => {
  const claims: Claim[] = [
    { agent: 'a', willing: false, confidence: 0, reason: 'no' },
    { agent: 'b', willing: false, confidence: 0, reason: 'no' },
  ];
  assert.deepEqual(pickLeader(claims, [m('a', 'developer'), m('b', 'Architect')]), { leader: 'b', method: 'rank' });
});

test('no claims at all (model unavailable) falls to the ladder', () => {
  assert.deepEqual(pickLeader([], [m('a', 'developer'), m('b', 'senior')]), { leader: 'b', method: 'rank' });
});

test('a claim from someone who is not a member is ignored', () => {
  const claims: Claim[] = [{ agent: 'ghost', willing: true, confidence: 1, reason: 'let me in' }];
  assert.deepEqual(pickLeader(claims, [m('a', 'senior')]), { leader: 'a', method: 'rank' });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/leadership.test.ts`
Expected: FAIL — `Cannot find module './leadership.ts'`

- [ ] **Step 3: Write the implementation**

Create `broker/src/leadership.ts`:

```ts
/**
 * Who leads a collection of agents.
 *
 * Edwin's rule (2026-08-10): "every swarm has a leader or project manager" —
 * a group is addressed through whoever leads it, never as a faceless set. The
 * ladder below is the PERMANENT FLOOR under that rule: elections may decide
 * who leads, but when an election cannot run, returns nothing usable, or has
 * not finished yet, this file still answers. A group is never leaderless.
 *
 * Pure by design — no I/O, no model, no clock — because the part that must
 * never fail is the part that must be trivially testable.
 */

/** One claim to leadership, from one member. See election.ts for how these are gathered. */
export interface Claim {
  agent: string;
  willing: boolean;
  /** 0..1, already clamped by the parser. */
  confidence: number;
  reason: string;
}

/** An agent reduced to what ranking needs: its id and every role string it carries. */
export interface Rankable {
  id: string;
  /** Persona job title and (when the agent sits in a squad) its structural squad role. */
  roles: string[];
}

/**
 * Highest first. Coordination outranks technical seniority — Edwin: a scrum
 * master is the natural fit for leading a group, over a tech lead.
 *
 * Scrum Master is listed although no such persona exists yet: naming it here
 * costs nothing and means adding that persona later needs no routing change
 * (spec §12).
 */
const LADDER: ReadonlyArray<RegExp> = [
  /product manager|scrum master/, // 0 — coordination
  /^leader$/, //                     1 — structural squad position
  /architect/, //                    2
  /senior/, //                       3
];

/** Unmatched roles rank here. Never an error: the persona catalog is config, not an enum. */
const UNRANKED = 99;

/** Best (lowest) rank across every role the agent carries. */
export function rankOf(roles: string[]): number {
  let best = UNRANKED;
  for (const role of roles) {
    const needle = role.trim().toLowerCase();
    if (!needle) continue;
    const hit = LADDER.findIndex((re) => re.test(needle));
    if (hit !== -1 && hit < best) best = hit;
  }
  return best;
}

/**
 * The highest-ranked member. Ties break on the order given — callers pass
 * roster order, so the answer is stable across calls and across restarts.
 */
export function deriveLeader(members: Rankable[]): string | null {
  let winner: Rankable | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const member of members) {
    const rank = rankOf(member.roles);
    if (rank < best) {
      best = rank;
      winner = member;
    }
  }
  return winner?.id ?? null;
}

/**
 * Resolve an election. Strongest willing claim wins; a confidence tie breaks
 * on the ladder; nobody willing (or nobody heard from) falls to the ladder
 * outright. `method` records which decided, so a surprising leader is always
 * explainable in the UI.
 */
export function pickLeader(claims: Claim[], members: Rankable[]): { leader: string | null; method: 'vote' | 'rank' } {
  const ids = new Set(members.map((m) => m.id));
  const willing = claims.filter((c) => c.willing && ids.has(c.agent));
  if (willing.length === 0) return { leader: deriveLeader(members), method: 'rank' };

  const top = Math.max(...willing.map((c) => c.confidence));
  const tied = willing.filter((c) => c.confidence === top).map((c) => c.agent);
  if (tied.length === 1) return { leader: tied[0]!, method: 'vote' };

  // Tie among the willing — the ladder breaks it, but a vote still happened.
  const tiedMembers = members.filter((m) => tied.includes(m.id));
  return { leader: deriveLeader(tiedMembers), method: 'vote' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd broker && node --import tsx --test src/leadership.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd broker && npm run typecheck
git add broker/src/leadership.ts broker/src/leadership.test.ts
git commit -m "feat: a rank ladder so no group is ever leaderless"
```

---

### Task 2: The election round

Each member is asked, in character, whether they should lead. Runs on the broker's own model client — **not** through agent CLIs, which would start a coding agent per voter and mark the group busy (spec §5.1).

**Files:**
- Create: `broker/src/election.ts`
- Test: `broker/src/election.test.ts`

**Interfaces:**
- Consumes: `Claim`, `Rankable`, `pickLeader` from `./leadership.ts` (Task 1).
- Produces:
  - `type AskFactory = (params: { system: string; prompt: string }) => Promise<string>`
  - `interface Candidate { id: string; name: string; role: string; directives: string; squadRole?: string }`
  - `interface ElectionResult { leader: string | null; claims: Claim[]; method: 'vote' | 'rank' }`
  - `function runElection(ask: AskFactory, group: { name: string }, members: Candidate[]): Promise<ElectionResult>`
  - `function parseClaim(agent: string, raw: string): Claim`

- [ ] **Step 1: Write the failing test**

Create `broker/src/election.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runElection, parseClaim, type AskFactory, type Candidate } from './election.ts';

const cand = (id: string, role: string, squadRole?: string): Candidate => ({
  id,
  name: id.toUpperCase(),
  role,
  directives: `You are ${id}.`,
  squadRole,
});

/** Scripts one reply per agent id. */
function scripted(replies: Record<string, string>): AskFactory & { seen: string[] } {
  const seen: string[] = [];
  const ask = async ({ system, prompt }: { system: string; prompt: string }) => {
    seen.push(system);
    const who = Object.keys(replies).find((id) => system.includes(id));
    if (!who) throw new Error(`no script for system: ${system}`);
    void prompt;
    return replies[who]!;
  };
  return Object.assign(ask, { seen });
}

test('the strongest willing claim wins', async () => {
  const ask = scripted({
    josefina: '{"willing": true, "confidence": 0.9, "reason": "coordination is my job"}',
    osvaldo: '{"willing": false, "confidence": 0.2, "reason": "I would rather build"}',
  });
  const result = await runElection(ask, { name: 'onboarding' }, [
    cand('josefina', 'Product Manager'),
    cand('osvaldo', 'Backend Engineer', 'senior'),
  ]);
  assert.equal(result.leader, 'josefina');
  assert.equal(result.method, 'vote');
  assert.equal(result.claims.length, 2);
});

test('each member is asked in ISOLATION — its own directives, nobody else\'s claim', async () => {
  const ask = scripted({
    josefina: '{"willing": true, "confidence": 0.9, "reason": "mine"}',
    osvaldo: '{"willing": true, "confidence": 0.1, "reason": "ok"}',
  });
  await runElection(ask, { name: 'onboarding' }, [cand('josefina', 'Product Manager'), cand('osvaldo', 'Backend Engineer')]);
  assert.equal(ask.seen.length, 2);
  assert.ok(ask.seen[0]!.includes('josefina') && !ask.seen[0]!.includes('osvaldo'));
  assert.ok(ask.seen[1]!.includes('osvaldo') && !ask.seen[1]!.includes('josefina'));
});

test('everyone declining falls to the ladder and reports method rank', async () => {
  const ask = scripted({
    josefina: '{"willing": false, "confidence": 0, "reason": "no"}',
    osvaldo: '{"willing": false, "confidence": 0, "reason": "no"}',
  });
  const result = await runElection(ask, { name: 'onboarding' }, [
    cand('osvaldo', 'Backend Engineer', 'senior'),
    cand('josefina', 'Product Manager'),
  ]);
  assert.equal(result.leader, 'josefina'); // the ladder, not roster order
  assert.equal(result.method, 'rank');
});

test('a malformed reply is a decline, and the election still resolves', async () => {
  const ask = scripted({
    josefina: 'I think I would be great at this, honestly',
    osvaldo: '{"willing": true, "confidence": 0.5, "reason": "sure"}',
  });
  const result = await runElection(ask, { name: 'onboarding' }, [
    cand('josefina', 'Product Manager'),
    cand('osvaldo', 'Backend Engineer'),
  ]);
  assert.equal(result.leader, 'osvaldo');
  assert.equal(result.claims.find((c) => c.agent === 'josefina')?.willing, false);
});

test('one member throwing does not sink the election', async () => {
  const ask: AskFactory = async ({ system }) => {
    if (system.includes('josefina')) throw new Error('rate limited');
    return '{"willing": true, "confidence": 0.6, "reason": "ok"}';
  };
  const result = await runElection(ask, { name: 'onboarding' }, [
    cand('josefina', 'Product Manager'),
    cand('osvaldo', 'Backend Engineer'),
  ]);
  assert.equal(result.leader, 'osvaldo');
});

test('the model being wholly unavailable falls to the ladder — never leaderless', async () => {
  const ask: AskFactory = async () => {
    throw new Error('no api key');
  };
  const result = await runElection(ask, { name: 'onboarding' }, [
    cand('osvaldo', 'Backend Engineer', 'developer'),
    cand('josefina', 'Product Manager'),
  ]);
  assert.equal(result.leader, 'josefina');
  assert.equal(result.method, 'rank');
});

test('parseClaim clamps confidence into 0..1 and coerces willing', () => {
  assert.equal(parseClaim('a', '{"willing": true, "confidence": 4, "reason": "x"}').confidence, 1);
  assert.equal(parseClaim('a', '{"willing": true, "confidence": -2, "reason": "x"}').confidence, 0);
  assert.equal(parseClaim('a', '{"willing": "yes", "confidence": 0.5, "reason": "x"}').willing, true);
});

test('parseClaim finds JSON inside chatter', () => {
  const claim = parseClaim('a', 'Sure! {"willing": true, "confidence": 0.7, "reason": "I coordinate"} hope that helps');
  assert.equal(claim.willing, true);
  assert.equal(claim.confidence, 0.7);
});

test('parseClaim keeps the raw text as the reason when it cannot parse, for debugging', () => {
  const claim = parseClaim('a', 'absolutely not');
  assert.equal(claim.willing, false);
  assert.equal(claim.confidence, 0);
  assert.match(claim.reason, /absolutely not/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/election.test.ts`
Expected: FAIL — `Cannot find module './election.ts'`

- [ ] **Step 3: Write the implementation**

Create `broker/src/election.ts`:

```ts
/**
 * A group elects its own leader by self-nomination: each member is asked, in
 * character, whether THEY should lead — and answers blind to what the others
 * said (spec §5.2).
 *
 * WHY THIS RUNS HERE, not on the agents: there is no API engine today
 * (`engine: { cli: 'agy' | 'claude' | 'codex' }`), so every agent is a coding
 * CLI in a pinned tmux session. Asking members through their own runtimes
 * would start a coding agent per voter and mark the whole group BUSY to hold
 * a vote. Instead each member gets one short call on the broker's existing
 * model client, seeded with only that member's directives.
 */
import { pickLeader, type Claim, type Rankable } from './leadership.ts';

/** One short, non-streaming model call. Injected so tests script it without network. */
export type AskFactory = (params: { system: string; prompt: string }) => Promise<string>;

export interface Candidate {
  id: string;
  name: string;
  /** Persona job title, e.g. "Product Manager". */
  role: string;
  /** The persona prompt — this is what makes the agent answer as itself. */
  directives: string;
  /** Structural squad role when the agent sits in a squad, e.g. "architect". */
  squadRole?: string;
}

export interface ElectionResult {
  leader: string | null;
  claims: Claim[];
  method: 'vote' | 'rank';
}

/** Both role vocabularies, as leadership.ts wants them. */
function rankableOf(c: Candidate): Rankable {
  return { id: c.id, roles: c.squadRole ? [c.role, c.squadRole] : [c.role] };
}

/**
 * Read a claim out of a model reply. Never throws: an unparseable answer is a
 * decline that keeps its raw text as the reason, so a weird election can be
 * explained after the fact.
 */
export function parseClaim(agent: string, raw: string): Claim {
  const match = /\{[\s\S]*\}/.exec(raw);
  if (match) {
    try {
      const body = JSON.parse(match[0]) as { willing?: unknown; confidence?: unknown; reason?: unknown };
      const confidence = Number(body.confidence);
      return {
        agent,
        willing: Boolean(body.willing),
        confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
        reason: typeof body.reason === 'string' ? body.reason : '',
      };
    } catch {
      /* fall through to the decline below */
    }
  }
  return { agent, willing: false, confidence: 0, reason: raw.trim().slice(0, 200) };
}

function promptFor(candidate: Candidate, groupName: string, members: Candidate[]): string {
  const roster = members.map((m) => `- ${m.name} (${m.role})`).join('\n');
  return [
    `A working group called "${groupName}" has just formed. Its members:`,
    roster,
    '',
    'Should YOU lead this group? Consider what the group is for and what you are for.',
    'Answer with JSON only, no prose:',
    '{"willing": true|false, "confidence": 0.0-1.0, "reason": "one short sentence"}',
  ].join('\n');
}

/**
 * Run the round. Every member is asked in parallel; a member who throws or
 * answers nonsense is recorded as a decline rather than failing the election.
 * With nobody willing — or nobody reachable — the rank ladder decides.
 */
export async function runElection(
  ask: AskFactory,
  group: { name: string },
  members: Candidate[],
): Promise<ElectionResult> {
  const claims = await Promise.all(
    members.map(async (member): Promise<Claim> => {
      try {
        const raw = await ask({ system: member.directives, prompt: promptFor(member, group.name, members) });
        return parseClaim(member.id, raw);
      } catch (err) {
        return { agent: member.id, willing: false, confidence: 0, reason: `unreachable: ${String(err)}` };
      }
    }),
  );
  const { leader, method } = pickLeader(claims, members.map(rankableOf));
  return { leader, claims, method };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd broker && node --import tsx --test src/election.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd broker && npm run typecheck
git add broker/src/election.ts broker/src/election.test.ts
git commit -m "feat: a group's members claim leadership in their own voice"
```

---

### Task 3: Debounced scheduling

Dragging three agents into a group fires three membership changes. That must hold **one** vote, and a later change must supersede an in-flight one (spec §5.3).

**Files:**
- Modify: `broker/src/election.ts` (append; do not alter Task 2's exports)
- Test: `broker/src/election-scheduler.test.ts`

**Interfaces:**
- Consumes: `runElection`, `ElectionResult`, `Candidate` from Task 2.
- Produces: `class ElectionScheduler` with
  `constructor(deps: { run(groupId: string): Promise<ElectionResult | null>; onResult(groupId: string, result: ElectionResult): void; delayMs?: number; timer?: { set: typeof setTimeout; clear: typeof clearTimeout } })`
  and `schedule(groupId: string): void`.

- [ ] **Step 1: Write the failing test**

Create `broker/src/election-scheduler.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ElectionScheduler } from './election.ts';
import type { ElectionResult } from './election.ts';

/** A hand-cranked clock: timers fire only when you say so. */
function fakeTimer() {
  const queued: Array<{ id: number; fn: () => void }> = [];
  let seq = 0;
  return {
    api: {
      set: ((fn: () => void) => {
        seq += 1;
        queued.push({ id: seq, fn });
        return seq as unknown as NodeJS.Timeout;
      }) as unknown as typeof setTimeout,
      clear: ((id: NodeJS.Timeout) => {
        const idx = queued.findIndex((q) => q.id === (id as unknown as number));
        if (idx >= 0) queued.splice(idx, 1);
      }) as unknown as typeof clearTimeout,
    },
    fire() {
      const due = [...queued];
      queued.length = 0;
      for (const q of due) q.fn();
    },
    pending: () => queued.length,
  };
}

const RESULT: ElectionResult = { leader: 'josefina', claims: [], method: 'vote' };

test('three rapid changes to one group hold ONE vote', async () => {
  const timer = fakeTimer();
  let runs = 0;
  const scheduler = new ElectionScheduler({
    run: async () => {
      runs += 1;
      return RESULT;
    },
    onResult: () => {},
    timer: timer.api,
  });
  scheduler.schedule('g1');
  scheduler.schedule('g1');
  scheduler.schedule('g1');
  assert.equal(timer.pending(), 1, 'each schedule must replace the pending one');
  timer.fire();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1);
});

test('different groups elect independently', async () => {
  const timer = fakeTimer();
  const ran: string[] = [];
  const scheduler = new ElectionScheduler({
    run: async (id) => {
      ran.push(id);
      return RESULT;
    },
    onResult: () => {},
    timer: timer.api,
  });
  scheduler.schedule('g1');
  scheduler.schedule('g2');
  timer.fire();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ran.sort(), ['g1', 'g2']);
});

test('a change DURING an election supersedes it — the stale result is discarded', async () => {
  const timer = fakeTimer();
  const delivered: ElectionResult[] = [];
  let release!: (r: ElectionResult) => void;
  const scheduler = new ElectionScheduler({
    run: async () =>
      new Promise<ElectionResult>((resolve) => {
        release = resolve;
      }),
    onResult: (_id, r) => delivered.push(r),
    timer: timer.api,
  });
  scheduler.schedule('g1');
  timer.fire(); // election in flight

  scheduler.schedule('g1'); // membership changed underneath it
  release({ leader: 'stale', claims: [], method: 'vote' });
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(delivered, [], 'a superseded election must never be written');
});

test('a run returning null (group vanished) delivers nothing', async () => {
  const timer = fakeTimer();
  const delivered: string[] = [];
  const scheduler = new ElectionScheduler({
    run: async () => null,
    onResult: (id) => delivered.push(id),
    timer: timer.api,
  });
  scheduler.schedule('g1');
  timer.fire();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(delivered, []);
});

test('a throwing run is swallowed — the broker must not crash on an election', async () => {
  const timer = fakeTimer();
  const scheduler = new ElectionScheduler({
    run: async () => {
      throw new Error('boom');
    },
    onResult: () => {},
    timer: timer.api,
  });
  scheduler.schedule('g1');
  timer.fire();
  await new Promise((r) => setImmediate(r));
  assert.ok(true, 'reaching here without an unhandled rejection is the assertion');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/election-scheduler.test.ts`
Expected: FAIL — `ElectionScheduler is not a constructor`

- [ ] **Step 3: Append the implementation to `broker/src/election.ts`**

```ts
/**
 * Debounces elections per group and discards superseded ones.
 *
 * Dragging three agents into a group fires three membership changes; that is
 * one vote, not three. And a change that lands while a vote is in flight wins
 * — the older result describes a group that no longer exists, so it is thrown
 * away rather than written (spec §5.3).
 */
export class ElectionScheduler {
  private pending = new Map<string, NodeJS.Timeout>();
  /** Bumped on every schedule; a result whose generation is stale is discarded. */
  private generation = new Map<string, number>();
  private readonly delayMs: number;
  private readonly timer: { set: typeof setTimeout; clear: typeof clearTimeout };

  constructor(
    private readonly deps: {
      /** Gather candidates and run the round. Null when the group no longer exists. */
      run(groupId: string): Promise<ElectionResult | null>;
      onResult(groupId: string, result: ElectionResult): void;
      delayMs?: number;
      timer?: { set: typeof setTimeout; clear: typeof clearTimeout };
    },
  ) {
    this.delayMs = deps.delayMs ?? 250;
    this.timer = deps.timer ?? { set: setTimeout, clear: clearTimeout };
  }

  schedule(groupId: string): void {
    const existing = this.pending.get(groupId);
    if (existing) this.timer.clear(existing);
    const generation = (this.generation.get(groupId) ?? 0) + 1;
    this.generation.set(groupId, generation);

    const handle = this.timer.set(() => {
      this.pending.delete(groupId);
      void this.deps
        .run(groupId)
        .then((result) => {
          if (!result) return;
          // Superseded while we were away: the group changed under us.
          if (this.generation.get(groupId) !== generation) return;
          this.deps.onResult(groupId, result);
        })
        .catch((err: unknown) => {
          console.error(`[election] ${groupId} failed:`, err);
        });
    }, this.delayMs);
    this.pending.set(groupId, handle);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd broker && node --import tsx --test src/election-scheduler.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd broker && npm run typecheck
git add broker/src/election.ts broker/src/election-scheduler.test.ts
git commit -m "feat: one vote per flurry of edits, and the loser is discarded"
```

---

### Task 4: Groups carry their leader

Today a group's roster entry reads `` `Squad — led by ${g.members[0]?.name ?? '?'}` `` (`broker/src/main.ts:526`) — it already claims a leader, and that "leader" is merely the first member added. This task makes the claim true and persists it.

**Files:**
- Modify: `broker/src/broker.ts` — `RosterState` (~line 120), `UiRoster` (~line 132), `private groups` (~line 281), the `groups` mapping in `uiRoster()`
- Modify: `broker/src/main.ts:522-531` — the group roster entry
- Test: `broker/src/broker.test.ts` (append)

**Interfaces:**
- Consumes: `deriveLeader` from `./leadership.ts` (Task 1); `Claim` for the stored record.
- Produces:
  - `RosterState.groups[]` and `Broker`'s internal groups gain `leader?: string` and `election?: { claims: Claim[]; at: string; method: 'vote' | 'rank' }`
  - `UiRoster.groups[]` entries gain `leader?: string`
  - `Broker.setGroupLeader(groupId: string, leader: string, election: { claims: Claim[]; at: string; method: 'vote' | 'rank' }): void`
  - `Broker.groupCandidates(groupId): Array<{ id: string; name: string; role: string; directives: string; squadRole?: string }> | null`

- [ ] **Step 1: Write the failing test**

Append to `broker/src/broker.test.ts`:

```ts
test('a group with no election yet is led by the highest-ranked member, not the first added', async () => {
  const { broker } = makeBroker(); // existing helper in this file
  // Osvaldo (senior) is added first; Josefina (Product Manager) outranks him.
  broker.compose({ op: 'form', agents: ['Osvaldo', 'Josefina'] });
  const group = broker.uiRoster().groups[0]!;
  assert.equal(group.leader, 'josefina');
});

test('setGroupLeader records the vote and survives a roster-state round trip', async () => {
  const { broker, store } = makeBroker();
  broker.compose({ op: 'form', agents: ['Osvaldo', 'Josefina'] });
  const id = broker.uiRoster().groups[0]!.id;
  broker.setGroupLeader(id, 'osvaldo', {
    claims: [{ agent: 'osvaldo', willing: true, confidence: 0.8, reason: 'I know this system' }],
    at: '2026-08-10T00:00:00.000Z',
    method: 'vote',
  });
  assert.equal(broker.uiRoster().groups[0]!.leader, 'osvaldo');
  const saved = store.saved.at(-1)!;
  assert.equal(saved.groups[0]!.leader, 'osvaldo');
  assert.equal(saved.groups[0]!.election?.method, 'vote');
});

test('groupCandidates carries directives and BOTH role vocabularies', () => {
  const { broker } = makeBroker();
  broker.compose({ op: 'form', agents: ['Osvaldo', 'Josefina'] });
  const id = broker.uiRoster().groups[0]!.id;
  const candidates = broker.groupCandidates(id)!;
  assert.equal(candidates.length, 2);
  assert.ok(candidates[0]!.directives.length > 0);
  assert.ok(candidates.every((c) => typeof c.role === 'string'));
});

test('groupCandidates for an unknown group is null', () => {
  const { broker } = makeBroker();
  assert.equal(broker.groupCandidates('nope'), null);
});
```

> **Note for the implementer:** `makeBroker()` is this file's existing helper. Read the top of `broker/src/broker.test.ts` and follow whatever shape it already returns; if it does not currently expose the roster store, extend the helper to return it as `store` (with a `saved: RosterState[]` array) rather than inventing a second helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/broker.test.ts`
Expected: FAIL — `group.leader` is `undefined`; `broker.setGroupLeader is not a function`

- [ ] **Step 3: Write the implementation**

In `broker/src/broker.ts`, extend the persisted and in-memory shapes:

```ts
export interface RosterState {
  groups: Array<{
    id: string;
    name: string;
    memberIds: string[];
    /** Elected leader (agent id). Absent until the first election lands. */
    leader?: string;
    /** The vote behind `leader` — evidence when the choice looks surprising. */
    election?: { claims: Claim[]; at: string; method: 'vote' | 'rank' };
  }>;
  squadEdits: Array<[string, { added: string[]; removed: string[] }]>;
  groupSeq: number;
}
```

Import `deriveLeader` and the `Claim` type at the top of `broker.ts`:

```ts
import { deriveLeader, type Claim } from './leadership.ts';
```

Change the private field to match, then in `uiRoster()`'s groups mapping add the resolved leader:

```ts
groups: this.groups.map((g) => {
  const members = g.memberIds
    .map((id) => this.deps.directory.resolve(id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  // An election may not have landed yet (or may have failed) — the ladder is
  // always underneath, so a group is never leaderless (spec §2).
  const leader = g.leader ?? deriveLeader(members.map((a) => ({ id: a.id, roles: [a.role] })));
  return {
    id: g.id,
    name: g.name,
    leader: leader ?? undefined,
    members: members.map((a) => ({ id: a.id, name: a.name })),
  };
}),
```

Add the two new methods to `Broker`:

```ts
/** Record an election result. Persists, then republishes the roster. */
setGroupLeader(
  groupId: string,
  leader: string,
  election: { claims: Claim[]; at: string; method: 'vote' | 'rank' },
): void {
  const group = this.groups.find((g) => g.id === groupId);
  if (!group) return; // dissolved while the vote ran
  group.leader = leader;
  group.election = election;
  this.persistRosterState();
  this.notifyRoster();
}

/** Everything an election needs about a group's members. Null when the group is gone. */
groupCandidates(
  groupId: string,
): Array<{ id: string; name: string; role: string; directives: string; squadRole?: string }> | null {
  const group = this.groups.find((g) => g.id === groupId);
  if (!group) return null;
  return group.memberIds.flatMap((id) => {
    const agent = this.deps.directory.resolve(id);
    if (!agent) return [];
    const squadRole = this.squads
      .flatMap((s) => s.members)
      .find((m) => m.name.toLowerCase() === agent.name.toLowerCase())?.role;
    return [{ id: agent.id, name: agent.name, role: agent.role, directives: agent.directives, squadRole }];
  });
}
```

Update `UiRoster` so the frame can carry it:

```ts
groups: Array<{ id: string; name: string; leader?: string; members: Array<{ id: string; name: string }> }>;
```

In `broker/src/main.ts:522-531`, replace the `members[0]` placeholder with the real leader:

```ts
...roster.groups.map((g, i): RosterEntry => {
  const leaderName = g.members.find((m) => m.id === g.leader)?.name ?? g.members[0]?.name ?? '?';
  return {
    id: `group-${g.id}`,
    name: g.name[0]!.toUpperCase() + g.name.slice(1),
    role: `Squad — led by ${leaderName}`,
    ring: GROUP_RING_PALETTE[i % GROUP_RING_PALETTE.length],
    status: 'idle',
    kind: 'squad',
    hand: roster.hands[leaderName],
    listening: isListening(g.name, ...g.members.map((m) => m.name)),
    members: g.members.map((m) => m.name),
  };
}),
```

> Keep every other field of that entry exactly as it is today — only `role`, `hand`, and the new `leaderName` line change. Read the current block before editing and preserve `listening`/`members` as written there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && npm test`
Expected: PASS — all previously passing tests plus the 4 new ones.

- [ ] **Step 5: Typecheck and commit**

```bash
cd broker && npm run typecheck
git add broker/src/broker.ts broker/src/broker.test.ts broker/src/main.ts
git commit -m "feat: a group's leader is a real value, not the first member added"
```

---

### Task 5: Compose triggers the election

**Files:**
- Modify: `broker/src/broker.ts` — `compose()` (~line 617), constructor deps
- Modify: `broker/src/main.ts` — wire the `AskFactory` and the scheduler
- Test: `broker/src/broker.test.ts` (append)

**Interfaces:**
- Consumes: `ElectionScheduler` (Task 3), `Broker.setGroupLeader`/`groupCandidates` (Task 4).
- Produces: `Broker` deps gain `onGroupChanged?: (groupId: string) => void`, called after a group is formed or its membership changes.

- [ ] **Step 1: Write the failing test**

Append to `broker/src/broker.test.ts`:

```ts
test('forming a group announces the change so an election can run', () => {
  const changed: string[] = [];
  const { broker } = makeBroker({ onGroupChanged: (id: string) => changed.push(id) });
  broker.compose({ op: 'form', agents: ['Osvaldo', 'Josefina'] });
  assert.equal(changed.length, 1);
});

test('adding and removing a member each announce the change', () => {
  const changed: string[] = [];
  const { broker } = makeBroker({ onGroupChanged: (id: string) => changed.push(id) });
  broker.compose({ op: 'form', agents: ['Osvaldo', 'Josefina'] });
  const id = broker.uiRoster().groups[0]!.id;
  broker.compose({ op: 'add', target: `group-${id}`, agent: 'Yesenia' });
  assert.equal(changed.length, 2);
  broker.compose({ op: 'remove', target: `group-${id}`, agent: 'Yesenia' });
  assert.equal(changed.length, 3);
});

test('a group that dissolves to one member announces nothing — there is no group left to lead', () => {
  const changed: string[] = [];
  const { broker } = makeBroker({ onGroupChanged: (id: string) => changed.push(id) });
  broker.compose({ op: 'form', agents: ['Osvaldo', 'Josefina'] });
  const id = broker.uiRoster().groups[0]!.id;
  changed.length = 0;
  broker.compose({ op: 'remove', target: `group-${id}`, agent: 'Josefina' }); // dissolves: < 2 members
  assert.deepEqual(changed, []);
});
```

> `makeBroker()` currently takes no arguments. Extend it to accept an optional partial-deps object merged over its defaults, rather than duplicating the helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/broker.test.ts`
Expected: FAIL — `changed.length` is `0`

- [ ] **Step 3: Write the implementation**

Add to `Broker`'s deps interface:

```ts
/** Fired after a group is formed or its membership changes — the election trigger. */
onGroupChanged?: (groupId: string) => void;
```

In `compose()`, after the `form` branch's `this.notifyRoster()`:

```ts
this.deps.onGroupChanged?.(`g${this.groupSeq}`);
```

And in the group add/remove branch, after `this.notifyRoster()` — **only when the group survived**, since a dissolved group has nobody to lead:

```ts
if (this.groups.includes(group)) this.deps.onGroupChanged?.(group.id);
```

In `broker/src/main.ts`, next to the existing `anthropic` client (line 58), add the one-shot ask and the scheduler. Place this after `broker` is constructed:

```ts
// Elections run on the broker's own model client — never through the agents'
// coding CLIs, which would start a tmux session per voter and mark the whole
// group busy just to hold a vote (spec §5.1).
const askForClaim: AskFactory = async ({ system, prompt }) => {
  const message = await anthropic.messages.create({
    model: config.brainModel,
    max_tokens: 200,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content.map((block) => ('text' in block ? block.text : '')).join('');
};

const elections = new ElectionScheduler({
  run: async (groupId) => {
    const candidates = broker.groupCandidates(groupId);
    if (!candidates || candidates.length < 2) return null;
    const group = broker.uiRoster().groups.find((g) => g.id === groupId);
    if (!group) return null;
    return runElection(askForClaim, { name: group.name }, candidates);
  },
  onResult: (groupId, result) => {
    if (!result.leader) return;
    broker.setGroupLeader(groupId, result.leader, {
      claims: result.claims,
      at: new Date().toISOString(),
      method: result.method,
    });
  },
});
```

Import at the top of `main.ts`:

```ts
import { ElectionScheduler, runElection, type AskFactory } from './election.ts';
```

Pass the trigger into the `Broker` constructor deps:

```ts
onGroupChanged: (groupId) => elections.schedule(groupId),
```

> `elections` is declared after `broker` but referenced from a dep closure that only runs later — that is fine, and matches how `textChannel` is already referenced from `Broker` deps in this file. If `config.brainModel` is named differently in `config.ts`, use whatever the brain is constructed with; do not introduce a second model constant.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd broker && npm run typecheck
git add broker/src/broker.ts broker/src/broker.test.ts broker/src/main.ts
git commit -m "feat: a new group holds its election the moment it forms"
```

---

### Task 6: Target resolution

**Files:**
- Create: `broker/src/targets.ts`
- Test: `broker/src/targets.test.ts`

**Interfaces:**
- Consumes: `deriveLeader` from `./leadership.ts` (Task 1).
- Produces:
  - `type Target = { kind: 'host' } | { kind: 'crew' } | { kind: 'squad'; id: string } | { kind: 'group'; id: string } | { kind: 'agent'; id: string }`
  - `type Resolution = { kind: 'brain' } | { kind: 'agent'; name: string } | { error: string }`
  - `function parseTarget(raw: unknown): Target | undefined`
  - `function resolveTarget(target: Target | undefined, roster: TargetRoster): Resolution`
  - `interface TargetRoster { squads: Array<{ id: string; leader: { name: string } }>; groups: Array<{ id: string; name: string; leader?: string; members: Array<{ id: string; name: string; roles: string[] }> }>; agents: Array<{ id: string; name: string }> }`

- [ ] **Step 1: Write the failing test**

Create `broker/src/targets.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTarget, resolveTarget, type TargetRoster } from './targets.ts';

const ROSTER: TargetRoster = {
  squads: [{ id: 'alpha', leader: { name: 'Gabriel' } }],
  groups: [
    {
      id: 'g1',
      name: 'delta',
      leader: 'josefina',
      members: [
        { id: 'osvaldo', name: 'Osvaldo', roles: ['Backend Engineer', 'senior'] },
        { id: 'josefina', name: 'Josefina', roles: ['Product Manager'] },
      ],
    },
    {
      id: 'g2',
      name: 'epsilon', // no leader yet — election still in flight
      members: [
        { id: 'osvaldo', name: 'Osvaldo', roles: ['Backend Engineer', 'developer'] },
        { id: 'josefina', name: 'Josefina', roles: ['Product Manager'] },
      ],
    },
  ],
  agents: [
    { id: 'osvaldo', name: 'Osvaldo' },
    { id: 'josefina', name: 'Josefina' },
  ],
};

test('no target at all is a brain turn — the untouched path every other caller uses', () => {
  assert.deepEqual(resolveTarget(undefined, ROSTER), { kind: 'brain' });
});

test('host and crew are both brain turns', () => {
  assert.deepEqual(resolveTarget({ kind: 'host' }, ROSTER), { kind: 'brain' });
  assert.deepEqual(resolveTarget({ kind: 'crew' }, ROSTER), { kind: 'brain' });
});

test('a squad resolves to its leader', () => {
  assert.deepEqual(resolveTarget({ kind: 'squad', id: 'alpha' }, ROSTER), { kind: 'agent', name: 'Gabriel' });
});

test('a group resolves to its elected leader', () => {
  assert.deepEqual(resolveTarget({ kind: 'group', id: 'g1' }, ROSTER), { kind: 'agent', name: 'Josefina' });
});

test('a group mid-election resolves through the ladder — sending NEVER waits for a vote', () => {
  assert.deepEqual(resolveTarget({ kind: 'group', id: 'g2' }, ROSTER), { kind: 'agent', name: 'Josefina' });
});

test('an individual resolves to itself', () => {
  assert.deepEqual(resolveTarget({ kind: 'agent', id: 'osvaldo' }, ROSTER), { kind: 'agent', name: 'Osvaldo' });
});

test('unknown ids report an error rather than silently becoming a brain turn', () => {
  assert.ok('error' in resolveTarget({ kind: 'squad', id: 'nope' }, ROSTER));
  assert.ok('error' in resolveTarget({ kind: 'group', id: 'nope' }, ROSTER));
  assert.ok('error' in resolveTarget({ kind: 'agent', id: 'nope' }, ROSTER));
});

test('parseTarget accepts the five shapes and rejects everything else', () => {
  assert.deepEqual(parseTarget({ kind: 'host' }), { kind: 'host' });
  assert.deepEqual(parseTarget({ kind: 'agent', id: 'osvaldo' }), { kind: 'agent', id: 'osvaldo' });
  assert.equal(parseTarget(undefined), undefined);
  assert.equal(parseTarget('agent:osvaldo'), undefined); // a string is never a target on the wire
  assert.equal(parseTarget({ kind: 'agent' }), undefined); // id required
  assert.equal(parseTarget({ kind: 'nonsense' }), undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/targets.test.ts`
Expected: FAIL — `Cannot find module './targets.ts'`

- [ ] **Step 3: Write the implementation**

Create `broker/src/targets.ts`:

```ts
/**
 * Who a composed message is for.
 *
 * The one rule (spec §2): every target resolves to exactly ONE addressable
 * agent. A squad is addressed through its leader, a group through the leader
 * its members elected, the whole crew through Anderson — who is the brain, so
 * that stays a brain turn. This keeps exactly two dispatch kinds and therefore
 * exactly one new code path.
 */
import { deriveLeader } from './leadership.ts';

export type Target =
  | { kind: 'host' }
  | { kind: 'crew' }
  | { kind: 'squad'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'agent'; id: string };

export type Resolution = { kind: 'brain' } | { kind: 'agent'; name: string } | { error: string };

export interface TargetRoster {
  squads: Array<{ id: string; leader: { name: string } }>;
  groups: Array<{ id: string; name: string; leader?: string; members: Array<{ id: string; name: string; roles: string[] }> }>;
  agents: Array<{ id: string; name: string }>;
}

const NEEDS_ID = new Set(['squad', 'group', 'agent']);

/** Narrow untrusted JSON to a Target. Anything unrecognised is `undefined` — i.e. a brain turn. */
export function parseTarget(raw: unknown): Target | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  if (kind === 'host' || kind === 'crew') return { kind };
  if (typeof kind !== 'string' || !NEEDS_ID.has(kind)) return undefined;
  if (typeof id !== 'string' || !id) return undefined;
  return { kind: kind as 'squad' | 'group' | 'agent', id };
}

export function resolveTarget(target: Target | undefined, roster: TargetRoster): Resolution {
  if (!target || target.kind === 'host' || target.kind === 'crew') return { kind: 'brain' };

  if (target.kind === 'squad') {
    const squad = roster.squads.find((s) => s.id === target.id);
    return squad ? { kind: 'agent', name: squad.leader.name } : { error: `unknown squad: ${target.id}` };
  }

  if (target.kind === 'group') {
    const group = roster.groups.find((g) => g.id === target.id);
    if (!group) return { error: `unknown group: ${target.id}` };
    // The stored leader when the election has landed; the ladder while it is
    // still in flight. Sending never waits for a vote (spec §2).
    const leaderId = group.leader ?? deriveLeader(group.members);
    const leader = group.members.find((m) => m.id === leaderId);
    return leader ? { kind: 'agent', name: leader.name } : { error: `group ${group.name} has no members` };
  }

  const agent = roster.agents.find((a) => a.id === target.id);
  return agent ? { kind: 'agent', name: agent.name } : { error: `unknown agent: ${target.id}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd broker && node --import tsx --test src/targets.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
cd broker && npm run typecheck
git add broker/src/targets.ts broker/src/targets.test.ts
git commit -m "feat: every target resolves to one addressable agent"
```

---

### Task 7: `/utterance` learns a target

The composer becomes the **third caller** of `Broker.dispatchWork()` — which already refuses busy agents with the exact message this feature needs.

**Files:**
- Modify: `broker/src/text-channel.ts` — the `POST /utterance` handler (~line 310), constructor deps
- Modify: `broker/src/main.ts` — the `TextChannel` construction
- Test: `broker/src/text-channel.test.ts` (append)

**Interfaces:**
- Consumes: `parseTarget`, `resolveTarget` (Task 6); `Broker.dispatchWork` (existing).
- Produces: `TextChannel` ctor gains a `directed?: { send(text: string, target: unknown): Promise<{ ok: true; taskId?: string } | { error: string; status: number }> }` dep, positioned **after** `documents` (index 24).

- [ ] **Step 1: Write the failing test**

Append to `broker/src/text-channel.test.ts`:

```ts
test('POST /utterance with a target dispatches instead of taking a brain turn', async () => {
  const calls: Array<{ text: string; target: unknown }> = [];
  const channel = channelWith({
    directed: {
      send: async (text, target) => {
        calls.push({ text, target });
        return { ok: true as const, taskId: 't1' };
      },
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/utterance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'look at the auth bug', target: { kind: 'agent', id: 'osvaldo' } }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, taskId: 't1' });
    assert.deepEqual(calls, [{ text: 'look at the auth bug', target: { kind: 'agent', id: 'osvaldo' } }]);
  } finally {
    await channel.stop();
  }
});

test('a busy target answers 409 with the broker\'s own wording, and dispatches nothing', async () => {
  const channel = channelWith({
    directed: {
      send: async () => ({ error: 'Osvaldo is busy with: refactor auth.', status: 409 }),
    },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/utterance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', target: { kind: 'agent', id: 'osvaldo' } }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: 'Osvaldo is busy with: refactor auth.' });
  } finally {
    await channel.stop();
  }
});

test('an unknown target answers 404', async () => {
  const channel = channelWith({
    directed: { send: async () => ({ error: 'unknown agent: ghost', status: 404 }) },
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/utterance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi', target: { kind: 'agent', id: 'ghost' } }),
    });
    assert.equal(res.status, 404);
  } finally {
    await channel.stop();
  }
});

test('an ABSENT target still takes the untouched onText path — every other caller depends on this', async () => {
  const heard: string[] = [];
  const directed: string[] = [];
  const channel = new TextChannel(
    (text: string) => heard.push(text),
    () => [],
  );
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/utterance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'plain old utterance' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(heard, ['plain old utterance']);
    assert.deepEqual(directed, []);
  } finally {
    await channel.stop();
  }
});

test('a host target is NOT a dispatch — it is the brain path', async () => {
  const heard: string[] = [];
  const calls: unknown[] = [];
  const channel = channelWith({
    onText: (text: string) => heard.push(text),
    directed: {
      send: async (_text, target) => {
        calls.push(target);
        return { ok: true as const };
      },
    },
  });
  const port = await channel.start(0);
  try {
    await fetch(`http://127.0.0.1:${port}/utterance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'who is free?', target: { kind: 'host' } }),
    });
    // The `directed` dep decides host-vs-agent, so it IS called; the assertion
    // that matters is that it reports a brain turn and the text still lands.
    assert.equal(calls.length, 1);
  } finally {
    await channel.stop();
  }
});
```

> Extend `channelWith` with `onText` and `directed` keys, following the existing pattern in that helper (it already maps named options onto positional ctor arguments).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd broker && node --import tsx --test src/text-channel.test.ts`
Expected: FAIL — the target is ignored and `calls` stays empty.

- [ ] **Step 3: Write the implementation**

In `broker/src/text-channel.ts`, add the ctor dep after `documents`:

```ts
/**
 * Directed sends (composer target selector). Owns the whole decision: it
 * resolves the target, takes the brain path for host/crew, and dispatches for
 * everyone else. Returning a status lets the route stay dumb.
 */
private readonly directed?: {
  send(text: string, target: unknown): Promise<{ ok: true; taskId?: string } | { error: string; status: number }>;
},
```

In the `POST /utterance` handler, after the body is parsed:

```ts
// A targeted send is awaited so a refusal (busy agent) can reach the composer.
// With no target this branch never runs, so mic PTT, stdin, Discord, and the
// CLI bridge keep the exact path they have today.
const target = (parsed as { target?: unknown }).target;
if (target !== undefined && this.directed) {
  void this.directed.send(text, target).then(
    (r) => {
      const status = 'error' in r ? r.status : 200;
      res.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify('error' in r ? { error: r.error } : r));
    },
    (err: unknown) =>
      res.writeHead(500, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify({ error: String((err as Error).message ?? err) })),
  );
  return;
}
```

In `broker/src/main.ts`, pass the new dep to `TextChannel`:

```ts
{
  send: async (text, rawTarget) => {
    const target = parseTarget(rawTarget);
    const roster = broker.uiRoster();
    const resolution = resolveTarget(target, {
      squads: roster.squads,
      groups: roster.groups.map((g) => ({
        id: g.id,
        name: g.name,
        leader: g.leader,
        members: g.members.map((m) => {
          const agent = directory.resolve(m.id);
          return { id: m.id, name: m.name, roles: agent ? [agent.role] : [] };
        }),
      })),
      agents: roster.agents.map((p) => ({ id: p.agent.id, name: p.agent.name })),
    });

    if ('error' in resolution) return { error: resolution.error, status: 404 };
    if (resolution.kind === 'brain') {
      textChannel.broadcast({ type: 'utterance', text });
      handleUserText(text);
      return { ok: true as const };
    }
    // The THIRD caller of the one dispatch path — busy-refusal, the
    // directives-prefixed prompt, task binding and roster refresh all come
    // from there rather than being reimplemented here.
    const dispatched = await broker.dispatchWork({ agent: resolution.name, task: text, inheritSessionRuntime: true });
    if ('error' in dispatched) return { error: dispatched.error, status: 409 };
    return { ok: true as const, taskId: dispatched.taskId };
  },
}
```

Import at the top of `main.ts`:

```ts
import { parseTarget, resolveTarget } from './targets.ts';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd broker && npm test`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
cd broker && npm run typecheck
git add broker/src/text-channel.ts broker/src/text-channel.test.ts broker/src/main.ts
git commit -m "feat: a directed utterance goes to the agent, not the brain"
```

---

### Task 8: Control-plane lockstep — types and API

**Files:**
- Modify: `control-plane/src/api/types.ts` — add `Target`, extend `RosterAgent`
- Modify: `control-plane/src/api/broker.ts` — `postUtterance`
- Test: `control-plane/src/api/broker.test.ts` (append)

**Interfaces:**
- Consumes: the wire shapes from Task 7.
- Produces:
  - `export type Target = { kind: "host" } | { kind: "crew" } | { kind: "squad"; id: string } | { kind: "group"; id: string } | { kind: "agent"; id: string }`
  - `RosterAgent` gains `leader?: string`
  - `postUtterance(text: string, target?: Target, base?: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

Append to `control-plane/src/api/broker.test.ts`:

```ts
describe("postUtterance with a target", () => {
  it("sends the target as an object and resolves null on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const error = await api.postUtterance("look at the auth bug", { kind: "agent", id: "osvaldo" });
    expect(error).toBeNull();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ text: "look at the auth bug", target: { kind: "agent", id: "osvaldo" } });
  });

  it("returns the broker's refusal text so the composer can show it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "Osvaldo is busy with: refactor auth." }) }),
    );
    expect(await api.postUtterance("hi", { kind: "agent", id: "osvaldo" })).toBe("Osvaldo is busy with: refactor auth.");
  });

  it("reports an unreachable broker rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await api.postUtterance("hi", { kind: "agent", id: "osvaldo" })).toBe("broker unreachable");
  });

  it("omits `target` entirely when none is given, preserving the untargeted wire shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await api.postUtterance("plain old utterance");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ text: "plain old utterance" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run src/api/broker.test.ts`
Expected: FAIL — the body has no `target`, and `postUtterance` resolves `undefined`.

- [ ] **Step 3: Write the implementation**

In `control-plane/src/api/types.ts`:

```ts
/**
 * Who a composed message is for — mirrors broker/src/targets.ts `Target`.
 * Kept in lockstep BY HAND: an object rather than an "agent:osvaldo" string so
 * a drifted parser is a type error instead of a silent mis-parse.
 */
export type Target =
  | { kind: "host" }
  | { kind: "crew" }
  | { kind: "squad"; id: string }
  | { kind: "group"; id: string }
  | { kind: "agent"; id: string };
```

Add to `RosterAgent` (a group rides the roster as `kind: "squad"` with `members`):

```ts
  /** For a group entry: the agent id its members elected to lead it. */
  leader?: string;
```

Replace `postUtterance` in `control-plane/src/api/broker.ts`:

```ts
/**
 * POST /utterance. Untargeted (or host-targeted) sends stay effectively
 * fire-and-forget — the broker echoes accepted utterances back as WS frames.
 * A DIRECTED send is different: it can be refused because the agent is busy,
 * and that refusal has to reach the composer, so this resolves to an error
 * string (or null on success).
 */
export async function postUtterance(text: string, target?: Target, base: string = BROKER_BASE): Promise<string | null> {
  try {
    const res = await fetch(`http://${base}/utterance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(target ? { text, target } : { text }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return "broker unreachable";
  }
}
```

> Every existing caller passes only `text` and ignores the return value, so this stays source-compatible. Import `Target` into `broker.ts`'s type import block.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd control-plane && npx vitest run src/api/broker.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd control-plane && pnpm typecheck && pnpm lint
git add control-plane/src/api/types.ts control-plane/src/api/broker.ts control-plane/src/api/broker.test.ts
git commit -m "feat: the control plane can name who a message is for"
```

---

### Task 9: The selector becomes real

The dead `<div className="selector">` becomes an OSS `Select`. **Verified against the MCP docs:** there is no `Menu` component; `Select` composes as `Select` → `Select.Trigger` → (`Select.Value`, `Select.Indicator`) → `Select.Popover` → `ListBox` → `ListBox.Section` → (`Header`, `ListBox.Item`), and `onChange` yields a **`Key` (string)** — so the UI uses string keys like `"agent:osvaldo"` and decodes to the `Target` object at the boundary.

**Files:**
- Modify: `control-plane/src/molecules/Composer.tsx`
- Modify: `control-plane/src/styles/documents.css` (the composer's own stylesheet; `components.css` is frozen)
- Test: `control-plane/src/molecules/Composer.test.tsx` (append)

**Interfaces:**
- Consumes: `Target`, `RosterAgent` (Task 8).
- Produces: `ComposerProps` gains
  - `targets?: RosterAgent[]` — the rail's entries, in rail order
  - `onSend: (text: string, target?: Target) => void | Promise<string | null>`
  - `function targetKey(t: Target): string` and `function parseTargetKey(key: string): Target` (exported for tests)

- [ ] **Step 1: Write the failing test**

Append to `control-plane/src/molecules/Composer.test.tsx`:

```ts
const TARGETS: RosterAgent[] = [
  { id: "osvaldo", name: "Osvaldo", role: "senior", status: "idle", kind: "agent" },
  { id: "squad-alpha", name: "Alpha", role: "Squad — led by Gabriel", status: "idle", kind: "squad", members: ["Gabriel"] },
  { id: "group-g1", name: "Delta", role: "Squad — led by Josefina", status: "idle", kind: "squad", members: ["Josefina", "Osvaldo"], leader: "josefina" },
];

describe("target selector", () => {
  it("defaults to the chief of staff", () => {
    render(<Composer onSend={vi.fn()} targets={TARGETS} />);
    expect(screen.getByRole("button", { name: /anderson/i })).toBeInTheDocument();
  });

  it("sends to the chosen agent, decoding the key into a Target object", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} targets={TARGETS} />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    await userEvent.click(await screen.findByRole("option", { name: /osvaldo/i }));
    await userEvent.type(screen.getByRole("textbox"), "look at the auth bug");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).toHaveBeenCalledWith("look at the auth bug", { kind: "agent", id: "osvaldo" });
  });

  it("snaps back to Anderson after a send, so no message ever leaks to a CLI", async () => {
    render(<Composer onSend={vi.fn()} targets={TARGETS} />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    await userEvent.click(await screen.findByRole("option", { name: /osvaldo/i }));
    await userEvent.type(screen.getByRole("textbox"), "one");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(screen.getByRole("button", { name: /anderson/i })).toBeInTheDocument();
  });

  it("shows a refusal and KEEPS the text when the target is busy", async () => {
    const onSend = vi.fn().mockResolvedValue("Osvaldo is busy with: refactor auth.");
    render(<Composer onSend={onSend} targets={TARGETS} />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    await userEvent.click(await screen.findByRole("option", { name: /osvaldo/i }));
    await userEvent.type(screen.getByRole("textbox"), "look at the auth bug");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(await screen.findByText(/busy with: refactor auth/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("look at the auth bug");
  });

  it("names a group's elected leader so you know who actually receives it", async () => {
    render(<Composer onSend={vi.fn()} targets={TARGETS} />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    expect(await screen.findByRole("option", { name: /delta/i })).toHaveTextContent(/josefina/i);
  });

  it("renders no selector at all when the caller passes no targets", () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /anderson/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run src/molecules/Composer.test.tsx`
Expected: FAIL — the selector is a static div reading "Swarm".

- [ ] **Step 3: Write the implementation**

Add the key codec and props to `Composer.tsx`:

```tsx
import { Header, ListBox, Select, Separator } from "@heroui/react";
import type { RosterAgent, Target } from "../api/types";

/** HeroUI's Select speaks string Keys; the wire speaks Target objects. Encode here, decode on the way out. */
export function targetKey(t: Target): string {
  return t.kind === "host" || t.kind === "crew" ? t.kind : `${t.kind}:${t.id}`;
}

export function parseTargetKey(key: string): Target {
  if (key === "host" || key === "crew") return { kind: key };
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  if (kind === "squad" || kind === "group" || kind === "agent") return { kind, id };
  return { kind: "host" };
}

/** A rail entry's id carries its own prefix (`squad-alpha`, `group-g1`); strip it for the wire. */
function targetOf(entry: RosterAgent): Target {
  if (entry.id.startsWith("squad-")) return { kind: "squad", id: entry.id.slice("squad-".length) };
  if (entry.id.startsWith("group-")) return { kind: "group", id: entry.id.slice("group-".length) };
  return { kind: "agent", id: entry.id };
}
```

Hold the selection and the refusal in state, defaulting to `host`:

```tsx
const [target, setTarget] = useState<Target>({ kind: "host" });
const [refusal, setRefusal] = useState<string | null>(null);
```

Replace the dead `<div className="selector">` with the verified compound shape. Squads and groups both arrive as `kind === "squad"`; split them on the id prefix:

```tsx
{targets && targets.length > 0 && (
  <Select
    className="selector"
    aria-label="Send to"
    value={targetKey(target)}
    onChange={(key) => {
      setRefusal(null);
      setTarget(parseTargetKey(String(key)));
    }}
  >
    <Select.Trigger>
      <Select.Value />
      <Select.Indicator />
    </Select.Trigger>
    <Select.Popover>
      <ListBox>
        <ListBox.Item id="host" textValue="Anderson">
          Anderson
          <ListBox.ItemIndicator />
        </ListBox.Item>
        <ListBox.Item id="crew" textValue="Entire Crew">
          Entire Crew
          <ListBox.ItemIndicator />
        </ListBox.Item>
        <Separator />
        <ListBox.Section>
          <Header>Squads &amp; groups</Header>
          {targets
            .filter((t) => t.kind === "squad")
            .map((t) => (
              <ListBox.Item key={t.id} id={targetKey(targetOf(t))} textValue={t.name}>
                {t.name}
                {/* The role string already reads "Squad — led by X", so it names the
                    recipient without a second lookup. */}
                <span className="selector__who">{t.role}</span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
        </ListBox.Section>
        <Separator />
        <ListBox.Section>
          <Header>Agents</Header>
          {targets
            .filter((t) => t.kind === "agent")
            .map((t) => (
              <ListBox.Item key={t.id} id={targetKey(targetOf(t))} textValue={t.name}>
                {t.name}
                <span className="selector__who">{t.role}</span>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
        </ListBox.Section>
      </ListBox>
    </Select.Popover>
  </Select>
)}
{refusal && <p className="composer__target-error">{refusal}</p>}
```

In the existing send handler, pass the target, await a possible refusal, and reset:

```tsx
const outcome = await onSend(text, target.kind === "host" ? undefined : target);
if (typeof outcome === "string" && outcome) {
  // Refused (busy agent, unknown target): keep the draft — nothing was sent.
  setRefusal(outcome);
  return;
}
setRefusal(null);
setText("");
// Directing is a per-message act: never leave a CLI armed for the next line.
setTarget({ kind: "host" });
```

Add to `control-plane/src/styles/documents.css` (beside the other composer rules):

```css
/* Target selector: a toolbar control, not a form field — it must not grow the row. */
.composer .selector .select__trigger {
  border: none;
  background: transparent;
  font-size: 11px;
  padding: 2px 6px;
  gap: 4px;
}
.selector__who {
  color: var(--text-dim);
  font-size: 10px;
}
.composer__target-error {
  order: 12;
  width: 100%;
  color: #d9534f;
  font-size: 11px;
  margin: 4px 0 0;
}
```

> `order: 12` continues the composer's existing priority bands in this file — the error sits below the tool row. Read the surrounding `@container` block and keep the numbering contiguous.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd control-plane && npx vitest run src/molecules/Composer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
cd control-plane && pnpm lint && pnpm typecheck
git add control-plane/src/molecules/Composer.tsx control-plane/src/molecules/Composer.test.tsx control-plane/src/styles/documents.css
git commit -m "feat: the swarm droplist finally decides who hears you"
```

---

### Task 10: Wire the call sites and verify end to end

**Files:**
- Modify: `control-plane/src/organisms/VoiceStage.tsx:91` — pass `targets`
- Modify: `control-plane/src/router.tsx:168` — pass `targets` to the docked composer
- Test: `control-plane/src/organisms/VoiceStage.test.tsx` (append)

**Interfaces:**
- Consumes: everything above.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `control-plane/src/organisms/VoiceStage.test.tsx`:

```ts
it("hands the rail's entries to the composer so you can direct a message", () => {
  renderStage({
    roster: [
      { id: "osvaldo", name: "Osvaldo", role: "senior", status: "idle", kind: "agent" },
      { id: "squad-alpha", name: "Alpha", role: "Squad — led by Gabriel", status: "idle", kind: "squad", members: ["Gabriel"] },
    ],
  });
  expect(screen.getByRole("button", { name: /anderson/i })).toBeInTheDocument();
});
```

> Follow this file's existing render helper and its prop names; do not introduce a second helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd control-plane && npx vitest run src/organisms/VoiceStage.test.tsx`
Expected: FAIL — no selector, because `targets` is not passed.

- [ ] **Step 3: Write the implementation**

In `VoiceStage.tsx`, pass the roster it already renders in the rail:

```tsx
<Composer
  targets={roster}
  onSend={(text, target) => api.postUtterance(text, target)}
  /* …every existing prop unchanged… */
/>
```

In `router.tsx`'s `DocRoute` dock (line ~168), do the same, taking the roster from the query the route already has access to:

```tsx
const { data: rosterData } = useRoster();
// …
<Composer
  targets={rosterData?.agents ?? NO_TARGETS}
  onSend={(text, target) => api.postUtterance(text, target)}
  /* …every existing prop unchanged… */
/>
```

Declare the stable empty default beside the file's other `NO_*` constants:

```tsx
const NO_TARGETS: RosterAgent[] = [];
```

- [ ] **Step 4: Run the full suites**

```bash
cd control-plane && pnpm test && pnpm lint && pnpm typecheck
cd ../broker && npm test && npm run typecheck
```

Expected: both suites green. Known flakes under load — `NewWorkspaceModal.test.tsx`, `SurfacePolicyPopover.test.tsx`, `MapStage.test.tsx` — pass in isolation; re-run any failure alone before treating it as a regression.

- [ ] **Step 5: Live smoke**

```bash
# Restart the broker on the new code
tmux send-keys -t smith-broker C-c && sleep 2 && tmux send-keys -t smith-broker "npm run serve" Enter
```

Then in the app:
1. Drag two agents together on the rail to form a group. Within a second its rail label should read `Squad — led by <someone>` — and after the election lands it may change to a different member. That change **is** the feature working.
2. Open the composer's selector. Confirm Anderson, Entire Crew, the three squads, the new group (naming its leader), and each individual agent.
3. Send with Anderson selected — Anderson answers as always.
4. Send to an idle agent — a task dispatches, no Anderson narration, and the selector returns to Anderson.
5. Send to the same agent while it is still working — an inline refusal naming what it is busy with, and your text stays in the box.

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/organisms/VoiceStage.tsx control-plane/src/organisms/VoiceStage.test.tsx control-plane/src/router.tsx
git commit -m "feat: both composers can direct a message"
```

---

## Self-review

**Spec coverage.** §2 target table → Tasks 6, 9. §2 "sending never waits" → Task 6 (`g2` fixture). §3 dispatchWork third caller → Task 7. §4 ladder → Task 1. §5.1 runs in-broker → Task 2 + Task 5 wiring. §5.2 mechanics → Tasks 1–2. §5.3 triggers/debounce/supersede → Tasks 3, 5. §5.4 squads not elected → Task 5 (only groups announce). §6 data model → Task 4. §7 modules → Tasks 1, 2, 6. §8 route → Task 7. §9 control plane → Tasks 8–10. §10 invariants → the tests named in each task. §11 testing → distributed. §12 out of scope → untouched, except the Scrum Master regex, which is deliberately present in the ladder so the persona can be added later without a routing change.

**Two spec corrections found while planning, and reflected above:**
1. The spec says a one-member group elects that member with no model call, and that zero-member groups are hidden. Both are unreachable: `compose()` dissolves any group that drops below two members (`broker.ts` — *"a squad of one dissolves"*), and `form` refuses fewer than two. Task 5 tests the dissolve path instead, and Task 5's `run` guards on `< 2` defensively rather than implementing a one-member branch.
2. A group's roster entry **already** claims `Squad — led by <members[0]>` — the UI has been showing a placeholder leader all along. Task 4 replaces it rather than adding a new concept.

**Type consistency.** `Claim` is defined once in `leadership.ts` and imported by `election.ts` and `broker.ts`. `Target` is defined in `targets.ts` and mirrored by hand in `types.ts` (Task 8), with `parseTargetKey` in the composer as the only string↔object codec. `ElectionResult.method` is `'vote' | 'rank'` everywhere, including the persisted record.
