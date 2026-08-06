import { PenLine, Settings } from "lucide-react";
import { useState } from "react";
import { Logo } from "../atoms/Logo";
import { ToolButton } from "../atoms/ToolButton";

const TOOLS = [{ icon: PenLine, label: "New session" }];

interface ToolRailProps {
  /** "New session" tool — opens the sessions panel. */
  onSessions?: () => void;
  /** Settings — the reset surface. */
  onSettings?: () => void;
}

// No operator avatar: there's no "account" concept in an all-local, single-operator
// app — reintroduce it when cloud hosting makes identity meaningful.
export function ToolRail({ onSessions, onSettings }: ToolRailProps) {
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
    </nav>
  );
}
