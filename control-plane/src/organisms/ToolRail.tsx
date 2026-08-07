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
