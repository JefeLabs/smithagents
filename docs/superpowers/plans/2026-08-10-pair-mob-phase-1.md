# Pair/Mob Phase 1 Implementation Plan — Solo Document Editor + Polish

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Claimed by:** unclaimed — claim this header before executing

**Goal:** Ship the spec's Phase 1: blueprint-driven documents in the broker, a document stage with the shifted layout and per-section markdown editing, session kinds with kind-aware activation, the SessionsPanel workspace anchor, and polish-my-input in the composer.

**Architecture:** Broker gains three small modules (`blueprints`, `documents`, `polish`) wired into `text-channel.ts` routes and a new `documents` WS frame, mirroring the sessions pattern exactly (manager + store closure in `main.ts`, full-frame-on-change broadcast). Control-plane gains a `/doc/$docId` stage (document center, chat docked right), a document choice on the new-session screen, kind badges + the active-workspace header on the SessionsPanel, and a polish action in the shared Composer.

**Tech Stack:** Broker: Node ≥24, tsx, `node:test`, npm. Control-plane: React 19, HeroUI Pro (post-1b), TanStack Router/Query, vitest, pnpm. **No new dependencies in either package.**

**Spec:** `docs/superpowers/specs/2026-08-10-pair-mob-document-sessions-design.md`

## Global Constraints

- **Base:** branch `pair-mob-phase-1` off `develop`, created only AFTER heroui-phase-1b fully merges (this plan builds on the migrated Composer/SessionsPanel). Execute in an isolated worktree (`git worktree add .worktrees/pair-mob-phase-1 -b pair-mob-phase-1 develop`); `.worktrees/` is gitignored.
- **Package managers:** broker = npm (`npm test`, `npm run typecheck` from `broker/`); control-plane = pnpm (from `control-plane/`). Never cross them.
- Broker targeted test: `node --import tsx --test src/<file>.test.ts` from `broker/`.
- **Lockstep parsers:** the `session` frame is parsed in BOTH `broker/src/main.ts` (`sessionFrame()`) and `control-plane/src/api/types.ts` + `src/stores/socketStore.ts`. Task 3 (broker) and Task 6 (control-plane) MUST land the same `kind`/`docId` shape; absent `kind` always parses as `"chat"`.
- **Frozen files:** `control-plane/src/styles/components.css` is never touched. New stage styles go in a NEW file `src/styles/documents.css` imported from `heroui.css` as `layer(legacy)` (the dashboards.css precedent). Pro-default conflicts go in `src/styles/overrides.css` under `@layer overrides` (the 1b precedent) — never inline `style={{}}`.
- **No route loaders; organisms router-free** — data rides the WS above the router; route components are thin.
- `onPress`/`isDisabled` on HeroUI components (raw pointer handlers only where 1b already sanctioned them in Composer).
- **HeroUI API verification is mandatory before writing compound JSX**: the plan's JSX for `Resizable` and `FloatingToc` is the expected shape, NOT verified API. Verify with `mcp__heroui-pro__get_component_docs` (load via ToolSearch) first — 1b's briefs guessed wrong on Sheet and PromptInput; the doc check caught it every time.
- Copy rules: all-lowercase UI copy for actions ("polish", "new document"); mono/uppercase only where existing surfaces already do it.
- Full gates before every commit: broker tasks `npm run typecheck && npm test`; control-plane tasks `pnpm typecheck && pnpm lint && pnpm test`. Lint prints a known warning baseline; exit code is the truth, read after a redirect, never after a pipe.
- Commit messages: lowercase descriptive, matching repo style.
- Documents are broker-owned state; **no git persistence of documents; no CRDT; no rich-text editor; no proposals/participants** (phases 2–3).

---

## File Structure

| Path | Responsibility |
|---|---|
| `broker/src/blueprints.ts` (new) | Blueprint types, packaged defaults (`spec`, `implementation-plan`), user-dir merge, `instantiateSections` with `when`/`required` rules |
| `broker/src/documents.ts` (new) | `Doc`/`DocSection`/`Proposal` types, `DocumentManager`, `DocumentStoreLike` |
| `broker/src/polish.ts` (new) | `polishText` free function (session-title.ts precedent) |
| `broker/src/sessions.ts` (modify) | `SessionKind`, `kind`/`docId` on `Session` + `SessionSummary` |
| `broker/src/text-channel.ts` (modify) | Routes: `GET /blueprints`, `POST /documents`, `PATCH /documents/:id/sections/:sectionId`, `POST /polish`; `documents` + `polish` ctor deps |
| `broker/src/main.ts` (modify) | Document store closure, `documentsFrame()`, broadcast sites, hello wiring, polish closure |
| `control-plane/src/api/types.ts` (modify) | `SessionKind`, `kind`/`docId` on `SessionSummary` + `SessionFrame`; `DocT`/`DocSectionT`/`BlueprintT`; `DocumentsFrame` |
| `control-plane/src/stores/socketStore.ts` (modify) | `documents` frame case |
| `control-plane/src/queries/keys.ts` + `pushed.ts` (modify) | `qk.documents` + `useDocuments()` |
| `control-plane/src/api/broker.ts` (modify) | `getBlueprints`, `postDocument`, `patchDocSection`, `postPolish` |
| `control-plane/src/organisms/SessionsPanel.tsx` (modify) | Active-workspace header, kind badges |
| `control-plane/src/pages/HomePage.tsx` (modify) | Kind-aware activation, DocumentStage wiring props |
| `control-plane/src/organisms/NewSessionScreen.tsx` (modify) | chat/document choice; blueprint + work-type + title fields |
| `control-plane/src/organisms/DocumentStage.tsx` (new) + `organisms/document/SectionCard.tsx` (new) | The document stage: resizable split, section read↔edit, TOC, chat dock |
| `control-plane/src/router.tsx` (modify) | `/doc/$docId` route |
| `control-plane/src/molecules/Composer.tsx` (modify) | polish action |
| `control-plane/src/styles/documents.css` (new) | All new stage/panel styles |

---

### Task 1: Broker blueprints module

**Files:**
- Create: `broker/src/blueprints.ts`
- Test: `broker/src/blueprints.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Tasks 2, 5 import): `interface BlueprintSection { id: string; heading: string; hint?: string; when?: { workType: string[] }; required?: boolean }`, `interface Blueprint { id: string; name: string; workTypes: string[]; sections: BlueprintSection[] }`, `loadBlueprints(dir?: string): Blueprint[]` (defaults merged with user files), `instantiateSections(bp: Blueprint, workType: string): { id: string; heading: string; body: string }[] | null` (null = workType not in bp.workTypes).

- [ ] **Step 1: Write the failing test**

```ts
// broker/src/blueprints.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { instantiateSections, loadBlueprints } from './blueprints.ts';

test('defaults ship spec and implementation-plan', () => {
  const bps = loadBlueprints(join(tmpdir(), 'no-such-dir'));
  assert.deepEqual(
    bps.map((b) => b.id).sort(),
    ['implementation-plan', 'spec'],
  );
});

test('user files merge over defaults by id and add new ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-'));
  writeFileSync(
    join(dir, 'spec.json'),
    JSON.stringify({ id: 'spec', name: 'My Spec', workTypes: ['feature'], sections: [{ id: 'only', heading: 'Only' }] }),
  );
  writeFileSync(
    join(dir, 'adr.json'),
    JSON.stringify({ id: 'adr', name: 'ADR', workTypes: ['decision'], sections: [{ id: 'context', heading: 'Context' }] }),
  );
  const bps = loadBlueprints(dir);
  const spec = bps.find((b) => b.id === 'spec');
  assert.equal(spec?.name, 'My Spec');
  assert.equal(spec?.sections.length, 1);
  assert.ok(bps.some((b) => b.id === 'adr'));
});

test('a malformed user file is skipped, defaults survive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-'));
  writeFileSync(join(dir, 'broken.json'), '{not json');
  const bps = loadBlueprints(dir);
  assert.ok(bps.some((b) => b.id === 'spec'));
});

test('instantiateSections activates conditional sections per workType', () => {
  const bp = {
    id: 'x',
    name: 'X',
    workTypes: ['feature', 'bugfix'],
    sections: [
      { id: 'a', heading: 'Always' },
      { id: 'b', heading: 'Bugfix only', when: { workType: ['bugfix'] } },
      { id: 'f', heading: 'Feature only', when: { workType: ['feature'] } },
    ],
  };
  assert.deepEqual(
    instantiateSections(bp, 'bugfix')?.map((s) => s.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    instantiateSections(bp, 'feature')?.map((s) => s.id),
    ['a', 'f'],
  );
});

test('instantiateSections rejects an undeclared workType', () => {
  const bp = { id: 'x', name: 'X', workTypes: ['feature'], sections: [{ id: 'a', heading: 'A' }] };
  assert.equal(instantiateSections(bp, 'bugfix'), null);
});

test('instantiated sections start with empty bodies', () => {
  const bp = { id: 'x', name: 'X', workTypes: ['feature'], sections: [{ id: 'a', heading: 'A' }] };
  assert.deepEqual(instantiateSections(bp, 'feature'), [{ id: 'a', heading: 'A', body: '' }]);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run (from `broker/`): `node --import tsx --test src/blueprints.test.ts`
Expected: FAIL — cannot find module `./blueprints.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// broker/src/blueprints.ts
/**
 * Blueprints — data-driven document schemas (spec 2026-08-10, "personas
 * principle": config, never a hardcoded enum). Packaged defaults merge with
 * user files by id; `when` conditions activate sections per work type.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BlueprintSection {
  id: string;
  heading: string;
  /** Author guidance shown as the empty-section placeholder. */
  hint?: string;
  /** Absent = always present. */
  when?: { workType: string[] };
  required?: boolean;
}

export interface Blueprint {
  id: string;
  name: string;
  workTypes: string[];
  sections: BlueprintSection[];
}

const DEFAULT_BLUEPRINTS: Blueprint[] = [
  {
    id: 'spec',
    name: 'Design Spec',
    workTypes: ['feature', 'bugfix', 'integration'],
    sections: [
      { id: 'overview', heading: 'What this is', hint: 'Two paragraphs, plain language.', required: true },
      { id: 'repro', heading: 'Reproduction', hint: 'Exact steps, expected vs actual.', when: { workType: ['bugfix'] } },
      { id: 'ui-refs', heading: 'Design refs', hint: 'Links or descriptions of the target look.', when: { workType: ['feature'] } },
      { id: 'contracts', heading: 'External contracts', hint: 'APIs, events, schemas this touches.', when: { workType: ['integration'] } },
      { id: 'approach', heading: 'Approach', hint: 'How it works, at the level a reviewer needs.' },
      { id: 'non-goals', heading: 'Non-goals', hint: 'What this deliberately does not do.', required: true },
      { id: 'testing', heading: 'Testing', hint: 'How we will know it works.' },
    ],
  },
  {
    id: 'implementation-plan',
    name: 'Implementation Plan',
    workTypes: ['feature', 'bugfix', 'integration'],
    sections: [
      { id: 'goal', heading: 'Goal', hint: 'One sentence.', required: true },
      { id: 'constraints', heading: 'Global constraints', hint: 'What binds every task.' },
      { id: 'tasks', heading: 'Tasks', hint: 'Bite-sized, each with its own test cycle.', required: true },
      { id: 'risks', heading: 'Risks', hint: 'What could go sideways and the early signal for each.' },
      { id: 'verification', heading: 'Verification', hint: 'The gates that must be green before merge.' },
    ],
  },
];

/** Defaults merged with user files (by id, user wins); malformed files are skipped. */
export function loadBlueprints(dir: string = process.env.BROKER_BLUEPRINTS_DIR ?? '.smith/blueprints'): Blueprint[] {
  const byId = new Map<string, Blueprint>(DEFAULT_BLUEPRINTS.map((b) => [b.id, b]));
  try {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      try {
        const bp = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Blueprint;
        if (typeof bp.id === 'string' && Array.isArray(bp.sections) && Array.isArray(bp.workTypes)) {
          byId.set(bp.id, bp);
        }
      } catch {
        /* skip malformed file; defaults must survive a bad user edit */
      }
    }
  } catch {
    /* no user dir — defaults only */
  }
  return [...byId.values()];
}

/** Sections active for a work type, with empty bodies; null = workType not declared by the blueprint. */
export function instantiateSections(
  bp: Blueprint,
  workType: string,
): Array<{ id: string; heading: string; body: string }> | null {
  if (!bp.workTypes.includes(workType)) return null;
  return bp.sections
    .filter((s) => !s.when || s.when.workType.includes(workType))
    .map((s) => ({ id: s.id, heading: s.heading, body: '' }));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/blueprints.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Full broker gate, commit**

Run: `npm run typecheck && npm test`

```bash
git add src/blueprints.ts src/blueprints.test.ts
git commit -m "feat: blueprints are config — defaults merge with user files, sections key on work type"
```

---

### Task 2: Broker documents module

**Files:**
- Create: `broker/src/documents.ts`
- Test: `broker/src/documents.test.ts`

**Interfaces:**
- Consumes: `Blueprint`, `instantiateSections` from `./blueprints.ts` (Task 1).
- Produces (Task 5 imports): types `DocSection { id; heading; body }`, `Proposal` (per spec, unused until phase 3), `Doc { id; title; blueprintId; workType; sections: DocSection[]; participants: string[]; proposals: Proposal[]; status: 'drafting'|'review'|'final'; createdAt; updatedAt }`, `DocumentStoreLike { loadAll(): Doc[]; save(doc: Doc): void }`, `class DocumentManager` with `init(): void`, `create(bp: Blueprint, workType: string, title: string): Doc | null`, `patchSection(docId: string, sectionId: string, body: string): Doc | null`, `get(id: string): Doc | null`, `list(): Doc[]` (newest-updated first).

- [ ] **Step 1: Write the failing test**

```ts
// broker/src/documents.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Blueprint } from './blueprints.ts';
import { type Doc, DocumentManager } from './documents.ts';

const BP: Blueprint = {
  id: 'spec',
  name: 'Design Spec',
  workTypes: ['feature', 'bugfix'],
  sections: [
    { id: 'overview', heading: 'What this is' },
    { id: 'repro', heading: 'Reproduction', when: { workType: ['bugfix'] } },
  ],
};

function manager(saved: Doc[] = []) {
  const writes: Doc[] = [];
  const m = new DocumentManager(
    { loadAll: () => saved, save: (d) => writes.push(structuredClone(d)) },
    () => '2026-08-10T12:00:00.000Z',
  );
  m.init();
  return { m, writes };
}

test('create instantiates sections for the work type and persists', () => {
  const { m, writes } = manager();
  const doc = m.create(BP, 'bugfix', 'Login breaks on resume');
  assert.ok(doc);
  assert.equal(doc.id, 'd1');
  assert.deepEqual(doc.sections.map((s) => s.id), ['overview', 'repro']);
  assert.equal(doc.status, 'drafting');
  assert.deepEqual(doc.participants, []);
  assert.equal(writes.length, 1);
});

test('create returns null for an undeclared work type and persists nothing', () => {
  const { m, writes } = manager();
  assert.equal(m.create(BP, 'decision', 'x'), null);
  assert.equal(writes.length, 0);
});

test('patchSection replaces the body, bumps updatedAt, persists', () => {
  const { m, writes } = manager();
  const doc = m.create(BP, 'feature', 'T')!;
  const patched = m.patchSection(doc.id, 'overview', 'It does the thing.');
  assert.equal(patched?.sections.find((s) => s.id === 'overview')?.body, 'It does the thing.');
  assert.equal(writes.length, 2);
});

test('patchSection on unknown doc or section is null, nothing persists', () => {
  const { m, writes } = manager();
  const doc = m.create(BP, 'feature', 'T')!;
  assert.equal(m.patchSection('d99', 'overview', 'x'), null);
  assert.equal(m.patchSection(doc.id, 'nope', 'x'), null);
  assert.equal(writes.length, 1);
});

test('init loads persisted docs and continues the id sequence', () => {
  const persisted: Doc = {
    id: 'd7',
    title: 'Old',
    blueprintId: 'spec',
    workType: 'feature',
    sections: [{ id: 'overview', heading: 'What this is', body: 'old' }],
    participants: [],
    proposals: [],
    status: 'drafting',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const { m } = manager([persisted]);
  assert.equal(m.get('d7')?.title, 'Old');
  assert.equal(m.create(BP, 'feature', 'New')?.id, 'd8');
});

test('list is newest-updated first', () => {
  const { m } = manager();
  const a = m.create(BP, 'feature', 'A')!;
  m.create(BP, 'feature', 'B');
  m.patchSection(a.id, 'overview', 'bump'); // same fake clock, but patch re-saves; order falls back to insertion — assert both present
  assert.deepEqual(m.list().map((d) => d.title).sort(), ['A', 'B']);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --import tsx --test src/documents.test.ts`
Expected: FAIL — cannot find module `./documents.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// broker/src/documents.ts
/**
 * Documents — blueprint-instantiated collaborative work products (spec
 * 2026-08-10). Broker-owned, persisted one JSON per doc like sessions are.
 * Phase 1 is solo editing; participants/proposals exist in the shape now so
 * phases 2-3 never migrate stored files.
 */
import { type Blueprint, instantiateSections } from './blueprints.ts';

export interface DocSection {
  id: string;
  heading: string;
  body: string;
}

export interface Proposal {
  id: string;
  sectionId: string;
  agentId: string;
  newBody: string;
  rationale: string;
  state: 'open' | 'accepted' | 'rejected' | 'stale';
  createdAt: string;
}

export interface Doc {
  id: string;
  title: string;
  blueprintId: string;
  workType: string;
  sections: DocSection[];
  participants: string[];
  proposals: Proposal[];
  status: 'drafting' | 'review' | 'final';
  createdAt: string;
  updatedAt: string;
}

export interface DocumentStoreLike {
  loadAll(): Doc[];
  save(doc: Doc): void;
}

export class DocumentManager {
  private docs = new Map<string, Doc>();
  private seq = 0;

  constructor(
    private readonly store: DocumentStoreLike,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  init(): void {
    for (const d of this.store.loadAll()) {
      this.docs.set(d.id, d);
      this.seq = Math.max(this.seq, Number(/^d(\d+)$/.exec(d.id)?.[1] ?? 0));
    }
  }

  create(bp: Blueprint, workType: string, title: string): Doc | null {
    const sections = instantiateSections(bp, workType);
    if (!sections) return null;
    this.seq += 1;
    const doc: Doc = {
      id: `d${this.seq}`,
      title: title.trim() || `${bp.name} ${this.seq}`,
      blueprintId: bp.id,
      workType,
      sections,
      participants: [],
      proposals: [],
      status: 'drafting',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.docs.set(doc.id, doc);
    this.store.save(doc);
    return doc;
  }

  /** Last-write-wins at section granularity (spec: conflict rules). */
  patchSection(docId: string, sectionId: string, body: string): Doc | null {
    const doc = this.docs.get(docId);
    const section = doc?.sections.find((s) => s.id === sectionId);
    if (!doc || !section) return null;
    section.body = body;
    doc.updatedAt = this.now();
    this.store.save(doc);
    return doc;
  }

  get(id: string): Doc | null {
    return this.docs.get(id) ?? null;
  }

  list(): Doc[] {
    return [...this.docs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/documents.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Full broker gate, commit**

Run: `npm run typecheck && npm test`

```bash
git add src/documents.ts src/documents.test.ts
git commit -m "feat: documents — blueprint-instantiated, section-patched, sessions-style store"
```

---

### Task 3: Session kinds (broker side of the lockstep pair)

**Files:**
- Modify: `broker/src/sessions.ts` (Session, SessionSummary, create opts, list)
- Modify: `broker/src/main.ts` (`sessionFrame()` session variant)
- Test: `broker/src/sessions.test.ts` (add cases)

**Interfaces:**
- Produces: `export type SessionKind = 'chat' | 'document';` `Session.kind?: SessionKind` and `Session.docId?: string`; `SessionSummary.kind: SessionKind` (resolved, never absent) and `SessionSummary.docId?: string`; `SessionManager.create(workspace, opts)` accepts `kind?: SessionKind; docId?: string`. Task 5 creates document sessions; Task 6 mirrors the types in the control-plane.

- [ ] **Step 1: Add failing tests to `broker/src/sessions.test.ts`**

Append (match the file's existing construction idiom — it builds `SessionManager` directly with a fake store; read the first existing test and reuse its helper):

```ts
test('sessions default to kind chat; document sessions carry kind and docId', () => {
  const m = new SessionManager({ loadAll: () => [], save: () => {} });
  m.create('acme', {});
  const doc = m.create('acme', { kind: 'document', docId: 'd1', title: 'Spec: login' });
  const [docRow, chatRow] = m.list();
  assert.equal(docRow.id, doc.id);
  assert.equal(docRow.kind, 'document');
  assert.equal(docRow.docId, 'd1');
  assert.equal(chatRow.kind, 'chat');
  assert.equal(chatRow.docId, undefined);
});

test('a persisted legacy session with no kind lists as chat', () => {
  const legacy = {
    id: 's3', title: 'Old', workspace: 'acme', runtime: 'local-in-process',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    transcript: [], brainHistory: [],
  } as Session;
  const m = new SessionManager({ loadAll: () => [legacy], save: () => {} });
  m.init();
  assert.equal(m.list()[0].kind, 'chat');
});
```

- [ ] **Step 2: Run to confirm the new tests fail**

Run: `node --import tsx --test src/sessions.test.ts`
Expected: the two new tests FAIL (unknown `kind` property / undefined); existing tests PASS.

- [ ] **Step 3: Implement in `sessions.ts`**

Add after the `ExecutionMode` type:

```ts
export type SessionKind = 'chat' | 'document';
```

Extend `Session` (after `runtime`):

```ts
  /** Absent on legacy files = "chat" (lockstep tolerance, same rule the UI parser applies). */
  kind?: SessionKind;
  /** Present iff kind === "document" — the document this session collaborates on. */
  docId?: string;
```

Extend `SessionSummary` (after `runtime`): `kind: SessionKind; docId?: string;`

In `create()`, extend the opts type with `kind?: SessionKind; docId?: string` and the constructed session with `kind: opts?.kind ?? 'chat', docId: opts?.docId,`.

In `list()`, extend the mapped summary with `kind: s.kind ?? 'chat', docId: s.docId,`.

- [ ] **Step 4: Extend `sessionFrame()` in `main.ts`**

Locate `function sessionFrame()` (~line 527). The active-session variant gains the same two fields:

```ts
    session: s
      ? { id: s.id, title: s.title, workspace: s.workspace, runtime: s.runtime, kind: s.kind ?? 'chat', docId: s.docId }
      : null,
```

(`sessions: sessionManager.list()` already carries the new summary fields.)

- [ ] **Step 5: Run the tests, full gate, commit**

Run: `node --import tsx --test src/sessions.test.ts` → PASS including the 2 new.
Run: `npm run typecheck && npm test`

```bash
git add src/sessions.ts src/sessions.test.ts src/main.ts
git commit -m "feat: sessions have a kind — chat by default, document when bound to a doc"
```

---

### Task 4: Polish module + route

**Files:**
- Create: `broker/src/polish.ts`
- Modify: `broker/src/text-channel.ts` (POST /polish route + optional ctor dep)
- Test: `broker/src/polish.test.ts`, `broker/src/text-channel.test.ts` (add one route test)

**Interfaces:**
- Consumes: `StreamFactory` from `./brain.ts`.
- Produces: `polishText(streamFactory: StreamFactory, model: string, text: string, context?: string): Promise<string | null>`; `TextChannel` gains optional ctor dep `polish?: (text: string) => Promise<string | null>` and route `POST /polish` `{text}` → 200 `{text}` | 400 `{error}` (empty text) | 502 `{error}` (model call failed). Task 8 (control-plane api) calls it.

- [ ] **Step 1: Write the failing polish test**

```ts
// broker/src/polish.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamFactory } from './brain.ts';
import { polishText } from './polish.ts';

const factoryReturning = (text: string | Error): StreamFactory =>
  ((params: unknown) => ({
    on: () => {},
    finalMessage: async () => {
      if (text instanceof Error) throw text;
      return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
    },
  })) as unknown as StreamFactory;

test('returns the rewritten text trimmed', async () => {
  const out = await polishText(factoryReturning('  Please review the login fix today.  '), 'm', 'plz revu login fx tody');
  assert.equal(out, 'Please review the login fix today.');
});

test('a failed model call returns null, never throws', async () => {
  const out = await polishText(factoryReturning(new Error('rate limited')), 'm', 'x');
  assert.equal(out, null);
});

test('an empty rewrite returns null so the caller keeps the draft', async () => {
  const out = await polishText(factoryReturning('   '), 'm', 'x');
  assert.equal(out, null);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `node --import tsx --test src/polish.test.ts`
Expected: FAIL — cannot find module `./polish.ts`.

- [ ] **Step 3: Write `polish.ts`**

```ts
// broker/src/polish.ts
/**
 * Polish-my-input — one standalone rewrite call BEFORE dispatch (spec
 * 2026-08-10): nothing reaches any agent until the user sends the result.
 * Same free-function-over-StreamFactory shape as session-title.ts; failure
 * returns null and the caller keeps the draft.
 */
import type { StreamFactory } from './brain.ts';

const SYSTEM =
  'You polish rough drafts into clear, well-formed requests. Keep the meaning, intent, language and any names exactly; fix spelling, grammar and structure; stay close to the original length. Reply with ONLY the polished text — no quotes, no preamble.';

export async function polishText(
  streamFactory: StreamFactory,
  model: string,
  text: string,
  context?: string,
): Promise<string | null> {
  try {
    const stream = streamFactory({
      model,
      max_tokens: 500,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: context
            ? `Conversation context (for names/terms only):\n${context.slice(0, 800)}\n\nDraft to polish:\n${text.slice(0, 2000)}`
            : `Draft to polish:\n${text.slice(0, 2000)}`,
        },
      ],
      tools: [] as never,
    });
    const final = await stream.finalMessage();
    const out = final.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return out || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the polish tests**

Run: `node --import tsx --test src/polish.test.ts` → PASS, 3 tests.

- [ ] **Step 5: Add the route test to `text-channel.test.ts`**

Use the file's `channelWith(opts)` helper (lines ~61-102) — it builds a `TextChannel` with only the named trailing deps wired. `polish` is a NEW optional dep; extend `channelWith`'s options type the same way the existing optional deps (e.g. `sessions`) are declared there.

```ts
test('POST /polish returns the rewrite, 400 on empty text, 502 when the rewrite fails', async () => {
  let fail = false;
  const channel = channelWith({
    polish: async (text: string) => (fail ? null : `polished: ${text}`),
  });
  const port = await channel.start(0);
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/polish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'plz fix' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { text: 'polished: plz fix' });

    const empty = await fetch(`http://127.0.0.1:${port}/polish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(empty.status, 400);

    fail = true;
    const down = await fetch(`http://127.0.0.1:${port}/polish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    assert.equal(down.status, 502);
  } finally {
    await channel.stop();
  }
});
```

- [ ] **Step 6: Wire the route in `text-channel.ts`**

Add the optional ctor dep alongside the existing optional deps (match how `sessions` is declared positionally — read the constructor before editing). Add the route next to `POST /sessions` (it is NOT inside the `if (this.creation)` block):

```ts
if (req.method === 'POST' && url.pathname === '/polish' && this.polish) {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let text = '';
    try {
      text = String((JSON.parse(body || '{}') as { text?: unknown }).text ?? '');
    } catch {
      /* falls through to the empty-text 400 */
    }
    if (!text.trim()) {
      json(400, { error: 'text is required' });
      return;
    }
    void this.polish!(text).then(
      (polished) => (polished ? json(200, { text: polished }) : json(502, { error: 'polish unavailable' })),
      () => json(502, { error: 'polish unavailable' }),
    );
  });
  return;
}
```

- [ ] **Step 7: Wire the closure in `main.ts`**

Where `TextChannel` is constructed (the `sessions` closure site, ~line 1014), add the `polish` dep. Context comes from the active session's transcript tail:

```ts
polish: (text) => {
  const s = sessionManager.activeOrNull();
  const context = s?.transcript.slice(-6).map((t) => `${t.role}: ${t.text}`).join('\n');
  return polishText(streamFactory, 'claude-haiku-4-5', text, context);
},
```

(`import { polishText } from './polish.ts';` at the top; `streamFactory` is the same module-level factory `maybeRetitle` uses — reuse it, do not construct a new client.)

- [ ] **Step 8: Run gates, commit**

Run: `node --import tsx --test src/polish.test.ts src/text-channel.test.ts` → PASS.
Run: `npm run typecheck && npm test`

```bash
git add src/polish.ts src/polish.test.ts src/text-channel.ts src/text-channel.test.ts src/main.ts
git commit -m "feat: polish-my-input — one rewrite call, nothing dispatched until the user sends"
```

---

### Task 5: Document routes + `documents` frame + wiring

**Files:**
- Modify: `broker/src/text-channel.ts` (routes + `documents`/`blueprints` ctor deps + `ChannelFrame` union)
- Modify: `broker/src/main.ts` (store closure, manager init, `documentsFrame()`, broadcasts, hello, document-session creation)
- Test: `broker/src/text-channel.test.ts` (add route tests)

**Interfaces:**
- Consumes: Tasks 1–3 (`loadBlueprints`, `DocumentManager`, session kinds).
- Produces (Task 6 mirrors): WS frame `{ type: 'documents'; documents: Doc[] }` (ALL docs, full-frame-on-change — the roster idiom; also delivered to every fresh WS client the same way the `session` frame is). Routes: `GET /blueprints` → `{blueprints}`; `POST /documents` `{blueprintId, workType, title}` → 200 `{doc}` | 400 `{error}` (also creates + activates the document session and broadcasts both frames); `PATCH /documents/:id/sections/:sectionId` `{body}` → 200 `{ok:true}` | 404 `{error}`.

- [ ] **Step 1: Add failing route tests**

Extend `channelWith`'s options with the two new deps, then:

```ts
test('GET /blueprints returns the loaded set', async () => {
  const channel = channelWith({
    blueprints: () => [{ id: 'spec', name: 'Design Spec', workTypes: ['feature'], sections: [] }],
  });
  const port = await channel.start(0);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/blueprints`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { blueprints: Array<{ id: string }> };
    assert.deepEqual(body.blueprints.map((b) => b.id), ['spec']);
  } finally {
    await channel.stop();
  }
});

test('POST /documents forwards the body and returns the created doc; PATCH updates a section', async () => {
  const patches: unknown[] = [];
  const channel = channelWith({
    documents: {
      create: async (body: { blueprintId?: string; workType?: string; title?: string }) =>
        body.blueprintId === 'spec'
          ? { doc: { id: 'd1', title: body.title ?? '', blueprintId: 'spec', workType: body.workType ?? '', sections: [], participants: [], proposals: [], status: 'drafting', createdAt: 't', updatedAt: 't' } }
          : { error: `unknown blueprint: ${body.blueprintId ?? '(none)'}` },
      patchSection: (docId: string, sectionId: string, body: string) => {
        patches.push([docId, sectionId, body]);
        return docId === 'd1' ? null : `unknown document: ${docId}`;
      },
    },
  });
  const port = await channel.start(0);
  try {
    const created = await fetch(`http://127.0.0.1:${port}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blueprintId: 'spec', workType: 'feature', title: 'Login spec' }),
    });
    assert.equal(created.status, 200);
    assert.equal(((await created.json()) as { doc: { id: string } }).doc.id, 'd1');

    const bad = await fetch(`http://127.0.0.1:${port}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blueprintId: 'nope', workType: 'feature', title: 'x' }),
    });
    assert.equal(bad.status, 400);

    const patched = await fetch(`http://127.0.0.1:${port}/documents/d1/sections/overview`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'It does the thing.' }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patches[0], ['d1', 'overview', 'It does the thing.']);

    const missing = await fetch(`http://127.0.0.1:${port}/documents/d9/sections/overview`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'x' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await channel.stop();
  }
});
```

- [ ] **Step 2: Run to confirm the new tests fail**

Run: `node --import tsx --test src/text-channel.test.ts`
Expected: the 2 new tests FAIL (404s — routes missing); everything else PASSES.

- [ ] **Step 3: Implement the routes in `text-channel.ts`**

Ctor deps (typed like `sessions`): `blueprints?: () => Blueprint[]` and `documents?: { create(body: { blueprintId?: string; workType?: string; title?: string }): Promise<{ doc?: Doc; error?: string; status?: number }>; patchSection(docId: string, sectionId: string, body: string): string | null }` (import the types from `./blueprints.ts` / `./documents.ts`). Extend the `ChannelFrame` union with `{ type: 'documents'; documents: Doc[] }`.

Routes, next to the sessions block (mutations use the same `originBlocked()` guard `POST /sessions` uses):

```ts
if (req.method === 'GET' && url.pathname === '/blueprints' && this.blueprints) {
  json(200, { blueprints: this.blueprints() });
  return;
}

if (req.method === 'POST' && url.pathname === '/documents' && this.documents) {
  if (originBlocked()) return;
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let parsed: { blueprintId?: unknown; workType?: unknown; title?: unknown } = {};
    try {
      parsed = JSON.parse(body || '{}') as typeof parsed;
    } catch {
      /* empty body handled by the closure's validation */
    }
    void this.documents!.create({
      blueprintId: typeof parsed.blueprintId === 'string' ? parsed.blueprintId : undefined,
      workType: typeof parsed.workType === 'string' ? parsed.workType : undefined,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
    }).then(
      (r) => (r.doc ? json(200, { doc: r.doc }) : json(r.status ?? 400, { error: r.error ?? 'invalid request' })),
      (err: unknown) => json(500, { error: String((err as Error).message ?? err) }),
    );
  });
  return;
}

const docSectionMatch = /^\/documents\/([^/]+)\/sections\/([^/]+)$/.exec(url.pathname);
if (req.method === 'PATCH' && docSectionMatch && this.documents) {
  if (originBlocked()) return;
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let text = '';
    try {
      text = String((JSON.parse(body || '{}') as { body?: unknown }).body ?? '');
    } catch {
      /* empty = clear the section, which is legal */
    }
    const error = this.documents!.patchSection(
      decodeURIComponent(docSectionMatch[1]),
      decodeURIComponent(docSectionMatch[2]),
      text,
    );
    json(error ? 404 : 200, error ? { error } : { ok: true });
  });
  return;
}
```

- [ ] **Step 4: Wire `main.ts`**

Next to the sessions store (~line 319), following its exact shape:

```ts
// Documents — blueprint-instantiated work products persisted under .smith/documents/.
const documentsDir = process.env.BROKER_DOCUMENTS_DIR ?? '.smith/documents';
const documentStore = {
  loadAll(): Doc[] {
    try {
      return readdirSync(documentsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(documentsDir, f), 'utf8')) as Doc);
    } catch {
      return [];
    }
  },
  save(doc: Doc): void {
    try {
      mkdirSync(documentsDir, { recursive: true });
      writeFileSync(join(documentsDir, `${doc.id}.json`), JSON.stringify(doc, null, 2));
    } catch (err) {
      console.error('[documents] persist failed:', err);
    }
  },
};
const documentManager = new DocumentManager(documentStore);
documentManager.init();
const blueprints = loadBlueprints();
```

Frame builder next to `sessionFrame()`:

```ts
function documentsFrame() {
  return { type: 'documents' as const, documents: documentManager.list() };
}
```

**Hello delivery:** find how a fresh WS client receives its first `session` frame (search `text-channel.ts` for the `connection` handler / the hello mechanism — the session frame reaches new clients somewhere; the pack did not capture it). Register `documentsFrame()` through the SAME mechanism, immediately after the session frame. Do not invent a parallel path; mirror the existing one exactly and note in your report which mechanism it was.

Ctor wiring (with the `sessions`/`polish` closures):

```ts
blueprints: () => blueprints,
documents: {
  create: async (body) => {
    const bp = blueprints.find((b) => b.id === body.blueprintId);
    if (!bp) return { error: `unknown blueprint: ${body.blueprintId ?? '(none)'}` };
    if (!body.workType || !bp.workTypes.includes(body.workType))
      return { error: `workType must be one of: ${bp.workTypes.join(', ')}` };
    const doc = documentManager.create(bp, body.workType, body.title ?? '');
    if (!doc) return { error: 'could not create document' };
    // The document session is the collaboration episode on this doc (spec:
    // session kinds). Created active so the docked chat is live on arrival.
    sessionManager.create(defaultWorkspace, { kind: 'document', docId: doc.id, title: doc.title });
    textChannel.broadcast(documentsFrame());
    textChannel.broadcast(sessionFrame());
    return { doc };
  },
  patchSection: (docId, sectionId, body) => {
    const doc = documentManager.patchSection(docId, sectionId, body);
    if (!doc) return `unknown document or section: ${docId}/${sectionId}`;
    textChannel.broadcast(documentsFrame());
    return null;
  },
},
```

`defaultWorkspace` — use the same default-workspace value `resolveLazyWorkspace` uses in this file (read its call site; do not hardcode a name). Imports: `DocumentManager, type Doc` from `./documents.ts`, `loadBlueprints` from `./blueprints.ts`.

- [ ] **Step 5: Run gates, commit**

Run: `node --import tsx --test src/text-channel.test.ts` → PASS including new. Then `npm run typecheck && npm test`.

```bash
git add src/text-channel.ts src/text-channel.test.ts src/main.ts
git commit -m "feat: documents ride the wire — routes, the documents frame, and a session per doc"
```

---

### Task 6: Control-plane types, socket, queries, api helpers

**Files:**
- Modify: `control-plane/src/api/types.ts`, `src/stores/socketStore.ts`, `src/queries/keys.ts`, `src/queries/pushed.ts`, `src/api/broker.ts`
- Test: `control-plane/src/stores/socketStore.test.ts` (add a case), `src/api/broker.test.ts` if it exists — otherwise the socket test carries this task's coverage

**Interfaces:**
- Produces (Tasks 7–10 consume): in `types.ts`: `type SessionKind = "chat" | "document"`; `SessionSummary` gains `kind: SessionKind; docId?: string`; `SessionFrame`'s `session` variant gains `kind: SessionKind; docId?: string`; new `interface DocSectionT { id: string; heading: string; body: string }`, `interface DocT { id: string; title: string; blueprintId: string; workType: string; sections: DocSectionT[]; participants: string[]; status: "drafting" | "review" | "final"; createdAt: string; updatedAt: string }`, `interface BlueprintT { id: string; name: string; workTypes: string[] }`, `interface DocumentsFrame { type: "documents"; documents: DocT[] }`. In `keys.ts`: `documents: ["documents"] as const`. In `pushed.ts`: `useDocuments(): UseQueryResult<DocT[]>` (skipToken, staleTime Infinity — the pushed idiom). In `api/broker.ts`: `getBlueprints(base?): Promise<BlueprintT[]>`, `postDocument(blueprintId, workType, title, base?): Promise<{ doc?: DocT; error?: string }>`, `patchDocSection(docId, sectionId, body, base?): Promise<{ error?: string }>`, `postPolish(text, base?): Promise<{ text?: string; error?: string }>`.

- [ ] **Step 1: Add a failing socket test**

In `src/stores/socketStore.test.ts`, find the existing frame-dispatch test idiom (frames are fed to the handler and cache writes asserted) and add:

```ts
it("a documents frame replaces the documents cache wholesale", () => {
  // Build/connect exactly as the sibling session-frame test does, then deliver:
  // {"type":"documents","documents":[{ id: "d1", title: "Spec", blueprintId: "spec",
  //   workType: "feature", sections: [], participants: [], status: "drafting",
  //   createdAt: "t", updatedAt: "t" }]}
  // Assert: qc.getQueryData(qk.documents) deep-equals that array.
});
```

Write the real test by mirroring the neighboring `session` frame test's setup verbatim (it constructs the store with a QueryClient and a fake socket); the comment above is the content contract, not the finished test — the finished test must construct and assert, never stay a stub.

- [ ] **Step 2: Run to confirm it fails**

Run (from `control-plane/`): `pnpm vitest run src/stores/socketStore.test.ts`
Expected: the new test FAILS (unknown frame → default case ignores it, cache stays empty).

- [ ] **Step 3: Implement**

`types.ts` — add the exact types from the Interfaces block above (kind on both `SessionSummary` and the `SessionFrame.session` variant; note `DocT` omits `proposals` deliberately — phase 1 renders none, and an unknown extra field from the broker is simply not read).

`keys.ts` — add `documents: ["documents"] as const,`.

`socketStore.ts` — extend the `BrokerFrame` union with `DocumentsFrame` and add before the default case:

```ts
case "documents":
  qc.setQueryData<DocT[]>(qk.documents, frame.documents);
  return;
```

`pushed.ts` — add:

```ts
export function useDocuments() {
  return useQuery<DocT[]>({ queryKey: qk.documents, queryFn: skipToken, staleTime: Infinity });
}
```

`api/broker.ts` — add, following `postSession`'s exact fetch idiom (try/fetch/res.ok/catch → `{error: "broker unreachable"}`):

```ts
/** GET /blueprints — the creation form's schema list. */
export async function getBlueprints(base: string = BROKER_BASE): Promise<BlueprintT[]> {
  try {
    const res = await fetch(`http://${base}/blueprints`);
    if (!res.ok) return [];
    const body = (await res.json()) as { blueprints?: BlueprintT[] };
    return body.blueprints ?? [];
  } catch {
    return [];
  }
}

/** POST /documents — creates the doc AND its document session; the documents/session frames follow on the socket. */
export async function postDocument(
  blueprintId: string,
  workType: string,
  title: string,
  base: string = BROKER_BASE,
): Promise<{ doc?: DocT; error?: string }> {
  try {
    const res = await fetch(`http://${base}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blueprintId, workType, title }),
    });
    const body = (await res.json().catch(() => ({}))) as { doc?: DocT; error?: string };
    if (res.ok && body.doc) return { doc: body.doc };
    return { error: body.error ?? `broker returned ${res.status}` };
  } catch {
    return { error: "broker unreachable" };
  }
}

/** PATCH a section body; the refreshed documents frame follows on the socket. */
export async function patchDocSection(
  docId: string,
  sectionId: string,
  body: string,
  base: string = BROKER_BASE,
): Promise<{ error?: string }> {
  try {
    const res = await fetch(`http://${base}/documents/${encodeURIComponent(docId)}/sections/${encodeURIComponent(sectionId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (res.ok) return {};
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    return { error: parsed.error ?? `broker returned ${res.status}` };
  } catch {
    return { error: "broker unreachable" };
  }
}

/** POST /polish — rewrite a draft; null-equivalent failure keeps the caller's draft. */
export async function postPolish(text: string, base: string = BROKER_BASE): Promise<{ text?: string; error?: string }> {
  try {
    const res = await fetch(`http://${base}/polish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (res.ok && body.text) return { text: body.text };
    return { error: body.error ?? `broker returned ${res.status}` };
  } catch {
    return { error: "broker unreachable" };
  }
}
```

Also update every place the compiler now flags a missing `kind` on constructed `SessionSummary` fixtures (test files) — add `kind: "chat" as const` to those fixtures; that is the whole change at each site.

- [ ] **Step 4: Run gates, commit**

Run: `pnpm vitest run src/stores/socketStore.test.ts` → PASS. Then `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add src/api/types.ts src/stores/socketStore.ts src/queries/keys.ts src/queries/pushed.ts src/api/broker.ts src/stores/socketStore.test.ts
git commit -m "feat: the ui speaks documents — frame, cache key, api helpers, session kinds"
```

(Stage any test-fixture files the `kind` addition touched as well — list them in the commit.)

---

### Task 7: SessionsPanel anchor + kind badges; kind-aware activation

**Files:**
- Modify: `control-plane/src/organisms/SessionsPanel.tsx`, `src/pages/HomePage.tsx`
- Create: `control-plane/src/styles/documents.css` (initial: panel styles only; Task 9 appends)
- Modify: `control-plane/src/styles/heroui.css` (one `@import` line)
- Test: `src/organisms/SessionsPanel.test.tsx` (add cases), `src/router.test.tsx` (activation navigation — added in Task 9 with the route; here only the panel tests)

**Interfaces:**
- Consumes: `SessionKind` on `SessionSummary` (Task 6).
- Produces: `SessionsPanelProps` gains `activeWorkspace?: string`; rows show a `FileText` (lucide) badge when `s.kind === "document"`; the header shows the active workspace. `HomePage`'s `onActivateSession` navigates by kind (consumed by Task 9's route test).

- [ ] **Step 1: Add failing panel tests**

Append to `SessionsPanel.test.tsx`, following its existing render helper:

```tsx
it("the header anchors the active workspace", () => {
  renderPanel({ activeWorkspace: "acme" }); // extend the file's existing helper with the new prop
  expect(screen.getByText("acme")).toBeTruthy();
});

it("document sessions carry a doc badge; chat sessions do not", () => {
  renderPanel({
    sessions: [
      { id: "s1", title: "Chat", workspace: "acme", updatedAt: "t", active: true, runtime: "local-in-process", kind: "chat" },
      { id: "s2", title: "Login spec", workspace: "acme", updatedAt: "t", active: false, runtime: "local-in-process", kind: "document", docId: "d1" },
    ],
  });
  const rows = screen.getAllByRole("button", { name: /chat|login spec/i });
  expect(within(rows[1]).getByLabelText("document session")).toBeTruthy();
  expect(within(rows[0]).queryByLabelText("document session")).toBeNull();
});
```

- [ ] **Step 2: Run to confirm both fail**

Run: `pnpm vitest run src/organisms/SessionsPanel.test.tsx`
Expected: 2 new FAIL, existing PASS.

- [ ] **Step 3: Implement the panel changes**

In `SessionsPanel.tsx`: add `activeWorkspace?: string` to props. In the header:

```tsx
<Sheet.Header>
  <Sheet.Heading>Sessions</Sheet.Heading>
  {activeWorkspace && <span className="sessions-panel__ws">{activeWorkspace}</span>}
</Sheet.Header>
```

In the session row, after the title span:

```tsx
{s.kind === "document" && <FileText size={12} aria-label="document session" className="session-row__kind" />}
```

(`import { FileText, Plus } from "lucide-react";`)

Create `src/styles/documents.css` with a header comment naming its purpose (pair/mob phase 1 styles; imported as layer(legacy) like dashboards.css) and the two panel rules:

```css
.sessions-panel__ws {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.session-row__kind {
  flex: none;
  color: var(--accent);
}
```

In `heroui.css`, directly below the `dashboards.css` import: `@import url("./documents.css") layer(legacy);`

In `HomePage.tsx`: pass `activeWorkspace={session?.workspace}` to `<SessionsPanel …>`, and make activation kind-aware:

```tsx
const onActivateSession = useCallback(
  (id: string) => {
    closeComposer();
    void api.activateSession(id);
    // A session's surface is part of what "switching to it" means (spec:
    // session kinds): document sessions live at their doc, chat at "/".
    const target = sessions.find((s) => s.id === id);
    if (target?.kind === "document" && target.docId) {
      void navigate({ to: "/doc/$docId", params: { docId: target.docId } });
    } else {
      void navigate({ to: "/" });
    }
  },
  [closeComposer, sessions, navigate],
);
```

(The `/doc/$docId` route lands in Task 9; TypeScript will flag the route string until then — Task 7 and Task 9 are committed in dependency order on one branch, so if the typecheck gate fails ONLY on the not-yet-existing route, use `to: "/doc/$docId" as never` with a `// Task 9 registers this route` comment and remove the cast in Task 9. Disclose in the report either way.)

- [ ] **Step 4: Run gates, commit**

Run: `pnpm vitest run src/organisms/SessionsPanel.test.tsx` → PASS. Then `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add src/organisms/SessionsPanel.tsx src/organisms/SessionsPanel.test.tsx src/pages/HomePage.tsx src/styles/documents.css src/styles/heroui.css
git commit -m "feat: the panel anchors the workspace, badges documents, and activation routes by kind"
```

---

### Task 8: NewSessionScreen document choice

**Files:**
- Modify: `control-plane/src/organisms/NewSessionScreen.tsx`
- Test: `src/organisms/NewSessionScreen.test.tsx` (add cases; existing tests pass unedited)

**Interfaces:**
- Consumes: `getBlueprints`, `BlueprintT` (Task 6); `FormSelect`/`FormTextField` from `../molecules/form` (Phase 1a); `RadioButtonGroup` (the screen already uses it post-1b).
- Produces: props gain `onCreateDocument?: (blueprintId: string, workType: string, title: string) => Promise<{ error?: string } | undefined>` and `listBlueprints?: () => Promise<BlueprintT[]>`. When absent, the screen renders exactly as today (chat only). HomePage wires them in Task 9.

- [ ] **Step 1: Add failing tests**

Append to `NewSessionScreen.test.tsx` (reuse the file's existing render helper; extend it to accept the two new props):

```tsx
it("without document props there is no kind toggle (today's screen, unchanged)", () => {
  renderScreen();
  expect(screen.queryByRole("radio", { name: /document/i })).toBeNull();
});

it("choosing document swaps prompt for blueprint/work-type/title and submits them", async () => {
  const onCreateDocument = vi.fn().mockResolvedValue(undefined);
  const listBlueprints = vi
    .fn()
    .mockResolvedValue([{ id: "spec", name: "Design Spec", workTypes: ["feature", "bugfix"] }]);
  renderScreen({ onCreateDocument, listBlueprints });
  fireEvent.click(screen.getByRole("radio", { name: /document/i }));
  await screen.findByText("Design Spec"); // blueprints resolved into the select
  // FormSelect fields: interact per the form adapters' test idiom used elsewhere
  // in this file's sibling tests (NewWorkspaceModal.test.tsx selects by label).
  fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "Login spec" } });
  fireEvent.click(screen.getByRole("button", { name: /create document/i }));
  await waitFor(() =>
    expect(onCreateDocument).toHaveBeenCalledWith("spec", "feature", "Login spec"),
  );
});

it("a create-document error renders and keeps the form", async () => {
  const onCreateDocument = vi.fn().mockResolvedValue({ error: "broker unreachable" });
  const listBlueprints = vi.fn().mockResolvedValue([{ id: "spec", name: "Design Spec", workTypes: ["feature"] }]);
  renderScreen({ onCreateDocument, listBlueprints });
  fireEvent.click(screen.getByRole("radio", { name: /document/i }));
  await screen.findByText("Design Spec");
  fireEvent.change(screen.getByLabelText(/title/i), { target: { value: "X" } });
  fireEvent.click(screen.getByRole("button", { name: /create document/i }));
  expect(await screen.findByText(/broker unreachable/)).toBeTruthy();
  expect(screen.getByLabelText(/title/i)).toBeTruthy();
});
```

- [ ] **Step 2: Run to confirm the new tests fail**

Run: `pnpm vitest run src/organisms/NewSessionScreen.test.tsx`
Expected: new FAIL, existing PASS.

- [ ] **Step 3: Implement**

Read the current post-1b `NewSessionScreen.tsx` first — it already composes `FormTextField`, `FormSelect` and `RadioButtonGroup`. Add:

- Local state `kind: "chat" | "document"` (default `"chat"`), rendered as a two-item `RadioButtonGroup` at the top of the form, ONLY when `onCreateDocument` is provided. Items labeled `chat` / `document` (lowercase copy).
- When `kind === "document"`: hide the prompt textarea + execution-mode grid; render instead a blueprint `FormSelect` (options loaded once via `listBlueprints` in a `useEffect` guarded on the prop; loading state = disabled select), a work-type `FormSelect` whose options are the SELECTED blueprint's `workTypes` (first one preselected when the blueprint changes), and a title `FormTextField` (label "Title"). Submit button copy: `create document`. Submit calls `onCreateDocument(blueprintId, workType, title)`; a returned `{error}` renders through the screen's existing error affordance (the same element the chat path's broker errors use); success is the caller's concern (it navigates).
- The `forced`/cancel semantics are untouched — the kind toggle renders inside the same form body, and `forced` still suppresses cancel.
- All fields via the `../molecules/form` adapters — no inline `<Controller>`.

This step is deliberately prose-first because the screen's exact post-1b markup is the implementer's source of truth; the binding requirements are the props contract, the conditional swap, the option-flow (blueprint → its workTypes), the error path, and untouched chat/forced behavior. Match the file's existing RHF/adapter idioms exactly.

- [ ] **Step 4: Run gates, commit**

Run: `pnpm vitest run src/organisms/NewSessionScreen.test.tsx` → PASS (existing unedited + 3 new). Then `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add src/organisms/NewSessionScreen.tsx src/organisms/NewSessionScreen.test.tsx
git commit -m "feat: the new-session screen births documents too — blueprint, work type, title"
```

---

### Task 9: Document stage + route

**Files:**
- Create: `control-plane/src/organisms/DocumentStage.tsx`, `src/organisms/document/SectionCard.tsx`
- Modify: `control-plane/src/router.tsx` (route), `src/pages/HomePage.tsx` (wire `onCreateDocument`/`listBlueprints` + navigate), `src/styles/documents.css` (append stage styles)
- Test: `src/organisms/document/SectionCard.test.tsx`, `src/organisms/DocumentStage.test.tsx`, `src/router.test.tsx` (add navigation cases)

**Interfaces:**
- Consumes: `useDocuments`, `DocT` (Task 6); `Transcript`/`Composer` (post-1b); `patchDocSection`, `postUtterance` (api).
- Produces: `DocumentStage({ doc, onSaveSection, chat }: { doc: DocT; onSaveSection: (sectionId: string, body: string) => Promise<{ error?: string }>; chat: ReactNode })` rendering `<section className="stage document-stage" aria-label="Document">`; `SectionCard({ section, editing, onEdit, onCancel, onSave })`; route `/doc/$docId`.

- [ ] **Step 1: Verify the Resizable and FloatingToc APIs**

Load `mcp__heroui-pro__get_component_docs` (ToolSearch `select:mcp__heroui-pro__get_component_docs`) and fetch docs for `resizable` and `floating-toc`. The stage JSX below uses the EXPECTED shapes (`Resizable`/`Resizable.Panel`/`Resizable.Handle`; `FloatingToc` fed `{id, label}` items). Correct to the real API before writing code; note corrections in your report. If `FloatingToc`'s real API resists a simple section list, SKIP it (render nothing) and report — the TOC is a nicety, not a gate.

- [ ] **Step 2: Write the failing SectionCard test**

```tsx
// src/organisms/document/SectionCard.test.tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SectionCard } from "./SectionCard";

const SECTION = { id: "overview", heading: "What this is", body: "It **does** the thing." };

describe("SectionCard", () => {
  afterEach(() => cleanup());

  it("read mode renders the heading and the body as markdown", () => {
    render(<SectionCard section={SECTION} editing={false} onEdit={vi.fn()} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByText("What this is")).toBeTruthy();
    expect(screen.getByText("does").tagName).toBe("STRONG");
  });

  it("an empty body renders the edit affordance, not empty markdown", () => {
    render(
      <SectionCard section={{ ...SECTION, body: "" }} editing={false} onEdit={vi.fn()} onCancel={vi.fn()} onSave={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /edit what this is/i })).toBeTruthy();
  });

  it("edit mode shows a textarea seeded with the raw body; save passes the new text", () => {
    const onSave = vi.fn();
    render(<SectionCard section={SECTION} editing onEdit={vi.fn()} onCancel={vi.fn()} onSave={onSave} />);
    const box = screen.getByRole("textbox", { name: /what this is/i });
    expect((box as HTMLTextAreaElement).value).toBe("It **does** the thing.");
    fireEvent.change(box, { target: { value: "New text" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith("New text");
  });

  it("cancel discards without saving", () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<SectionCard section={SECTION} editing onEdit={vi.fn()} onCancel={onCancel} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Confirm failure, then write `SectionCard.tsx`**

Run: `pnpm vitest run src/organisms/document/SectionCard.test.tsx` → FAIL (unresolved import).

```tsx
// src/organisms/document/SectionCard.tsx
import { Markdown } from "@heroui-pro/react/markdown";
import { useState } from "react";
import type { DocSectionT } from "../../api/types";

interface SectionCardProps {
  section: DocSectionT;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (body: string) => void;
}

/** One blueprint section: markdown in read mode, a plain textarea in edit mode
 *  (spec: per-section markdown IS the editor — proposals diff cleanly over text). */
export function SectionCard({ section, editing, onEdit, onCancel, onSave }: SectionCardProps) {
  const [draft, setDraft] = useState(section.body);
  if (!editing) {
    return (
      <section className="doc-section" aria-label={section.heading}>
        <header className="doc-section__head">
          <h3 className="doc-section__heading">{section.heading}</h3>
          <button type="button" className="doc-section__edit" aria-label={`edit ${section.heading}`} onClick={onEdit}>
            edit
          </button>
        </header>
        {section.body ? (
          <Markdown>{section.body}</Markdown>
        ) : (
          <p className="doc-section__empty">empty — press edit to write this section</p>
        )}
      </section>
    );
  }
  return (
    <section className="doc-section doc-section--editing" aria-label={section.heading}>
      <header className="doc-section__head">
        <h3 className="doc-section__heading">{section.heading}</h3>
      </header>
      <textarea
        aria-label={section.heading}
        className="doc-section__editor"
        rows={8}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="doc-section__actions">
        <button type="button" className="doc-section__cancel" onClick={onCancel}>
          cancel
        </button>
        <button type="button" className="doc-section__save" onClick={() => onSave(draft)}>
          save
        </button>
      </div>
    </section>
  );
}
```

Run the test → PASS, 4 tests. (Note: `useState(section.body)` seeds once per mount; `DocumentStage` below keys the editing card by `${section.id}` so a fresh mount reseeds on each edit entry.)

- [ ] **Step 4: Write the failing DocumentStage test**

```tsx
// src/organisms/DocumentStage.test.tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocT } from "../api/types";
import { DocumentStage } from "./DocumentStage";

const DOC: DocT = {
  id: "d1",
  title: "Login spec",
  blueprintId: "spec",
  workType: "feature",
  sections: [
    { id: "overview", heading: "What this is", body: "Words." },
    { id: "non-goals", heading: "Non-goals", body: "" },
  ],
  participants: [],
  status: "drafting",
  createdAt: "t",
  updatedAt: "t",
};

describe("DocumentStage", () => {
  afterEach(() => cleanup());

  it("renders the title, every section, and the docked chat", () => {
    render(<DocumentStage doc={DOC} onSaveSection={vi.fn()} chat={<div data-testid="dock" />} />);
    expect(screen.getByText("Login spec")).toBeTruthy();
    expect(screen.getByText("What this is")).toBeTruthy();
    expect(screen.getByText("Non-goals")).toBeTruthy();
    expect(screen.getByTestId("dock")).toBeTruthy();
  });

  it("one section edits at a time and save round-trips", async () => {
    const onSaveSection = vi.fn().mockResolvedValue({});
    render(<DocumentStage doc={DOC} onSaveSection={onSaveSection} chat={null} />);
    fireEvent.click(screen.getByRole("button", { name: /edit what this is/i }));
    // entering one section's edit mode leaves the other read-only
    expect(screen.queryByRole("button", { name: /edit what this is/i })).toBeNull();
    expect(screen.getByRole("button", { name: /edit non-goals/i })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /what this is/i }), { target: { value: "New." } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(onSaveSection).toHaveBeenCalledWith("overview", "New."));
    // back to read mode after a successful save
    await screen.findByRole("button", { name: /edit what this is/i });
  });

  it("a failed save keeps edit mode and shows the error", async () => {
    const onSaveSection = vi.fn().mockResolvedValue({ error: "broker unreachable" });
    render(<DocumentStage doc={DOC} onSaveSection={onSaveSection} chat={null} />);
    fireEvent.click(screen.getByRole("button", { name: /edit non-goals/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /non-goals/i }), { target: { value: "Draft kept" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/broker unreachable/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /non-goals/i }) as HTMLTextAreaElement).value).toBe("Draft kept");
  });
});
```

- [ ] **Step 5: Confirm failure, write `DocumentStage.tsx`**

Run → FAIL (unresolved import). Then (correcting `Resizable`/`FloatingToc` to the Step-1-verified API):

```tsx
// src/organisms/DocumentStage.tsx
import { Resizable } from "@heroui-pro/react/resizable";
import { type ReactNode, useState } from "react";
import type { DocT } from "../api/types";
import { SectionCard } from "./document/SectionCard";

interface DocumentStageProps {
  doc: DocT;
  onSaveSection: (sectionId: string, body: string) => Promise<{ error?: string }>;
  /** The docked chat column — composed by the route, the stage stays router- and store-free. */
  chat: ReactNode;
}

/** The pair/mob surface: document center, chat right (spec 2026-08-10, phase 1 = solo). */
export function DocumentStage({ doc, onSaveSection, chat }: DocumentStageProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async (sectionId: string, body: string) => {
    setSaveError(null);
    const r = await onSaveSection(sectionId, body);
    if (r.error) {
      setSaveError(r.error);
      return; // stay in edit mode; the draft lives in the still-mounted card
    }
    setEditingId(null);
  };

  return (
    <section className="stage document-stage" aria-label="Document">
      <Resizable className="document-stage__split">
        <Resizable.Panel defaultSize={70} minSize={45} className="document-stage__doc">
          <header className="document-stage__bar">
            <div className="document-stage__title">{doc.title}</div>
            <span className="document-stage__meta">
              {doc.blueprintId} · {doc.workType} · {doc.status}
            </span>
          </header>
          {saveError && (
            <p className="document-stage__error" role="status">
              {saveError}
            </p>
          )}
          <div className="document-stage__sections">
            {doc.sections.map((s) => (
              <SectionCard
                key={editingId === s.id ? `${s.id}-editing` : s.id}
                section={s}
                editing={editingId === s.id}
                onEdit={() => {
                  setSaveError(null);
                  setEditingId(s.id);
                }}
                onCancel={() => setEditingId(null)}
                onSave={(body) => void save(s.id, body)}
              />
            ))}
          </div>
        </Resizable.Panel>
        <Resizable.Handle />
        <Resizable.Panel defaultSize={30} minSize={20} className="document-stage__chat">
          {chat}
        </Resizable.Panel>
      </Resizable>
    </section>
  );
}
```

Run the DocumentStage tests → PASS, 3 tests. (If the verified Resizable API differs, keep the panel semantics — 70/30 default, document min 45 — and report the mapping.)

- [ ] **Step 6: Route, HomePage wiring, router tests**

`router.tsx` — add with the other route consts and register between `dashboardsRoute` and `workRoute`:

```tsx
function DocRoute() {
  const { docId } = docRoute.useParams();
  const { data: docs = NO_DOCS } = useDocuments();
  const { data: messages = NO_MESSAGES } = useTranscript();
  const connected = useSocketStore((c) => c.connected);
  const doc = docs.find((d) => d.id === docId);
  // Unknown or deleted doc — the stage-routing convention: go home.
  if (!doc) return <Navigate to="/" replace />;
  return (
    <DocumentStage
      doc={doc}
      onSaveSection={(sectionId, body) => api.patchDocSection(doc.id, sectionId, body)}
      chat={
        <div className="document-stage__dock">
          <Transcript messages={messages} />
          <Composer onSend={api.postUtterance} disabled={!connected} onPolish={api.polishDraft} />
        </div>
      }
    />
  );
}

const docRoute = createRoute({ getParentRoute: () => rootRoute, path: "/doc/$docId", component: DocRoute });
```

(`const NO_DOCS: DocT[] = [];` beside the other stable empties. `api.polishDraft` is Task 10's adapter — until Task 10 lands, wire `onPolish={undefined}`; Task 10 flips it. The dock deliberately omits mic/sound props — hold-to-talk stays a voice-stage affordance in phase 1.)

Remove the Task-7 `as never` cast on the activation navigate if one was used.

`HomePage.tsx` — wire the creation props into `<NewSessionScreen …>`:

```tsx
listBlueprints={api.getBlueprints}
onCreateDocument={async (blueprintId, workType, title) => {
  const r = await api.postDocument(blueprintId, workType, title);
  if (r.error) return { error: r.error };
  closeComposer();
  if (r.doc) void navigate({ to: "/doc/$docId", params: { docId: r.doc.id } });
  return undefined;
}}
```

`router.test.tsx` — add (mirror the existing seeding idiom; seed the documents cache like the roster is seeded):

```tsx
it("a document session activation lands on its document", async () => {
  const router = await renderAt("/");
  // seed one document + a document session into the cache inside renderAt's client
  // (extend renderAt's setQueryData block: qk.documents with [{id:"d1", …DOC fixture…}],
  //  qk.sessions with a kind:"document" docId:"d1" row) — then drive activation through
  //  the sessions panel exactly as the existing activation test does, and assert:
  await waitFor(() => expect(router.state.location.pathname).toBe("/doc/d1"));
  expect(await screen.findByRole("region", { name: "Document" })).toBeTruthy();
});

it("an unknown docId redirects home", async () => {
  const router = await renderAt("/doc/d404");
  await waitFor(() => expect(router.state.location.pathname).toBe("/"));
});
```

Write the first test fully against the file's real helpers (the comment is the contract; the committed test must seed and drive, never stub).

`documents.css` — append the stage styles:

```css
/* ---- document stage (pair/mob phase 1) ---- */
.document-stage__split {
  flex: 1;
  min-height: 0;
}
.document-stage__doc {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
  padding: 8px 18px 34px 18px;
}
.document-stage__bar {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 6px 0 14px 0;
}
.document-stage__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.document-stage__meta {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.document-stage__error {
  color: var(--text);
  border: 1px solid var(--pill-br);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
}
.document-stage__sections {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.document-stage__chat {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-left: 1px solid var(--rail-br);
}
.document-stage__dock {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: 10px;
  gap: 10px;
}
.doc-section {
  border: 1px solid var(--rail-br);
  border-radius: 10px;
  padding: 14px 16px;
}
.doc-section__head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.doc-section__heading {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.doc-section__edit,
.doc-section__cancel,
.doc-section__save {
  cursor: pointer;
  font-size: 11px;
  color: var(--text-2);
  border: 1px solid var(--pill-br);
  background: transparent;
  border-radius: 6px;
  padding: 3px 9px;
}
.doc-section__edit {
  margin-left: auto;
}
.doc-section__save {
  color: var(--text);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.doc-section__empty {
  margin: 0;
  font-size: 12.5px;
  font-style: italic;
  color: var(--text-dim);
}
.doc-section__editor {
  width: 100%;
  resize: vertical;
  background: transparent;
  color: var(--text);
  border: 1px solid var(--pill-br);
  border-radius: 8px;
  padding: 10px;
  font-size: 13.5px;
  line-height: 1.5;
  font-family: inherit;
}
.doc-section__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
```

Also add `.stage.document-stage` to base.css's edge-to-edge rule (the selector list that already carries `.stage.board-stage, .stage.map-stage, .stage.dashboards-stage`) — one selector, rule body untouched.

- [ ] **Step 7: Run gates, commit**

Run: `pnpm vitest run src/organisms/document/SectionCard.test.tsx src/organisms/DocumentStage.test.tsx src/router.test.tsx` → PASS. Then `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add src/organisms/DocumentStage.tsx src/organisms/DocumentStage.test.tsx src/organisms/document/SectionCard.tsx src/organisms/document/SectionCard.test.tsx src/router.tsx src/router.test.tsx src/pages/HomePage.tsx src/styles/documents.css src/styles/base.css
git commit -m "feat: the document stage — sections center, chat docked right, a route of its own"
```

---

### Task 10: Composer polish action

**Files:**
- Modify: `control-plane/src/molecules/Composer.tsx`, `src/api/broker.ts` (one adapter), `src/pages/HomePage.tsx` + `src/router.tsx` (wire `onPolish`)
- Test: `src/molecules/Composer.test.tsx` (add cases; the existing tests pass unedited)

**Interfaces:**
- Consumes: `postPolish` (Task 6).
- Produces: `ComposerProps` gains `onPolish?: (text: string) => Promise<string | null>`; `api/broker.ts` gains `polishDraft(text: string): Promise<string | null>` (adapter over `postPolish` returning null on error). Wired on the voice stage (VoiceStage passes through — check whether Composer is rendered by VoiceStage; wire wherever the Composer instances live) and the doc route's dock.

- [ ] **Step 1: Add failing tests**

Append to `Composer.test.tsx` (existing 18 stay byte-identical):

```tsx
it("polish replaces the draft with the rewrite and keeps it editable", async () => {
  const onPolish = vi.fn().mockResolvedValue("Please fix the login flow.");
  render(<Composer onSend={vi.fn()} onPolish={onPolish} />);
  const box = screen.getByRole("textbox", { name: /type a request/i });
  fireEvent.change(box, { target: { value: "plz fx login" } });
  fireEvent.click(screen.getByRole("button", { name: /polish/i }));
  await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("Please fix the login flow."));
  expect(onPolish).toHaveBeenCalledWith("plz fx login");
});

it("a failed polish keeps the draft exactly and shows an error", async () => {
  const onPolish = vi.fn().mockResolvedValue(null);
  render(<Composer onSend={vi.fn()} onPolish={onPolish} />);
  const box = screen.getByRole("textbox", { name: /type a request/i });
  fireEvent.change(box, { target: { value: "my rough draft" } });
  fireEvent.click(screen.getByRole("button", { name: /polish/i }));
  expect(await screen.findByText(/polish failed/i)).toBeTruthy();
  expect((box as HTMLTextAreaElement).value).toBe("my rough draft");
});

it("polish is absent without the prop and disabled on an empty draft", () => {
  const { rerender } = render(<Composer onSend={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /polish/i })).toBeNull();
  rerender(<Composer onSend={vi.fn()} onPolish={vi.fn()} />);
  expect(screen.getByRole("button", { name: /polish/i }).getAttribute("aria-disabled")).toBe("true");
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm vitest run src/molecules/Composer.test.tsx`
Expected: 3 new FAIL, existing 18 PASS.

- [ ] **Step 3: Implement**

In `Composer.tsx`: add props `onPolish?: (text: string) => Promise<string | null>`; local state `polishing` + `polishError`. In `PromptInput.ToolbarStart`, after the Plus button:

```tsx
{onPolish && (
  <PromptInput.Action
    className="polish-toggle"
    aria-label="Polish my input"
    aria-disabled={draft.trim() === "" || polishing || disabled}
    onPress={() => {
      const text = draft.trim();
      if (!text || polishing || disabled) return;
      setPolishing(true);
      setPolishError(null);
      void onPolish(text).then((polished) => {
        setPolishing(false);
        if (polished) {
          setDraft(polished);
          textareaRef.current?.focus();
        } else {
          setPolishError("polish failed — draft unchanged");
        }
      });
    }}
  >
    <Sparkles strokeWidth={1.7} />
  </PromptInput.Action>
)}
{polishError && (
  <span className="composer__polish-error" role="status">
    {polishError}
  </span>
)}
```

(`Sparkles` joins the lucide import. Clear `polishError` inside the textarea's existing `onChange` (one added line: `setPolishError(null);`). `aria-disabled` not `isDisabled` — the press must be interceptable for the no-op guard, matching the mic-action precedent.)

`documents.css` — append:

```css
.composer__polish-error {
  font-size: 11px;
  color: var(--text-dim);
  align-self: center;
}
.polish-toggle svg {
  width: 24px;
  height: 24px;
  margin: 0;
}
```

(The svg rule mirrors overrides.css's icon-sizing counter for the sibling toggles; it lives here, not overrides.css, ONLY if visual inspection shows the default is already correct — if the icon is mis-sized like Task 3's were, put the rule in `overrides.css` under the existing comment block instead. Decide by looking, disclose in the report.)

`api/broker.ts` — the adapter:

```ts
/** Composer-facing polish adapter: null on any failure so the caller keeps the draft. */
export async function polishDraft(text: string): Promise<string | null> {
  const r = await postPolish(text);
  return r.text ?? null;
}
```

Wire `onPolish={api.polishDraft}` wherever `Composer` is rendered with `onSend` (the voice stage's instance — find it via grep — and the doc route dock from Task 9, replacing its temporary `onPolish={undefined}`).

- [ ] **Step 4: Run gates, commit**

Run: `pnpm vitest run src/molecules/Composer.test.tsx` → PASS (21). Then `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add src/molecules/Composer.tsx src/molecules/Composer.test.tsx src/api/broker.ts src/pages/HomePage.tsx src/router.tsx src/styles/documents.css
git commit -m "feat: polish before dispatch — the draft is yours until you send it"
```

(Stage only the files actually touched; drop unmodified ones from the list.)

---

### Task 11: Full verification + live smoke

**Files:** none created — this task gates the branch.

- [ ] **Step 1: Broker gates**

From `broker/`: `npm run typecheck` then `npm test`, exit codes read after redirect. Expected: 0 / all tests pass.

- [ ] **Step 2: Control-plane gates**

From `control-plane/`: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Expected: all green (lint's known warning baseline aside), build succeeds; note the bundle delta vs 1b's recorded numbers.

- [ ] **Step 3: Live smoke (real browser, honest reporting)**

A LOCAL broker instance — do NOT restart the live tmux broker. From `broker/`: `BROKER_TEXT_PORT=7791 BROKER_SESSIONS_DIR=/tmp/smoke-sessions BROKER_DOCUMENTS_DIR=/tmp/smoke-docs npm run serve` (needs the repo `.env`; if required env is unavailable in this session, say so plainly and smoke against the live broker on 7790 WITHOUT restarting it, skipping the polish step if its cost is a concern). Dev server on 1421 pointed at the chosen broker (check how BROKER_BASE is derived; `VITE_`-style override or the default 7790).

Walk: create a document from the new-session screen (blueprint spec, work type feature) → land on `/doc/…` → edit a section, save, reload the page, confirm persistence → sessions panel shows the doc badge + workspace header → activate a chat session (lands on `/`), re-activate the document session (lands back on the doc) → type a rough draft, polish, confirm replacement, send. For anything not exercisable, state it plainly.

- [ ] **Step 4: Report**

Suite counts (both packages), gate statuses, bundle delta, smoke steps exercised vs not. No commit unless fixes were needed.

---

## Self-Review (done at plan time)

- **Spec coverage (phase 1 scope):** blueprints w/ conditionals + defaults ✔ (T1), broker store + section LWW ✔ (T2), session kinds both parsers ✔ (T3/T6), routes + documents frame + hello ✔ (T5), polish broker+UI ✔ (T4/T10), panel anchor + badges + kind routing ✔ (T7), creation surface ✔ (T8), stage + route + resizable + per-section editor ✔ (T9), error paths (broker down / unknown blueprint / unknown docId) ✔ (T2/T5/T8/T9), real-browser smoke ✔ (T11). FloatingToc: included as optional in T9 Step 1 with a sanctioned skip — spec calls it navigation nicety.
- **Type consistency:** `Doc`/`DocT` field sets match minus `proposals` (deliberate, documented in T6); `kind`/`docId` shapes identical in T3 and T6; `onSaveSection(sectionId, body)` signature consistent T9; `polishDraft` adapter over `postPolish` consistent T10.
- **Placeholder scan:** T6 Step 1, T8 Step 3, and T9 Step 6's first router test are contract-prose over the implementer's real file idioms (post-1b markup is the source of truth); each names its binding requirements and forbids stub tests. No TBDs.
