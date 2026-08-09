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
    <nav className="sm-navbar" aria-label="Workspace and account">
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
