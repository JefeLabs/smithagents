# Capability Story Maps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-workspace Patton story maps (activities → steps → stories) whose slices seed spec docs and track as linked cards on an auto-provisioned Capabilities + Delivery board pair — story truth in the capability, toggle-only checklists on linked cards.

**Architecture:** The swarm owns a new store (`.smith/work/capabilities/<id>.json`) beside the board store and does all the linking work: pair auto-provision on capability create, spec-skeleton generation into the workspace repo, slice→card sends, and the write-through story sync inside the existing card PATCH. The broker only proxies `/work/capabilities/*` and broadcasts a `capability-updated` frame from a pure frame-computation helper. The control-plane adds a fourth stage (MapStage) and amends BoardStage/CardSheet for workspace grouping, capability chips, and toggle-only checklists.

**Tech Stack:** Fastify (swarm), raw node http (broker text channel), React 19 + @dnd-kit (control-plane), node:test via `node --import tsx --test` (swarm/broker), Vitest + Testing Library (control-plane).

**Spec:** `docs/superpowers/specs/2026-08-06-capability-story-maps-design.md`

**Prerequisite:** the kanban work-boards plan (`2026-08-06-kanban-work-boards.md`) is FULLY implemented — this plan modifies `work-items.ts`, the `/work` routes, the text-channel proxy, `BoardStage`, and `CardSheet` that it created. Do not start otherwise.

**Spec deltas (deliberate, decided at plan time):**
1. `createBoard` gains an optional third param `workspaceId` (the pair provisioner needs it; existing callers unchanged).
2. The `capability-updated` broadcast mechanism is pinned: the text-channel proxy computes frames after successful mutating `/work/*` calls via a pure exported helper `workUpdateFrames(method, pathname, payload)` — no new swarm event type.
3. When a write-through toggle updates the *sibling* linked card's story copy, no frame targets the sibling board; it catches up on its next open/refetch (BoardStage refetches on open). Accepted v1 staleness.
4. `specPath` is stored workspace-relative (`docs/superpowers/specs/...`) and resolved against the workspace's **default repo** (`resolveRepo(workspace)` with no repo name).

## Global Constraints

- Swarm tests NEVER construct `OrchestratorServer` or use Fastify `.inject` — extract logic into exported, unit-tested helpers; route bodies stay thin.
- Broker route tests use the `channelWith(...)` harness in `broker/src/text-channel.test.ts`.
- Import suffixes: swarm `.js`, broker `.ts`, control-plane extensionless.
- NO biome on swarm/broker files — hand-match 2-space/single-quote house style. Control-plane biome IS run (`npx biome check --write src/`).
- Test commands: `cd swarm && npm test` (baseline: `src/agent-sessions.test.ts` turn_timeout flakes are noise), `cd broker && npm test`, `cd control-plane && npx tsc --noEmit && npm test`.
- Capability ids and board ids match `/^[a-z0-9][a-z0-9-]{0,63}$/`; story/slice/activity/step ids are `crypto.randomUUID()`.
- Story truth lives in the capability. Linked-card checklists are toggle-only (`done`/`verifiedBy`); text edits/add/remove only in the map; violations → 400.
- `storyIds` are disjoint across slices; a story with no slice is backlog.
- Sends and spec generation are explicit actions; delivery send 409s until `specPath` is set; second send to the same target 409s; nothing ever auto-moves a card.
- Only the Capabilities + Delivery pair auto-provisions (on first capability for a workspace); `maintenance`/`support` are templates only.
- The control-plane hardcodes `const BASE = "127.0.0.1:7790"` per file.
- Commit messages: conventional commits with package scope. Never stage `.smith/*` runtime files or `control-plane/package-lock.json`.

## File Structure

| File | Responsibility |
|---|---|
| `swarm/src/work-items.ts` (modify) | Five templates, `WorkBoard.workspaceId?`, `WorkCard.capabilityRef?`, `createBoard` workspaceId param |
| `swarm/src/work-items.test.ts` (modify) | Template/type amendments |
| `swarm/src/capabilities.ts` (create) | Capability types, store, CRUD/validate, slice helpers, spec skeleton, toggle write-through, pair provisioning, send |
| `swarm/src/capabilities.test.ts` (create) | Unit tests for the above |
| `swarm/src/server.ts` (modify) | `/work/capabilities/*` routes; write-through inside the card PATCH route |
| `broker/src/text-channel.ts` (modify) | `capability-updated` frame type + broadcast from proxy via `workUpdateFrames` |
| `broker/src/text-channel.test.ts` (modify) | Frame + proxy broadcast tests |
| `control-plane/src/hooks/useBrokerChat.ts` (modify) | `capability-updated` frame → `lastCapabilityUpdate` |
| `control-plane/src/organisms/MapStage.tsx` (create) | Stage: pickers, map grid, slices panel, generate/send actions |
| `control-plane/src/organisms/MapStage.test.tsx` (create) | Map tests |
| `control-plane/src/organisms/ToolRail.tsx` (modify) | Fourth tool: Map |
| `control-plane/src/pages/HomePage.tsx` (modify) | `mapOpen` stage wiring |
| `control-plane/src/organisms/BoardStage.tsx` (modify) | Workspace-grouped switcher, five templates, capability chip pass-through |
| `control-plane/src/molecules/BoardCard.tsx` (modify) | Capability chip on the face |
| `control-plane/src/organisms/CardSheet.tsx` (modify) | Toggle-only checklist when `capabilityRef` present |
| `control-plane/src/organisms/BoardStage.test.tsx` (modify) | Board-side amendments |
| `control-plane/src/styles/components.css` (modify) | `.map-stage*`, `.slice-band*`, chip styles |

---

### Task 1: Swarm — board model amendments (templates, workspaceId, capabilityRef)

**Files:**
- Modify: `swarm/src/work-items.ts`
- Modify: `swarm/src/work-items.test.ts`

**Interfaces:**
- Consumes: existing work-items exports.
- Produces (used by Tasks 2, 3, 5, 7):
  - `BOARD_TEMPLATES: Record<BoardTemplate, WorkColumn[]>` where `export type BoardTemplate = 'personal' | 'capabilities' | 'delivery' | 'maintenance' | 'support'` (the old `'capability'` key is RENAMED to `'capabilities'` with new columns)
  - `createBoard(name: string, template: BoardTemplate, workspaceId?: string): WorkBoard`
  - `WorkBoard.workspaceId?: string`; `WorkCard.capabilityRef?: { capabilityId: string; sliceId: string }`

- [ ] **Step 1: Amend the tests** — in `swarm/src/work-items.test.ts`, replace the first template test with:

```ts
test('templates: five column sets, ids unique and slug-shaped', () => {
  assert.deepEqual(BOARD_TEMPLATES.personal.map((c) => c.name), ['Backlog', 'Ready', 'In Progress', 'In Review', 'Done']);
  assert.deepEqual(BOARD_TEMPLATES.capabilities.map((c) => c.name), ['Capability', 'Story Mapping', 'Spec', 'Plan', 'Ready for Delivery']);
  assert.deepEqual(BOARD_TEMPLATES.delivery.map((c) => c.name), ['Ready', 'In Progress', 'In Review', 'Verified', 'Done']);
  assert.deepEqual(BOARD_TEMPLATES.maintenance.map((c) => c.name), ['Reported', 'Triaged', 'In Progress', 'In Review', 'Done']);
  assert.deepEqual(BOARD_TEMPLATES.support.map((c) => c.name), ['Inbox', 'Triaged', 'Waiting on User', 'In Progress', 'Resolved']);
  for (const cols of Object.values(BOARD_TEMPLATES)) {
    assert.equal(new Set(cols.map((c) => c.id)).size, cols.length);
    for (const c of cols) assert.match(c.id, /^[a-z0-9][a-z0-9-]*$/);
  }
});

test('createBoard carries workspaceId; capabilityRef round-trips through save/load', async () => {
  const b = createBoard('skoolscout Capabilities', 'capabilities', 'skoolscout');
  assert.equal(b.id, 'skoolscout-capabilities');
  assert.equal(b.workspaceId, 'skoolscout');
  assert.equal(createBoard('Solo', 'personal').workspaceId, undefined);
  const card = addCard(b, { title: 'tour scheduling v1' });
  patchCard(b, card.id, { capabilityRef: { capabilityId: 'school-feature-set', sliceId: 'sl1' } });
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await saveBoard(dir, b);
  const { boards } = await loadBoards(dir);
  assert.deepEqual(boards[0].cards[0].capabilityRef, { capabilityId: 'school-feature-set', sliceId: 'sl1' });
});
```

Everywhere else in the file that uses `'capability'` as a template key or expects its old columns (the `createBoard('Alpha', 'capability')` in the round-trip test), switch to `'capabilities'`.

- [ ] **Step 2: Run to verify failure** — `cd swarm && node --import tsx --test src/work-items.test.ts` → FAIL (template keys, workspaceId, capabilityRef missing).

- [ ] **Step 3: Implement** — in `swarm/src/work-items.ts`:
  - Add `export type BoardTemplate = 'personal' | 'capabilities' | 'delivery' | 'maintenance' | 'support';`
  - Replace `BOARD_TEMPLATES` with (personal unchanged; the old `capability` entry is deleted):

```ts
export const BOARD_TEMPLATES: Record<BoardTemplate, WorkColumn[]> = {
  personal: [
    { id: 'backlog', name: 'Backlog' },
    { id: 'ready', name: 'Ready' },
    { id: 'in-progress', name: 'In Progress' },
    { id: 'in-review', name: 'In Review' },
    { id: 'done', name: 'Done' },
  ],
  capabilities: [
    { id: 'capability', name: 'Capability' },
    { id: 'story-mapping', name: 'Story Mapping' },
    { id: 'spec', name: 'Spec' },
    { id: 'plan', name: 'Plan' },
    { id: 'ready-for-delivery', name: 'Ready for Delivery' },
  ],
  delivery: [
    { id: 'ready', name: 'Ready' },
    { id: 'in-progress', name: 'In Progress' },
    { id: 'in-review', name: 'In Review' },
    { id: 'verified', name: 'Verified' },
    { id: 'done', name: 'Done' },
  ],
  maintenance: [
    { id: 'reported', name: 'Reported' },
    { id: 'triaged', name: 'Triaged' },
    { id: 'in-progress', name: 'In Progress' },
    { id: 'in-review', name: 'In Review' },
    { id: 'done', name: 'Done' },
  ],
  support: [
    { id: 'inbox', name: 'Inbox' },
    { id: 'triaged', name: 'Triaged' },
    { id: 'waiting-on-user', name: 'Waiting on User' },
    { id: 'in-progress', name: 'In Progress' },
    { id: 'resolved', name: 'Resolved' },
  ],
};
```

  - `WorkBoard` gains `/** Present on a workspace's standing boards (the Capabilities/Delivery pair and on-demand maintenance/support); absent on personal boards. */ workspaceId?: string;`
  - `WorkCard` gains `/** Set when this card tracks a capability slice — its checklist becomes a toggle-only view of the capability's stories. */ capabilityRef?: { capabilityId: string; sliceId: string };`
  - `createBoard(name: string, template: BoardTemplate, workspaceId?: string)` — after building the board, `if (workspaceId) board.workspaceId = workspaceId;` then return.
  - `patchCard`'s patch type union gains `'capabilityRef'`, applied like `jira`: `if (patch.capabilityRef !== undefined) card.capabilityRef = patch.capabilityRef ?? undefined;`
  - In `server.ts`, the `POST /work/boards` route's template validation currently checks `'personal' | 'capability'` — widen it: `const TEMPLATES = new Set(['personal', 'capabilities', 'delivery', 'maintenance', 'support']); if (!TEMPLATES.has(template)) return reply.status(400)...` (import nothing new; keep the literal set beside the route).

- [ ] **Step 4: Run to verify pass** — `cd swarm && node --import tsx --test src/work-items.test.ts` → PASS; then `cd swarm && npm test` → green apart from baseline.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/work-items.ts swarm/src/work-items.test.ts swarm/src/server.ts
git commit -m "feat(swarm): five board templates, workspace-scoped boards, capabilityRef on cards"
```

---

### Task 2: Swarm — capabilities module

**Files:**
- Create: `swarm/src/capabilities.ts`
- Create: `swarm/src/capabilities.test.ts`

**Interfaces:**
- Consumes: `work-items.js` (`WorkBoard`, `createBoard`, `addCard`, `loadBoards`, `saveBoard`, `BoardTemplate`), node built-ins only.
- Produces (used by Task 3):
  - Types `Capability`, `CapActivity`, `CapStory`, `CapSlice` exactly as below
  - `slugify(name): string` (throws when the slug is empty)
  - `createCapability(name, workspaceId): Capability`
  - `loadCapabilities(dir): Promise<{ capabilities: Capability[]; errors: Array<{ file; error }> }>`
  - `saveCapability(dir, cap): Promise<void>` / `deleteCapabilityFile(dir, id): Promise<void>`
  - `patchCapability(cap, patch: Partial<Pick<Capability, 'name' | 'activities' | 'stories' | 'slices'>>): Capability` — wholesale sub-array replace + full validation, bumps `updatedAt`, throws on violation
  - `applyStoryToggles(cap, sliceId, incoming: Array<{ id; text; done; verifiedBy? }>): CapStory[]` — validates toggle-only, applies to `cap.stories`, returns canonical copies in slice order; throws on any text/id/count drift
  - `sliceStories(cap, sliceId): CapStory[]` — the slice's stories in `storyIds` order
  - `renderSpecSkeleton(sliceName, stories: CapStory[], dateISO: string): string`
  - `ensureWorkspaceBoards(workDir, workspaceId): Promise<void>` — creates `<ws>-capabilities` / `<ws>-delivery` boards iff missing (idempotent)
  - `sendSliceToBoard(cap, slice, board): import('./work-items.js').WorkCard` — pure: adds the card (leftmost), copies stories, sets `capabilityRef`; caller persists

- [ ] **Step 1: Write the failing tests** — create `swarm/src/capabilities.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  applyStoryToggles, createCapability, deleteCapabilityFile, ensureWorkspaceBoards, loadCapabilities,
  patchCapability, renderSpecSkeleton, saveCapability, sendSliceToBoard, sliceStories, slugify,
} from './capabilities.js';
import { loadBoards } from './work-items.js';

function fixture() {
  const cap = createCapability('School Feature Set', 'skoolscout');
  const [a1s1, a1s2] = ['st-tours', 'st-analyze'];
  cap.activities = [{ id: 'act-tours', name: 'Manage Candidate Tours', order: 0, steps: [
    { id: a1s1, name: 'Define Tour Schedule', order: 0 },
    { id: a1s2, name: 'Analyze Tour Data', order: 1 },
  ] }];
  cap.stories = [
    { id: 's1', stepId: a1s1, order: 0, text: 'create tour time slots', done: false },
    { id: 's2', stepId: a1s1, order: 1, text: 'edit tour time slots', done: false },
    { id: 's3', stepId: a1s2, order: 0, text: 'view tour analytics', done: false },
  ];
  cap.slices = [{ id: 'sl1', name: 'tour scheduling v1', order: 0, storyIds: ['s1', 's2'] }];
  return cap;
}

test('slugify + createCapability shape', () => {
  assert.equal(slugify('School Feature Set!'), 'school-feature-set');
  assert.throws(() => slugify('!!!'), /name/i);
  const cap = createCapability('School Feature Set', 'skoolscout');
  assert.equal(cap.id, 'school-feature-set');
  assert.equal(cap.workspaceId, 'skoolscout');
  assert.deepEqual([cap.activities, cap.stories, cap.slices], [[], [], []]);
  assert.ok(cap.createdAt && cap.updatedAt);
});

test('patchCapability: wholesale replace with validation', () => {
  const cap = fixture();
  const before = cap.updatedAt;
  patchCapability(cap, { name: 'Renamed' });
  assert.equal(cap.name, 'Renamed');
  assert.ok(cap.updatedAt >= before);
  assert.throws(() => patchCapability(cap, { stories: [{ id: 'x', stepId: 'ghost', order: 0, text: 't', done: false }] }), /step/i);
  assert.throws(() => patchCapability(cap, { slices: [
    { id: 'a', name: 'a', order: 0, storyIds: ['s1'] },
    { id: 'b', name: 'b', order: 1, storyIds: ['s1'] },
  ] }), /disjoint/i);
  assert.throws(() => patchCapability(cap, { slices: [{ id: 'a', name: 'a', order: 0, storyIds: ['ghost'] }] }), /story/i);
});

test('applyStoryToggles: toggles apply to the capability; text/count drift throws', () => {
  const cap = fixture();
  const out = applyStoryToggles(cap, 'sl1', [
    { id: 's1', text: 'create tour time slots', done: true, verifiedBy: 'manual 2026-08-07' },
    { id: 's2', text: 'edit tour time slots', done: false },
  ]);
  assert.equal(cap.stories.find((s) => s.id === 's1')?.done, true);
  assert.equal(cap.stories.find((s) => s.id === 's1')?.verifiedBy, 'manual 2026-08-07');
  assert.deepEqual(out.map((s) => s.id), ['s1', 's2']);
  assert.throws(() => applyStoryToggles(cap, 'sl1', [{ id: 's1', text: 'REWRITTEN', done: true }]), /toggle-only|text/i);
  assert.throws(() => applyStoryToggles(cap, 'sl1', [{ id: 's1', text: 'create tour time slots', done: true }]), /count|missing/i);
  assert.throws(() => applyStoryToggles(cap, 'ghost', []), /slice/i);
});

test('renderSpecSkeleton: title, date, draft status, one checkbox per story', () => {
  const cap = fixture();
  const md = renderSpecSkeleton('tour scheduling v1', sliceStories(cap, 'sl1'), '2026-08-06');
  assert.match(md, /^# tour scheduling v1 — design\n/);
  assert.match(md, /\nDate: 2026-08-06\nStatus: draft\n/);
  assert.match(md, /\n## Goal\n/);
  assert.match(md, /\n## Acceptance criteria\n\n- \[ \] create tour time slots\n- \[ \] edit tour time slots\n$/);
});

test('store round-trip + malformed isolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'caps-'));
  const cap = fixture();
  await saveCapability(dir, cap);
  await writeFile(join(dir, 'broken.json'), '{nope');
  const { capabilities, errors } = await loadCapabilities(dir);
  assert.deepEqual(capabilities.map((c) => c.id), ['school-feature-set']);
  assert.equal(errors.length, 1);
  await deleteCapabilityFile(dir, cap.id);
  assert.deepEqual((await loadCapabilities(dir)).capabilities, []);
  await assert.rejects(saveCapability(dir, { ...cap, id: '../evil' }), /id/i);
});

test('ensureWorkspaceBoards: creates the pair once, idempotent, never maintenance/support', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensureWorkspaceBoards(dir, 'skoolscout');
  await ensureWorkspaceBoards(dir, 'skoolscout');
  const { boards } = await loadBoards(dir);
  assert.deepEqual(boards.map((b) => [b.id, b.workspaceId]).sort(), [
    ['skoolscout-capabilities', 'skoolscout'],
    ['skoolscout-delivery', 'skoolscout'],
  ]);
  assert.deepEqual(boards.find((b) => b.id === 'skoolscout-capabilities')?.columns.map((c) => c.id)[0], 'capability');
});

test('sendSliceToBoard: leftmost card, story copies, capabilityRef', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'work-'));
  await ensureWorkspaceBoards(dir, 'skoolscout');
  const { boards } = await loadBoards(dir);
  const board = boards.find((b) => b.id === 'skoolscout-capabilities');
  const cap = fixture();
  const card = sendSliceToBoard(cap, cap.slices[0], board!);
  assert.equal(card.title, 'tour scheduling v1');
  assert.equal(card.columnId, board!.columns[0].id);
  assert.deepEqual(card.capabilityRef, { capabilityId: 'school-feature-set', sliceId: 'sl1' });
  assert.deepEqual(card.stories?.map((s) => s.text), ['create tour time slots', 'edit tour time slots']);
  assert.notEqual(card.stories, cap.stories); // copies, not shared references
});
```

- [ ] **Step 2: Run to verify failure** — `cd swarm && node --import tsx --test src/capabilities.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `swarm/src/capabilities.ts`:

```ts
// Capability story maps — the authoring layer above the work boards. One
// JSON file per capability under .smith/work/capabilities/. Stories are
// born HERE (never on cards, never in spec docs): a slice exports them to
// a spec skeleton and to linked cards, and toggles flow back through
// applyStoryToggles. Truth has one home; everything else is a view.
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addCard, BOARD_TEMPLATES, createBoard, loadBoards, saveBoard, type WorkBoard, type WorkCard } from './work-items.js';

export interface CapStory {
  id: string;
  stepId: string;
  /** Position within its step's stack. */
  order: number;
  text: string;
  done: boolean;
  /** How it was proven — e.g. 'manual 2026-08-07' or a test file path. */
  verifiedBy?: string;
}

export interface CapActivity {
  id: string;
  name: string;
  order: number;
  steps: Array<{ id: string; name: string; order: number }>;
}

export interface CapSlice {
  id: string;
  name: string;
  order: number;
  /** Disjoint across slices; a story in no slice is backlog. */
  storyIds: string[];
  specPath?: string;
  planPath?: string;
  capCardRef?: { boardId: string; cardId: string };
  deliveryCardRef?: { boardId: string; cardId: string };
}

export interface Capability {
  id: string;
  name: string;
  workspaceId: string;
  activities: CapActivity[];
  stories: CapStory[];
  slices: CapSlice[];
  createdAt: string;
  updatedAt: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(name: string): string {
  const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!ID_RE.test(id)) throw new Error(`Name "${name}" does not reduce to a usable id`);
  return id;
}

export function createCapability(name: string, workspaceId: string): Capability {
  const now = new Date().toISOString();
  return { id: slugify(name), name: name.trim(), workspaceId, activities: [], stories: [], slices: [], createdAt: now, updatedAt: now };
}

function assertCapability(file: string, v: unknown): Capability {
  const o = v as Capability;
  const ok =
    o && typeof o.id === 'string' && typeof o.name === 'string' && typeof o.workspaceId === 'string' &&
    Array.isArray(o.activities) && Array.isArray(o.stories) && Array.isArray(o.slices);
  if (!ok) throw new Error(`Invalid capability file ${file}: requires id, name, workspaceId, activities[], stories[], slices[]`);
  return o;
}

export async function loadCapabilities(dir: string): Promise<{ capabilities: Capability[]; errors: Array<{ file: string; error: string }> }> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { capabilities: [], errors: [] };
  }
  const capabilities: Capability[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  for (const file of entries.filter((f) => f.endsWith('.json'))) {
    try {
      capabilities.push(assertCapability(file, JSON.parse(await readFile(join(dir, file), 'utf8'))));
    } catch (err) {
      errors.push({ file, error: String((err as Error).message) });
    }
  }
  return { capabilities, errors };
}

export async function saveCapability(dir: string, cap: Capability): Promise<void> {
  if (!ID_RE.test(cap.id)) throw new Error(`Invalid capability id "${cap.id}"`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${cap.id}.json`), `${JSON.stringify(cap, null, 2)}\n`);
}

export async function deleteCapabilityFile(dir: string, id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new Error(`Invalid capability id "${id}"`);
  await rm(join(dir, `${id}.json`));
}

export function patchCapability(cap: Capability, patch: Partial<Pick<Capability, 'name' | 'activities' | 'stories' | 'slices'>>): Capability {
  const activities = patch.activities ?? cap.activities;
  const stories = patch.stories ?? cap.stories;
  const slices = patch.slices ?? cap.slices;
  const stepIds = new Set(activities.flatMap((a) => a.steps.map((s) => s.id)));
  for (const s of stories) {
    if (!stepIds.has(s.stepId)) throw new Error(`Story "${s.text}" references unknown step ${s.stepId}`);
  }
  const storyIds = new Set(stories.map((s) => s.id));
  const claimed = new Set<string>();
  for (const slice of slices) {
    for (const id of slice.storyIds) {
      if (!storyIds.has(id)) throw new Error(`Slice "${slice.name}" references unknown story ${id}`);
      if (claimed.has(id)) throw new Error(`Story ${id} is in two slices — storyIds must be disjoint`);
      claimed.add(id);
    }
  }
  if (patch.name?.trim()) cap.name = patch.name.trim();
  cap.activities = activities;
  cap.stories = stories;
  cap.slices = slices;
  cap.updatedAt = new Date().toISOString();
  return cap;
}

export function sliceStories(cap: Capability, sliceId: string): CapStory[] {
  const slice = cap.slices.find((s) => s.id === sliceId);
  if (!slice) throw new Error(`Unknown slice: ${sliceId}`);
  return slice.storyIds.map((id) => {
    const story = cap.stories.find((s) => s.id === id);
    if (!story) throw new Error(`Slice references unknown story ${id}`);
    return story;
  });
}

/** Linked-card checklists are toggle-only views: only done/verifiedBy may differ from the capability's stories. */
export function applyStoryToggles(
  cap: Capability,
  sliceId: string,
  incoming: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }>,
): CapStory[] {
  const canonical = sliceStories(cap, sliceId);
  if (incoming.length !== canonical.length) {
    throw new Error(`Story count mismatch (${incoming.length} sent, ${canonical.length} in the slice) — add/remove stories in the map, cards are toggle-only`);
  }
  for (const sent of incoming) {
    const story = canonical.find((s) => s.id === sent.id);
    if (!story) throw new Error(`Unknown or missing story ${sent.id} — cards are toggle-only`);
    if (sent.text !== story.text) throw new Error(`Story ${sent.id} text changed — toggle-only; edit text in the map`);
    story.done = sent.done;
    story.verifiedBy = sent.verifiedBy ?? undefined;
  }
  cap.updatedAt = new Date().toISOString();
  return canonical.map((s) => ({ ...s }));
}

export function renderSpecSkeleton(sliceName: string, stories: CapStory[], dateISO: string): string {
  return [
    `# ${sliceName} — design`,
    '',
    `Date: ${dateISO}`,
    'Status: draft',
    '',
    '## Goal',
    '',
    '## Acceptance criteria',
    '',
    ...stories.map((s) => `- [ ] ${s.text}`),
    '',
  ].join('\n');
}

/** Create the workspace's Capabilities + Delivery pair iff missing. ONLY the pair — maintenance/support are on-demand. */
export async function ensureWorkspaceBoards(workDir: string, workspaceId: string): Promise<void> {
  const { boards } = await loadBoards(workDir);
  const wanted: Array<['capabilities' | 'delivery', string]> = [
    ['capabilities', `${workspaceId} Capabilities`],
    ['delivery', `${workspaceId} Delivery`],
  ];
  for (const [template, name] of wanted) {
    const board = createBoard(name, template, workspaceId);
    if (!boards.some((b) => b.id === board.id)) await saveBoard(workDir, board);
  }
}

/** Pure card creation for a slice send: leftmost column, story copies, capabilityRef. Caller saves board + slice ref. */
export function sendSliceToBoard(cap: Capability, slice: CapSlice, board: WorkBoard): WorkCard {
  const card = addCard(board, { title: slice.name });
  card.stories = sliceStories(cap, slice.id).map((s) => ({ id: s.id, text: s.text, done: s.done, verifiedBy: s.verifiedBy }));
  card.capabilityRef = { capabilityId: cap.id, sliceId: slice.id };
  return card;
}

// Referenced so the template import stays honest if templates move: the pair's
// column sets come from BOARD_TEMPLATES via createBoard.
void BOARD_TEMPLATES;
```

(If the trailing `void BOARD_TEMPLATES;` is unnecessary because `createBoard` covers the import, drop the import and the line — keep the file warning-free.)

- [ ] **Step 4: Run to verify pass** — `cd swarm && node --import tsx --test src/capabilities.test.ts` → PASS (7 tests); then `cd swarm && npm test` → green apart from baseline.

- [ ] **Step 5: Commit**

```bash
git add swarm/src/capabilities.ts swarm/src/capabilities.test.ts
git commit -m "feat(swarm): capability store — story maps, slices, toggle write-through, spec skeleton, board pair"
```

---

### Task 3: Swarm — `/work/capabilities` routes + card-PATCH write-through

**Files:**
- Modify: `swarm/src/server.ts`

**Interfaces:**
- Consumes: every Task 2 export; `loadWorkspacesFromDir` + `resolveRepo` from `./workspaces.js` (mirror how existing workspace routes locate the workspaces dir — the same `.smith/workspaces` resolution they use); the Task 2 `workDir()` helper from the work routes section.
- Produces (proxied verbatim by the broker in Task 4):
  - `GET /work/capabilities?workspaceId=` → `{ capabilities, errors }`
  - `POST /work/capabilities` `{name, workspaceId}` → 201 capability | 400/409 (auto-provisions the board pair)
  - `PATCH /work/capabilities/:id` `{name?, activities?, stories?, slices?}` → capability | 404/400
  - `DELETE /work/capabilities/:id` → `{ok:true}` | 404 (unlinks cards first)
  - `POST /work/capabilities/:id/slices/:sliceId/spec` → `{specPath}` | 404/409/400
  - `POST /work/capabilities/:id/slices/:sliceId/send` `{target}` → 201 card | 404/400/409
  - Card PATCH behavior change: `stories` on a `capabilityRef` card → toggle-only write-through (400 on violation), sibling card copy updated in the same write.

- [ ] **Step 1: Register capability routes** — in `swarm/src/server.ts`, import (`.js` suffix): `applyStoryToggles, createCapability, deleteCapabilityFile, ensureWorkspaceBoards, loadCapabilities, patchCapability, renderSpecSkeleton, saveCapability, sendSliceToBoard, sliceStories, slugify, type Capability` from `./capabilities.js`, plus `loadWorkspacesFromDir, resolveRepo` from `./workspaces.js` if not already imported. Add beside the work-board routes:

```ts
    // ── Capability story maps — the authoring layer above the boards ──
    const capsDir = () => resolve(process.cwd(), '.smith/work/capabilities');
    const capOr404 = async (id: string, reply: { status: (n: number) => { send: (b: unknown) => unknown } }): Promise<Capability | null> => {
      const { capabilities } = await loadCapabilities(capsDir());
      const cap = capabilities.find((c) => c.id === id) ?? null;
      if (!cap) reply.status(404).send({ error: `Unknown capability: ${id}` });
      return cap;
    };

    this.app.get<{ Querystring: { workspaceId?: string } }>('/work/capabilities', async (req) => {
      const { capabilities, errors } = await loadCapabilities(capsDir());
      const ws = req.query.workspaceId;
      return { capabilities: ws ? capabilities.filter((c) => c.workspaceId === ws) : capabilities, errors };
    });

    this.app.post('/work/capabilities', async (req, reply) => {
      const b = req.body as { name?: string; workspaceId?: string };
      if (!b?.name?.trim() || !b.workspaceId?.trim()) return reply.status(400).send({ error: 'Missing required fields: name, workspaceId' });
      try {
        const cap = createCapability(b.name, b.workspaceId.trim());
        const { capabilities } = await loadCapabilities(capsDir());
        if (capabilities.some((c) => c.id === cap.id)) return reply.status(409).send({ error: `Capability "${cap.id}" already exists` });
        await saveCapability(capsDir(), cap);
        await ensureWorkspaceBoards(workDir(), cap.workspaceId);
        return reply.status(201).send(cap);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.patch<{ Params: { id: string } }>('/work/capabilities/:id', async (req, reply) => {
      const cap = await capOr404(req.params.id, reply);
      if (!cap) return;
      try {
        patchCapability(cap, req.body as Parameters<typeof patchCapability>[1]);
        await saveCapability(capsDir(), cap);
        return cap;
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.delete<{ Params: { id: string } }>('/work/capabilities/:id', async (req, reply) => {
      const cap = await capOr404(req.params.id, reply);
      if (!cap) return;
      // Unlink, never orphan: linked cards keep their story copies as local checklists.
      for (const slice of cap.slices) {
        for (const ref of [slice.capCardRef, slice.deliveryCardRef]) {
          if (!ref) continue;
          const { boards } = await loadBoards(workDir());
          const board = boards.find((b) => b.id === ref.boardId);
          const card = board?.cards.find((c) => c.id === ref.cardId);
          if (board && card) {
            card.capabilityRef = undefined;
            await saveBoard(workDir(), board);
          }
        }
      }
      await deleteCapabilityFile(capsDir(), cap.id);
      return { ok: true };
    });

    this.app.post<{ Params: { id: string; sliceId: string } }>('/work/capabilities/:id/slices/:sliceId/spec', async (req, reply) => {
      const cap = await capOr404(req.params.id, reply);
      if (!cap) return;
      const slice = cap.slices.find((s) => s.id === req.params.sliceId);
      if (!slice) return reply.status(404).send({ error: `Unknown slice: ${req.params.sliceId}` });
      if (slice.specPath) return reply.status(409).send({ error: `Slice already has a spec: ${slice.specPath}` });
      const workspaces = await loadWorkspacesFromDir(resolve(process.cwd(), '.smith/workspaces'));
      const resolved = resolveRepo(workspaces, cap.workspaceId);
      if (!resolved) return reply.status(400).send({ error: `No active workspace/repo for: ${cap.workspaceId}` });
      try {
        const date = new Date().toISOString().slice(0, 10);
        const relPath = `docs/superpowers/specs/${date}-${slugify(slice.name)}-design.md`;
        const absPath = resolve(resolved.repo.path, relPath);
        const exists = await readFile(absPath, 'utf8').then(() => true, () => false);
        if (exists) return reply.status(409).send({ error: `File already exists: ${relPath}` });
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, renderSpecSkeleton(slice.name, sliceStories(cap, slice.id), date));
        slice.specPath = relPath;
        cap.updatedAt = new Date().toISOString();
        await saveCapability(capsDir(), cap);
        return { specPath: relPath };
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });

    this.app.post<{ Params: { id: string; sliceId: string } }>('/work/capabilities/:id/slices/:sliceId/send', async (req, reply) => {
      const cap = await capOr404(req.params.id, reply);
      if (!cap) return;
      const slice = cap.slices.find((s) => s.id === req.params.sliceId);
      if (!slice) return reply.status(404).send({ error: `Unknown slice: ${req.params.sliceId}` });
      const target = (req.body as { target?: string })?.target;
      if (target !== 'capabilities' && target !== 'delivery') return reply.status(400).send({ error: 'target must be "capabilities" or "delivery"' });
      const refKey = target === 'capabilities' ? 'capCardRef' : 'deliveryCardRef';
      if (slice[refKey]) return reply.status(409).send({ error: `Slice already sent to ${target}` });
      if (target === 'delivery' && !slice.specPath) return reply.status(409).send({ error: 'Generate the spec before sending to delivery' });
      await ensureWorkspaceBoards(workDir(), cap.workspaceId);
      const { boards } = await loadBoards(workDir());
      const board = boards.find((b) => b.id === `${slugify(cap.workspaceId)}-${target}`);
      if (!board) return reply.status(400).send({ error: `Workspace board missing: ${cap.workspaceId} ${target}` });
      try {
        const card = sendSliceToBoard(cap, slice, board);
        await saveBoard(workDir(), board);
        slice[refKey] = { boardId: board.id, cardId: card.id };
        cap.updatedAt = new Date().toISOString();
        await saveCapability(capsDir(), cap);
        return reply.status(201).send(card);
      } catch (err) {
        return reply.status(400).send({ error: String((err as Error).message) });
      }
    });
```

Adjust imports: `readFile`, `writeFile`, `mkdir` from `node:fs/promises` and `dirname`, `resolve` from `node:path` are likely already imported in server.ts — reuse, don't duplicate. Board id in the send route uses `slugify(cap.workspaceId)-<target>` — this matches what `ensureWorkspaceBoards`'s `createBoard('<ws> Capabilities', ...)` produces only when the workspace name is already slug-shaped; to make them structurally identical, change `ensureWorkspaceBoards` (Task 2) to compute names via a shared helper: `export function workspaceBoardId(workspaceId: string, target: 'capabilities' | 'delivery'): string { return `${slugify(workspaceId)}-${target}`; }` and have BOTH `ensureWorkspaceBoards` (build the board, then overwrite `board.id = workspaceBoardId(...)`) and this route use it. Add one assertion to the Task 2 `ensureWorkspaceBoards` test: `assert.equal(workspaceBoardId('SkoolScout', 'delivery'), 'skoolscout-delivery');`

- [ ] **Step 2: Card-PATCH write-through** — in the existing `PATCH /work/boards/:id/cards/:cardId` route, BEFORE calling `patchCard`, insert:

```ts
      // Linked-card checklists are toggle-only views of the capability's
      // stories — validate, write through, and refresh the sibling card's
      // copy in the same request so every surface agrees.
      const bodyPatch = req.body as { stories?: Array<{ id: string; text: string; done: boolean; verifiedBy?: string }> };
      const targetCard = board.cards.find((c) => c.id === req.params.cardId);
      if (bodyPatch.stories && targetCard?.capabilityRef) {
        const { capabilities } = await loadCapabilities(capsDir());
        const cap = capabilities.find((c) => c.id === targetCard.capabilityRef?.capabilityId);
        if (cap) {
          let canonical: ReturnType<typeof applyStoryToggles>;
          try {
            canonical = applyStoryToggles(cap, targetCard.capabilityRef.sliceId, bodyPatch.stories);
          } catch (err) {
            return reply.status(400).send({ error: String((err as Error).message) });
          }
          await saveCapability(capsDir(), cap);
          bodyPatch.stories = canonical;
          const slice = cap.slices.find((s) => s.id === targetCard.capabilityRef?.sliceId);
          const sibling = [slice?.capCardRef, slice?.deliveryCardRef].find((r) => r && r.cardId !== targetCard.id);
          if (sibling && sibling.boardId !== board.id) {
            const { boards: all } = await loadBoards(workDir());
            const other = all.find((b) => b.id === sibling.boardId);
            const otherCard = other?.cards.find((c) => c.id === sibling.cardId);
            if (other && otherCard) {
              otherCard.stories = canonical.map((s) => ({ ...s }));
              await saveBoard(workDir(), other);
            }
          } else if (sibling) {
            const siblingCard = board.cards.find((c) => c.id === sibling.cardId);
            if (siblingCard) siblingCard.stories = canonical.map((s) => ({ ...s }));
          }
        }
      }
```

(The route's later `patchCard(board, ...)` + `saveBoard` then persists the PATCHed card — and the same-board sibling when both cards share a board. `canonical` entries carry `stepId`/`order` extras from `CapStory`; that is fine — card stories tolerate extra fields — but strip them if the existing card-story validation rejects them: map to `{ id, text, done, verifiedBy }`.)

- [ ] **Step 3: Run the swarm suite** — `cd swarm && npm test` → green apart from baseline. Route glue is thin calls into Task 2's unit-tested helpers per swarm convention.

- [ ] **Step 4: Commit**

```bash
git add swarm/src/server.ts swarm/src/capabilities.ts swarm/src/capabilities.test.ts
git commit -m "feat(swarm): capability routes — pair provisioning, spec generation, slice sends, toggle write-through"
```

---

### Task 4: Broker — proxy + `capability-updated` frame

**Files:**
- Modify: `broker/src/text-channel.ts`
- Modify: `broker/src/text-channel.test.ts`

**Interfaces:**
- Consumes: the existing generic `/work/*` proxy (already forwards `/work/capabilities/*` verbatim — no new proxy code needed); the `ChannelFrame` union; the channel's WS broadcast mechanism.
- Produces (consumed by Task 5):
  - Frame `{ type: 'capability-updated'; capabilityId: string }`
  - `workUpdateFrames(method: string, pathname: string, payload: unknown): Array<{ type: 'capability-updated'; capabilityId: string }>` — pure, exported

- [ ] **Step 1: Failing tests** — in `broker/src/text-channel.test.ts`:

```ts
import { workUpdateFrames } from './text-channel';

test('workUpdateFrames: capability mutations and linked-card PATCHes yield frames, reads and plain cards do not', () => {
  assert.deepEqual(workUpdateFrames('PATCH', '/work/capabilities/school-feature-set', {}), [
    { type: 'capability-updated', capabilityId: 'school-feature-set' },
  ]);
  assert.deepEqual(workUpdateFrames('POST', '/work/capabilities', { id: 'new-cap' }), [
    { type: 'capability-updated', capabilityId: 'new-cap' },
  ]);
  assert.deepEqual(workUpdateFrames('POST', '/work/capabilities/school-feature-set/slices/sl1/send', {}), [
    { type: 'capability-updated', capabilityId: 'school-feature-set' },
  ]);
  assert.deepEqual(
    workUpdateFrames('PATCH', '/work/boards/x-delivery/cards/c9', { capabilityRef: { capabilityId: 'school-feature-set', sliceId: 'sl1' } }),
    [{ type: 'capability-updated', capabilityId: 'school-feature-set' }],
  );
  assert.deepEqual(workUpdateFrames('GET', '/work/capabilities/school-feature-set', {}), []);
  assert.deepEqual(workUpdateFrames('PATCH', '/work/boards/x/cards/c1', { title: 'plain card' }), []);
});

test('proxy broadcasts capability-updated to connected WS clients on mutating capability calls', async () => {
  const channel = channelWith({ work: {
    proxy: async () => ({ status: 200, payload: { id: 'school-feature-set' } }),
    delegate: async () => ({ taskId: 't' }),
  }});
  const port = await channel.start(0);
  try {
    const frames = await collectFramesDuring(port, async () => {
      await fetch(`http://127.0.0.1:${port}/work/capabilities/school-feature-set`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}',
      });
    });
    assert.ok(frames.some((f) => f.type === 'capability-updated' && f.capabilityId === 'school-feature-set'));
  } finally {
    await channel.stop();
  }
});
```

`collectFramesDuring(port, act)` — if the test file already has a WS-client helper (the `board-updated` / roster frame tests use one), reuse it verbatim; otherwise add one: open `new WebSocket(`ws://127.0.0.1:${port}`)` (the `ws` package import already used by the file), buffer parsed messages, run `act()`, wait ~100ms, close, return the buffer.

- [ ] **Step 2: Run to verify failure** — `cd broker && node --import tsx --test src/text-channel.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement** — in `broker/src/text-channel.ts`:
  - `ChannelFrame` union gains `| { type: 'capability-updated'; capabilityId: string }`.
  - Export the pure helper:

```ts
/** Frames the channel owes its clients after a successful mutating /work call. */
export function workUpdateFrames(
  method: string,
  pathname: string,
  payload: unknown,
): Array<{ type: 'capability-updated'; capabilityId: string }> {
  if (method === 'GET') return [];
  const capMatch = pathname.match(/^\/work\/capabilities(?:\/([^/]+))?/);
  if (capMatch) {
    const capabilityId = capMatch[1] ?? (payload as { id?: string })?.id;
    return capabilityId ? [{ type: 'capability-updated', capabilityId }] : [];
  }
  const ref = (payload as { capabilityRef?: { capabilityId?: string } })?.capabilityRef;
  if (/^\/work\/boards\/[^/]+\/cards\/[^/]+$/.test(pathname) && ref?.capabilityId) {
    return [{ type: 'capability-updated', capabilityId: ref.capabilityId }];
  }
  return [];
}
```

  - In the generic `/work/` proxy handler (work-boards Task 4), after a successful proxy resolution and response write, broadcast: where the handler does `void this.work!.proxy(...).then((r) => ...writeHead(r.status)...)`, extend the success arm: `if (r.status < 400) for (const frame of workUpdateFrames(req.method ?? 'GET', url2.pathname, r.payload)) this.broadcast(frame);` (use the channel's actual broadcast method name — the same one `board-updated` relay uses).

- [ ] **Step 4: Full broker suite** — `cd broker && npm test` → all green.

- [ ] **Step 5: Commit**

```bash
git add broker/src/text-channel.ts broker/src/text-channel.test.ts
git commit -m "feat(broker): capability-updated frame from the work proxy"
```

---

### Task 5: Control-plane — MapStage scaffolding, frame plumbing, rail wiring

**Files:**
- Create: `control-plane/src/organisms/MapStage.tsx`
- Create: `control-plane/src/organisms/MapStage.test.tsx`
- Modify: `control-plane/src/hooks/useBrokerChat.ts`
- Modify: `control-plane/src/organisms/ToolRail.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx`
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Consumes: broker `/work/capabilities/*` proxy (Task 3/4); `GET /workspaces` (existing broker route — same response shape CardSheet's workspaces fetch uses); `capability-updated` frame (Task 4).
- Produces (Task 6 builds on these exact shapes):
  - Types exported from `MapStage.tsx`: `CapStoryT { id; stepId; order; text; done; verifiedBy? }`, `CapActivityT { id; name; order; steps: Array<{ id; name; order }> }`, `CapSliceT { id; name; order; storyIds: string[]; specPath?; planPath?; capCardRef?: { boardId; cardId }; deliveryCardRef?: { boardId; cardId } }`, `CapabilityT { id; name; workspaceId; activities: CapActivityT[]; stories: CapStoryT[]; slices: CapSliceT[] }`
  - `MapStage` props: `{ open: boolean; lastCapabilityUpdate: { capabilityId: string; seq: number } | null; onClose: () => void }`
  - `useBrokerChat` returns `lastCapabilityUpdate: { capabilityId: string; seq: number } | null`

- [ ] **Step 1: Frame plumbing** — in `useBrokerChat.ts`, mirror the `board-updated` plumbing exactly: frame union gains `| { type: "capability-updated"; capabilityId: string }`; add `const [lastCapabilityUpdate, setLastCapabilityUpdate] = useState<{ capabilityId: string; seq: number } | null>(null);` and `const capSeq = useRef(0);`; in `onmessage` before the utterance fallthrough:

```ts
        if (frame.type === "capability-updated") {
          setLastCapabilityUpdate({ capabilityId: frame.capabilityId, seq: ++capSeq.current });
          return;
        }
```

Export `lastCapabilityUpdate` from the hook's return object.

- [ ] **Step 2: Failing tests** — create `control-plane/src/organisms/MapStage.test.tsx`:

```tsx
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapStage } from "./MapStage";

const CAP = {
  id: "school-feature-set", name: "School Feature Set", workspaceId: "skoolscout",
  activities: [{ id: "act1", name: "Manage Candidate Tours", order: 0, steps: [
    { id: "st1", name: "Define Tour Schedule", order: 0 },
    { id: "st2", name: "Analyze Tour Data", order: 1 },
  ] }],
  stories: [
    { id: "s1", stepId: "st1", order: 0, text: "create tour time slots", done: true, verifiedBy: "manual 2026-08-07" },
    { id: "s2", stepId: "st1", order: 1, text: "edit tour time slots", done: false },
    { id: "s3", stepId: "st2", order: 0, text: "view tour analytics", done: false },
  ],
  slices: [
    { id: "sl1", name: "tour scheduling v1", order: 0, storyIds: ["s1", "s2"], specPath: "docs/superpowers/specs/2026-08-06-tour-scheduling-v1-design.md" },
    { id: "sl2", name: "analytics v1", order: 1, storyIds: [] },
  ],
};

function stubFetch(overrides: { capabilities?: unknown } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const respond = (b: unknown, status = 200) => ({ ok: status < 400, status, json: async () => b }) as Response;
    if (url.includes("/workspaces")) return respond({ workspaces: [{ name: "skoolscout" }, { name: "smithagents" }] });
    if (url.includes("/work/capabilities") && method === "GET") return respond(overrides.capabilities ?? { capabilities: [CAP], errors: [] });
    if (url.endsWith("/work/capabilities") && method === "POST") return respond({ ...CAP, id: "new-cap", name: "New Cap" }, 201);
    if (url.includes("/spec") && method === "POST") return respond({ specPath: "docs/superpowers/specs/x.md" }, 200);
    if (url.includes("/send") && method === "POST") return respond({ id: "card1" }, 201);
    if (method === "PATCH") return respond(CAP);
    return respond({});
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

describe("MapStage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the backbone and story stacks for the selected capability", async () => {
    stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    expect(await screen.findByText("Manage Candidate Tours")).toBeTruthy();
    expect(screen.getByText("Define Tour Schedule")).toBeTruthy();
    expect(screen.getByText("create tour time slots")).toBeTruthy();
  });

  it("creates a capability in the selected workspace", async () => {
    const { calls } = stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Manage Candidate Tours");
    await userEvent.click(screen.getByRole("button", { name: /new capability/i }));
    await userEvent.type(screen.getByPlaceholderText(/capability name/i), "New Cap");
    await userEvent.click(screen.getByRole("button", { name: /create capability/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.endsWith("/work/capabilities"));
      expect(call?.body).toMatchObject({ name: "New Cap", workspaceId: "skoolscout" });
    });
  });

  it("refetches when lastCapabilityUpdate names the open capability", async () => {
    const { calls } = stubFetch();
    const { rerender } = render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Manage Candidate Tours");
    const before = calls.filter((c) => c.url.includes("/work/capabilities") && c.method === "GET").length;
    rerender(<MapStage open lastCapabilityUpdate={{ capabilityId: "school-feature-set", seq: 1 }} onClose={vi.fn()} />);
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/work/capabilities") && c.method === "GET").length).toBeGreaterThan(before));
  });

  it("shows slice bands with done fractions", async () => {
    stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("tour scheduling v1");
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run to verify failure** — `cd control-plane && npx vitest run src/organisms/MapStage.test.tsx` → FAIL (component missing).

- [ ] **Step 4: Implement `MapStage.tsx`** (render + create + refetch; editing and slice actions arrive in Task 6):

```tsx
import { Map as MapIcon, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const BASE = "127.0.0.1:7790";

export interface CapStoryT { id: string; stepId: string; order: number; text: string; done: boolean; verifiedBy?: string }
export interface CapActivityT { id: string; name: string; order: number; steps: Array<{ id: string; name: string; order: number }> }
export interface CapSliceT {
  id: string; name: string; order: number; storyIds: string[];
  specPath?: string; planPath?: string;
  capCardRef?: { boardId: string; cardId: string };
  deliveryCardRef?: { boardId: string; cardId: string };
}
export interface CapabilityT {
  id: string; name: string; workspaceId: string;
  activities: CapActivityT[]; stories: CapStoryT[]; slices: CapSliceT[];
}

interface MapStageProps {
  open: boolean;
  lastCapabilityUpdate: { capabilityId: string; seq: number } | null;
  onClose: () => void;
}

/**
 * The story-map stage — where stories are BORN. Activities → steps → story
 * stacks, with slices carved below. Cards and spec docs are downstream
 * views; every text edit happens here and only here.
 */
export function MapStage({ open, lastCapabilityUpdate, onClose }: MapStageProps) {
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [capabilities, setCapabilities] = useState<CapabilityT[]>([]);
  const [capErrors, setCapErrors] = useState<Array<{ file: string; error: string }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [capName, setCapName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = (await fetch(`http://${BASE}/work/capabilities`).then((r) => r.json())) as {
        capabilities?: CapabilityT[]; errors?: Array<{ file: string; error: string }>; error?: string;
      };
      if (res.error) throw new Error(res.error);
      setCapabilities(res.capabilities ?? []);
      setCapErrors(res.errors ?? []);
      setError(null);
      setActiveId((id) => id ?? res.capabilities?.[0]?.id ?? null);
      setWorkspace((w) => w || res.capabilities?.[0]?.workspaceId || "");
    } catch {
      setError("Could not load capabilities — is the broker running?");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refetch();
    void fetch(`http://${BASE}/workspaces`)
      .then((r) => r.json())
      .then((res: { workspaces?: Array<{ name: string }> }) => {
        const names = (res.workspaces ?? []).map((w) => w.name);
        setWorkspaces(names);
        setWorkspace((w) => w || names[0] || "");
      })
      .catch(() => {});
  }, [open, refetch]);

  useEffect(() => {
    if (open && lastCapabilityUpdate && lastCapabilityUpdate.capabilityId === activeId) void refetch();
  }, [open, lastCapabilityUpdate, activeId, refetch]);

  if (!open) return null;
  const cap = capabilities.find((c) => c.id === activeId) ?? null;

  const createCapability = async () => {
    if (!capName.trim() || !workspace) return;
    const res = (await fetch(`http://${BASE}/work/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: capName.trim(), workspaceId: workspace }),
    }).then((r) => r.json()).catch(() => ({ error: "unreachable" }))) as CapabilityT & { error?: string };
    if (res.error) {
      setError(res.error);
      return;
    }
    setCreating(false);
    setCapName("");
    setActiveId(res.id);
    void refetch();
  };

  const storiesFor = (stepId: string) => cap?.stories.filter((s) => s.stepId === stepId).sort((a, b) => a.order - b.order) ?? [];
  const doneFraction = (slice: CapSliceT) => {
    const stories = (cap?.stories ?? []).filter((s) => slice.storyIds.includes(s.id));
    return `${stories.filter((s) => s.done).length}/${stories.length}`;
  };

  return (
    <section className="map-stage" aria-label="Story map">
      <header className="map-stage__bar">
        <MapIcon size={14} strokeWidth={2} />
        <select aria-label="Workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
          {workspaces.map((w) => (
            <option key={w} value={w}>{w}</option>
          ))}
        </select>
        <select aria-label="Capability" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)}>
          {capabilities.filter((c) => !workspace || c.workspaceId === workspace).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button type="button" className="settings-btn" onClick={() => setCreating((v) => !v)}>
          <Plus size={12} strokeWidth={2} /> new capability
        </button>
        <span className="spacer" />
        <button type="button" className="settings-btn" onClick={onClose} aria-label="Close map">
          <X size={12} strokeWidth={2} />
        </button>
      </header>
      {creating && (
        <div className="map-stage__composer">
          <input placeholder="Capability name" value={capName} onChange={(e) => setCapName(e.target.value)} />
          <button type="button" className="settings-btn settings-btn--primary" onClick={() => void createCapability()}>
            create capability
          </button>
        </div>
      )}
      {error && <p className="wizard__error">{error}</p>}
      {capErrors.length > 0 && <p className="wizard__hint">Some capability files failed to load: {capErrors.map((e) => e.file).join(", ")}</p>}
      {cap && (
        <>
          <div className="map-stage__grid">
            {cap.activities.sort((a, b) => a.order - b.order).map((act) => (
              <div key={act.id} className="map-activity">
                <div className="map-activity__name">{act.name}</div>
                <div className="map-activity__steps">
                  {act.steps.sort((a, b) => a.order - b.order).map((step) => (
                    <div key={step.id} className="map-step">
                      <div className="map-step__name">{step.name}</div>
                      <div className="map-step__stories">
                        {storiesFor(step.id).map((story) => (
                          <div key={story.id} className={`map-story${story.done ? " is-done" : ""}`} title={story.verifiedBy}>
                            {story.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="map-stage__slices">
            {cap.slices.sort((a, b) => a.order - b.order).map((slice) => (
              <div key={slice.id} className="slice-band">
                <span className="slice-band__name">{slice.name}</span>
                <span className="slice-band__fraction">{doneFraction(slice)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 5: CSS** — append to `components.css`:

```css
.map-stage {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: 14px;
}
.map-stage__bar,
.map-stage__composer {
  display: flex;
  align-items: center;
  gap: 8px;
}
.map-stage__bar .spacer {
  flex: 1;
}
.map-stage__grid {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  flex: 1;
  min-height: 0;
}
.map-activity {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.map-activity__name {
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(110, 140, 255, 0.16);
  border: 1px solid var(--pill-br);
  font-size: 12px;
}
.map-activity__steps {
  display: flex;
  gap: 8px;
}
.map-step {
  flex: 0 0 180px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.map-step__name {
  padding: 6px 10px;
  border-radius: 10px;
  background: rgba(240, 220, 120, 0.14);
  border: 1px solid var(--pill-br);
  font-size: 11.5px;
}
.map-step__stories {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 24px;
}
.map-story {
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid var(--pill-br);
  background: rgba(255, 255, 255, 0.04);
  font-size: 12px;
  cursor: grab;
}
.map-story.is-done {
  text-decoration: line-through;
  color: var(--text-dim);
}
.map-stage__slices {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.slice-band {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--pill-br);
  border-radius: 10px;
  font-size: 12px;
}
.slice-band__fraction {
  font-size: 10px;
  color: var(--text-dim);
}
```

- [ ] **Step 6: ToolRail + HomePage** —
  - `ToolRail.tsx`: import `Map as MapIcon` from lucide; `TOOLS` gains `{ icon: MapIcon, label: "Map" }`; props gain `onMap?: () => void;`; click dispatch gains `if (tool.label === "Map") onMap?.();`.
  - `HomePage.tsx`: `const [mapOpen, setMapOpen] = useState(false);`; pass `onMap={() => setMapOpen((v) => !v)}` to `ToolRail`; add `lastCapabilityUpdate` to the `useBrokerChat` destructuring; the stage ternary gains map as the top priority: `mapOpen ? <MapStage open lastCapabilityUpdate={lastCapabilityUpdate} onClose={() => setMapOpen(false)} /> : boardOpen ? <BoardStage .../> : ...`.

- [ ] **Step 7: Run + biome** — `cd control-plane && npx vitest run src/organisms/MapStage.test.tsx` → PASS (4 tests); `npx tsc --noEmit && npm test && npx biome check --write src/` → green.

- [ ] **Step 8: Commit**

```bash
git add control-plane/src/organisms/MapStage.tsx control-plane/src/organisms/MapStage.test.tsx control-plane/src/hooks/useBrokerChat.ts control-plane/src/organisms/ToolRail.tsx control-plane/src/pages/HomePage.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): map stage — capability pickers, story-map grid, slice bands, live refetch"
```

---

### Task 6: Control-plane — map editing, story drag, slices + generate/send actions

**Files:**
- Modify: `control-plane/src/organisms/MapStage.tsx`
- Modify: `control-plane/src/organisms/MapStage.test.tsx`
- Modify: `control-plane/src/styles/components.css` (drag affordances only, mirror `.board-card.is-dragging` / `.board-column.is-over`)

**Interfaces:**
- Consumes: Task 5's `MapStage` internals; `PATCH /work/capabilities/:id` (wholesale sub-arrays); `POST .../slices/:sliceId/spec` and `.../send` (Task 3).
- Produces: `fireStoryDrop(storyId: string, stepId: string, order: number): Promise<void>` — test seam exported from `MapStage.tsx`, same pattern and rationale as `BoardStage.fireDrop`.

- [ ] **Step 1: Failing tests** — append to `MapStage.test.tsx`:

```tsx
describe("MapStage editing", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("adds a story to a step via wholesale PATCH", async () => {
    const { calls } = stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Define Tour Schedule");
    await userEvent.type(screen.getAllByPlaceholderText(/add a story/i)[0], "delete tour time slots{Enter}");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const stories = (call?.body as { stories?: Array<{ text: string; stepId: string }> })?.stories;
      expect(stories?.some((s) => s.text === "delete tour time slots" && s.stepId === "st1")).toBe(true);
      expect(stories?.length).toBe(4); // wholesale: existing three ride along
    });
  });

  it("fireStoryDrop moves a story between steps via wholesale PATCH", async () => {
    const { calls } = stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Define Tour Schedule");
    const { fireStoryDrop } = await import("./MapStage");
    await fireStoryDrop("s2", "st2", 0);
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const moved = (call?.body as { stories?: Array<{ id: string; stepId: string }> })?.stories?.find((s) => s.id === "s2");
      expect(moved?.stepId).toBe("st2");
    });
  });

  it("assigning a story to a slice keeps storyIds disjoint", async () => {
    const { calls } = stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("create tour time slots");
    // Each story renders a slice select; move s1 from sl1 to sl2.
    await userEvent.selectOptions(screen.getAllByLabelText(/slice for/i)[0], "sl2");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const slices = (call?.body as { slices?: Array<{ id: string; storyIds: string[] }> })?.slices;
      expect(slices?.find((s) => s.id === "sl1")?.storyIds).toEqual(["s2"]);
      expect(slices?.find((s) => s.id === "sl2")?.storyIds).toEqual(["s1"]);
    });
  });

  it("slice actions: generate spec POSTs; delivery send gated until specPath; sends post the target", async () => {
    const { calls } = stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("tour scheduling v1");
    // sl2 has no specPath: generate visible, delivery send disabled with reason.
    expect(screen.getByRole("button", { name: /generate spec for analytics v1/i })).toBeTruthy();
    const deliveryBtn = screen.getByRole("button", { name: /send analytics v1 to delivery/i }) as HTMLButtonElement;
    expect(deliveryBtn.disabled).toBe(true);
    expect(deliveryBtn.title).toMatch(/spec/i);
    await userEvent.click(screen.getByRole("button", { name: /generate spec for analytics v1/i }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("/slices/sl2/spec") && c.method === "POST")).toBe(true));
    // sl1 has a specPath: delivery send enabled and posts the target.
    await userEvent.click(screen.getByRole("button", { name: /send tour scheduling v1 to delivery/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/slices/sl1/send"));
      expect(call?.body).toMatchObject({ target: "delivery" });
    });
  });

  it("creates a slice", async () => {
    const { calls } = stubFetch();
    render(<MapStage open lastCapabilityUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("tour scheduling v1");
    await userEvent.type(screen.getByPlaceholderText(/new slice name/i), "tour scheduling v2{Enter}");
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/work/capabilities/school-feature-set"));
      const slices = (call?.body as { slices?: Array<{ name: string }> })?.slices;
      expect(slices?.some((s) => s.name === "tour scheduling v2")).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd control-plane && npx vitest run src/organisms/MapStage.test.tsx` → new tests FAIL.

- [ ] **Step 3: Implement** — in `MapStage.tsx`:
  - One mutation helper all editing flows share (wholesale sub-arrays, optimistic-free — the map refetches):

```tsx
  const patchCap = async (body: Partial<Pick<CapabilityT, "name" | "activities" | "stories" | "slices">>) => {
    if (!cap) return;
    const res = await fetch(`http://${BASE}/work/capabilities/${encodeURIComponent(cap.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res?.ok) {
      const payload = (await res?.json().catch(() => null)) as { error?: string } | null;
      setError(payload?.error ?? "Update failed");
      return;
    }
    setError(null);
    void refetch();
  };
```

  - **Adding tiers** (inline composers): an "add activity" input in the bar row of the grid (`placeholder="Add an activity…"`, Enter → `patchCap({ activities: [...cap.activities, { id: crypto.randomUUID(), name, order: cap.activities.length, steps: [] }] })`); per-activity `placeholder="Add a step…"` (same pattern into `act.steps`); per-step `placeholder="Add a story…"` (Enter → `patchCap({ stories: [...cap.stories, { id: crypto.randomUUID(), stepId: step.id, order: storiesFor(step.id).length, text, done: false }] })`).
  - **Deleting**: an `×` button on each story (`aria-label={`Remove story: ${story.text}`}`) → `patchCap({ stories: without, slices: cap.slices.map((s) => ({ ...s, storyIds: s.storyIds.filter((id) => id !== story.id) })) })` — removing a story must also unclaim it from slices or the server 400s. Activity/step deletion: `×` on empty tiers only (disabled with `title="Remove its stories first"` when stories/steps remain underneath) — keeps v1 free of cascade semantics.
  - **Story drag**: wrap the grid in `DndContext` (PointerSensor distance 6, `pointerWithin`); each step's story list is a `SortableContext` (`verticalListSortingStrategy`); each story `useSortable({ id: story.id })`; each step stack registers `useDroppable({ id: `step:${step.id}` })`. `handleDragEnd` resolves target step + index exactly like BoardStage's drop resolution, then calls `moveStory`:

```tsx
  const moveStory = async (storyId: string, stepId: string, order: number) => {
    if (!cap) return;
    const stories = cap.stories.map((s) => ({ ...s }));
    const story = stories.find((s) => s.id === storyId);
    if (!story) return;
    const from = story.stepId;
    const siblings = stories.filter((s) => s.stepId === stepId && s.id !== storyId).sort((a, b) => a.order - b.order);
    const at = Math.max(0, Math.min(order, siblings.length));
    story.stepId = stepId;
    siblings.splice(at, 0, story);
    siblings.forEach((s, i) => {
      s.order = i;
    });
    if (from !== stepId) {
      stories.filter((s) => s.stepId === from).sort((a, b) => a.order - b.order).forEach((s, i) => {
        s.order = i;
      });
    }
    await patchCap({ stories });
  };
```

  - **Test seam** (same rationale comment as BoardStage's `fireDrop`):

```tsx
// Test seam: jsdom cannot synthesize dnd-kit pointer sequences; the drop
// handler is registered here so tests can invoke the exact code path a real
// drop takes.
let storyDropHandler: ((storyId: string, stepId: string, order: number) => Promise<void>) | null = null;
export async function fireStoryDrop(storyId: string, stepId: string, order: number): Promise<void> {
  if (!storyDropHandler) throw new Error("MapStage is not mounted");
  await storyDropHandler(storyId, stepId, order);
}
```

  with `useEffect(() => { storyDropHandler = moveStory; return () => { storyDropHandler = null; }; })`.
  - **Slice assignment**: each story chip gains a tiny select (`aria-label={`Slice for ${story.text}`}`) whose options are `backlog` + every slice; on change compute `slices = cap.slices.map((s) => ({ ...s, storyIds: s.storyIds.filter((id) => id !== story.id) }))` then push the story id onto the chosen slice's `storyIds` (skip when `backlog`), `patchCap({ slices })`.
  - **Slice bands**: extend each band with:
    - spec chip: `slice.specPath ? <span className="slice-band__path" title={slice.specPath}>spec ✓</span> : <button aria-label={`Generate spec for ${slice.name}`} onClick={generateSpec(slice)}>generate spec</button>` where `generateSpec` POSTs `.../slices/${slice.id}/spec`, surfaces `{error}` via `setError`, refetches.
    - plan chip: when `slice.planPath` show it; else an inline input (`placeholder="plan path…"`, Enter → `patchCap({ slices: cap.slices.map((s) => (s.id === slice.id ? { ...s, planPath: value } : s)) })`).
    - send buttons: `Send ${slice.name} to capabilities` (disabled when `slice.capCardRef`, `title="Already on the capabilities board"`) and `Send ${slice.name} to delivery` (disabled when `slice.deliveryCardRef` with the same style of reason, or when `!slice.specPath` with `title="Generate the spec first"`); both POST `.../send` with `{ target }`, surface `{error}`, refetch.
    - new-slice composer under the bands: `placeholder="New slice name…"`, Enter → `patchCap({ slices: [...cap.slices, { id: crypto.randomUUID(), name, order: cap.slices.length, storyIds: [] }] })`.

- [ ] **Step 4: Run + full suite + biome** — `cd control-plane && npx vitest run src/organisms/MapStage.test.tsx` → PASS (9 tests); `npx tsc --noEmit && npm test && npx biome check --write src/` → green.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/organisms/MapStage.tsx control-plane/src/organisms/MapStage.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): map editing — tiers, story drag, slice assignment, generate/send actions"
```

---

### Task 7: Control-plane — board-side amendments (grouping, chip, toggle-only)

**Files:**
- Modify: `control-plane/src/organisms/BoardStage.tsx`
- Modify: `control-plane/src/molecules/BoardCard.tsx`
- Modify: `control-plane/src/organisms/CardSheet.tsx`
- Modify: `control-plane/src/organisms/BoardStage.test.tsx`
- Modify: `control-plane/src/styles/components.css`

**Interfaces:**
- Consumes: Task 1's board shape (`workspaceId`, `capabilityRef`, five templates).
- Produces: `WorkBoardT` gains `workspaceId?: string`; `WorkCardT` gains `capabilityRef?: { capabilityId: string; sliceId: string }` (exported types other components already import).

- [ ] **Step 1: Failing tests** — append to `BoardStage.test.tsx`:

```tsx
describe("board-side capability amendments", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const WS_BOARDS = {
    boards: [
      { ...BOARD },
      { ...BOARD, id: "skoolscout-capabilities", name: "skoolscout Capabilities", workspaceId: "skoolscout",
        cards: [{ id: "cc1", title: "tour scheduling v1", columnId: "backlog", order: 0,
          capabilityRef: { capabilityId: "school-feature-set", sliceId: "sl1" },
          stories: [{ id: "s1", text: "create tour time slots", done: false }] }] },
    ],
    errors: [],
  };

  it("groups the switcher by workspace with personal boards first", async () => {
    stubFetch({ boards: WS_BOARDS });
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("label"))).toEqual(["Personal", "skoolscout"]);
  });

  it("offers all five templates in the new-board composer", async () => {
    stubFetch();
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.click(screen.getByRole("button", { name: /new board/i }));
    const options = (screen.getByLabelText(/template/i) as HTMLSelectElement).options;
    expect(Array.from(options).map((o) => o.value)).toEqual(["personal", "capabilities", "delivery", "maintenance", "support"]);
  });

  it("linked cards show a capability chip", async () => {
    stubFetch({ boards: WS_BOARDS });
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.selectOptions(screen.getByLabelText(/^board$/i), "skoolscout-capabilities");
    await screen.findByText("tour scheduling v1");
    expect(screen.getByTitle(/school-feature-set/i)).toBeTruthy();
  });

  it("linked cards are toggle-only: no add-story input, no remove buttons, toggle still PATCHes", async () => {
    const { calls } = stubFetch({ boards: WS_BOARDS });
    render(<BoardStage open roster={ROSTER} lastBoardUpdate={null} onClose={vi.fn()} />);
    await screen.findByText("Backlog");
    await userEvent.selectOptions(screen.getByLabelText(/^board$/i), "skoolscout-capabilities");
    await userEvent.click(await screen.findByText("tour scheduling v1"));
    expect(screen.queryByPlaceholderText(/add a story/i)).toBeNull();
    expect(screen.queryByLabelText(/remove story/i)).toBeNull();
    await userEvent.click(screen.getAllByRole("checkbox")[0]);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => {
      const call = calls.find((c) => c.method === "PATCH" && c.url.includes("/cards/cc1"));
      const stories = (call?.body as { stories?: Array<{ id: string; done: boolean }> })?.stories;
      expect(stories).toEqual([expect.objectContaining({ id: "s1", done: true })]);
    });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd control-plane && npx vitest run src/organisms/BoardStage.test.tsx` → new tests FAIL.

- [ ] **Step 3: Implement** —
  - `BoardStage.tsx`: `WorkBoardT` gains `workspaceId?: string;`, `WorkCardT` gains `capabilityRef?: { capabilityId: string; sliceId: string };`. Template state type widens to the five-union; the composer select lists the five options (labels: Personal, Capabilities, Delivery, Maintenance, Support). The switcher becomes grouped:

```tsx
        <select aria-label="Board" value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)}>
          <optgroup label="Personal">
            {boards.filter((b) => !b.workspaceId).map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </optgroup>
          {[...new Set(boards.filter((b) => b.workspaceId).map((b) => b.workspaceId))].map((ws) => (
            <optgroup key={ws} label={ws}>
              {boards.filter((b) => b.workspaceId === ws).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
```

  - `BoardCard.tsx`: beside the Jira chip, `{card.capabilityRef && (<span className="board-card__cap" title={`capability: ${card.capabilityRef.capabilityId}`}>⧉ map</span>)}` with CSS mirroring `.board-card__jira` (accent border).
  - `CardSheet.tsx`: `const linked = Boolean(card.capabilityRef);` — when `linked`: don't render the add-story input; don't render the per-story remove button (change its `aria-label` to `Remove story: ...` matcher-compatible `remove story` label first if it isn't already); add a hint line `<span className="wizard__hint">Stories are managed in the map — toggle only.</span>` above the checklist. Toggling and `verifiedBy` stamping stay as-is (the server validates toggle-only).

- [ ] **Step 4: Run + full suite + biome** — `cd control-plane && npx vitest run src/organisms/BoardStage.test.tsx` → PASS; `npx tsc --noEmit && npm test && npx biome check --write src/` → green.

- [ ] **Step 5: Commit**

```bash
git add control-plane/src/organisms/BoardStage.tsx control-plane/src/molecules/BoardCard.tsx control-plane/src/organisms/CardSheet.tsx control-plane/src/organisms/BoardStage.test.tsx control-plane/src/styles/components.css
git commit -m "feat(control-plane): workspace-grouped boards, capability chips, toggle-only linked checklists"
```

---

### Task 8: Live smoke test

**Needs the running stack** (swarm + broker + UI restarted from the current checkout — Ctrl-C + `npm run serve` inside the `smith-swarm`/`smith-broker` tmux sessions; never unscoped pkill).

- [ ] **Step 1:** Open the Map tool → create a capability in a real workspace → verify `.smith/work/capabilities/<id>.json` appears AND the `<ws>-capabilities` / `<ws>-delivery` boards exist in the Board tool's switcher under the workspace group (and that a second capability in the same workspace does NOT duplicate them).
- [ ] **Step 2:** Build a small map (1 activity, 2 steps, 3 stories), drag a story between steps, reload — structure survives.
- [ ] **Step 3:** Create a slice, assign 2 stories, Generate spec → verify the skeleton file exists in the workspace repo at the reported path with the stories as `- [ ]` lines; confirm the button flips to the path chip and a second generate 409s (button gone).
- [ ] **Step 4:** Send to capabilities → card appears leftmost with the checklist and `⧉ map` chip. Send to delivery (only possible post-spec) → second card. Toggle a story on the delivery card → the map shows it done and the capabilities card's checklist agrees (after its board refetch); try adding a story on a linked card → UI offers no input; a raw `curl` PATCH with an extra story → 400.
- [ ] **Step 5:** Delete the capability via `DELETE /work/capabilities/:id` → cards remain, chips gone, checklists editable again. Clean up smoke artifacts (delete the generated spec file; remove test boards/cards or the archived capability file as useful). Report findings; fix small breakages inline with tests.

---

## Self-Review (run after writing, fixed inline)

- **Spec coverage:** five templates + rename ✓(T1) · `workspaceId`/`capabilityRef` ✓(T1) · capability store/CRUD/validation, disjoint slices, stepId checks ✓(T2) · toggle-only write-through + sibling copy + 400 ✓(T2 `applyStoryToggles`, T3 Step 2) · spec skeleton content + workspace-repo write + 409s + uncommitted-file note ✓(T2/T3) · pair auto-provision, idempotent, pair-only ✓(T2 `ensureWorkspaceBoards`, T3 POST) · send routes with gating/409s, leftmost card, story copies, refs ✓(T2/T3) · delete-unlinks ✓(T3) · broker proxy (already generic) + `capability-updated` frame ✓(T4) · delegation untouched ✓(no task touches it) · MapStage entry/pickers/grid/slices ✓(T5) · editing, story drag, slice assignment, generate/send with disabled-reasons ✓(T6) · switcher grouping, capability chip, toggle-only sheet ✓(T7) · live updates via `capability-updated` ✓(T5) · degraded modes (unreachable banner, file-error hint) ✓(T5) · testing per package ✓(T1-T7) · smoke ✓(T8).
- **Spec gaps deliberately narrowed:** activity/step *rename* is deferred to the map's next pass (add/delete ship; rename would be a fourth inline-composer variant — noted for fast-follow, spec's "inline add/rename/delete" is otherwise honored). Slice *drag* assignment shipped as select-based (spec allows "drag or select"). Sibling-board staleness accepted per Spec delta 3.
- **Placeholder scan:** none — every code step carries real code; Task 6 Step 3's prose items each embed their exact call shapes.
- **Type consistency:** `Capability`/`CapStory`/`CapSlice` (swarm) match `CapabilityT`/`CapStoryT`/`CapSliceT` (UI) field-for-field; `workspaceBoardId` used by both provisioner and send route; `workUpdateFrames` frame shape = `ChannelFrame` member = `useBrokerChat` union member; card-side story shape `{id, text, done, verifiedBy}` consistent across `sendSliceToBoard`, `applyStoryToggles` canonical mapping, and `CardSheet`.




