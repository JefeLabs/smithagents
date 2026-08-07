import { History, Map as MapIcon, Plus, Settings, SquareKanban } from "lucide-react";
import { useState } from "react";
import { Logo } from "../atoms/Logo";
import { ToolButton } from "../atoms/ToolButton";

const TOOLS = [
  { icon: Plus, label: "New workspace" },
  { icon: History, label: "Sessions" },
  { icon: SquareKanban, label: "Board" },
  { icon: MapIcon, label: "Map" },
];

interface ToolRailProps {
  /** "New workspace" tool — opens the create-workspace flow directly (design §5). */
  onNewWorkspace?: () => void;
  /** "Sessions" tool — toggles the sessions panel. */
  onSessions?: () => void;
  /** "Board" tool — toggles the kanban board stage. */
  onBoard?: () => void;
  /** "Map" tool — toggles the story map stage. */
  onMap?: () => void;
  /** Settings — the reset surface. */
  onSettings?: () => void;
}

// No operator avatar: there's no "account" concept in an all-local, single-operator
// app — reintroduce it when cloud hosting makes identity meaningful.
export function ToolRail({ onNewWorkspace, onSessions, onBoard, onMap, onSettings }: ToolRailProps) {
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
