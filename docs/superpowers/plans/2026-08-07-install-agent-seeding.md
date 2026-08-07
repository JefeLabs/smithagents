# Install-Time Agent Seeding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh clone ships exactly one presence — Anderson, the broker host — and the control-plane rail renders him pinned above a labeled Crew section; user-created agents live only in `swarm/.smith/` and reappear on relaunch.

**Architecture:** Two independent halves. (1) Repo state: untrack the three committed crew/workspace files and ignore all of `swarm/.smith/`; `broker/.smith/identity.json` stays tracked as the shipped Anderson. (2) UI: the roster WS frame already carries an `identity` field on every push; a pure `hostSeed()` helper converts it to an `AgentSeed` with `kind: "host"`, `HomePage` prepends it, and `AgentRoster` renders it in a pinned host slot above a structural "crew" label — outside the sortable/drag/combine/remove machinery. No broker or swarm code changes.

**Tech Stack:** git, React 18 + TypeScript (control-plane), vitest + @testing-library/react, dnd-kit (existing — host stays outside it), pnpm.

**Spec:** `docs/superpowers/specs/2026-08-07-install-agent-seeding-design.md`

## Global Constraints

- Anderson is never an agent: no engine, never delegatable, never in the roster `agents` array (`broker/src/main.ts:497` — "the host is never in `agents`"). All host presence is UI composition.
- User crew state lives only in `.smith`, never in git.
- `broker/.smith/identity.json` stays tracked — do not touch broker gitignore rules (root `.gitignore` lines ~73-81).
- Run all git commands as `git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents ...` and commit with explicit file paths only — the working tree carries unrelated uncommitted changes (`swarm/.smith/agents/*.json`) that must never be swept into a commit.
- Control-plane checks: `pnpm test`, `pnpm typecheck`, `pnpm lint` (biome — control-plane only; swarm/broker have no biome).
- Swarm tests: `npm test` in `swarm/` (`node --import tsx --test src/*.test.ts`). Broker tests: `npm test` in `broker/`.
- The host ring fallback is `#8a93a6` (matches `broker/.smith/identity.json` `avatarRing`).

---

### Task 1: Untrack crew state from git

**Files:**
- Modify: `.gitignore:51-58` (the swarm runtime-state block)
- Untrack (files stay on disk): `swarm/.smith/agents/ignacio.json`, `swarm/.smith/agents/wilkin.json`, `swarm/.smith/workspaces/jefelabs.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a repo where `git ls-files swarm/.smith` is empty. Later tasks don't depend on this task; it can land independently.

- [ ] **Step 1: Untrack the three files (index only — disk copies survive)**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents rm --cached \
  swarm/.smith/agents/ignacio.json \
  swarm/.smith/agents/wilkin.json \
  swarm/.smith/workspaces/jefelabs.json
```

- [ ] **Step 2: Rewrite the gitignore block**

In `.gitignore`, replace this block (currently lines 51-58):

```gitignore
# Swarm runtime state is ignored, but the seed composed-agents are committed.
swarm/.smith/*
!swarm/.smith/agents/
!swarm/.smith/agents/*.json
!swarm/.smith/workspaces/
!swarm/.smith/workspaces/*.json
!swarm/.smith/squads/
!swarm/.smith/squads/*.json
```

with:

```gitignore
# Swarm runtime state — user crew/workspaces/squads live only on the machine, never in git.
swarm/.smith/
```

Do NOT touch the `broker/.smith/*` block further down (lines ~73-81) — `!broker/.smith/identity.json` is the shipped Anderson.

- [ ] **Step 3: Verify the untrack**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents ls-files swarm/.smith
ls /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm/.smith/agents/
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents ls-files broker/.smith
```

Expected: first command prints nothing; second still lists `ignacio.json minerva.json wilkin.json` (disk untouched); third still prints `broker/.smith/identity.json`.

- [ ] **Step 4: Prove nothing reads the tracked copies — run swarm and broker suites**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && npm test
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && npm test
```

Expected: both PASS. (`ignacio`/`wilkin` appearing in `swarm/src/agents.test.ts` etc. are inline fixtures, not reads of the tracked files.)

- [ ] **Step 5: Commit (explicit paths only)**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit \
  -m "fix: crew state never ships — untrack swarm/.smith, ignore it whole" \
  -- .gitignore swarm/.smith/agents/ignacio.json swarm/.smith/agents/wilkin.json swarm/.smith/workspaces/jefelabs.json
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents show --stat HEAD
```

Expected: `show --stat` lists exactly 4 files (1 modified, 3 deleted).

---

### Task 2: `hostSeed()` helper in data/agents.ts

**Files:**
- Modify: `control-plane/src/data/agents.ts` (add `"host"` to the `kind` union; add `hostSeed`)
- Test: `control-plane/src/data/agents.test.ts` (create)

**Interfaces:**
- Consumes: `BrokerIdentityInfo` shape from `control-plane/src/hooks/useBrokerChat.ts:45` — `{ name: string; role: string; ring?: string; listening?: boolean }`. To avoid a data→hooks import cycle, `hostSeed` takes a structural parameter type, not the exported interface.
- Produces: `hostSeed(identity: { name: string; role: string; ring?: string; listening?: boolean } | null): AgentSeed | null` — returns `null` for `null` input, else an `AgentSeed` with `id: "host"`, `kind: "host"`, ring fallback `#8a93a6`. Task 3 branches on `kind === "host"`; Task 4 calls `hostSeed(identity)`.

- [ ] **Step 1: Write the failing test**

Create `control-plane/src/data/agents.test.ts`:

```tsx
import { describe, expect, it } from "vitest";
import { hostSeed } from "./agents";

describe("hostSeed", () => {
  it("returns null when the broker has sent no identity", () => {
    expect(hostSeed(null)).toBeNull();
  });

  it("builds a host-kind seed from the identity frame field", () => {
    expect(hostSeed({ name: "Anderson", role: "Chief of Staff", ring: "#8a93a6", listening: true })).toEqual({
      id: "host",
      name: "Anderson",
      role: "Chief of Staff",
      ring: "#8a93a6",
      listening: true,
      kind: "host",
    });
  });

  it("falls back to the identity ring when the frame omits one", () => {
    expect(hostSeed({ name: "Anderson", role: "Chief of Staff" })?.ring).toBe("#8a93a6");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && pnpm test -- src/data/agents.test.ts`
Expected: FAIL — `hostSeed` is not exported.

- [ ] **Step 3: Implement**

In `control-plane/src/data/agents.ts`, change the `kind` line of `AgentSeed`:

```ts
  /** Solo agent, squad/group rendered as one circle, or the broker host (never an agent). */
  kind?: "agent" | "squad" | "host";
```

and add after the `AgentSeed` interface:

```ts
/** The broker's host identity as a rail entry. Presentation only — the host is never an agent. */
export function hostSeed(
  identity: { name: string; role: string; ring?: string; listening?: boolean } | null,
): AgentSeed | null {
  if (!identity) return null;
  return {
    id: "host",
    name: identity.name,
    role: identity.role,
    ring: identity.ring ?? "#8a93a6",
    listening: identity.listening,
    kind: "host",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && pnpm test -- src/data/agents.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit \
  -m "feat(control-plane): hostSeed — identity frame field as a host-kind rail entry" \
  -- control-plane/src/data/agents.ts control-plane/src/data/agents.test.ts
```

---

### Task 3: Host slot + Crew label in AgentRoster

**Files:**
- Modify: `control-plane/src/organisms/AgentRoster.tsx`
- Modify: `control-plane/src/styles/components.css` (one new rule near `.roster` at line ~269)
- Test: `control-plane/src/organisms/AgentRoster.test.tsx` (create)

**Interfaces:**
- Consumes: `AgentSeed` with `kind?: "agent" | "squad" | "host"` from Task 2. `AgentAvatar` props (`control-plane/src/molecules/AgentAvatar.tsx`): `name`, `role`, `ring`, `listening`; omitting `agentId` disables the surface-policy popover/long-press — correct for the host.
- Produces: `AgentRoster` accepts a `kind: "host"` entry anywhere in its `agents` prop and renders it pinned first, above a structural "crew" label; the host never enters sort order, drag, combine, edit, or remove. Crew semantics unchanged. Task 4 relies on exactly this contract.

- [ ] **Step 1: Write the failing tests**

Create `control-plane/src/organisms/AgentRoster.test.tsx`:

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSeed } from "../data/agents";
import { AgentRoster } from "./AgentRoster";

const HOST: AgentSeed = { id: "host", name: "Anderson", role: "Chief of Staff", ring: "#8a93a6", kind: "host" };
const CREW: AgentSeed[] = [
  { id: "ignacio", name: "Ignacio", role: "Builder", ring: "#6f8dff" },
  { id: "minerva", name: "Minerva", role: "Researcher", ring: "#e0a15a" },
];

describe("AgentRoster host slot", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("pins the host above the crew list, outside the sortable roster", () => {
    const { container } = render(<AgentRoster agents={[HOST, ...CREW]} onAdd={vi.fn()} />);
    const hostSlot = container.querySelector(".roster-host");
    expect(hostSlot?.textContent).toContain("Anderson");
    // The host circle lives outside the .roster sortable list…
    expect(container.querySelector(".roster .roster-host")).toBeNull();
    // …and the crew circles render inside it, without the host.
    const roster = container.querySelector(".roster");
    expect(roster?.textContent).toContain("Ignacio");
    expect(roster?.textContent).not.toContain("Anderson");
    // Host precedes the crew label in document order.
    const label = container.querySelector(".rail__label");
    expect(hostSlot && label && hostSlot.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("labels the crew section 'crew' and keeps the add button when the crew is empty", () => {
    const { container } = render(<AgentRoster agents={[HOST]} onAdd={vi.fn()} />);
    expect(container.querySelector(".rail__label")?.textContent).toBe("crew");
    expect(container.querySelector("button.add")).not.toBeNull();
    expect(container.querySelectorAll(".roster-item").length).toBe(0);
  });

  it("renders no host slot when no host entry is passed (identity null)", () => {
    const { container } = render(<AgentRoster agents={CREW} onAdd={vi.fn()} />);
    expect(container.querySelector(".roster-host")).toBeNull();
    expect(container.querySelector(".rail__label")?.textContent).toBe("crew");
  });

  it("keeps the host out of the saved roster order", () => {
    localStorage.setItem("smith.rosterOrder", JSON.stringify(["minerva", "ignacio"]));
    const { container } = render(<AgentRoster agents={[HOST, ...CREW]} onAdd={vi.fn()} />);
    const names = [...container.querySelectorAll(".roster .agent-avatar-anchor")].map((n) => n.textContent ?? "");
    expect(names[0]).toContain("Minerva");
    expect(names[1]).toContain("Ignacio");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && pnpm test -- src/organisms/AgentRoster.test.tsx`
Expected: FAIL — `.roster-host` never renders, label text is `agents`, and the host leaks into `.roster`.

- [ ] **Step 3: Implement the host slot in AgentRoster**

In `control-plane/src/organisms/AgentRoster.tsx`:

(a) Inside `AgentRoster`, split host from crew before ordering — replace

```tsx
  const entries = applyOrder(agents, order);
```

with

```tsx
  // The host (broker identity) is presentation only: pinned, never sorted,
  // dragged, combined, edited, or removed — so it never enters `entries`.
  const host = agents.find((a) => a.kind === "host");
  const crew = agents.filter((a) => a.kind !== "host");
  const entries = applyOrder(crew, order);
```

(b) In the returned JSX, add the host slot above the label and rename the label — replace

```tsx
    <aside className="rail rail--right" aria-label="Agents">
      <div className="rail__label">
```

with

```tsx
    <aside className="rail rail--right" aria-label="Agents">
      {host && (
        <div className="roster-host">
          <AgentAvatar name={host.name} role={host.role} ring={host.ring} listening={host.listening} />
        </div>
      )}
      <div className="rail__label">
```

and replace the label's idle text `"agents"` (line ~239) with `"crew"`.

- [ ] **Step 4: Add the host-slot style**

In `control-plane/src/styles/components.css`, directly above the `.roster` rule (line ~269), add:

```css
/* Pinned host (broker identity) — separated from the crew it introduces. */
.roster-host {
  display: flex;
  justify-content: center;
  padding-bottom: 10px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--rail-br);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && pnpm test -- src/organisms/AgentRoster.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit \
  -m "feat(control-plane): pinned host slot above a labeled Crew section in the rail" \
  -- control-plane/src/organisms/AgentRoster.tsx control-plane/src/organisms/AgentRoster.test.tsx control-plane/src/styles/components.css
```

---

### Task 4: HomePage prepends the host entry

**Files:**
- Modify: `control-plane/src/pages/HomePage.tsx:2` (import) and `:141-155` (agents composition)

**Interfaces:**
- Consumes: `hostSeed` from Task 2; `identity` already destructured from `useBrokerChat` at `HomePage.tsx:61`; `AgentRoster`'s host contract from Task 3.
- Produces: the rail shows Anderson whenever the broker connection has delivered a roster frame, ahead of the mapped crew. No other consumer of the `agents` array exists in HomePage (`agents` feeds only `<AgentRoster agents={agents} …>` at line 213).

- [ ] **Step 1: Wire the host entry**

In `control-plane/src/pages/HomePage.tsx`, change the import at line 2:

```tsx
import { type AgentSeed, hostSeed, ringForIndex } from "../data/agents";
```

and replace the `agents` composition (lines 141-155):

```tsx
  const host = hostSeed(identity);
  const agents: AgentSeed[] = [
    ...(host ? [host] : []),
    ...roster.map((a, i) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      ring: a.ring ?? ringForIndex(i),
      status: a.status,
      hand: a.hand,
      listening: a.listening,
      kind: a.kind,
      members: a.members,
      avatar: a.avatar,
      engineWarning: engineWarnings[a.id],
    })),
  ];
```

- [ ] **Step 2: Full control-plane verification**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && pnpm test && pnpm typecheck && pnpm lint
```

Expected: all PASS. (`pnpm lint` is biome; fix any formatting it flags in the files this plan touched, nothing else.)

- [ ] **Step 3: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit \
  -m "feat(control-plane): rail leads with Anderson — host entry from the identity frame" \
  -- control-plane/src/pages/HomePage.tsx
```

---

### Task 5: End-to-end verification

**Files:** none created — verification only.

**Interfaces:**
- Consumes: everything above.
- Produces: evidence for the spec's two invariants — fresh clone ships Anderson only; live app shows host + crew.

- [ ] **Step 1: Fresh-clone smoke — nothing user-owned ships**

```bash
git clone --no-hardlinks /Users/edwincruz/Development/Workspaces/jefelabs/smithagents \
  /private/tmp/claude-501/-Users-edwincruz-Development-Workspaces-jefelabs-smithagents/ec8b7bac-974d-4024-9d80-1c3c29f0074e/scratchpad/fresh-clone-smoke
git -C /private/tmp/claude-501/-Users-edwincruz-Development-Workspaces-jefelabs-smithagents/ec8b7bac-974d-4024-9d80-1c3c29f0074e/scratchpad/fresh-clone-smoke ls-files swarm/.smith
git -C /private/tmp/claude-501/-Users-edwincruz-Development-Workspaces-jefelabs-smithagents/ec8b7bac-974d-4024-9d80-1c3c29f0074e/scratchpad/fresh-clone-smoke ls-files broker/.smith
```

Expected: `swarm/.smith` listing is EMPTY; `broker/.smith` listing shows exactly `broker/.smith/identity.json`.

- [ ] **Step 2: Live-app smoke — host + crew render**

The dev stack is already running (broker in tmux `smith-broker` on 7790, Tauri in tmux `smith-ui`, vite hot-reloads the change). In the app window: the rail shows Anderson's circle pinned at top with a divider, then the `crew` label, then the existing crew (ignacio, minerva, wilkin), then `+`. If checking without eyes on the window, `curl -s http://127.0.0.1:1420/` returning the index HTML plus the passing component tests stands in for the visual check, and note the manual check as pending for Edwin.

- [ ] **Step 3: Full suites one last time**

```bash
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/swarm && npm test
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/broker && npm test
cd /Users/edwincruz/Development/Workspaces/jefelabs/smithagents/control-plane && pnpm test
```

Expected: all PASS. No commit — nothing changed.
