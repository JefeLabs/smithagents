import { Sidebar } from "@heroui-pro/react";
import { useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

interface ControlPlaneLayoutProps {
  topBar?: ReactNode;
  background: ReactNode;
  leftRail: ReactNode;
  rightRail: ReactNode;
  stage: ReactNode;
  hint?: ReactNode;
  overlays?: ReactNode;
}

/**
 * `topBar` is fixed chrome that renders outside the Sidebar.Provider, first in the DOM
 * so keyboard focus reaches it before the canvas underlay and the rails.
 *
 * `background` renders next, still a sibling of the Provider rather than nested inside
 * it. `position: fixed` elements paint according to DOM tree order within their
 * stacking context, not viewport math alone — nesting the canvas under `Sidebar.Main`
 * (itself a sibling *after* `<Sidebar>`) put it later in tree order than the rail,
 * which put it visually and interactively *on top of* the rail: every click on a
 * sidebar row silently hit the canvas instead. Rendering it before the Provider keeps
 * it painted beneath everything, exactly as the old fixed-position layout did.
 *
 * `leftRail` takes real width in flow now — it composes the `<Sidebar>` element itself
 * (see ToolRail), and this template owns the `Sidebar.Provider` that wraps it because
 * the Provider is the thing that needs the router: `navigate` here is what turns a
 * `Sidebar.MenuItem href` into an actual route change.
 *
 * `hint` and `overlays` render OUTSIDE the Provider too, for a reason that bit hard:
 * `position: fixed` — which `Sidebar.Provider` now carries — always opens its own
 * stacking context, even at `z-index: auto`. Everything inside it, no matter how high
 * an overlay's own z-index climbs (SettingsPanel's full-screen shell is 200), is
 * compared against `.sm-navbar` as a *single unit* at that auto/0 level — and loses to the
 * navbar's z-index: 4 every time. Nested there, the Settings screen rendered on top
 * visually but the navbar silently ate every click in its own 56px band. Rendering
 * `overlays` as a sibling of the Provider (like `topBar` and `background`) puts them
 * back in the same stacking context as the navbar, where z-index actually means what
 * it says. `rightRail` and `stage` stay inside — nothing outside the Provider needs to
 * out-stack *them* specifically, only the navbar's own small footprint mattered here.
 */
export function ControlPlaneLayout({
  topBar,
  background,
  leftRail,
  rightRail,
  stage,
  hint,
  overlays,
}: ControlPlaneLayoutProps) {
  const router = useRouter();
  return (
    <>
      {topBar}
      {background}
      {/* toggleShortcut={false} turns OFF HeroUI's default "mod+b". Nobody chose that
          binding, and it does more than it looks: it preventDefault()s Cmd/Ctrl+B with no
          input-element guard, expands the rail to 240px, and persists that in a
          `sidebar_state` cookie, so one stray keypress survives reload. `.sessions-panel`
          is hardcoded `left: 56px` on the premise of a collapsed 48px rail — true until
          the shortcut fires, then permanently false, with the panel painting over 184px of
          expanded rail. An expandable rail is a real feature worth having; it just needs
          the panel offset to track `--sidebar-width`, which is a later phase's work. Until
          then it should not arrive by accident through a library default. */}
      <Sidebar.Provider
        defaultOpen={false}
        collapsible="icon"
        toggleShortcut={false}
        navigate={(href) => void router.navigate({ to: href })}
      >
        {leftRail}
        <Sidebar.Main>
          {/* rightRail (AgentRoster) is still position: fixed and untouched CSS-wise, but its
              containment changed: it's no longer a root-level sibling, it's nested inside
              Sidebar.Provider's stacking context. Nothing breaks today (checked the z-index
              math), but HeroUI Phase 2 — which migrates this rail and retires the last
              dnd-kit usage — should know that before it starts. */}
          {rightRail}
          {stage}
        </Sidebar.Main>
      </Sidebar.Provider>
      {hint != null && <div className="subhint">{hint}</div>}
      {overlays}
    </>
  );
}
