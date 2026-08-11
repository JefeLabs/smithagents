# Workspace Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Groups are first-class nested sets of workspaces/groups you can pin docs to (down-only flow into sessions), view Board/Map through (lens), scope dashboards by, and manage from the workspace manager — plus text answer cards in DashSpec.

**Architecture:** The group entity lives in the swarm beside workspaces (one JSON per group under `.smith/groups/`, loader + cycle-safe `expandGroup`); the swarm's `GET /groups` returns each group WITH its precomputed `expansion` so no other service reimplements traversal. The broker proxies CRUD through swarm-client, mirrors groups for pin seeding (`group:<name>` pin namespace, resolved via a pure `pins.ts` helper), and ships groups on the session frame next to `workspaces`. The control plane adds a `useGroups` pushed query, a PinButton popover, a navbar GROUPS tier driving the existing `viewedWorkspaces` filter, a Groups section in the manager modal, group scope chips, and `texts` cards in DashSpec.

**Tech Stack:** Fastify (swarm), node:test via tsx (swarm/broker), React 19 + TanStack Query/zustand + vitest (control-plane), biome 2.5.3.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-workspace-groups-design.md` — the Decisions section quotes Edwin's rulings; do not drift from them.
- Pins never flow UP ("will not adopt its pinned shelf items"); they flow DOWN into sessions of transitively-member workspaces.
- Group pin entries in `Doc.pins` are namespaced exactly `group:<name>`; workspace entries stay bare names.
- The lens adds no pin shelf — it only sets `viewedWorkspaces` and labels the selector.
- pnpm only; lint baseline is ZERO biome diagnostics; run swarm/broker tests from their own cwd (`pnpm test`), never `--dir` from inside the package.
- Organisms stay router-free; no route loaders; one field per zustand selector.
- Lockstep pair `swarm/src/work-items.ts` ↔ `control-plane/src/lib/board-aggregate.ts` is NOT touched by this plan.
- Measure exit codes by redirect (`cmd > /tmp/x.out 2>&1; echo $?`); commit with explicit file paths; verify `[main <hash>]` + file count.

---

### Task 1: Swarm groups module (entity, loader, expansion, cycle guard)

**Files:**
- Create: `swarm/src/groups.ts`
- Test: `swarm/src/groups.test.ts`

**Interfaces:**
- Consumes: `Workspace` from `swarm/src/workspaces.ts` (only `.name`, `.archived`).
- Produces: `WorkspaceGroup { name; description?; workspaces: string[]; groups: string[]; color? }`, `loadGroupsFromDir(dir): Promise<WorkspaceGroup[]>`, `expandGroup(name, all, workspaces): Set<string>`, `wouldCycle(candidate, all): boolean`, `assertGroup(file, v): WorkspaceGroup`.

- [ ] **Step 1: Write the failing tests**

```ts
// swarm/src/groups.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertGroup, expandGroup, wouldCycle, type WorkspaceGroup } from "./groups.js";
import type { Workspace } from "./workspaces.js";

const ws = (name: string, archived = false): Workspace => ({ name, archived, repos: [{ name, path: "/tmp/x" }] });
const g = (name: string, workspaces: string[] = [], groups: string[] = []): WorkspaceGroup => ({
  name,
  workspaces,
  groups,
});

describe("assertGroup", () => {
  it("accepts empty member arrays (a group may be built up gradually)", () => {
    assert.deepEqual(assertGroup("f.json", { name: "a", workspaces: [], groups: [] }).name, "a");
  });
  it("rejects a missing name or non-array members", () => {
    assert.throws(() => assertGroup("f.json", { workspaces: [], groups: [] }));
    assert.throws(() => assertGroup("f.json", { name: "a", workspaces: "x", groups: [] }));
  });
});

describe("expandGroup", () => {
  const workspaces = [ws("acme-web"), ws("acme-api"), ws("labs"), ws("old", true)];
  it("resolves nested membership transitively", () => {
    const all = [g("frontend", ["acme-web"]), g("acme", ["acme-api"], ["frontend"])];
    assert.deepEqual([...expandGroup("acme", all, workspaces)].sort(), ["acme-api", "acme-web"]);
  });
  it("survives cycles and skips missing/archived members", () => {
    const all = [g("a", ["acme-web", "gone", "old"], ["b"]), g("b", [], ["a"])];
    assert.deepEqual([...expandGroup("a", all, workspaces)], ["acme-web"]);
  });
  it("unknown group expands to nothing", () => {
    assert.equal(expandGroup("nope", [], workspaces).size, 0);
  });
});

describe("wouldCycle", () => {
  it("rejects a group that reaches itself transitively", () => {
    const all = [g("b", [], ["c"]), g("c", [], ["a"])];
    assert.equal(wouldCycle(g("a", [], ["b"]), all), true);
  });
  it("accepts a DAG", () => {
    const all = [g("b", [], ["c"]), g("c", [], [])];
    assert.equal(wouldCycle(g("a", [], ["b", "c"]), all), false);
  });
  it("rejects direct self-membership", () => {
    assert.equal(wouldCycle(g("a", [], ["a"]), []), true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd swarm && pnpm test > /tmp/g1.out 2>&1; echo $?` → non-zero, "Cannot find module './groups.js'".

- [ ] **Step 3: Implement**

```ts
// swarm/src/groups.ts
// Workspace groups — nested, named sets of workspaces and other groups.
// One JSON file per group under .smith/groups/, mirroring workspaces.ts.
// Spec: docs/superpowers/specs/2026-08-11-workspace-groups-design.md
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "./workspaces.js";

export interface WorkspaceGroup {
  name: string;
  description?: string;
  workspaces: string[];
  groups: string[];
  /** Optional identity colour; the UI falls back to a hash of `name`. */
  color?: string;
}

export function assertGroup(file: string, v: unknown): WorkspaceGroup {
  const o = v as Partial<WorkspaceGroup>;
  const ok =
    o &&
    typeof o.name === "string" &&
    o.name.length > 0 &&
    Array.isArray(o.workspaces) &&
    o.workspaces.every((w) => typeof w === "string") &&
    Array.isArray(o.groups) &&
    o.groups.every((n) => typeof n === "string");
  if (!ok) throw new Error(`Invalid group file ${file}: requires name, workspaces[], groups[]`);
  return o as WorkspaceGroup;
}

export async function loadGroupsFromDir(dir: string): Promise<WorkspaceGroup[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const groups: WorkspaceGroup[] = [];
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    groups.push(assertGroup(file, JSON.parse(await readFile(join(dir, file), "utf8"))));
  }
  return groups;
}

/**
 * Transitive member WORKSPACES of a group. Cycle-safe (visited set); missing
 * members and archived workspaces are skipped silently — a dangling reference
 * is stale data, not an error (delete does not cascade).
 */
export function expandGroup(name: string, all: WorkspaceGroup[], workspaces: Workspace[]): Set<string> {
  const active = new Set(workspaces.filter((w) => !w.archived).map((w) => w.name));
  const byName = new Map(all.map((g) => [g.name, g]));
  const out = new Set<string>();
  const visited = new Set<string>();
  const walk = (n: string) => {
    if (visited.has(n)) return;
    visited.add(n);
    const grp = byName.get(n);
    if (!grp) return;
    for (const w of grp.workspaces) if (active.has(w)) out.add(w);
    for (const child of grp.groups) walk(child);
  };
  walk(name);
  return out;
}

/** True if saving `candidate` would let it reach itself through `all` (which may contain its old version). */
export function wouldCycle(candidate: WorkspaceGroup, all: WorkspaceGroup[]): boolean {
  const byName = new Map(all.filter((g) => g.name !== candidate.name).map((g) => [g.name, g]));
  byName.set(candidate.name, candidate);
  const visited = new Set<string>();
  const reaches = (n: string): boolean => {
    if (visited.has(n)) return false;
    visited.add(n);
    const grp = byName.get(n);
    if (!grp) return false;
    for (const child of grp.groups) {
      if (child === candidate.name || reaches(child)) return true;
    }
    return false;
  };
  return reaches(candidate.name);
}
```

- [ ] **Step 4: Run to verify pass** — `cd swarm && pnpm test > /tmp/g1.out 2>&1; echo $?` → 0.
- [ ] **Step 5: Commit** — `git add swarm/src/groups.ts swarm/src/groups.test.ts && git commit -m "feat(swarm): workspace groups — nested entity, cycle-safe expansion"`

### Task 2: Swarm /groups routes (CRUD, expansion in GET, cycle-guarded writes)

**Files:**
- Modify: `swarm/src/server.ts` (import from `./groups.js`; a `groups` mirror + `refreshGroups()` beside the workspaces mirror at `:311`; routes registered beside the workspace routes at `:1566-1713`)

**Interfaces:**
- Consumes: Task 1's `loadGroupsFromDir`, `assertGroup`, `expandGroup`, `wouldCycle`.
- Produces the HTTP contract Task 3's swarm-client pins:
  - `GET /groups` → `{ groups: Array<WorkspaceGroup & { expansion: string[] }> }` (expansion sorted, computed against active workspaces)
  - `POST /groups` body `WorkspaceGroup` → 200 `{ group }` | 400 `{ error }` (invalid shape, duplicate name, or cycle: error text `"group would contain itself"`)
  - `PUT /groups/:name` body `Partial<WorkspaceGroup>` (name immutable; merged over existing) → 200/400/404
  - `DELETE /groups/:name` → `{ ok: true, deleted: name }` | 404. No cascade — other groups' dangling refs are skipped by `expandGroup`.

- [ ] **Step 1: Add the mirror + routes.** Follow the workspace-route bodies at `swarm/src/server.ts:1566-1713` exactly (resolve `.smith/groups`, `mkdir` recursive on first write, write `<name>.json`, `rm` on delete, re-load the mirror after every mutation). Writes validate with `assertGroup("request", body)` then `wouldCycle` before touching disk. `GET /groups` maps the mirror: `groups.map((g) => ({ ...g, expansion: [...expandGroup(g.name, groups, this.workspaces)].sort() }))`.
- [ ] **Step 2: Boot check** — `cd swarm && pnpm test > /tmp/g2.out 2>&1; echo $?` → 0 (route logic is thin; validation is Task 1's tested code. Live route smoke happens in Task 11.)
- [ ] **Step 3: Commit** — `git add swarm/src/server.ts && git commit -m "feat(swarm): /groups CRUD — expansion in GET, cycle-guarded writes"`

### Task 3: Broker — swarm-client groups + proxy routes + session-frame `groups`

**Files:**
- Modify: `broker/src/swarm-client.ts` (beside `listWorkspaces` at `:349`), `broker/src/text-channel.ts` (proxy routes beside `/workspaces` at `:858`), `broker/src/main.ts` (mirror + adapter + frame at `:662-690`, `:794`)
- Test: `broker/src/swarm-client.test.ts` (route-contract list at `:105`)

**Interfaces:**
- Consumes: Task 2's HTTP contract.
- Produces:
  - swarm-client: `listGroups(): Promise<SwarmGroup[]>` where `interface SwarmGroup { name: string; description?: string; workspaces: string[]; groups: string[]; color?: string; expansion: string[] }`, `createGroup(body)`, `updateGroup(name, body)`, `deleteGroup(name)` — paths `GET/POST /groups`, `PUT/DELETE /groups/:name`.
  - main.ts: module state `let groupRecords: SwarmGroup[] = []`, refreshed inside `refreshWorkspaceNames()` (`groupRecords = await swarm.listGroups().catch(() => [])`); `sessionFrame()` gains `groups: groupRecords` next to `workspaces`; a `groups` adapter `{ list, save(body, isNew), remove(name) }` mirroring the `workspaces` adapter at `:794`, wired into the text-channel deps at `:1265`.
  - text-channel routes (writes originBlocked, like workspaces): `GET /groups`, `POST /groups`, `PUT /groups/:name`, `DELETE /groups/:name` — each calls the adapter and 200s the result (adapter returns `{ error }` objects rather than throwing, same as `workspaces.save`).

- [ ] **Step 1: Extend the contract test** — in `broker/src/swarm-client.test.ts`, add `"GET /groups"`, `"POST /groups"`, `"PUT /groups/g"`, `"DELETE /groups/g"` to the expected-route list and stub responses (`"/groups": { groups: [] }`), calling the four new methods. Run `cd broker && pnpm test > /tmp/g3.out 2>&1; echo $?` → non-zero (methods missing).
- [ ] **Step 2: Implement** swarm-client methods (copy the `createWorkspace`/`listWorkspaces` bodies at `:326-353`, s/workspaces/groups/), the main.ts mirror + adapter + frame field, and the text-channel proxies (copy the `/workspaces` route bodies at `:858-870`).
- [ ] **Step 3: Run to verify pass** — `cd broker && pnpm test > /tmp/g3.out 2>&1; echo $?` → 0.
- [ ] **Step 4: Commit** — `git add broker/src/swarm-client.ts broker/src/swarm-client.test.ts broker/src/text-channel.ts broker/src/main.ts && git commit -m "feat(broker): proxy /groups and ship groups on the session frame"`

### Task 4: Broker — `group:` pin resolution + session seeding

**Files:**
- Create: `broker/src/pins.ts`
- Test: `broker/src/pins.test.ts`
- Modify: `broker/src/main.ts:713` (the seeding line inside `startSession`)

**Interfaces:**
- Consumes: `SwarmGroup.expansion` from Task 3's mirror.
- Produces: `GROUP_PIN_PREFIX = "group:"`, `docSeedsInWorkspace(pins: string[] | undefined, workspace: string, groups: Array<{ name: string; expansion: string[] }>): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// broker/src/pins.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { docSeedsInWorkspace } from "./pins.js";

const groups = [
  { name: "frontend", expansion: ["acme-web", "labs"] },
  { name: "acme", expansion: ["acme-web", "acme-api"] },
];

describe("docSeedsInWorkspace", () => {
  it("bare workspace pin matches exactly", () => {
    assert.equal(docSeedsInWorkspace(["acme-web"], "acme-web", groups), true);
    assert.equal(docSeedsInWorkspace(["acme-web"], "acme-api", groups), false);
  });
  it("group pin flows DOWN to member workspaces (spec decision 4)", () => {
    assert.equal(docSeedsInWorkspace(["group:frontend"], "labs", groups), true);
    assert.equal(docSeedsInWorkspace(["group:frontend"], "acme-api", groups), false);
  });
  it("a deleted group's pin is skipped, never throws (spec §3)", () => {
    assert.equal(docSeedsInWorkspace(["group:gone"], "acme-web", groups), false);
  });
  it("no pins seeds nowhere; a workspace named like a group does not collide", () => {
    assert.equal(docSeedsInWorkspace(undefined, "acme-web", groups), false);
    assert.equal(docSeedsInWorkspace(["frontend"], "labs", groups), false); // bare "frontend" is a WORKSPACE name
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd broker && pnpm test > /tmp/g4.out 2>&1; echo $?` → non-zero.
- [ ] **Step 3: Implement**

```ts
// broker/src/pins.ts
// Pin-target resolution. One array, two namespaces: bare entries are workspace
// names; "group:<name>" entries resolve through the group's precomputed
// expansion (swarm's GET /groups). Down-only by construction — nothing here
// ever attributes a member's pins to its parent (spec decisions 3-5).
export const GROUP_PIN_PREFIX = "group:";

export function docSeedsInWorkspace(
  pins: string[] | undefined,
  workspace: string,
  groups: Array<{ name: string; expansion: string[] }>,
): boolean {
  if (!pins) return false;
  const expansions = new Map(groups.map((g) => [g.name, g.expansion]));
  return pins.some((p) =>
    p.startsWith(GROUP_PIN_PREFIX)
      ? (expansions.get(p.slice(GROUP_PIN_PREFIX.length)) ?? []).includes(workspace)
      : p === workspace,
  );
}
```

In `broker/src/main.ts:713` replace the seeding condition:

```ts
if (docSeedsInWorkspace(doc.pins, workspace, groupRecords)) sessionManager.addArtifact(s.id, doc.id);
```

- [ ] **Step 4: Run to verify pass** — `cd broker && pnpm test > /tmp/g4.out 2>&1; echo $?` → 0.
- [ ] **Step 5: Commit** — `git add broker/src/pins.ts broker/src/pins.test.ts broker/src/main.ts && git commit -m "feat(broker): group pins seed sessions in member workspaces — down-only"`

### Task 5: Control-plane — types, frame plumbing, api helpers

**Files:**
- Modify: `control-plane/src/api/types.ts`, `control-plane/src/queries/keys.ts:8`, `control-plane/src/queries/pushed.ts:50`, `control-plane/src/stores/socketStore.ts:131`, `control-plane/src/api/broker.ts`
- Test: `control-plane/src/stores/socketStore.test.ts` (session-frame case)

**Interfaces:**
- Consumes: Task 3's frame field `groups`.
- Produces: `GroupT { name: string; description?: string; workspaces: string[]; groups: string[]; color?: string; expansion: string[] }` in types.ts; `qk.groups = ["groups"]`; `useGroups(): UseQueryResult<GroupT[]>` (skipToken + staleTime Infinity, same shape as `useWorkspaces` at pushed.ts:50); socketStore session case adds `qc.setQueryData<GroupT[]>(qk.groups, frame.groups ?? [])` (normalized — an older broker sends no `groups`); api/broker.ts `saveGroup(body: Omit<GroupT, "expansion">, isNew: boolean): Promise<{ error?: string }>` (POST or PUT `/groups...`), `deleteGroup(name): Promise<{ error?: string }>`.

- [ ] **Step 1: Extend the socketStore session-frame test** — the existing test feeds a session frame and asserts cache writes; add `groups: [{ name: "g1", workspaces: [], groups: [], expansion: ["w1"] }]` to the fed frame and assert `qc.getQueryData(qk.groups)` equals it; also feed a frame WITHOUT `groups` and assert the cache gets `[]`. Run vitest on that file → FAIL.
- [ ] **Step 2: Implement** the five modifications above (api helpers follow the `brokerFetch` + `{ error }` pattern of `pinDoc` in api/broker.ts).
- [ ] **Step 3: Run** — `cd control-plane && pnpm exec vitest run src/stores/socketStore.test.ts` → PASS.
- [ ] **Step 4: Commit** — `git add control-plane/src/api/types.ts control-plane/src/api/broker.ts control-plane/src/queries/keys.ts control-plane/src/queries/pushed.ts control-plane/src/stores/socketStore.ts control-plane/src/stores/socketStore.test.ts && git commit -m "feat(cp): groups ride the session frame — GroupT, useGroups, CRUD helpers"`

### Task 6: PinButton becomes a "Pin to…" popover (workspace + groups + stale rows)

**Files:**
- Modify: `control-plane/src/molecules/PinButton.tsx` (full rewrite), `control-plane/src/molecules/PinButton.test.tsx` (full rewrite), `control-plane/src/router.tsx` (the three `<PinButton …>` sites gain `groups={groupNames}` from `useGroups`), `control-plane/src/styles/documents.css` (popover styles)

**Interfaces:**
- Consumes: Task 5's `useGroups`; existing `api.pinDoc/unpinDoc` (targets may now be `group:<name>`).
- Produces: `PinButtonProps { pins?: string[]; workspace?: string; groups?: string[]; onPin(target): Promise<string | null>; onUnpin(target): Promise<string | null> }`. Trigger button `aria-label="Pin to…"` shows `📌 <n>` when n>0 targets are pinned; opens a popover (`role="menu"`, closes on outside click/Esc) with one `aria-pressed` toggle row per target: the session workspace (bare name), each group (label `name`, target `group:<name>`), then a row per STALE pin (pin entries matching neither the workspace, another known workspace pin, nor a known group — label `<target> (gone)`, unpin-only).
- The stale check treats any bare pin ≠ session workspace as "another workspace's pin" and does NOT list it (decision 5: you see those in their workspace) — only `group:` pins naming unknown groups are stale rows.

- [ ] **Step 1: Rewrite the tests** — cover: no workspace → renders null; toggle pin/unpin on the workspace row; group row pins `group:frontend`; count badge; stale `group:gone` row unpins; other-workspace pins NOT listed. Run → FAIL.
- [ ] **Step 2: Rewrite the component** (local `open` state; reuse the existing `pin-button` classes for the trigger; popover markup `div.pin-popover > button.pin-popover__row[aria-pressed]`; error `span.pin-button__error` kept).
- [ ] **Step 3: Add styles** — `.pin-popover { position: absolute; z-index: 5; background: var(--ground-2); border: 1px solid var(--pill-br); border-radius: 10px; padding: 6px; display: flex; flex-direction: column; gap: 2px; }` and row hover/pressed states, in documents.css beside the pin-button block.
- [ ] **Step 4: Run** — `pnpm exec vitest run src/molecules/PinButton.test.tsx` → PASS; then the full suite (router sites changed).
- [ ] **Step 5: Commit** — `git add control-plane/src/molecules/PinButton.tsx control-plane/src/molecules/PinButton.test.tsx control-plane/src/router.tsx control-plane/src/styles/documents.css && git commit -m "feat(cp): Pin to… popover — pin docs to the workspace or any group"`

### Task 7: Navbar GROUPS tier + lens

**Files:**
- Modify: `control-plane/src/stores/uiStore.ts` (+test), `control-plane/src/molecules/WorkspaceSelector.tsx`, `control-plane/src/molecules/WorkspaceSelector.test.tsx`

**Interfaces:**
- Consumes: Task 5's `useGroups`.
- Produces: uiStore `activeLens: { group: string } | null`, `setLens(group: string, expansion: string[])` (sets `activeLens` AND `viewedWorkspaces = new Set(expansion)`), `clearLens()` (resets `activeLens: null, viewedWorkspaces: new Set()`); selector sentinel `const GROUP_PREFIX = "__group__:"` for group option keys and `NEW_GROUP = "__new-group__"` command.

- [ ] **Step 1: uiStore test first** — `setLens("frontend", ["a","b"])` sets both fields; `clearLens()` resets both; initial null. FAIL → implement → PASS.
- [ ] **Step 2: Selector tests** — renders a GROUPS section listing group names above the workspaces separator; selecting a group calls `setLens` with its expansion and does NOT call `api.activateSession`; selecting a workspace clears the lens and activates as today; `New group…` opens the manager (uiStore `setWorkspacesOpen(true)`). The Select's controlled `value` becomes `activeLens ? GROUP_PREFIX + activeLens.group : current` so the trigger shows the group name while the lens is on. FAIL → implement → PASS.
- [ ] **Step 3: Run the full cp suite** (HomePage renders the selector; MapStage/BoardStage read `viewedWorkspaces` — no changes expected there, the lens drives the existing filter).
- [ ] **Step 4: Commit** — `git add control-plane/src/stores/uiStore.ts control-plane/src/stores/uiStore.test.ts control-plane/src/molecules/WorkspaceSelector.tsx control-plane/src/molecules/WorkspaceSelector.test.tsx && git commit -m "feat(cp): navbar GROUPS tier — picking a group applies a Board/Map lens"`

### Task 8: Groups section in the workspace manager

**Files:**
- Create: `control-plane/src/organisms/GroupsSection.tsx`
- Test: `control-plane/src/organisms/GroupsSection.test.tsx`
- Modify: `control-plane/src/organisms/WorkspaceManagerModal.tsx` (render `<GroupsSection …>` above/below the workspace list), `control-plane/src/styles/components.css` (reuse `workspace-manager__*` classes; add `.groups-section__members` checkbox grid)

**Interfaces:**
- Consumes: Task 5's `useGroups`, `useWorkspaces`, `api.saveGroup`, `api.deleteGroup`.
- Produces: `GroupsSection({ groups, workspaces, onSave, onDelete })` — router-free, props-driven like every organism; WorkspaceManagerModal supplies the queries/api. Form: name (immutable when editing), description, color, two checkbox groups (member workspaces from `workspaces`, member groups from `groups` minus self). Server-side cycle rejection (`{ error: "group would contain itself" }`) renders on an inline error row.

- [ ] **Step 1: Tests first** — list renders group names; create flow calls `onSave({ name, workspaces: [...], groups: [...] , description, color }, true)`; member-groups picker omits the group being edited; an `onSave` resolving `{ error: "group would contain itself" }` shows that text; delete calls `onDelete(name)`. FAIL → implement → PASS.
- [ ] **Step 2: Wire into WorkspaceManagerModal** and run the full cp suite.
- [ ] **Step 3: Commit** — `git add control-plane/src/organisms/GroupsSection.tsx control-plane/src/organisms/GroupsSection.test.tsx control-plane/src/organisms/WorkspaceManagerModal.tsx control-plane/src/styles/components.css && git commit -m "feat(cp): manage groups from the workspace manager"`

### Task 9: Dashboard scope chips = groups

**Files:**
- Modify: `control-plane/src/organisms/dashboards/DashboardAsk.tsx` (+test), `control-plane/src/organisms/DashboardsStage.tsx` (+test), `control-plane/src/router.tsx` (DashboardsRoute), `control-plane/src/data/dashboards.ts` (`DASH_SCOPES` shrinks to `["all workspaces"]`; `scopeHint(scope)` returns `scope === "all workspaces" ? "all workspaces" : \`group ${scope}\``)

**Interfaces:**
- Consumes: Task 5's `useGroups`.
- Produces: `DashboardAsk` gains `scopes: string[]` (rendered as the radio chips; replaces the `DASH_SCOPES` import); `DashboardsStage` gains `scopes?: string[]` (default `["all workspaces"]`) and threads it through; DashboardsRoute passes `scopes={["all workspaces", ...groups.map((g) => g.name)]}`. The picked scope keeps flowing into `onPresent(question, scope)` → the doc's question section as `scope: <name>` (unchanged).

- [ ] **Step 1: Tests first** — DashboardAsk renders exactly the `scopes` prop as chips (board-type chips gone); DashboardsStage default scope is `"all workspaces"` and a picked group scope reaches `onPresent`. FAIL → implement → PASS, full suite (the retired board-type chips will break existing scope tests — update them to the prop).
- [ ] **Step 1b: SAVED meta strips the pin namespace** (spec §6) — in DashboardsRoute's `savedDocs` mapping, display targets as `d.pins?.map((p) => p.replace(/^group:/, ""))` joined; assert in the route-level or DashboardAsk test that a doc pinned to `group:core` shows meta `core`, never `group:core`.
- [ ] **Step 2: Commit** — `git add control-plane/src/organisms/dashboards/DashboardAsk.tsx control-plane/src/organisms/dashboards/DashboardAsk.test.tsx control-plane/src/organisms/DashboardsStage.tsx control-plane/src/organisms/DashboardsStage.test.tsx control-plane/src/router.tsx control-plane/src/data/dashboards.ts && git commit -m "feat(cp): dashboard scope chips are your groups"`

### Task 10: DashSpec text cards

**Files:**
- Modify: `control-plane/src/lib/dashboardSpec.ts` (+test), `control-plane/src/organisms/dashboards/DashboardBoard.tsx` (+test), `control-plane/src/styles/dashboards.css`

**Interfaces:**
- Produces: `DashSpec` gains `texts?: Array<{ title: string; body: string; source?: string }>`; `parseDashSpec` accepts and validates them (title+body strings required, source optional; a malformed entry fails the whole parse — all-or-nothing like the rest); `specToFence` round-trips them; `DashboardBoard` renders each as `article.dash-text-card` (h in the grid: title, body paragraph, `.dash-text-card__source` label when present) between the charts row and the table.

- [ ] **Step 1: Tests first** — parse round-trip with texts; parse failure on `{ title: 1 }`; DashboardBoard renders title/body/source and skips the section when `texts` absent. FAIL → implement → PASS.
- [ ] **Step 2: Styles** — `.dash-text-card { border: 1px solid var(--pill-br); border-radius: 12px; padding: 14px 16px; background: rgba(255,255,255,0.02); }`, `.dash-text-card__source { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; }` in dashboards.css.
- [ ] **Step 3: Full cp suite + commit** — `git add control-plane/src/lib/dashboardSpec.ts control-plane/src/lib/dashboardSpec.test.ts control-plane/src/organisms/dashboards/DashboardBoard.tsx control-plane/src/organisms/dashboards/DashboardBoard.test.tsx control-plane/src/styles/dashboards.css && git commit -m "feat(cp): dashboards carry text answer cards"`

### Task 11: Verification, restarts, live smoke, ship

- [ ] Root `pnpm test` / `pnpm lint` / `pnpm typecheck` clean (exit codes via redirect).
- [ ] Restart swarm (tmux `smith-swarm`) and broker (tmux `smith-broker`): C-c, relaunch `node --env-file=../.env --import tsx src/server.ts` / `src/main.ts`. Reload the control-plane tab BEFORE judging routing (stale-blueprints lesson: post-restart caches lie).
- [ ] Live smoke: manager → create group `core` containing `jefelabs`; navbar shows GROUPS tier; picking `core` lenses Board to jefelabs and keeps the session; pin dashboard d34 to `group:core` via the popover; start a NEW jefelabs session → d34 attached; launcher SCOPE shows `core`; dock-send "add a text card summarizing the release risk" on a dashboard → text card renders. Screenshot and LOOK.
- [ ] Cycle guard live: try adding `core` to a group that `core` contains → inline "group would contain itself".
- [ ] Spec status → SHIPPED; memory file + MEMORY.md line; push via the ecruz165 dance.
