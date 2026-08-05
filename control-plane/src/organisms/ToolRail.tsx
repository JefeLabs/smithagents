import { GitBranch, LayoutGrid, PenLine, Search, Settings, SquareCheck } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import { Avatar } from "../atoms/Avatar";
import { Logo } from "../atoms/Logo";
import { ToolButton } from "../atoms/ToolButton";

const TOOLS = [
  { icon: PenLine, label: "New session" },
  { icon: Search, label: "Search" },
  { icon: SquareCheck, label: "Tasks and activity" },
  { icon: GitBranch, label: "Branches and pull requests" },
  { icon: LayoutGrid, label: "Apps" },
];

const OPERATOR_STYLE = {
  "--ring": "var(--rail-br)",
  background: "linear-gradient(135deg,#3a4358,#232a38)",
  fontSize: 14,
} as CSSProperties;

interface ToolRailProps {
  /** "New session" tool — opens the sessions panel. */
  onSessions?: () => void;
  /** Settings — the reset surface. */
  onSettings?: () => void;
  /** Operator avatar — opens the account panel. */
  onAccount?: () => void;
}

export function ToolRail({ onSessions, onSettings, onAccount }: ToolRailProps) {
  const [active, setActive] = useState(0);
  return (
    <nav className="rail rail--left" aria-label="Tools and activity">
      <div className="logo" title="smithagents">
        <Logo />
      </div>
      {TOOLS.map((tool, i) => (
        <ToolButton
          key={tool.label}
          icon={tool.icon}
          label={tool.label}
          active={i === active}
          onClick={() => {
            setActive(i);
            if (tool.label === "New session") onSessions?.();
          }}
        />
      ))}
      <div className="spacer" />
      <ToolButton icon={Settings} label="Settings" onClick={onSettings} />
      <Avatar initial="E" label="Edwin · operator" style={OPERATOR_STYLE} onClick={onAccount} />
    </nav>
  );
}
