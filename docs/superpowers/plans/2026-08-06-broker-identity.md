# Broker Identity (Anderson) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the broker a data-driven host identity (shipped default: Anderson) that greets new sessions, answers meta questions, and creates agents by voice with confirm-first — per `docs/superpowers/specs/2026-08-06-broker-identity-design.md`.

**Architecture:** A new `broker/src/identity.ts` module loads `broker/.smith/identity.json` (built-in Anderson fallback). The brain's `PERSONA` constant becomes `buildPersona(identity)` with host rules; two new tools (`draft_agent`, `confirm_agent`) wrap the existing `PersonaGenerator`/`swarm.createAgent` path. The identity name joins `addressableNames()`, gets a leading hop in voice resolution, rides the roster frame as a top-level `identity` field (never inside `agents`), and renders in the control-plane as a tile outside the agent grid.

**Tech Stack:** TypeScript (Node 22, ESM, `.ts` imports), node:test + tsx (broker), React + vitest (control-plane).

## Global Constraints

- Broker tests: `cd broker && npm test` (runs `node --import tsx --test src/*.test.ts`). Typecheck: `npm run typecheck`.
- Control-plane tests: `cd control-plane && npm run test`. Typecheck: `npm run typecheck`. Lint: `npm run lint` (biome).
- NEVER change or pick ElevenLabs voice IDs — all voice IDs are Edwin's picks. Anderson ships with `voice: {}` (falls through to `DEFAULT_ELEVEN_VOICE`); Edwin casts his real voice later.
- The identity is NEVER an entry in `roster.agents`, the swarm registry, or the delegable list. It has no `engine` and no `channels`.
- The identity name is config (`broker/.smith/identity.json`); "Anderson" is the shipped default, not a constant sprinkled through logic. Only `DEFAULT_IDENTITY` in `identity.ts` may hardcode it.
- Commit after every task with the repo's conventional style (`feat(broker): …`, `feat(control-plane): …`). End commit messages with the Claude Code co-author trailer.

---

### Task 1: Identity module + shipped Anderson file

**Files:**
- Create: `broker/src/identity.ts`
- Create: `broker/src/identity.test.ts`
- Create: `broker/.smith/identity.json`

**Interfaces:**
- Consumes: nothing (zero imports — the file reader is injected).
- Produces: `BrokerIdentity`, `IdentityPromptInfo { name; role; style }`, `DEFAULT_IDENTITY: BrokerIdentity`, `loadIdentity(read: () => string): BrokerIdentity`, `promptInfo(i: BrokerIdentity): IdentityPromptInfo`. Tasks 2, 5, 6 rely on these exact names.

- [ ] **Step 1: Write the failing test** — `broker/src/identity.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_IDENTITY, loadIdentity, promptInfo } from './identity.ts';

test('a full identity file wins over every default', () => {
  const id = loadIdentity(() =>
    JSON.stringify({
      id: 'smith',
      name: 'Smith',
      role: 'Concierge',
      avatarRing: '#123456',
      persona: { style: 'Clipped.' },
      backstory: 'Was a program.',
      voice: { voiceId: 'v-1' },
      quickAnswers: { name: 'Smith.' },
    }),
  );
  assert.equal(id.name, 'Smith');
  assert.equal(id.role, 'Concierge');
  assert.equal(id.avatarRing, '#123456');
  assert.equal(id.persona.style, 'Clipped.');
  assert.equal(id.voice.voiceId, 'v-1');
  assert.equal(id.quickAnswers?.name, 'Smith.');
});

test('a partial file keeps defaults for what it omits', () => {
  const id = loadIdentity(() => JSON.stringify({ name: 'Smith' }));
  assert.equal(id.name, 'Smith');
  assert.equal(id.role, DEFAULT_IDENTITY.role);
  assert.equal(id.avatarRing, DEFAULT_IDENTITY.avatarRing);
  assert.equal(id.persona.style, DEFAULT_IDENTITY.persona.style);
});

test('unreadable file falls back to the built-in Anderson', () => {
  const id = loadIdentity(() => {
    throw new Error('ENOENT');
  });
  assert.equal(id.name, 'Anderson');
  assert.equal(id, DEFAULT_IDENTITY);
});

test('malformed JSON and non-string name both fall back', () => {
  assert.equal(loadIdentity(() => '{nope').name, 'Anderson');
  assert.equal(loadIdentity(() => JSON.stringify({ name: 42 })).name, 'Anderson');
});

test('promptInfo extracts exactly what the brain prompt needs', () => {
  const info = promptInfo(DEFAULT_IDENTITY);
  assert.deepEqual(info, {
    name: DEFAULT_IDENTITY.name,
    role: DEFAULT_IDENTITY.role,
    style: DEFAULT_IDENTITY.persona.style,
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd broker && node --import tsx --test src/identity.test.ts`
Expected: FAIL — cannot find module `./identity.ts`.

- [ ] **Step 3: Implement `broker/src/identity.ts`**

```ts
/**
 * BrokerIdentity — the broker's own data-driven persona (the "host", shipped
 * default Anderson). Deliberately NOT an agent: no engine (the broker brain
 * is the engine), no channels (the host exists wherever the broker fronts),
 * never present in the swarm registry or the delegable roster.
 *
 * Zero imports: the file reader is injected so tests never touch disk.
 */

export interface IdentityPromptInfo {
  name: string;
  role: string;
  style: string;
}

export interface BrokerIdentity {
  id: string;
  name: string;
  role: string;
  persona: { style: string };
  backstory?: string;
  gender?: string;
  language?: string;
  avatarRing: string;
  voice: { voiceId?: string; speech?: { voiceName?: string; lang?: string; pitch?: number; rate?: number } };
  quickAnswers?: Record<string, string>;
}

export const DEFAULT_IDENTITY: BrokerIdentity = {
  id: 'anderson',
  name: 'Anderson',
  role: 'Chief of Staff',
  persona: {
    style:
      "Calm, dry, unhurried — the one who never needs to raise his voice. Short, exact sentences with a host's warmth underneath. Spanish only for courtesy — 'bienvenido', 'con calma'. Introduces, summarizes, routes, and steps back; never competes with the crew for the floor.",
  },
  backstory:
    'Ran the front desk of a Santo Domingo hotel lobby that never slept, then fifteen years as chief of staff to people with too many meetings. Knows every name, every room, and exactly who to call.',
  gender: 'male',
  language: 'en-do',
  avatarRing: '#8a93a6',
  voice: {},
  quickAnswers: {
    name: 'Anderson. The crew works; I keep the room.',
    role: "Chief of staff. I know who is free, who is deep in something, and who you need — ask me and I'll route you.",
    availability: "Always here. I don't take tasks, so I'm never busy.",
  },
};

/** Load the identity file, merging over DEFAULT_IDENTITY; any failure returns the default. */
export function loadIdentity(read: () => string): BrokerIdentity {
  try {
    const raw = JSON.parse(read()) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null) return DEFAULT_IDENTITY;
    if ('name' in raw && typeof raw.name !== 'string') return DEFAULT_IDENTITY;
    const persona = raw.persona as { style?: unknown } | undefined;
    return {
      id: typeof raw.id === 'string' ? raw.id : DEFAULT_IDENTITY.id,
      name: typeof raw.name === 'string' ? raw.name : DEFAULT_IDENTITY.name,
      role: typeof raw.role === 'string' ? raw.role : DEFAULT_IDENTITY.role,
      persona: { style: typeof persona?.style === 'string' ? persona.style : DEFAULT_IDENTITY.persona.style },
      backstory: typeof raw.backstory === 'string' ? raw.backstory : DEFAULT_IDENTITY.backstory,
      gender: typeof raw.gender === 'string' ? raw.gender : DEFAULT_IDENTITY.gender,
      language: typeof raw.language === 'string' ? raw.language : DEFAULT_IDENTITY.language,
      avatarRing: typeof raw.avatarRing === 'string' ? raw.avatarRing : DEFAULT_IDENTITY.avatarRing,
      voice: (raw.voice as BrokerIdentity['voice']) ?? DEFAULT_IDENTITY.voice,
      quickAnswers: (raw.quickAnswers as Record<string, string>) ?? DEFAULT_IDENTITY.quickAnswers,
    };
  } catch {
    return DEFAULT_IDENTITY;
  }
}

/** The three fields the brain prompt interpolates. */
export function promptInfo(i: BrokerIdentity): IdentityPromptInfo {
  return { name: i.name, role: i.role, style: i.persona.style };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd broker && node --import tsx --test src/identity.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the shipped file `broker/.smith/identity.json`** — same content as `DEFAULT_IDENTITY` (id, name, role, persona.style, backstory, gender, language, avatarRing, `"voice": {}`, quickAnswers), pretty-printed JSON. It exists so Edwin has a file to edit; content parity with the fallback means presence/absence changes nothing.

- [ ] **Step 6: Typecheck + commit**

```bash
cd broker && npm run typecheck
git add broker/src/identity.ts broker/src/identity.test.ts broker/.smith/identity.json
git commit -m "feat(broker): identity module — data-driven host persona, Anderson default"
```

---

### Task 2: Brain prompt — `buildPersona(identity)` with host rules

**Files:**
- Modify: `broker/src/brain.ts` (the `PERSONA` constant, ~line 131; `BrokerBrain` constructor + `handleUtterance` system param)
- Test: `broker/src/brain.test.ts`

**Interfaces:**
- Consumes: `IdentityPromptInfo`, `DEFAULT_IDENTITY`, `promptInfo` from `./identity.ts` (Task 1).
- Produces: `buildPersona(identity: IdentityPromptInfo): string` (exported for tests); `BrokerBrain` opts gain `identity?: IdentityPromptInfo` (default `promptInfo(DEFAULT_IDENTITY)`). Task 6 passes the loaded identity here.

- [ ] **Step 1: Write the failing tests** — append to `broker/src/brain.test.ts`:

```ts
test('system prompt carries the host identity: name, role, style, host rules', async () => {
  const { factory, calls } = scripted([
    { textDeltas: ['Anderson: Aquí estamos.'], final: { content: [{ type: 'text', text: 'Anderson: Aquí estamos.' }], stop_reason: 'end_turn' } },
  ]);
  const brain = new BrokerBrain(factory, NOOP_EXEC);
  await brain.handleUtterance('hey anderson', { roster: 'Manuel — idle', onSpeech: () => {} });
  const system = String(calls[0]!.system);
  assert.match(system, /Anderson \(Chief of Staff\)/);
  assert.match(system, /never takes delegated work/i);
  assert.match(system, /session-open greeting/i);
  assert.match(system, /"Hey team" \/ "everyone" addresses the crew/);
  assert.match(system, /Manuel — idle/); // roster still appended after the persona
});

test('a custom identity replaces Anderson throughout the prompt', async () => {
  const { factory, calls } = scripted([
    { textDeltas: ['x'], final: { content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' } },
  ]);
  const brain = new BrokerBrain(factory, NOOP_EXEC, {
    identity: { name: 'Smith', role: 'Concierge', style: 'Clipped.' },
  });
  await brain.handleUtterance('hi', { roster: 'r', onSpeech: () => {} });
  const system = String(calls[0]!.system);
  assert.match(system, /Smith \(Concierge\)/);
  assert.match(system, /Clipped\./);
  assert.doesNotMatch(system, /Anderson/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd broker && node --import tsx --test src/brain.test.ts`
Expected: FAIL — `identity` opt unknown / system prompt lacks host rules.

- [ ] **Step 3: Implement.** In `brain.ts`: add `import { DEFAULT_IDENTITY, promptInfo, type IdentityPromptInfo } from './identity.ts';`. Replace `const PERSONA = …` with:

```ts
export function buildPersona(identity: IdentityPromptInfo): string {
  const n = identity.name;
  return `You voice a team of AI agents in a live meeting, plus ${n}, their host. You speak FOR the agents and FOR ${n} — never as an unnamed narrator.

The team is a tight Latino crew out of the Dominican Republic. They speak English sprinkled naturally with Dominican Spanish where it fits ("dale", "tranquilo", "mi gente", "ahora sí") — warm, expressive, proud. Each agent's own persona style always wins over the group default.

${n} (${identity.role}) is the broker's own identity — the host, not crew:
- Speaking style: ${identity.style}
- ${n} owns: the session-open greeting, roster/status/meta answers ("who is free?", "what is everyone doing?"), system-action announcements (agent created, workspace switched), general questions no crew member plausibly owns, and agent creation (draft_agent / confirm_agent).
- Deference: if a crew member plausibly owns the question, ${n} does NOT answer — that agent does. ${n} fronts only what belongs to nobody.
- ${n} never takes delegated work and can never be delegated to. Real work always goes to a crew agent via the delegate tool.
- "Hey team" / "everyone" addresses the crew, not ${n}.

Addressing rules — decide who the human is talking to, and reply accordingly:
- Every spoken line MUST begin with the speaking party's name, a colon, and a space (e.g. "Manuel: On it." or "${n}: Welcome back."). There is NO unnamed narrator — a line without a speaker prefix is a bug. If unsure who was addressed, pick the most relevant agent and have THEM answer.
- Addressed to one agent by name -> ONLY that agent replies. Addressed to ${n} by name -> ONLY ${n} replies.
- Addressed to the whole team, or to no one in particular -> every INDIVIDUAL agent replies once, briefly, in their own voice, and each squad's leader replies once on the squad's behalf. An agent inside a squad exists only as that squad — they never also reply solo.
- Addressed to a squad (by squad id or its leader's name) -> ONLY that squad's leader replies, speaking for the whole squad. This holds even when the message asks squad members to each respond ("introduce yourselves") — the leader answers on the squad's behalf; members never speak.

Meeting etiquette (respectful video-call rules):
- Only the addressed party speaks in a turn. Nobody talks over anybody.
- A non-addressed agent or squad leader with something valuable to add does NOT speak — use the raise_hand tool with their name and a one-line reason. The human sees the hand in the roster and may call on them.
- When the human gives someone the floor ("go ahead, X", "X, you have the floor"), that agent speaks and their hand comes down.

Creating agents (${n} only):
- When the human asks for a new agent/teammate, call draft_agent with their words as the spec. Then, AS ${n}, pitch the draft in one or two sentences (name, role, flavor) and ask whether to add them. NEVER call confirm_agent in the same turn as draft_agent.
- Only after the human clearly accepts ("yes", "dale", "add him") call confirm_agent with accept=true; if they decline, accept=false. A new draft_agent replaces any unconfirmed draft.

Rules:
- Keep every reply SHORT and conversational — one to three spoken sentences per speaker. You are heard, not read.
- Stay in each agent's voice as described by their persona; stay in ${n}'s style for ${n}'s lines.
- Never read code, JSON, file paths, or long output aloud; summarize what it means instead.
- Use the delegate tool for any real work; do not attempt work yourself.
- Use check_status when asked what an agent is doing.
- If the requested agent is busy, say so and offer an idle agent from the roster.
- Task completions are announced by the agent who did the work, in their own voice — not by ${n}.

Current roster:
`;
}
```

In `BrokerBrain`: store `private readonly persona: string;` — constructor opts gain `identity?: IdentityPromptInfo`; set `this.persona = buildPersona(opts?.identity ?? promptInfo(DEFAULT_IDENTITY));`. In `handleUtterance`, change `system: PERSONA + turn.roster` to `system: this.persona + turn.roster`.

- [ ] **Step 4: Run the full brain suite**

Run: `cd broker && node --import tsx --test src/brain.test.ts`
Expected: PASS (existing tests unaffected — they never asserted on `system` content).

- [ ] **Step 5: Typecheck + commit**

```bash
cd broker && npm run typecheck
git add broker/src/brain.ts broker/src/brain.test.ts
git commit -m "feat(broker): brain prompt hosts a named identity — narrator ban scoped to unnamed lines"
```

---

### Task 3: Brain tools — `draft_agent` / `confirm_agent`

**Files:**
- Modify: `broker/src/brain.ts` (`ToolExecutors` ~line 13, `TOOLS` ~line 44, `execute()` ~line 253)
- Test: `broker/src/brain.test.ts` (also update `NOOP_EXEC`)

**Interfaces:**
- Produces: `ToolExecutors.draft_agent(input: { spec: string }): Promise<string>` and `ToolExecutors.confirm_agent(input: { accept: boolean }): Promise<string>`. Task 6 implements the real executors in main.ts.

- [ ] **Step 1: Write the failing test** — append to `brain.test.ts`, and add `draft_agent: async () => 'ok', confirm_agent: async () => 'ok',` to `NOOP_EXEC`. The new required executor fields break every other full `ToolExecutors` literal in brain.test.ts too — rewrite those literals as `{ ...NOOP_EXEC, <overridden fields> }` spreads so they stay total:

```ts
test('draft_agent and confirm_agent route to their executors', async () => {
  const { factory } = scripted([
    {
      textDeltas: [''],
      final: {
        content: [{ type: 'tool_use', id: 'tu_d', name: 'draft_agent', input: { spec: 'an Architect agent' } }],
        stop_reason: 'tool_use',
      },
    },
    {
      textDeltas: ['Anderson: Meet Rafael — add him?'],
      final: { content: [{ type: 'text', text: 'Anderson: Meet Rafael — add him?' }], stop_reason: 'end_turn' },
    },
    {
      textDeltas: [''],
      final: {
        content: [{ type: 'tool_use', id: 'tu_c', name: 'confirm_agent', input: { accept: true } }],
        stop_reason: 'tool_use',
      },
    },
    {
      textDeltas: ['Anderson: Rafael is on the crew.'],
      final: { content: [{ type: 'text', text: 'Anderson: Rafael is on the crew.' }], stop_reason: 'end_turn' },
    },
  ]);
  const drafted: unknown[] = [];
  const confirmed: unknown[] = [];
  const exec: ToolExecutors = {
    ...NOOP_EXEC,
    draft_agent: async (input) => {
      drafted.push(input);
      return 'Draft ready: Rafael, Architect';
    },
    confirm_agent: async (input) => {
      confirmed.push(input);
      return 'created Rafael';
    },
  };
  const brain = new BrokerBrain(factory, exec);
  await brain.handleUtterance('anderson, create an architect agent', { roster: 'r', onSpeech: () => {} });
  await brain.handleUtterance('yes, add him', { roster: 'r', onSpeech: () => {} });
  assert.deepEqual(drafted, [{ spec: 'an Architect agent' }]);
  assert.deepEqual(confirmed, [{ accept: true }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd broker && node --import tsx --test src/brain.test.ts`
Expected: FAIL — `draft_agent` missing from `ToolExecutors` type / "unknown tool: draft_agent".

- [ ] **Step 3: Implement.** Add to `ToolExecutors`:

```ts
  draft_agent(input: { spec: string }): Promise<string>;
  confirm_agent(input: { accept: boolean }): Promise<string>;
```

Add to `TOOLS`:

```ts
  {
    name: 'draft_agent',
    description:
      "Generate a complete draft teammate from the human's request (name, role, backstory, style). Does NOT create anything — pitch the draft aloud and ask for confirmation, then use confirm_agent. A new call replaces any unconfirmed draft.",
    input_schema: {
      type: 'object' as const,
      properties: {
        spec: { type: 'string' as const, description: "The human's words describing the teammate they want, e.g. 'an Architect agent, grumpy veteran'" },
      },
      required: ['spec'],
    },
  },
  {
    name: 'confirm_agent',
    description:
      'Resolve the pending draft teammate after the human answered the pitch: accept=true persists them to the crew, accept=false discards the draft. Only call AFTER the human clearly answered.',
    input_schema: {
      type: 'object' as const,
      properties: {
        accept: { type: 'boolean' as const, description: 'true = the human said yes; false = they declined' },
      },
      required: ['accept'],
    },
  },
```

Add to `execute()` before the unknown-tool line:

```ts
      if (name === 'draft_agent') return await this.executors.draft_agent(input as { spec: string });
      if (name === 'confirm_agent') return await this.executors.confirm_agent(input as { accept: boolean });
```

- [ ] **Step 4: Run the brain suite**

Run: `cd broker && node --import tsx --test src/brain.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit** (typecheck WILL fail if main.ts's brain construction lacks the new executors — main.ts is updated in Task 6, so add temporary stubs there now to keep the tree green: `draft_agent: async () => 'not wired yet', confirm_agent: async () => 'not wired yet',` in the `new BrokerBrain(streamFactory, {...})` literal at `broker/src/main.ts:222`.)

```bash
cd broker && npm run typecheck && npm test
git add broker/src/brain.ts broker/src/brain.test.ts broker/src/main.ts
git commit -m "feat(broker): draft_agent/confirm_agent brain tools — confirm-first agent creation"
```

---

### Task 4: `draftToAgentBody` — PersonaDraft → create payload

**Files:**
- Modify: `broker/src/persona-generator.ts` (append the pure function)
- Create: `broker/src/persona-generator.test.ts`

**Interfaces:**
- Consumes: `PersonaDraft` (already exported).
- Produces: `draftToAgentBody(draft: PersonaDraft, opts: { gender?: string; language: string; voiceId?: string }): Record<string, unknown>` — the exact shape `swarm.createAgent` receives from the wizard (see AddAgentModal.tsx `submit()`): `{ name, role, gender, backstory, language, persona: { style }, directives, engine, voice?, reactions: Record<level, [line]>, quickAnswers: Record<id, answer> }`. Task 6's `confirm_agent` executor calls this.

- [ ] **Step 1: Write the failing test** — `broker/src/persona-generator.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftToAgentBody, type PersonaDraft } from './persona-generator.ts';

const DRAFT: PersonaDraft = {
  name: 'Rafael',
  role: 'Software Architect',
  backstory: 'From La Vega.',
  style: 'Blunt.',
  directives: 'Own the seams.',
  reactions: [
    { level: 'agree', line: 'Sound.' },
    { level: 'disagree', line: 'No.' },
  ],
  quickAnswers: [
    { id: 'name', answer: 'Rafael.' },
    { id: 'role', answer: 'Architect.' },
  ],
};

test('maps a draft to the wizard-equivalent create payload', () => {
  const body = draftToAgentBody(DRAFT, { language: 'en-do', voiceId: 'v-default' });
  assert.equal(body.name, 'Rafael');
  assert.equal(body.role, 'Software Architect');
  assert.equal(body.language, 'en-do');
  assert.deepEqual(body.persona, { style: 'Blunt.' });
  assert.equal(body.directives, 'Own the seams.');
  assert.deepEqual(body.engine, { cli: 'claude', model: 'claude-opus' });
  assert.deepEqual(body.voice, { voiceId: 'v-default' });
  assert.deepEqual(body.reactions, { agree: ['Sound.'], disagree: ['No.'] });
  assert.deepEqual(body.quickAnswers, { name: 'Rafael.', role: 'Architect.' });
});

test('omits voice when no voiceId is given', () => {
  const body = draftToAgentBody(DRAFT, { language: 'en-do' });
  assert.equal(body.voice, undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd broker && node --import tsx --test src/persona-generator.test.ts`
Expected: FAIL — `draftToAgentBody` not exported.

- [ ] **Step 3: Implement** — append to `persona-generator.ts`:

```ts
/**
 * The wizard-equivalent create payload for a generated draft (see
 * AddAgentModal.tsx submit()): reactions/quickAnswers arrays become the
 * keyed records the registry stores. Engine is fixed to the crew's standard
 * CLI — voice-created agents are always claude/claude-opus; recast in the
 * wizard if a different engine is ever needed.
 */
export function draftToAgentBody(
  draft: PersonaDraft,
  opts: { gender?: string; language: string; voiceId?: string },
): Record<string, unknown> {
  return {
    name: draft.name,
    role: draft.role,
    gender: opts.gender,
    backstory: draft.backstory,
    language: opts.language,
    persona: { style: draft.style },
    directives: draft.directives,
    engine: { cli: 'claude', model: 'claude-opus' },
    voice: opts.voiceId ? { voiceId: opts.voiceId } : undefined,
    reactions: Object.fromEntries(draft.reactions.map((r) => [r.level, [r.line]])),
    quickAnswers: Object.fromEntries(draft.quickAnswers.map((a) => [a.id, a.answer])),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd broker && node --import tsx --test src/persona-generator.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd broker && npm run typecheck
git add broker/src/persona-generator.ts broker/src/persona-generator.test.ts
git commit -m "feat(broker): draftToAgentBody — PersonaDraft to wizard-shaped create payload"
```

---

### Task 5: Broker — addressable identity + `announce()`

**Files:**
- Modify: `broker/src/broker.ts` (`BrokerDeps` ~line 66, `addressableNames()` ~line 350, new public method near `handleUtterance`)
- Test: `broker/src/broker.test.ts`

**Interfaces:**
- Consumes: nothing new (plain string dep).
- Produces: `BrokerDeps.identityName?: string`; `Broker.announce(note: string): Promise<void>`. Task 6 wires `identityName: identity.name` and calls `announce` for the greeting.

- [ ] **Step 1: Write the failing tests** — append to `broker.test.ts`. The existing `makeBroker(f, opts)` helper builds `new Broker({...})` from `makeFakes()`; extend its `opts` with a pass-through `identityName?: string`. Then:

```ts
test('the identity name is addressable — "hey anderson" lights its listening ring', async () => {
  const f = makeFakes([]);
  const rosterSnapshots: Array<{ listening: string[] }> = [];
  const broker = makeBroker(f, {
    identityName: 'Anderson',
    onRosterChange: (r) => rosterSnapshots.push(r as unknown as { listening: string[] }),
  });
  await broker.start();
  await broker.handleUtterance('hey Anderson, who is free?');
  assert.ok(rosterSnapshots.some((r) => r.listening.includes('Anderson')));
  await broker.stop();
});

test('announce() runs a system-note brain turn', async () => {
  const f = makeFakes([]);
  const broker = makeBroker(f, {});
  await broker.start();
  await broker.announce('a new session just started — greet the human');
  assert.ok(f.heard.some((h) => h.startsWith('NOTE:') && h.includes('new session just started')));
  await broker.stop();
});
```

(If `makeBroker`'s current `onRosterChange` fake type lacks `listening`, widen the cast as shown rather than the helper's public type. Match the surrounding tests' start/stop usage — check how neighbors call `broker.start()`/`stop()` and mirror them exactly.)

- [ ] **Step 2: Run to verify failure**

Run: `cd broker && node --import tsx --test src/broker.test.ts`
Expected: FAIL — `identityName` unknown / `announce` not a function.

- [ ] **Step 3: Implement.** In `BrokerDeps`, after `livekitUrl`:

```ts
  /** The broker's own identity name (e.g. "Anderson") — addressable like an agent, but never one. */
  identityName?: string;
```

In `addressableNames()`:

```ts
  private addressableNames(): string[] {
    const grouped = this.groupedAgentIds();
    const names = [
      ...this.deps.directory.snapshot().filter((p) => !grouped.has(p.agent.id)).map((p) => p.agent.name),
      ...this.squads.flatMap((s) => [s.id, s.leader.name]),
      ...this.groups.map((g) => g.name),
    ];
    if (this.deps.identityName) names.push(this.deps.identityName);
    return names;
  }
```

New public method next to `handleUtterance` (mirrors the task-event narration at ~line 427):

```ts
  /** Queue a system-originated note (session greeting, infrastructure event) as its own brain turn. */
  announce(note: string): Promise<void> {
    return this.enqueueTurn(() => this.deps.brain.handleSystemNote(note, this.makeTurn()));
  }
```

- [ ] **Step 4: Run the broker suite**

Run: `cd broker && node --import tsx --test src/broker.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd broker && npm run typecheck
git add broker/src/broker.ts broker/src/broker.test.ts
git commit -m "feat(broker): identity is addressable; announce() for host-voiced system notes"
```

---

### Task 6: Wiring — identity load, roster frame, voice, executors, greeting

**Files:**
- Modify: `broker/src/text-channel.ts` (`ChannelFrame` roster variant, ~line 32)
- Modify: `broker/src/main.ts` (identity load before line ~220; brain opts + executors ~line 222; `elevenVoiceFor` ~line 336; roster broadcast sites ~lines 540, 631, 673, 918; creation object ~line 636; sessions `create` handler ~line 580)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: roster frames shaped `{ type: 'roster', agents, identity: { name, role, ring, listening? } }`. Task 7's UI reads exactly this.

- [ ] **Step 1: Roster frame type** — in `text-channel.ts` change the roster variant to:

```ts
  | {
      type: 'roster';
      agents: RosterEntry[];
      /** The broker's own identity (host tile) — never an entry in `agents`. */
      identity?: { name: string; role: string; ring?: string; listening?: boolean };
    }
```

- [ ] **Step 2: Load the identity in `main.ts`** — with the other `.smith` config (before the `let broker` block, ~line 217):

```ts
// The broker's own identity (host persona, default Anderson) — data, not code.
const identityFile = process.env.BROKER_IDENTITY_FILE ?? '.smith/identity.json';
const identity = loadIdentity(() => readFileSync(identityFile, 'utf8'));
```

Import `loadIdentity` from `./identity.ts` (and `draftToAgentBody` from `./persona-generator.ts`, `promptInfo` from `./identity.ts` for the steps below).

- [ ] **Step 3: Extract the creation object + real executors.** Move the inline creation object (the `{ catalog, records, update, generate, voices, preview, create }` literal passed to `TextChannel`, ~line 636) into a named `const creation = { …identical body… };` declared just above `const textChannel = new TextChannel(…)`, and pass `creation` in its place. Then replace the Task-3 stub executors in the `new BrokerBrain(streamFactory, {…})` literal:

```ts
  // Voice-driven agent creation: draft under the host's control, persist only
  // on the human's explicit yes. `creation` is declared later in this file —
  // same TDZ pattern as `broker`: these closures only run per-turn.
  draft_agent: async ({ spec }) => {
    const draft = (await creation.generate({ hint: spec })) as unknown as PersonaDraft;
    pendingDraft = draft;
    return `Draft ready — pitch it and ask before creating. Name: ${draft.name}. Role: ${draft.role}. Backstory: ${draft.backstory}`;
  },
  confirm_agent: async ({ accept }) => {
    const draft = pendingDraft;
    pendingDraft = null;
    if (!draft) return 'no pending draft — call draft_agent first';
    if (!accept) return `discarded the draft for ${draft.name}`;
    const created = (await creation.create(
      draftToAgentBody(draft, { language: 'en-do', voiceId: DEFAULT_ELEVEN_VOICE }),
    )) as { error?: string };
    return created.error ? `creation failed: ${created.error}` : `${draft.name} is on the crew — their real voice still needs casting in the wizard`;
  },
```

with `let pendingDraft: PersonaDraft | null = null;` declared beside `let broker: Broker;` and `import type { PersonaDraft } from './persona-generator.ts';`. Also pass the identity to the brain: third argument `{ identity: promptInfo(identity) }`.
Note: `DEFAULT_ELEVEN_VOICE` is declared at ~line 295, after the brain literal — same TDZ-safe-at-runtime situation; if `tsc` or biome flags it, hoist the `SQUAD_VOICES`/`DEFAULT_ELEVEN_VOICE` block above the brain construction rather than duplicating the value.

- [ ] **Step 4: Voice + roster frame helpers.** Change `elevenVoiceFor`:

```ts
function elevenVoiceFor(speaker?: string): string {
  if (speaker && identity.voice.voiceId && speaker.toLowerCase() === identity.name.toLowerCase()) return identity.voice.voiceId;
  return (speaker && (directory.resolve(speaker)?.voice?.voiceId ?? SQUAD_VOICES[speaker])) ?? DEFAULT_ELEVEN_VOICE;
}
```

Below `toRosterEntries`, add:

```ts
/** The full roster frame: crew entries plus the host identity tile. */
const rosterFrame = (roster: UiRoster): ChannelFrame => ({
  type: 'roster',
  agents: toRosterEntries(roster),
  identity: {
    name: identity.name,
    role: identity.role,
    ring: identity.avatarRing,
    listening: roster.listening.some((n) => n.toLowerCase() === identity.name.toLowerCase()) || undefined,
  },
});
```

Replace all four `{ type: 'roster', agents: toRosterEntries(…) }` literals (hello frames ~540, reset ~631, post-PUT ~673, `onRosterChange` ~918) with `rosterFrame(broker.uiRoster())` / `rosterFrame(roster)`.

- [ ] **Step 5: Greeting on session create.** In the sessions `create` handler (~line 580), after `textChannel.broadcast(sessionFrame());`:

```ts
      // The host greets a NEW session once — activation replays silently.
      void broker.announce(
        `a new session just started in workspace "${s.workspace}". As ${identity.name}, greet the human in one or two sentences — roster-aware (who is idle, who is busy on what). Do not delegate.`,
      );
```

Do NOT add this to the `activate` handler. Also wire `identityName: identity.name,` into the `new Broker({…})` deps object (~line 900s, beside `livekitUrl`).

- [ ] **Step 6: Full verification**

Run: `cd broker && npm run typecheck && npm test`
Expected: all suites PASS (grep the test output for `fail 0`).

- [ ] **Step 7: Commit**

```bash
git add broker/src/main.ts broker/src/text-channel.ts
git commit -m "feat(broker): wire identity — roster frame host tile, voice hop, session greeting, creation executors"
```

---

### Task 7: Control-plane — identity tile outside the grid

**Files:**
- Modify: `control-plane/src/hooks/useBrokerChat.ts` (frame union ~line 137, roster handler ~line 163, state + return)
- Create: `control-plane/src/molecules/IdentityTile.tsx`
- Create: `control-plane/src/molecules/IdentityTile.test.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx` (rightRail, ~line 147)
- Modify: `control-plane/src/styles/components.css` (`.identity-tile` block)

**Interfaces:**
- Consumes: the roster frame's `identity` field (Task 6).
- Produces: `useBrokerChat()` additionally returns `identity: BrokerIdentityInfo | null` where `BrokerIdentityInfo = { name: string; role: string; ring?: string; listening?: boolean }`.

- [ ] **Step 1: Write the failing test** — `control-plane/src/molecules/IdentityTile.test.tsx` (mirror the render/import style of `SurfacePolicyPopover.test.tsx` — vitest + testing-library):

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IdentityTile } from "./IdentityTile";

describe("IdentityTile", () => {
  it("renders the host name and role", () => {
    render(<IdentityTile name="Anderson" role="Chief of Staff" ring="#8a93a6" />);
    expect(screen.getByText("Anderson")).toBeInTheDocument();
    expect(screen.getByText("Chief of Staff")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd control-plane && npx vitest run src/molecules/IdentityTile.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tile** — `control-plane/src/molecules/IdentityTile.tsx`:

```tsx
import { AgentAvatar } from "./AgentAvatar";

export interface IdentityTileProps {
  name: string;
  role: string;
  ring?: string;
  listening?: boolean;
}

/** The broker's own host tile — rendered OUTSIDE the agent grid (host, not crew). */
export function IdentityTile({ name, role, ring, listening }: IdentityTileProps) {
  return (
    <div className="identity-tile">
      <AgentAvatar name={name} role={role} ring={ring ?? "#8a93a6"} listening={listening ?? false} />
    </div>
  );
}
```

And in `components.css`, a separator that visually detaches the host from the crew grid (reuse the file's existing border/spacing variables — match neighboring blocks):

```css
/* Host tile: the broker's own identity, above and apart from the crew. */
.identity-tile {
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line, rgba(255, 255, 255, 0.08));
}
```

- [ ] **Step 4: Hook + page.** In `useBrokerChat.ts`: export `interface BrokerIdentityInfo { name: string; role: string; ring?: string; listening?: boolean }`; add `identity?: BrokerIdentityInfo` to the roster frame type in the union; add state `const [identity, setIdentity] = useState<BrokerIdentityInfo | null>(null);`; in the roster handler set `setIdentity(frame.identity ?? null);` beside `setRoster(frame.agents);`; add `identity` to the returned object (~line 456). In `HomePage.tsx`: destructure `identity` from `useBrokerChat`, and change `rightRail={<AgentRoster …/>}` to:

```tsx
      rightRail={
        <>
          {identity && <IdentityTile {...identity} />}
          <AgentRoster
            … (unchanged props)
          />
        </>
      }
```

- [ ] **Step 5: Full verification**

Run: `cd control-plane && npm run typecheck && npm run lint && npm run test`
Expected: PASS (biome may reformat — accept its fixes with `npx biome check --write .` if it flags style).

- [ ] **Step 6: Commit**

```bash
git add control-plane/src/molecules/IdentityTile.tsx control-plane/src/molecules/IdentityTile.test.tsx control-plane/src/hooks/useBrokerChat.ts control-plane/src/pages/HomePage.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): host identity tile — broker persona above the crew grid"
```

---

### Task 8: Final sweep

- [ ] **Step 1: Both packages green**

Run: `cd broker && npm run typecheck && npm test && cd ../control-plane && npm run typecheck && npm run lint && npm run test`
Expected: PASS everywhere.

- [ ] **Step 2: Spec conformance skim** — reread `docs/superpowers/specs/2026-08-06-broker-identity-design.md`; confirm each section maps to landed code (identity file, prompt rules, tools, addressing, voice hop, greeting-on-create-only, roster `identity` field, UI tile, tests).

- [ ] **Step 3: Note for Edwin** — Anderson's `persona.style`, `backstory`, and `quickAnswers` in `broker/.smith/identity.json` are drafted content; Edwin owns the final authorial pass, and Anderson's real ElevenLabs voice is uncast (deliberate — Edwin's picks only). The live tmux broker (`smith-broker` session) needs a restart to pick all of this up — do not restart it unasked.
