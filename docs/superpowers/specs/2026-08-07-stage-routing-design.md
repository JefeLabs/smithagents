# Stages become routes: Map, Board, and Work via TanStack Router

**Date:** 2026-08-07
**Status:** Approved by Edwin (TanStack Router, minimal adoption, all four stages routed).

## Problem

Map and Board act like full-screen modals instead of navigation. Both stages
escape the layout's stage slot with `position: fixed; inset: 0 72px`
(`components.css:2308`, `:2502`), each carries its own X close button, and
`HomePage` drives them with `mapOpen`/`boardOpen` booleans in a four-way
ternary (`HomePage.tsx:227-255`). The left `ToolRail` keeps a *local* `active`
index that is disconnected from what is actually shown — close a stage via its
X and the rail still highlights it (`ToolRail.tsx:29`).

**Decision:** stage-swapping surfaces become real routes behind
`@tanstack/react-router` (pinned) with `createHashHistory()` so the same code
runs in the Tauri webview and the browser. The router decides *which stage
renders* — nothing else.

## Route tree

`control-plane/src/router.tsx`, code-based (no file-based routing):

| Route              | Stage                          |
| ------------------ | ------------------------------ |
| `#/`               | Voice (home)                   |
| `#/board`          | Board                          |
| `#/map`            | Map                            |
| `#/work/$agentId`  | Work (inspect a busy agent)    |
| anything else      | redirect to `#/`               |

`App.tsx` renders `<RouterProvider router={router} />`.

## Architecture: HomePage is the root layout

`HomePage` becomes the root route's layout component. It keeps every hook it
owns today — most importantly the **single `useBrokerChat()` WebSocket** — and
renders `ControlPlaneLayout` with `stage={<Outlet />}`.

A `StageContext` (new: `src/hooks/StageContext.tsx`) carries the
stage-relevant slice to thin route components: `messages`, `roster`,
`lastBoardUpdate`, `lastCapabilityUpdate`, `send`, `activity`, `workAction`,
mic/voice state, and the voice-notice plumbing. Route components read the
context and render the existing organisms with plain props; **organisms stay
router-free**, so their tests need no router harness.

**Invariant: no route loaders, ever.** Data flows over the one live socket
owned above the router. Mounting `useBrokerChat` per-route would reconnect the
WebSocket on every navigation. Do not "modernize" toward TanStack loaders —
this app's data is connection-oriented, not request-oriented.

## Component changes

- **ToolRail** — the local `active` index is deleted. The layout passes the
  current route (`activeRoute`) and navigate callbacks; the rail stays
  router-free. The **logo becomes the Home affordance** (navigates `#/`).
  Clicking the already-active Board/Map tool also navigates home, preserving
  today's toggle behavior.
- **BoardStage / MapStage** — drop `open` and `onClose` props and the X
  buttons (`BoardStage.tsx:363`, `MapStage.tsx:477`). The `if (!open) return
  null` early-outs and `open`-keyed refetch effects become mount effects —
  routing in/out *is* open/close now. Delete the `position: fixed; inset: 0
  72px` blocks; the stages render inside `main`, which already reserves rail
  clearance.
- **WorkStage** — `AgentRoster.onInspect` navigates to `/work/$agentId`
  instead of `setInspecting`. The route component looks the agent up in the
  roster and **redirects home when the id is unknown** (stale URL, removed or
  archived agent). The back arrow navigates to `#/` — not `history.back()`,
  which could walk out of the app on a fresh session.
- **HomePage** — `mapOpen`, `boardOpen`, `inspecting` state dies; the stage
  ternary dies. Overlay state (`settingsOpen`, `sessionsOpen`, modals,
  `removing`) stays exactly where it is.
- **Settings, Sessions, workspace modals, ConfirmSheet** — stay
  overlays/state. They are genuinely modal; only stage-swapping surfaces
  become routes.

## Testing

- `BoardStage.test.tsx` / `MapStage.test.tsx`: shed the `open`-gate cases;
  everything else unchanged (props are otherwise identical).
- New navigation test (router with in-memory history): rail click swaps the
  stage, back button restores the previous stage, unknown `/work/$agentId`
  redirects home, rail highlight tracks the real route.
- `HomePage.test.tsx`: wrapped in a `RouterProvider`.
- `ToolRail.test.tsx`: updated for `activeRoute` prop instead of local state.

## Out of scope (deliberate)

- `#/board/$boardId` deep links — the active-board picker stays internal
  state in `BoardStage`; the route structure makes this a cheap follow-up.
- Routing Sessions/Settings.
- Browser-history (non-hash) mode for the web target.
