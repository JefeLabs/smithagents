# Stage Routing (TanStack Router) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map, Board, and Work stop acting like full-screen modals — all four stage views become real hash routes (`#/`, `#/board`, `#/map`, `#/work/$agentId`) behind TanStack Router, with the left rail as the navigation.

**Architecture:** `HomePage` becomes the root layout route: it keeps the single `useBrokerChat()` WebSocket and every overlay, renders `ControlPlaneLayout` with `stage={<Outlet />}`, and hands stage data down via a new `StageContext`. Thin route components in `src/router.tsx` read the context and render the existing organisms with plain props — organisms stay router-free. Board/Map lose their `open`/`onClose` props, X buttons, and `position: fixed` escape hatch; their root element becomes `<main>`, which already gets `inset: 0 72px` rail clearance from `base.css:26`.

**Tech Stack:** React 19, TypeScript, Vite, Vitest + Testing Library, Biome, `@tanstack/react-router` (new).

**Spec:** `docs/superpowers/specs/2026-08-07-stage-routing-design.md`

## Post-ship amendments (2026-08-07)

**Status: EXECUTED — shipped on main (`90c477f..1312ef1`).** Two corrections discovered at execution time; the task steps below are left as written for the historical record:

- **The repo is pnpm, not npm.** Every `npm`/`npx` command below ran as its pnpm equivalent; the dependency was added with `pnpm add -E @tanstack/react-router@1.170.23`, and the committed lockfile is `control-plane/pnpm-lock.yaml` (plus a `pnpm-workspace.yaml` `minimumReleaseAgeExclude` entry) — there is no `package-lock.json`.
- **Task 3 Step 3.5 was wrong to drop `X` from MapStage's lucide import.** Unlike BoardStage, MapStage also uses `X` for the story/activity/step remove buttons — only the `Close map` button block was deleted; the import keeps `X`.

## Global Constraints

- **Baseline check (do this before Task 1):** at plan time the working tree carried ANOTHER SESSION's uncommitted changes (deleted `IdentityTile.tsx`/`.test.tsx`, modified `HomePage.tsx` and `components.css` — an identity-tile removal, orthogonal to this plan). Run `git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents status --short control-plane`. If those files are still dirty, STOP and ask Edwin whether that work has landed. Never `git add -A` — stage explicit paths only.
- All `npm`/`npx` commands run inside `control-plane/`.
- Dependency is pinned EXACT: `npm i -E @tanstack/react-router@1.170.23` (no `^`).
- **No route loaders, ever.** Data flows over the one live WebSocket owned by `HomePage` above the router (spec invariant). Do not move fetching into TanStack loaders.
- **Organisms stay router-free.** Only `src/router.tsx`, `src/App.tsx`, `src/pages/HomePage.tsx`, and test files may import from `@tanstack/react-router`.
- Verify with: `npx vitest run <file>` (single file), `npm test` (all), `npm run typecheck`, `npm run lint` (Biome).
- Git: always `git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents …`; after each commit verify the `[main <hash>]` line and file count match what you staged.
- Test files in this repo use plain Vitest matchers (no jest-dom): assert attributes via `.getAttribute(...)`, not `toHaveAttribute`.

---

### Task 1: StageContext

**Files:**
- Create: `control-plane/src/hooks/StageContext.tsx`
- Test: `control-plane/src/hooks/StageContext.test.tsx`

**Interfaces:**
- Consumes: `ChatMessage`, `RosterAgent` types from `src/hooks/useBrokerChat.ts`; `AgentSeed` from `src/data/agents.ts`.
- Produces: `StageContextValue` (exact shape below), `StageProvider` (context Provider), `useStage(): StageContextValue` (throws outside a provider). Tasks 5–6 rely on these exact names.

- [ ] **Step 1: Write the failing test**

```tsx
// control-plane/src/hooks/StageContext.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StageProvider, type StageContextValue, useStage } from "./StageContext";

const VALUE: StageContextValue = {
  messages: [],
  micLive: false,
  onMicToggle: vi.fn(),
  brokerConnected: true,
  send: vi.fn(),
  soundOn: false,
  onSoundToggle: vi.fn(),
  sttEnabled: false,
  onVoiceBlocked: vi.fn(),
  showMicHero: true,
  voiceNotice: null,
  roster: [],
  lastBoardUpdate: null,
  lastCapabilityUpdate: null,
  agents: [],
  activity: vi.fn(async () => ({ busy: false })),
  workAction: vi.fn(async () => null),
};

function Probe() {
  const { brokerConnected } = useStage();
  return <span>{brokerConnected ? "connected" : "offline"}</span>;
}

describe("StageContext", () => {
  it("useStage returns the provided value", () => {
    render(
      <StageProvider value={VALUE}>
        <Probe />
      </StageProvider>,
    );
    expect(screen.getByText("connected")).toBeTruthy();
  });

  it("useStage throws outside a provider", () => {
    // React logs the thrown error; silence the noise for this one render.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/StageProvider/);
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/StageContext.test.tsx`
Expected: FAIL — cannot resolve `./StageContext`.

- [ ] **Step 3: Write the implementation**

```tsx
// control-plane/src/hooks/StageContext.tsx
import { createContext, useContext } from "react";
import type { AgentSeed } from "../data/agents";
import type { ChatMessage, RosterAgent } from "./useBrokerChat";

/**
 * The slice of broker state the stage routes need. Provided by HomePage (the
 * root layout, which owns the single useBrokerChat WebSocket) and consumed by
 * the thin route components in src/router.tsx. Never fetched via route
 * loaders — the connection lives above the router.
 */
export interface StageContextValue {
  // voice stage
  messages: ChatMessage[];
  micLive: boolean;
  onMicToggle: () => void;
  brokerConnected: boolean;
  send: (text: string) => void;
  soundOn: boolean;
  onSoundToggle: () => void;
  sttEnabled: boolean;
  onVoiceBlocked: () => void;
  showMicHero: boolean;
  voiceNotice: string | null;
  // board stage
  roster: RosterAgent[];
  lastBoardUpdate: { boardId: string; seq: number } | null;
  // map stage
  lastCapabilityUpdate: { capabilityId: string; seq: number } | null;
  // work stage
  agents: AgentSeed[];
  activity: (name: string) => Promise<{ busy: boolean; label?: string; output?: string }>;
  workAction: (name: string, action: "steer" | "cancel", message?: string) => Promise<string | null>;
}

const StageContext = createContext<StageContextValue | null>(null);

export const StageProvider = StageContext.Provider;

export function useStage(): StageContextValue {
  const value = useContext(StageContext);
  if (!value) throw new Error("useStage must be used inside HomePage's StageProvider");
  return value;
}
```

If `ChatMessage` is not exported from `useBrokerChat.ts`, check how `VoiceStage.tsx:2` imports it and mirror that import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/StageContext.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/src/hooks/StageContext.tsx control-plane/src/hooks/StageContext.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): StageContext — broker slice for stage routes"
```

---

### Task 2: BoardStage sheds its modal skin

**Files:**
- Modify: `control-plane/src/organisms/BoardStage.tsx` (props at 46-53, effects at 210-224, early-return at 266, root element at 326, close button at 363-365, lucide import at 12)
- Modify: `control-plane/src/pages/HomePage.tsx` (BoardStage call site — keep the `boardOpen` ternary for now)
- Modify: `control-plane/src/styles/components.css` (`.board-stage` block at ~2308)
- Test: `control-plane/src/organisms/BoardStage.test.tsx`

**Interfaces:**
- Produces: `BoardStage({ roster, lastBoardUpdate })` — `open`/`onClose` GONE. Task 5's `BoardRoute` renders exactly this.

- [ ] **Step 1: Update the tests first (they drive the prop change)**

In `BoardStage.test.tsx`, change every `render(<BoardStage open roster={ROSTER} lastBoardUpdate={...} onClose={vi.fn()} />)` (and the `rerender` at ~177) to drop `open` and `onClose`:

```tsx
render(<BoardStage roster={ROSTER} lastBoardUpdate={null} />);
```

Delete any test that clicks the X (`Close board`) or asserts `onClose` — search the file for `Close board` and `onClose`. All other assertions stay untouched.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/organisms/BoardStage.test.tsx`
Expected: FAIL — TypeScript/props mismatch (`open`/`onClose` still required by the component).

- [ ] **Step 3: Implement the component change**

In `BoardStage.tsx`:

1. Props:

```tsx
interface BoardStageProps {
  roster: RosterAgent[];
  lastBoardUpdate: { boardId: string; seq: number } | null;
}
```

and `export function BoardStage({ roster, lastBoardUpdate }: BoardStageProps) {`.

2. Effects (lines 210-224) — mount replaces `open`:

```tsx
useEffect(() => {
  void refetch();
}, [refetch]);

useEffect(() => {
  fetch(`http://${BASE}/workspaces`)
    .then((r) => r.json())
    .then((res: { workspaces?: Array<{ name: string }> }) => setWorkspaces((res.workspaces ?? []).map((w) => w.name)))
    .catch(() => {});
}, []);

useEffect(() => {
  if (lastBoardUpdate && lastBoardUpdate.boardId === activeId) void refetch();
}, [lastBoardUpdate, activeId, refetch]);
```

3. Delete `if (!open) return null;` (line 266).
4. Root element: `<section className="board-stage" aria-label="Work boards">` → `<main className="board-stage" aria-label="Work boards">` (and the matching `</section>` → `</main>`).
5. Delete the close button block:

```tsx
<button type="button" className="settings-btn" onClick={onClose} aria-label="Close board">
  <X size={12} strokeWidth={2} />
</button>
```

6. Drop `X` from the lucide import: `import { Download, Plus, SquareKanban } from "lucide-react";`

- [ ] **Step 4: Patch the HomePage call site (transitional)**

In `HomePage.tsx`'s stage ternary: `<BoardStage open roster={roster} lastBoardUpdate={lastBoardUpdate} onClose={() => setBoardOpen(false)} />` → `<BoardStage roster={roster} lastBoardUpdate={lastBoardUpdate} />`. The `boardOpen` boolean and rail toggle still control visibility until Task 5; the X is simply gone for one task.

- [ ] **Step 5: Replace the CSS escape hatch**

In `components.css`, the `.board-stage` block (~2308) currently ends with a long comment plus `position: fixed; inset: 0 72px;`. Replace comment and both declarations with:

```css
  /* Rendered as the stage's own <main> (base.css gives main `inset: 0 72px`
     rail clearance); undo main's centering so columns fill the stage. */
  align-items: stretch;
  justify-content: flex-start;
```

(The block keeps `display:flex; flex-direction:column; gap:10px; min-height:0; padding:14px;`.)

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `npx vitest run src/organisms/BoardStage.test.tsx && npm run typecheck && npm run lint`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/src/organisms/BoardStage.tsx control-plane/src/organisms/BoardStage.test.tsx \
  control-plane/src/pages/HomePage.tsx control-plane/src/styles/components.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "refactor(control-plane): BoardStage is a stage, not a modal — no open/onClose/X, renders as main"
```

---

### Task 3: MapStage sheds its modal skin

**Files:**
- Modify: `control-plane/src/organisms/MapStage.tsx` (props at 50-54, effects at 219-234, early-return at 293, root element at 444, close button at 477, lucide import at 12)
- Modify: `control-plane/src/pages/HomePage.tsx` (MapStage call site — keep the `mapOpen` ternary for now)
- Modify: `control-plane/src/styles/components.css` (`.map-stage` block at ~2502)
- Test: `control-plane/src/organisms/MapStage.test.tsx`

**Interfaces:**
- Produces: `MapStage({ lastCapabilityUpdate })` — `open`/`onClose` GONE. Task 5's `MapRoute` renders exactly this.

- [ ] **Step 1: Update the tests first**

In `MapStage.test.tsx`, change every `render(<MapStage open lastCapabilityUpdate={...} onClose={vi.fn()} />)` (and the `rerender` at ~91) to:

```tsx
render(<MapStage lastCapabilityUpdate={null} />);
```

Delete any test that clicks `Close map` or asserts `onClose`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/organisms/MapStage.test.tsx`
Expected: FAIL — props mismatch.

- [ ] **Step 3: Implement the component change**

In `MapStage.tsx`:

1. Props:

```tsx
interface MapStageProps {
  lastCapabilityUpdate: { capabilityId: string; seq: number } | null;
}
```

and `export function MapStage({ lastCapabilityUpdate }: MapStageProps) {`.

2. Effects (219-234):

```tsx
useEffect(() => {
  void refetch();
  void fetch(`http://${BASE}/workspaces`)
    .then((r) => r.json())
    .then((res: { workspaces?: Array<{ name: string }> }) => {
      const names = (res.workspaces ?? []).map((w) => w.name);
      setWorkspaces(names);
      setWorkspace((w) => w || names[0] || "");
    })
    .catch(() => {});
}, [refetch]);

useEffect(() => {
  if (lastCapabilityUpdate && lastCapabilityUpdate.capabilityId === activeId) void refetch();
}, [lastCapabilityUpdate, activeId, refetch]);
```

3. Delete `if (!open) return null;` (line 293).
4. Root: `<section className="map-stage" aria-label="Story map">` → `<main className="map-stage" aria-label="Story map">` (+ closing tag).
5. Delete the `Close map` button block (line 477); drop `X` from the lucide import: `import { Map as MapIcon, Plus } from "lucide-react";`

- [ ] **Step 4: Patch the HomePage call site (transitional)**

`<MapStage open lastCapabilityUpdate={lastCapabilityUpdate} onClose={() => setMapOpen(false)} />` → `<MapStage lastCapabilityUpdate={lastCapabilityUpdate} />`.

- [ ] **Step 5: Replace the CSS escape hatch**

In `components.css`, the `.map-stage` block (~2502): replace its comment + `position: fixed; inset: 0 72px;` with the same two overrides as `.board-stage`:

```css
  /* Rendered as the stage's own <main> — see .board-stage. */
  align-items: stretch;
  justify-content: flex-start;
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `npx vitest run src/organisms/MapStage.test.tsx && npm run typecheck && npm run lint`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/src/organisms/MapStage.tsx control-plane/src/organisms/MapStage.test.tsx \
  control-plane/src/pages/HomePage.tsx control-plane/src/styles/components.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "refactor(control-plane): MapStage is a stage, not a modal — no open/onClose/X, renders as main"
```

---

### Task 4: ToolRail reflects the real route; logo becomes Home

**Files:**
- Modify: `control-plane/src/organisms/ToolRail.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx` (pass `activeRoute` + `onHome`, derived from the booleans until Task 5)
- Modify: `control-plane/src/styles/components.css` (button reset for `.logo`, after the `.logo svg` rule at ~59)
- Test: `control-plane/src/organisms/ToolRail.test.tsx`

**Interfaces:**
- Produces: `ToolRail({ activeRoute?, onHome?, onNewWorkspace?, onSessions?, onBoard?, onMap?, onSettings? })`. Highlight contract: a tool is active iff its route equals `activeRoute` (`ToolButton` renders `aria-current="true"`). Task 5 passes the router's live pathname.

- [ ] **Step 1: Add failing tests**

Append to `ToolRail.test.tsx` (existing callback tests stay):

```tsx
it("board tool is highlighted only when activeRoute is /board", () => {
  render(<ToolRail activeRoute="/board" />);
  expect(screen.getByRole("button", { name: /^board$/i }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("button", { name: /^map$/i }).getAttribute("aria-current")).toBeNull();
  expect(screen.getByRole("button", { name: /new workspace/i }).getAttribute("aria-current")).toBeNull();
});

it("nothing is highlighted at the home route", () => {
  render(<ToolRail activeRoute="/" />);
  expect(screen.getByRole("button", { name: /^board$/i }).getAttribute("aria-current")).toBeNull();
  expect(screen.getByRole("button", { name: /^map$/i }).getAttribute("aria-current")).toBeNull();
});

it("logo fires onHome", async () => {
  const onHome = vi.fn();
  render(<ToolRail onHome={onHome} />);
  await userEvent.click(screen.getByRole("button", { name: /home/i }));
  expect(onHome).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/organisms/ToolRail.test.tsx`
Expected: 3 new FAIL (no `activeRoute`/`onHome` props, logo is a div), 5 old PASS.

- [ ] **Step 3: Rewrite ToolRail**

```tsx
// control-plane/src/organisms/ToolRail.tsx
import { History, Map as MapIcon, Plus, Settings, SquareKanban } from "lucide-react";
import { Logo } from "../atoms/Logo";
import { ToolButton } from "../atoms/ToolButton";

// route: null = action tool (opens an overlay, never highlighted as a place).
const TOOLS = [
  { icon: Plus, label: "New workspace", route: null },
  { icon: History, label: "Sessions", route: null },
  { icon: SquareKanban, label: "Board", route: "/board" },
  { icon: MapIcon, label: "Map", route: "/map" },
] as const;

interface ToolRailProps {
  /** Current stage route ("/", "/board", "/map", "/work/<id>") — drives the highlight. */
  activeRoute?: string;
  /** Logo press — back to the voice stage (home). */
  onHome?: () => void;
  /** "New workspace" tool — opens the create-workspace flow directly (design §5). */
  onNewWorkspace?: () => void;
  /** "Sessions" tool — toggles the sessions panel. */
  onSessions?: () => void;
  /** "Board" tool — navigates to the kanban board stage. */
  onBoard?: () => void;
  /** "Map" tool — navigates to the story map stage. */
  onMap?: () => void;
  /** Settings — the reset surface. */
  onSettings?: () => void;
}

// No operator avatar: there's no "account" concept in an all-local, single-operator
// app — reintroduce it when cloud hosting makes identity meaningful.
export function ToolRail({
  activeRoute = "/",
  onHome,
  onNewWorkspace,
  onSessions,
  onBoard,
  onMap,
  onSettings,
}: ToolRailProps) {
  return (
    <nav className="rail rail--left" aria-label="Tools and activity">
      <button type="button" className="logo" title="smithagents" aria-label="Home" onClick={onHome}>
        <Logo />
      </button>
      {TOOLS.map((tool) => (
        <ToolButton
          key={tool.label}
          icon={tool.icon}
          label={tool.label}
          active={tool.route !== null && tool.route === activeRoute}
          onClick={() => {
            if (tool.label === "New workspace") onNewWorkspace?.();
            if (tool.label === "Sessions") onSessions?.();
            if (tool.label === "Board") onBoard?.();
            if (tool.label === "Map") onMap?.();
          }}
        />
      ))}
      <div className="spacer" />
      <ToolButton icon={Settings} label="Settings" onClick={onSettings} />
    </nav>
  );
}
```

(The `useState` import and local `active` index are deleted.)

- [ ] **Step 4: CSS — the logo is a button now**

After the `.logo svg` rule (~`components.css:59`), add:

```css
button.logo {
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
```

- [ ] **Step 5: Transitional HomePage wiring**

In `HomePage.tsx`, the `<ToolRail …>` element gains (booleans still rule until Task 5; priority mirrors the stage ternary — map wins):

```tsx
<ToolRail
  activeRoute={mapOpen ? "/map" : boardOpen ? "/board" : "/"}
  onHome={() => {
    setMapOpen(false);
    setBoardOpen(false);
    setInspecting(null);
  }}
  onNewWorkspace={() => setNewWorkspaceOpen(true)}
  onSessions={() => setSessionsOpen((open) => !open)}
  onBoard={() => setBoardOpen((v) => !v)}
  onMap={() => setMapOpen((v) => !v)}
  onSettings={() => setSettingsOpen(true)}
/>
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `npx vitest run src/organisms/ToolRail.test.tsx && npm run typecheck && npm run lint`
Expected: all 8 PASS / clean.

- [ ] **Step 7: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/src/organisms/ToolRail.tsx control-plane/src/organisms/ToolRail.test.tsx \
  control-plane/src/pages/HomePage.tsx control-plane/src/styles/components.css
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): rail highlight tracks the active route; logo is Home"
```

---

### Task 5: The router — HomePage becomes the root layout

**Files:**
- Create: `control-plane/src/router.tsx`
- Modify: `control-plane/src/App.tsx`
- Modify: `control-plane/src/pages/HomePage.tsx`
- Modify: `control-plane/package.json` (+ lockfile, via npm)
- Test: `control-plane/src/pages/HomePage.test.tsx` (RouterProvider wrapper)

**Interfaces:**
- Consumes: `StageProvider`/`StageContextValue`/`useStage` (Task 1); `BoardStage({roster, lastBoardUpdate})` (Task 2); `MapStage({lastCapabilityUpdate})` (Task 3); `ToolRail({activeRoute, onHome, …})` (Task 4); existing `VoiceStage`/`WorkStage` props (unchanged).
- Produces: `createAppRouter(history?)` from `src/router.tsx` — Task 6's tests and `App.tsx` both call it. Routes: `/`, `/board`, `/map`, `/work/$agentId`; unknown routes and unknown agent ids render `<Navigate to="/" replace />`.

- [ ] **Step 1: Install the pinned dependency**

```bash
npm i -E @tanstack/react-router@1.170.23
```

Verify `package.json` shows `"@tanstack/react-router": "1.170.23"` (no caret).

- [ ] **Step 2: Make HomePage.test the failing test — wrap in a router**

In `HomePage.test.tsx`: add imports and replace `render(<HomePage />)` (line 110):

```tsx
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "../router";
```

```tsx
const router = createAppRouter(createMemoryHistory({ initialEntries: ["/"] }));
render(<RouterProvider router={router} />);
```

The `HomePage` import in this file becomes unused — remove it. Everything else (hook mocks, assertions) stays.

Run: `npx vitest run src/pages/HomePage.test.tsx`
Expected: FAIL — `../router` does not exist.

- [ ] **Step 3: Write `src/router.tsx`**

```tsx
// control-plane/src/router.tsx
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  useNavigate,
} from "@tanstack/react-router";
import { useStage } from "./hooks/StageContext";
import { BoardStage } from "./organisms/BoardStage";
import { MapStage } from "./organisms/MapStage";
import { VoiceStage } from "./organisms/VoiceStage";
import { WorkStage } from "./organisms/WorkStage";
import { HomePage } from "./pages/HomePage";

/**
 * Route components are deliberately thin: they read the broker slice from
 * StageContext (owned by HomePage, the root layout) and render the organisms
 * with plain props. No route loaders — data rides the WebSocket above the
 * router, and mounting it per-route would reconnect on every navigation.
 */
function VoiceRoute() {
  const s = useStage();
  return (
    <VoiceStage
      micLive={s.micLive}
      onMicToggle={s.onMicToggle}
      messages={s.messages}
      brokerConnected={s.brokerConnected}
      onSend={s.send}
      soundOn={s.soundOn}
      onSoundToggle={s.onSoundToggle}
      sttEnabled={s.sttEnabled}
      onVoiceBlocked={s.onVoiceBlocked}
      showMicHero={s.showMicHero}
      voiceNotice={s.voiceNotice}
    />
  );
}

function BoardRoute() {
  const s = useStage();
  return <BoardStage roster={s.roster} lastBoardUpdate={s.lastBoardUpdate} />;
}

function MapRoute() {
  const s = useStage();
  return <MapStage lastCapabilityUpdate={s.lastCapabilityUpdate} />;
}

function WorkRoute() {
  const s = useStage();
  const navigate = useNavigate();
  const { agentId } = workRoute.useParams();
  const agent = s.agents.find((a) => a.id === agentId);
  // Stale URL, removed agent, or the host (never inspectable) — go home.
  if (!agent || agent.kind === "host") return <Navigate to="/" replace />;
  return (
    <WorkStage
      name={agent.name}
      ring={agent.ring}
      onBack={() => void navigate({ to: "/" })}
      fetchActivity={s.activity}
      onWorkAction={s.workAction}
    />
  );
}

const rootRoute = createRootRoute({
  component: HomePage,
  notFoundComponent: () => <Navigate to="/" replace />,
});
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: VoiceRoute });
const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/board", component: BoardRoute });
const mapRoute = createRoute({ getParentRoute: () => rootRoute, path: "/map", component: MapRoute });
const workRoute = createRoute({ getParentRoute: () => rootRoute, path: "/work/$agentId", component: WorkRoute });

const routeTree = rootRoute.addChildren([indexRoute, boardRoute, mapRoute, workRoute]);

export function createAppRouter(history = createHashHistory()) {
  return createRouter({ routeTree, history });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
```

- [ ] **Step 4: Convert HomePage to the root layout**

In `HomePage.tsx`:

1. Delete state: `inspecting`, `boardOpen`, `mapOpen` (lines 34-38 area) and every `setInspecting`/`setBoardOpen`/`setMapOpen` call.
2. Delete imports of `BoardStage`, `MapStage`, `VoiceStage`, `WorkStage` (they now live in `router.tsx`). Add:

```tsx
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type StageContextValue, StageProvider } from "../hooks/StageContext";
```

3. Inside the component, after the existing hooks:

```tsx
const navigate = useNavigate();
const pathname = useRouterState({ select: (s) => s.location.pathname });
// Clicking the active tool returns home — preserves the old toggle feel.
const toggleTo = (route: "/board" | "/map") => void navigate({ to: pathname === route ? "/" : route });

const stageValue: StageContextValue = {
  messages,
  micLive,
  onMicToggle: () => void toggleMic(),
  brokerConnected: connected,
  send,
  soundOn,
  onSoundToggle: toggleSound,
  sttEnabled: voice.stt,
  onVoiceBlocked,
  showMicHero: !hideMic,
  voiceNotice,
  roster,
  lastBoardUpdate,
  lastCapabilityUpdate,
  agents,
  activity,
  workAction,
};
```

(Place `stageValue` after `agents` is computed. If `voice.stt` isn't a boolean, coerce: `sttEnabled: Boolean(voice.stt)`.)

4. ToolRail wiring (replaces Task 4's transitional version):

```tsx
<ToolRail
  activeRoute={pathname}
  onHome={() => void navigate({ to: "/" })}
  onNewWorkspace={() => setNewWorkspaceOpen(true)}
  onSessions={() => setSessionsOpen((open) => !open)}
  onBoard={() => toggleTo("/board")}
  onMap={() => toggleTo("/map")}
  onSettings={() => setSettingsOpen(true)}
/>
```

5. AgentRoster: `onInspect={(entry) => void navigate({ to: "/work/$agentId", params: { agentId: entry.id } })}`.
6. The whole stage ternary becomes `stage={<Outlet />}`, and the layout is wrapped in the provider:

```tsx
return (
  <StageProvider value={stageValue}>
    <ControlPlaneLayout
      background={<DotGridCanvas params={gridParams} />}
      leftRail={/* ToolRail from point 4 */}
      rightRail={/* AgentRoster, unchanged apart from onInspect */}
      stage={<Outlet />}
      overlays={/* unchanged */}
    />
  </StageProvider>
);
```

Everything else — overlays, ConfirmSheet flow, keyboard `g` tuner, voice-notice plumbing — stays byte-for-byte.

- [ ] **Step 5: Rewrite App.tsx**

```tsx
// control-plane/src/App.tsx
import { RouterProvider } from "@tanstack/react-router";
import { createAppRouter } from "./router";

const router = createAppRouter();

export function App() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 6: Run the full suite, typecheck, lint**

Run: `npm test && npm run typecheck && npm run lint`
Expected: everything PASSES — including `HomePage.test.tsx` (TanStack renders asynchronously; its existing `waitFor`s absorb that). If a test hangs on rendering, prefer `await screen.findByRole(...)` over `getByRole` for the first query after `render`.

- [ ] **Step 7: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add \
  control-plane/src/router.tsx control-plane/src/App.tsx control-plane/src/pages/HomePage.tsx \
  control-plane/src/pages/HomePage.test.tsx control-plane/package.json control-plane/package-lock.json
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "feat(control-plane): stages are routes — TanStack Router with hash history, HomePage is the root layout"
```

---

### Task 6: Navigation regression suite

**Files:**
- Test (create): `control-plane/src/router.test.tsx`

**Interfaces:**
- Consumes: `createAppRouter` (Task 5), the hook-mock pattern from `HomePage.test.tsx:37-98`.

- [ ] **Step 1: Write the suite**

```tsx
// control-plane/src/router.test.tsx
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrokerChat } from "./hooks/useBrokerChat";
import { useCliToolHealth } from "./hooks/useCliToolHealth";
import { usePushToTalk } from "./hooks/usePushToTalk";
import { useSpokenReplies } from "./hooks/useSpokenReplies";
import { useTheme } from "./hooks/useTheme";
import { createAppRouter } from "./router";

// Same isolation story as HomePage.test.tsx: HomePage calls these hooks
// directly and useBrokerChat opens a real WebSocket on mount.
vi.mock("./hooks/useBrokerChat");
vi.mock("./hooks/useSpokenReplies");
vi.mock("./hooks/usePushToTalk");
vi.mock("./hooks/useCliToolHealth");
vi.mock("./hooks/useTheme");

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

const ROSTER = [{ id: "ignacio", name: "Ignacio", role: "Builder", status: "busy" as const }];

function mockBrokerChat() {
  vi.mocked(useBrokerChat).mockReturnValue({
    messages: [],
    roster: ROSTER,
    identity: null,
    connected: true,
    audioMode: false,
    session: null,
    sessions: [],
    workspaces: [],
    lastBoardUpdate: null,
    lastCapabilityUpdate: null,
    send: vi.fn(),
    compose: vi.fn(),
    activity: vi.fn(async () => ({ busy: true, label: "compiling" })),
    removalPreview: vi.fn(),
    removeAgent: vi.fn(),
    workAction: vi.fn(async () => null),
    micControl: vi.fn(),
    micAudio: vi.fn(),
    createSession: vi.fn(),
    activateSession: vi.fn(),
    resetSetup: vi.fn(),
    listWorkspaceRecords: vi.fn(async () => []),
    saveWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    verifyWorkspaceAtlassian: vi.fn(),
    verifyRepoGithub: vi.fn(),
    getWorkspaceChannels: vi.fn(),
    saveWorkspaceChannels: vi.fn(),
    verifyWorkspaceDiscord: vi.fn(),
    getVoiceSettings: vi.fn(async () => ({ stt: null, tts: null, hideInactive: false })),
    saveVoiceSettings: vi.fn(),
    listConnectorVendors: vi.fn(async () => []),
    listMyConnectors: vi.fn(async () => []),
    addConnector: vi.fn(),
    updateConnector: vi.fn(),
    deleteConnector: vi.fn(),
    verifyConnector: vi.fn(),
    listCliTools: vi.fn(async () => []),
    refreshCliTools: vi.fn(),
    setCliToolEnabled: vi.fn(),
    listApiKeys: vi.fn(async () => []),
    saveApiKey: vi.fn(),
    verifyApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
  } as unknown as ReturnType<typeof useBrokerChat>);
}

async function renderAt(path: string) {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(<RouterProvider router={router} />);
  // The rail renders once the root layout is mounted.
  await screen.findByRole("navigation", { name: /tools/i });
  return router;
}

describe("stage routing", () => {
  beforeEach(() => {
    vi.mocked(useTheme).mockReturnValue({ theme: "dark", setTheme: vi.fn() });
    vi.mocked(useCliToolHealth).mockReturnValue({ warnings: {}, refresh: vi.fn() });
    vi.mocked(useSpokenReplies).mockReturnValue({
      soundOn: false,
      toggleSound: vi.fn(),
      playAudioFrame: vi.fn(),
      audioBlocked: false,
    });
    vi.mocked(usePushToTalk).mockReturnValue({ micLive: false, micError: null, toggleMic: vi.fn() });
    mockBrokerChat();
    // Board/Map/voice-status fetches all hit the broker; answer them all empty.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/agents")) return new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: false } }));
        if (url.endsWith("/work/boards")) return new Response(JSON.stringify({ boards: [] }));
        if (url.endsWith("/work/capabilities")) return new Response(JSON.stringify({ capabilities: [] }));
        if (url.endsWith("/workspaces")) return new Response(JSON.stringify({ workspaces: [] }));
        return new Response(JSON.stringify({}));
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the voice stage at / — no board main", async () => {
    await renderAt("/");
    expect(screen.queryByRole("main", { name: "Work boards" })).toBeNull();
  });

  it("board tool navigates to /board and highlights itself", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("button", { name: /^board$/i }));
    expect(await screen.findByRole("main", { name: "Work boards" })).toBeTruthy();
    expect(router.state.location.pathname).toBe("/board");
    expect(screen.getByRole("button", { name: /^board$/i }).getAttribute("aria-current")).toBe("true");
  });

  it("clicking the active board tool returns home", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("button", { name: /^board$/i }));
    await screen.findByRole("main", { name: "Work boards" });
    await userEvent.click(screen.getByRole("button", { name: /^board$/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByRole("main", { name: "Work boards" })).toBeNull();
  });

  it("browser back restores the previous stage", async () => {
    const router = await renderAt("/");
    await userEvent.click(screen.getByRole("button", { name: /^map$/i }));
    await screen.findByRole("main", { name: "Story map" });
    act(() => router.history.back());
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(screen.queryByRole("main", { name: "Story map" })).toBeNull();
  });

  it("logo navigates home from a stage", async () => {
    const router = await renderAt("/map");
    await screen.findByRole("main", { name: "Story map" });
    await userEvent.click(screen.getByRole("button", { name: /home/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("an unknown route redirects home", async () => {
    const router = await renderAt("/nonsense");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("an unknown agent id redirects home", async () => {
    const router = await renderAt("/work/ghost");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("a known roster agent renders the work stage", async () => {
    const router = await renderAt("/work/ignacio");
    await waitFor(() => expect(document.querySelector("main.work-stage")).toBeTruthy());
    expect(router.state.location.pathname).toBe("/work/ignacio");
  });
});
```

- [ ] **Step 2: Run the suite**

Run: `npx vitest run src/router.test.tsx`
Expected: all 8 PASS. These tests exercise code Task 5 already wrote — a failure here is a real bug in the routing wiring (fix the wiring, not the test), with one exception: if a `findByRole("main", …)` query can't see an accessible name, fall back to `document.querySelector('main.board-stage')`-style assertions and note it in the commit message.

- [ ] **Step 3: Commit**

```bash
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents add control-plane/src/router.test.tsx
git -C /Users/edwincruz/Development/Workspaces/jefelabs/smithagents commit -m "test(control-plane): navigation regression suite — rail, back button, redirects"
```

---

### Task 7: Final verification sweep

**Files:** none created — verification only (fix anything found, amend into a final commit).

- [ ] **Step 1: Full suite + static checks**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: all green.

- [ ] **Step 2: Dead-code sweep**

All of these must come back empty:

```bash
grep -n "mapOpen\|boardOpen\|inspecting" control-plane/src/pages/HomePage.tsx
grep -n "onClose\|\bopen\b" control-plane/src/organisms/BoardStage.tsx | grep -v openCard
grep -n "onClose\|\bopen\b" control-plane/src/organisms/MapStage.tsx
grep -A8 "^\.board-stage {" control-plane/src/styles/components.css | grep "position: fixed"
grep -A8 "^\.map-stage {" control-plane/src/styles/components.css | grep "position: fixed"
```

And the router-import boundary (only `router.tsx`, `App.tsx`, `HomePage.tsx`, and `*.test.tsx` may appear):

```bash
grep -rln "@tanstack/react-router" control-plane/src
```

- [ ] **Step 3: Visual smoke (needs Edwin or a browser)**

`npm run dev`, then: Board via rail (columns render inside the rails, Board highlighted, no X), Map via rail, logo → home, browser back/forward walks the stages, `#/work/<busy-agent-id>` shows the work view. Report results; if the broker isn't running the stages show their "is the broker running?" empty states — that's expected, not a failure.

- [ ] **Step 4: Report completion**

Summarize: routes live, X buttons gone, rail highlight truthful, back/forward works. Note any deviations from this plan.
