# App Shell Navbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Claimed by:** unclaimed — claim this header before executing

**Goal:** Add a top navbar carrying logo, workspace selector, alert icon and a
cloud-gated avatar, making the selector the app's single workspace control and retiring
the per-stage filters that own it today.

**Architecture:** The navbar introduces **no new source of truth**. The workspace that
matters is already authoritative on the active session and already governs dispatch
(`broker/src/main.ts:288-298`). Selecting a workspace activates a session; the broker
broadcasts a session frame; every surface follows it. `ControlPlaneLayout` gains a
seventh slot; `BoardStage`'s scope state and `MapStage`'s workspace state are deleted,
not duplicated.

**Tech Stack:** React 19, TypeScript 5.6 (strict), TanStack Query 5.101, TanStack Router
1.170, zustand 5.0, Vitest 4 + jsdom, Testing Library, Biome, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-09-app-shell-navbar-design.md`

## Global Constraints

- Package manager is **pnpm**, run from `control-plane/`. Never `npm`. **The repo root has
  no `package.json` and no `node_modules`** — they were a scratch install and were deleted
  2026-08-09. If any command creates files at the repo root, stop and report it.
- **No broker or swarm change. No new endpoints.** Every action reuses existing wiring:
  `api.activateSession(id)` and `uiStore.openComposer(ws)`.
- **Agents must not gain a workspace field.** An agent's workspace is a property of the
  work it was handed, derived from the session. This is enforced server-side already.
- **Selecting a workspace must never change who is in a channel.** Channel participation
  is per-agent surface policy and is a different axis entirely.
- **No route loaders, ever.** The WebSocket lives above the router; data arrives by frame.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` must all pass before every commit.
- Branch is `app-shell-navbar`, created off `main`.
- **Commit discipline:** stage and commit with explicit paths in one step. Never
  `git commit -a`. Never leave work staged-but-uncommitted between turns. After each
  commit run `git show --stat HEAD` and confirm the file list.

## Sequencing note

This plan touches `BoardStage` and `MapStage`, which **HeroUI Phase 1c** also migrates.
Run this plan first: Phase 1c then inherits stages that no longer own their scope, which
is strictly less to migrate. The reverse order does the scope retirement twice.
HeroUI Phase 1a is independent and may run in parallel — it touches neither stage.

## File Structure

| Path | Responsibility |
|---|---|
| `src/organisms/Navbar.tsx` | The bar itself. Composition only — every child is fed by props. |
| `src/molecules/WorkspaceSelector.tsx` | The selector. Owns the select→activate decision. |
| `src/molecules/AlertMenu.tsx` | Badge + list. Presentation only. |
| `src/queries/alerts.ts` | `useAlerts()` + the pure `computeAlerts()` it wraps. |
| `src/lib/cloud.ts` | `CLOUD_MODE`. One constant, one reason. |
| `src/templates/ControlPlaneLayout.tsx` | Modified — gains a `topBar` slot. |
| `src/organisms/ToolRail.tsx` | Modified — loses the logo. |
| `src/pages/HomePage.tsx` | Modified — composes the navbar. |
| `src/organisms/BoardStage.tsx` | Modified — `scope` state deleted. |
| `src/molecules/BoardTabs.tsx` | Modified — scope picker deleted. |
| `src/organisms/MapStage.tsx` | Modified — `workspace` state deleted. |
| `src/stores/uiStore.ts` | Modified — gains `aggregateView`. |

---

### Task 1: The shell — `Sidebar` rail, layout restructure, navbar slot

**Files:**
- Modify: `src/templates/ControlPlaneLayout.tsx`, `src/organisms/ToolRail.tsx`,
  `src/pages/HomePage.tsx`, `src/styles/components.css`
- Create: `src/organisms/Navbar.tsx`
- Test: `src/organisms/Navbar.test.tsx`, `src/organisms/ToolRail.test.tsx` (existing)

**Interfaces:**
- Consumes: `Logo` from `../atoms/Logo`; `Sidebar` from `@heroui-pro/react`.
- Produces: `Navbar(props: { onHome?: () => void; workspaceSlot?: ReactNode;
  alertSlot?: ReactNode; avatarSlot?: ReactNode })`, and a `topBar` slot on
  `ControlPlaneLayout`. Later tasks fill the three slots.

**This is the biggest task in the plan** — it converts the left side of the shell from
fixed-position to flow layout. The three files are touched together on purpose: splitting
the `Sidebar` conversion from the navbar would mean restructuring `ControlPlaneLayout`,
`ToolRail` and `HomePage` twice.

**The layout collision, stated up front.** `Sidebar.Provider` owns layout —
`.sidebar__provider` is `flex min-h-svh w-full`, `Sidebar.Main` is `flex-1`. Today
`.rail--left` and `.rail--right` are fixed, the dot-grid canvas is a fixed underlay, and
the board/map stages clear the rails with `inset 0 72px`. After this task:

- The **left** rail takes real width in flow; the stages' left inset goes away.
- The **right** roster rail stays fixed — it is HeroUI Phase 2 work. The right inset stays.
- The **canvas stays `position: fixed`** as an underlay behind everything. It is not a
  flow child, and making it one will break the fisheye's coordinate math.

Verify the stages in a real window, not only in tests. `pnpm dev` works and a broker is
typically listening on 127.0.0.1:7790.

- [ ] **Step 1: Write the failing test**

Create `src/organisms/Navbar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Navbar } from "./Navbar";

describe("Navbar", () => {
  it("is a landmark distinct from the tool rail", () => {
    render(<Navbar />);
    // The rail is aria-label="Tools and activity"; two <nav>s with the same name
    // would be indistinguishable to a screen reader.
    expect(screen.getByRole("navigation", { name: /workspace and account/i })).toBeDefined();
  });

  it("the logo goes home", async () => {
    const onHome = vi.fn();
    render(<Navbar onHome={onHome} />);
    await userEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(onHome).toHaveBeenCalled();
  });

  it("renders the slots it is given and nothing when they are absent", () => {
    const { rerender } = render(<Navbar alertSlot={<span>alerts-here</span>} />);
    expect(screen.getByText("alerts-here")).toBeDefined();
    rerender(<Navbar />);
    expect(screen.queryByText("alerts-here")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run src/organisms/Navbar.test.tsx`
Expected: FAIL — unresolved import `./Navbar`.

- [ ] **Step 3: Write `Navbar`**

Create `src/organisms/Navbar.tsx`:

```tsx
import type { ReactNode } from "react";
import { Logo } from "../atoms/Logo";

interface NavbarProps {
  /** Logo press — back to the voice stage, the behaviour the rail's logo had. */
  onHome?: () => void;
  workspaceSlot?: ReactNode;
  alertSlot?: ReactNode;
  avatarSlot?: ReactNode;
}

/**
 * The top bar. Composition only — it reads no query and holds no state, so every
 * later task lands one child without restructuring it.
 *
 * The logo moved here from ToolRail: two logos would be wrong, and the bar is
 * where an app's mark belongs. It keeps the rail's Home behaviour and its label.
 */
export function Navbar({ onHome, workspaceSlot, alertSlot, avatarSlot }: NavbarProps) {
  return (
    <nav className="navbar" aria-label="Workspace and account">
      <button type="button" className="logo" title="smithagents" aria-label="Home" onClick={onHome}>
        <Logo />
      </button>
      {workspaceSlot}
      <div className="spacer" />
      {alertSlot}
      {avatarSlot}
    </nav>
  );
}
```

- [ ] **Step 4: Add the layout slot**

In `src/templates/ControlPlaneLayout.tsx`, add `topBar?: ReactNode` to the props and
render it **first**, before `background`:

```tsx
  return (
    <>
      {topBar}
      {background}
      {leftRail}
      ...
```

Order matters only for the DOM and therefore for tab order: the bar should come before
the canvas underlay and the rails so keyboard focus reaches it first.

- [ ] **Step 4b: Rebuild `ToolRail` on `Sidebar`**

Replace the hand-rolled `<nav className="rail rail--left">` with the real anatomy —
verified against the docs, not guessed:

```tsx
<Sidebar collapsible="icon">
  <Sidebar.Header>{/* empty — the logo lives in the navbar now */}</Sidebar.Header>
  <Sidebar.Content>
    <Sidebar.Menu aria-label="Tools and activity">
      <Sidebar.MenuItem onAction={onNewSession}>
        <Sidebar.MenuIcon><Plus /></Sidebar.MenuIcon>
        <Sidebar.MenuLabel>New session</Sidebar.MenuLabel>
      </Sidebar.MenuItem>
      <Sidebar.MenuItem onAction={onSessions}>
        <Sidebar.MenuIcon><History /></Sidebar.MenuIcon>
        <Sidebar.MenuLabel>Sessions</Sidebar.MenuLabel>
      </Sidebar.MenuItem>
      <Sidebar.MenuItem href="/board" isCurrent={activeRoute === "/board"}>
        <Sidebar.MenuIcon><SquareKanban /></Sidebar.MenuIcon>
        <Sidebar.MenuLabel>Board</Sidebar.MenuLabel>
      </Sidebar.MenuItem>
      <Sidebar.MenuItem href="/map" isCurrent={activeRoute === "/map"}>
        <Sidebar.MenuIcon><MapIcon /></Sidebar.MenuIcon>
        <Sidebar.MenuLabel>Map</Sidebar.MenuLabel>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Content>
  <Sidebar.Footer>
    <Sidebar.Menu aria-label="Settings">
      <Sidebar.MenuItem onAction={onSettings}>
        <Sidebar.MenuIcon><Settings /></Sidebar.MenuIcon>
        <Sidebar.MenuLabel>Settings</Sidebar.MenuLabel>
      </Sidebar.MenuItem>
    </Sidebar.Menu>
  </Sidebar.Footer>
</Sidebar>
```

Wire routing on the provider in `ControlPlaneLayout`:

```tsx
<Sidebar.Provider
  defaultOpen={false}
  collapsible="icon"
  navigate={(href) => void router.navigate({ to: href })}
>
```

Five things this changes, each of which a test or a comment currently depends on:

1. **`activeRoute` string comparison is retired** in favour of `isCurrent`. The
   `tool.route !== null && tool.route === activeRoute` logic at `ToolRail.tsx:47` goes.
2. **The `TOOLS` array goes** — items are now JSX, because each has a different shape
   (two dispatch handlers, two hrefs). The `if (tool.label === "…")` dispatch chain at
   `:53` was only ever a workaround for a uniform array.
3. **`defaultOpen={false}`** keeps today's icon-only feel. `collapsible="icon"` gives a
   48px rail with automatic per-item tooltips, plus an expanded state the rail never had.
4. **`Sidebar.MenuItem` cannot render as an `<a>`** — RAC `TreeItem`, HTML spec
   limitation. Navigation is programmatic. Any test asserting a link role must become a
   press assertion.
5. **`toggleShortcut` defaults to `mod+b`.** No collision today — the app binds a bare
   `g` for the grid tuner (`HomePage.tsx:165-171`). Leave the default; if a command
   palette ever lands, disable it with `toggleShortcut={false}` rather than fighting it.

- [ ] **Step 5: Move the logo out of `ToolRail`, and repurpose its Plus**

Two changes to `src/organisms/ToolRail.tsx`:

**(a) Delete the logo `<button>` and the `Logo` import.** Keep `onHome` in its props
**only if** something still calls it — run
`grep -n "onHome" src/organisms/ToolRail.tsx src/pages/HomePage.tsx` and remove the prop
entirely if the navbar is now its only caller. A prop no one passes is dead weight.

**(b) The Plus tool stops meaning "New workspace" and becomes "New session".** Rename the
entry at `ToolRail.tsx:7`, rename the `onNewWorkspace` prop to `onNewSession`, and update
the dispatch at `:53`:

```tsx
const TOOLS = [
  { icon: Plus, label: "New session", route: null },
  { icon: History, label: "Sessions", route: null },
  { icon: SquareKanban, label: "Board", route: "/board" },
  { icon: MapIcon, label: "Map", route: "/map" },
] as const;
```

In `HomePage`, wire it to the composer — locked only when the view is unambiguous:

```tsx
// You may look at many, create in one. With several workspaces viewed there is no
// non-surprising default, so leave the picker unlocked and let the user say which.
// NewSessionScreen already renders a picker when lockedWorkspace is undefined.
onNewSession={() =>
  openComposer(viewedWorkspaces.size === 1 ? session?.workspace : undefined)
}
```

Falling back to the active session's workspace would be unambiguous to the code and
surprising to the user, who is looking at three boards with no reason to expect one of
them to win. The same rule governs the board's add-card control — see the spec.

`openComposer(locked)` already exists and `NewSessionScreen` already reads
`lockedWorkspace={composer?.locked}` — this is the same call `SessionsPanel` makes today,
so there is no new wiring. Workspace *creation* moves to the navbar dropdown in Task 2.

The resulting split is the reason the shell has two chrome surfaces at all: the navbar
answers **which workspace**, the rail answers **what to do in it**. Creating a workspace
is a switching action; creating a session is work inside the current one.

`ToolRail.test.tsx` asserts the logo and probably the Plus's label/handler. Update those
in **this** commit — the elements moved and changed meaning, so the tests move with them.
Do not delete a Plus assertion: repoint it at `onNewSession`.

- [ ] **Step 6: Compose it in `HomePage`**

Pass `topBar={<Navbar onHome={() => void navigate({ to: "/" })} />}` to
`ControlPlaneLayout`, and remove the `onHome` prop from the `ToolRail` element if Step 5
removed it.

- [ ] **Step 7: Add the CSS**

Add a `.navbar` block to `src/styles/components.css`. It is fixed chrome across the top;
the rails and stage must clear it. Match the rails' existing visual language — same
`--pill` background treatment, same `--rail-br` border — rather than inventing a new one.

**Check the stage-mode rail clearance.** Board and map stages use `inset 0 72px` to clear
the side rails; a top bar changes the vertical inset too. Verify both stages in a real
window, not only in tests.

- [ ] **Step 8: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/organisms/Navbar.tsx src/organisms/Navbar.test.tsx \
        src/templates/ControlPlaneLayout.tsx src/organisms/ToolRail.tsx \
        src/organisms/ToolRail.test.tsx src/pages/HomePage.tsx src/styles/components.css
git commit -m "feat: app shell navbar with the logo moved out of the tool rail"
git show --stat HEAD
```

---

### Task 2: The workspace selector

**Files:**
- Create: `src/molecules/WorkspaceSelector.tsx`
- Test: `src/molecules/WorkspaceSelector.test.tsx`
- Modify: `src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: `useSession`, `useSessions`, `useWorkspaces` from `../queries/pushed`;
  `api.activateSession`; `uiStore.openComposer`.
- Produces: `WorkspaceSelector()` — takes no props; it reads its own queries, which is
  safe for the same reason the voice route's do (one shared cache entry).

This is the task the whole design turns on. `select(X)` resolves to a session action
because that is the only activation the broker has.

- [ ] **Step 1: Write the failing tests**

Create `src/molecules/WorkspaceSelector.test.tsx`. Seed the query cache the way the
existing suites do — read `src/test/renderWithProviders.tsx` first and match its helper
rather than inventing a new one.

```tsx
describe("WorkspaceSelector", () => {
  it("shows the active session's workspace without any client-side workspace state", async () => {
    renderWithSession({ workspace: "acme" }, { workspaces: ["acme", "jefelabs"] });
    expect(await screen.findByRole("button", { name: /acme/ })).toBeDefined();
  });

  it("selecting a workspace activates that workspace's most recent session", async () => {
    const activate = vi.fn();
    renderWithSession(
      { workspace: "acme" },
      {
        workspaces: ["acme", "jefelabs"],
        sessions: [
          { id: "s1", workspace: "jefelabs", updatedAt: "2026-08-01T00:00:00Z", title: "old", active: false, runtime: "local-in-process" },
          { id: "s2", workspace: "jefelabs", updatedAt: "2026-08-08T00:00:00Z", title: "new", active: false, runtime: "local-in-process" },
        ],
        activate,
      },
    );
    await userEvent.click(screen.getByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "jefelabs" }));
    expect(activate).toHaveBeenCalledWith("s2"); // most recent by updatedAt, not first in the array
  });

  it("selecting a workspace with no sessions opens the composer locked to it and activates nothing", async () => {
    const activate = vi.fn();
    renderWithSession({ workspace: "acme" }, { workspaces: ["acme", "empty"], sessions: [], activate });
    await userEvent.click(screen.getByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "empty" }));
    expect(useUiStore.getState().composer).toEqual({ locked: "empty" });
    expect(activate).not.toHaveBeenCalled();
  });

  it("offers New workspace as the last item, opening the create flow", async () => {
    const setNewWorkspaceOpen = vi.fn();
    renderWithSession({ workspace: "acme" }, { workspaces: ["acme"], setNewWorkspaceOpen });
    await userEvent.click(screen.getByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: /new workspace/i }));
    expect(setNewWorkspaceOpen).toHaveBeenCalledWith(true);
    // It is a command, not a workspace — it must never be treated as a selection.
    expect(useUiStore.getState().composer).toBeNull();
  });

  it("selecting the workspace already active is a no-op", async () => {
    const activate = vi.fn();
    renderWithSession({ workspace: "acme" }, { workspaces: ["acme"], sessions: [{ id: "s1", workspace: "acme", updatedAt: "2026-08-08T00:00:00Z", title: "t", active: true, runtime: "local-in-process" }], activate });
    await userEvent.click(screen.getByRole("button", { name: /acme/ }));
    await userEvent.click(await screen.findByRole("option", { name: "acme" }));
    expect(activate).not.toHaveBeenCalled();
  });
});
```

That last case matters: re-activating the current session would reload brain history and
re-broadcast a frame for no reason.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run src/molecules/WorkspaceSelector.test.tsx`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the selector**

Create `src/molecules/WorkspaceSelector.tsx`:

```tsx
import * as api from "../api/broker";
import { useSession, useSessions, useWorkspaces } from "../queries/pushed";
import { useUiStore } from "../stores/uiStore";

const NO_SESSIONS: never[] = [];
const NO_WORKSPACES: never[] = [];

/**
 * The app's one workspace control.
 *
 * It holds NO workspace state. The displayed workspace is the active session's,
 * straight off the session frame — the broker already treats that as
 * authoritative and dispatches work against it (`broker/src/main.ts:288-298`).
 * Selecting therefore cannot mean "set a variable"; it means "activate a session
 * there", and the frame that comes back moves every surface at once.
 */
export function WorkspaceSelector() {
  const { data: session } = useSession();
  const { data: sessions = NO_SESSIONS } = useSessions();
  const { data: workspaces = NO_WORKSPACES } = useWorkspaces();
  const openComposer = useUiStore((s) => s.openComposer);

  const current = session?.workspace ?? null;

  // "New workspace…" is a COMMAND in the list, not a workspace. It is sentinel-keyed
  // rather than matched on its label so a workspace literally named "New workspace"
  // cannot shadow it — the same class of bug the colour picker's sentinel avoids.
  const NEW_WORKSPACE = "new-workspace";

  const select = (name: string) => {
    if (name === NEW_WORKSPACE) {
      setNewWorkspaceOpen(true);
      return; // never falls through to session activation
    }
    // Re-activating the current session reloads brain history and re-broadcasts
    // a frame for no gain.
    if (name === current) return;
    const newest = sessions
      .filter((s) => s.workspace === name)
      .reduce<(typeof sessions)[number] | null>(
        (best, s) => (best === null || s.updatedAt > best.updatedAt ? s : best),
        null,
      );
    if (newest) void api.activateSession(newest.id);
    else openComposer(name); // no session there yet — the existing create flow
  };

  // …render a listbox of `workspaces` with `current` selected, calling select(name).
  // Use the same control the rest of the shell uses; do not introduce a new one.
}
```

`updatedAt` is an ISO 8601 string, so lexicographic `>` is a correct chronological
comparison. Do **not** add `new Date()` parsing — it buys nothing and costs a
timezone-shaped bug.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run src/molecules/WorkspaceSelector.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mount it**

In `HomePage`, pass `workspaceSlot={<WorkspaceSelector />}` to `Navbar`.

- [ ] **Step 6: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/molecules/WorkspaceSelector.tsx src/molecules/WorkspaceSelector.test.tsx src/pages/HomePage.tsx
git commit -m "feat: workspace selector — selecting activates that workspace's newest session"
git show --stat HEAD
```

---

### Task 3: Retire `BoardStage`'s scope picker

**Files:**
- Modify: `src/organisms/BoardStage.tsx`, `src/molecules/BoardTabs.tsx`,
  `src/stores/uiStore.ts`
- Test: `src/organisms/BoardStage.test.tsx` (809 lines), `src/molecules/BoardTabs.test.tsx`

**Interfaces:**
- Consumes: `useSession` from `../queries/pushed`; `uiStore.aggregateView`.
- Produces: `uiStore` gains `aggregateView: boolean` and `setAggregateView(v: boolean)`.

**This is a behaviour change, not a refactor.** Aggregate scope stops being per-stage.
Say so in the commit message.

- [ ] **Step 1: Add `aggregateView` to `uiStore`**

Add to the interface, the `initial` object, and the creator:

```ts
  /**
   * The board's "all workspaces" view. The ONLY thing with no session to represent
   * it, so it cannot ride on the session frame like every other workspace does.
   * View-only: it never affects dispatch and never changes the active session —
   * work still lands in the active session's workspace regardless.
   */
  aggregateView: boolean;
  setAggregateView: (aggregateView: boolean) => void;
```

- [ ] **Step 2: Rewrite `BoardStage`'s scope source**

Replace `const [scope, setScope] = useState<string>(ALL_WORKSPACES)` (line 171) with:

```tsx
  const { data: session } = useSession();
  const aggregateView = useUiStore((s) => s.aggregateView);
  // Derived, not stored: the session frame is the source of truth, and the
  // aggregate toggle is the one case it cannot express.
  const scope = aggregateView ? ALL_WORKSPACES : (session?.workspace ?? ALL_WORKSPACES);
```

Everything downstream of `scope` — `tabsFor(boards, scope)`, the reset effect at line
220, `createBoardMutation.mutateAsync({ type, workspaceId: scope })` at 291, and
`addable` at 317 — is **unchanged**. Only where `scope` comes from moves.

The reset effect's dependency stays `[scope, tab?.key]`; `scope` is now derived, so it
changes when the session frame does, which is exactly when the reset should fire.

- [ ] **Step 3: Delete the picker from `BoardTabs`**

Remove the `scope` and `onScope` props, the `workspaces` prop if it becomes unused, and
the `.board-tabs__scope` control at line 52. Keep the **scope-keyed reset effect** at
lines 26-29 — its `adding` state still needs clearing when scope changes, and the
comment explaining why still applies. Change its dependency to the `scope` value passed
down, or lift the reset into `BoardStage` if the prop is gone entirely.

Leave `.board-tabs__scope`'s CSS in `components.css` — HeroUI Phase 3 deletes that file
wholesale, and removing rules piecemeal makes other surfaces' screenshot diffs
unexplainable.

- [ ] **Step 4: Update the tests**

`BoardStage.test.tsx` drives the picker to change scope. Those tests change to setting
the session frame's workspace (or `aggregateView`) instead. **The assertions must not
change** — only how the workspace gets chosen. If an assertion needs changing, stop:
that is a behaviour change beyond the one this task sanctions.

Add one test for the new capability:

```tsx
it("follows the session frame's workspace without any in-stage control", async () => {
  const { client } = renderBoardStage();
  seedSessionFrame(client, { workspace: "acme" });
  expect(await screen.findByRole("tab", { name: /acme/i })).toBeDefined();
});
```

Match `renderBoardStage`/`seedSessionFrame` to the suite's real helpers — read the top
of the file first.

- [ ] **Step 5: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/organisms/BoardStage.tsx src/organisms/BoardStage.test.tsx \
        src/molecules/BoardTabs.tsx src/molecules/BoardTabs.test.tsx src/stores/uiStore.ts
git commit -m "feat!: board scope follows the session, retiring the in-stage picker

Behaviour change: aggregate scope is no longer per-stage. Watching an
all-workspaces board while chatting inside one workspace now requires the
explicit aggregate toggle."
git show --stat HEAD
```

---

### Task 4: Retire `MapStage`'s workspace filter

**Files:**
- Modify: `src/organisms/MapStage.tsx`
- Test: `src/organisms/MapStage.test.tsx`

**Interfaces:**
- Consumes: `useSession`.
- Produces: nothing.

`MapStage` is subtler than `BoardStage`: its `workspace` state is seeded by **two**
racing effects (lines 243-252), one from the capabilities response and one from
`useWorkspaceRecords`, with a documented "whichever supplies a workspace first wins".
Both exist only because the state had no authoritative source. It now has one.

- [ ] **Step 1: Read the two seeding effects and their comments**

Read `MapStage.tsx:228-252` in full before changing anything. The comment block explains
a real bug the `!workspace ||` filter prevents. You are deleting the state those effects
seed, so both effects go — but the `activeId` selection they also perform must survive.

- [ ] **Step 2: Replace the state with the session's workspace**

```tsx
  const { data: session } = useSession();
  const workspace = session?.workspace ?? "";
```

Then delete `const [workspace, setWorkspace] = useState("")` and **every** `setWorkspace`
call, including the two in the seeding effects. Keep the `setActiveId` logic; re-express
its effect so it depends on `workspace` rather than seeding it.

- [ ] **Step 3: Run the suite**

Run: `pnpm vitest run src/organisms/MapStage.test.tsx`
Expected: PASS. Three tests query `{ selector: ".slice-band__name" }` — leave them alone;
this task does not touch slice bands.

- [ ] **Step 4: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/organisms/MapStage.tsx src/organisms/MapStage.test.tsx
git commit -m "feat: story map scope follows the session, retiring its own filter"
git show --stat HEAD
```

---

### Task 5: Alert aggregation

**Files:**
- Create: `src/queries/alerts.ts`, `src/queries/alerts.test.tsx`

**Interfaces:**
- Consumes: `useEngineWarnings` (`queries/health.ts`), `useBoards` (`queries/work.ts`),
  `useSocketStore`.
- Produces: `computeAlerts(input): Alert[]` (pure) and `useAlerts(): Alert[]`, where
  `Alert = { id: string; severity: "warn" | "error"; text: string; target?: string }`.
  `target` is a router path the row navigates to.

Derived, never fetched — the same shape `computeEngineWarnings` already uses, so
invalidating any underlying key refreshes the badge with no bespoke refresh path.

- [ ] **Step 1: Write the pure function's tests first**

Create `src/queries/alerts.test.tsx` with a table-driven suite over `computeAlerts`,
covering: an inactive engine produces one alert naming the agent; board errors produce
one alert each; a card with `jira.lastPushError` produces one; `connected: false`
produces exactly one broker alert; and everything healthy produces `[]`.

Include this case explicitly — it is the one that decides whether the badge is useful:

```tsx
it("a disconnected broker produces exactly one alert, not one per downstream failure", () => {
  const alerts = computeAlerts({
    connected: false,
    engineWarnings: { ana: "claude: unavailable" },
    boards: [],
    boardErrors: ["could not load boards"],
  });
  expect(alerts.filter((a) => a.id === "broker-disconnected")).toHaveLength(1);
});
```

When the broker is down everything downstream fails at once; a badge reading "14" for
one root cause is noise.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run src/queries/alerts.test.tsx`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write `computeAlerts` and `useAlerts`**

`computeAlerts` takes a plain object and returns `Alert[]` — no hooks, no imports from
React. `useAlerts` reads the three sources and calls it. Use stable module-level empty
arrays for the pending states, the way `queries/health.ts` already does, or the pure
function gets a new array identity every render.

`voiceNotice` is deliberately **excluded**: it self-dismisses after 6s and belongs to the
moment, not to a list you review later. Note that in the file's doc comment so its
absence reads as a decision.

- [ ] **Step 4: Run the tests, verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/queries/alerts.ts src/queries/alerts.test.tsx
git commit -m "feat: derive an alert list from existing query state"
git show --stat HEAD
```

---

### Task 6: The alert menu

**Files:**
- Create: `src/molecules/AlertMenu.tsx`, `src/molecules/AlertMenu.test.tsx`
- Modify: `src/pages/HomePage.tsx`

**Interfaces:**
- Consumes: `useAlerts` from Task 5.
- Produces: `AlertMenu(props: { onNavigate: (target: string) => void })`.

- [ ] **Step 1: Write the failing tests**

Cover: the badge shows the alert count; zero alerts renders the icon with no badge (and
an accessible name saying so); opening lists every alert; pressing a row with a `target`
calls `onNavigate` with it; a row without a `target` is not a button.

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm vitest run src/molecules/AlertMenu.test.tsx`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write it, mount it in `HomePage`**

Pass `alertSlot={<AlertMenu onNavigate={(t) => void navigate({ to: t })} />}` to `Navbar`.
The icon needs an accessible name that reflects state — "3 alerts" vs "No alerts" — not a
static label with a separate badge a screen reader never reaches.

- [ ] **Step 4: Verify and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`

```bash
git add src/molecules/AlertMenu.tsx src/molecules/AlertMenu.test.tsx src/pages/HomePage.tsx
git commit -m "feat: alert menu in the navbar"
git show --stat HEAD
```

---

### Task 7: The cloud-gated avatar, and close the phase

**Files:**
- Create: `src/lib/cloud.ts`, `src/molecules/OperatorAvatar.tsx`,
  `src/molecules/OperatorAvatar.test.tsx`
- Modify: `src/pages/HomePage.tsx`, `src/organisms/ToolRail.tsx`

**Interfaces:**
- Consumes: `useMe` from `queries/http`, `CLOUD_MODE`.
- Produces: `CLOUD_MODE: boolean`, `OperatorAvatar()`.

- [ ] **Step 1: Write `src/lib/cloud.ts`**

```ts
/**
 * Cloud mode is not implemented. The hosted switchboard is what will make operator
 * identity meaningful; until then this is false and the avatar never renders.
 *
 * Deliberately a constant rather than a query: there is no endpoint to ask, and
 * inventing one would build the seam twice. Everything downstream reads the flag,
 * never the literal, so making it real later is a one-line change here.
 */
export const CLOUD_MODE = false;
```

- [ ] **Step 2: Write the failing test**

```tsx
it("renders nothing while cloud mode is off", () => {
  render(<OperatorAvatar />);
  expect(screen.queryByRole("button", { name: /account/i })).toBeNull();
});
```

Do not mock `CLOUD_MODE` to `true` and assert the signed-in rendering — there is no login
to exercise and the assertion would encode a guess. Test the shipped behaviour.

- [ ] **Step 3: Write it and mount it**

`OperatorAvatar` returns `null` when `!CLOUD_MODE`. Otherwise it renders the operator's
avatar from `useMe()`. Pass `avatarSlot={<OperatorAvatar />}` to `Navbar`.

- [ ] **Step 4: Retire the stale comment**

`ToolRail.tsx:30-31` says *"No operator avatar … reintroduce it when cloud hosting makes
identity meaningful."* That decision has now been acted on. Replace it with a pointer:

```tsx
// The operator avatar lives in the Navbar (src/molecules/OperatorAvatar.tsx),
// gated on CLOUD_MODE. The rail is tools only.
```

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Confirm no test file outside the ones this plan names was edited:

```bash
git diff --stat main -- 'src/**/*.test.tsx' 'src/**/*.test.ts'
```

- [ ] **Step 6: UI smoke against a live broker**

Start the broker (tmux `smith-broker`, port 7790) and `pnpm dev`:

1. Select a workspace with sessions — confirm chat, board and story map all move, and
   that the newest session activated (not the first in the list).
2. Select a workspace with no sessions — confirm the composer opens locked to it and no
   session activated.
3. Select the workspace already active — confirm nothing happens.
4. Toggle the aggregate board view — confirm the board spans workspaces while the active
   session is unchanged.
5. Stop the broker — confirm exactly one alert appears, not one per downstream failure.
6. Confirm no avatar renders.
7. **Check both stages clear the navbar** — board and map use `inset 0 72px` for the side
   rails, and the top bar changes the vertical inset.
8. Tab from the top of the page — confirm focus reaches the navbar before the rails.

- [ ] **Step 7: Commit**

```bash
git add src/lib/cloud.ts src/molecules/OperatorAvatar.tsx \
        src/molecules/OperatorAvatar.test.tsx src/pages/HomePage.tsx src/organisms/ToolRail.tsx
git commit -m "feat: cloud-gated operator avatar, closing the navbar work"
git show --stat HEAD
```
