import { Sidebar } from "@heroui-pro/react";
import { History, Map as MapIcon, Plus, Settings, SquareKanban } from "lucide-react";

interface ToolRailProps {
  /** Current stage route ("/", "/board", "/map", "/work/<id>") — drives the highlight. */
  activeRoute?: string;
  /** "New session" tool — opens the composer (design §5; workspace *creation* lives in the navbar now). */
  onNewSession?: () => void;
  /** "Sessions" tool — toggles the sessions panel. */
  onSessions?: () => void;
  /** Settings — the reset surface. */
  onSettings?: () => void;
}

// The operator avatar lives in the Navbar (src/molecules/OperatorAvatar.tsx),
// gated on CLOUD_MODE. The rail is tools only.
//
// Board and Map navigate via `href` + the ancestor Sidebar.Provider's `navigate`
// callback (wired in ControlPlaneLayout) rather than an onClick prop here — that is
// also what drives `isCurrent`'s highlight, so there is one source of truth for
// "where does this item go" instead of two.
export function ToolRail({ activeRoute = "/", onNewSession, onSessions, onSettings }: ToolRailProps) {
  return (
    <Sidebar>
      {/* No Sidebar.Header — the logo lives in the navbar now. */}
      <Sidebar.Content>
        <Sidebar.Menu aria-label="Tools and activity">
          <Sidebar.MenuItem onAction={onNewSession}>
            <Sidebar.MenuIcon>
              <Plus />
            </Sidebar.MenuIcon>
            <Sidebar.MenuItemContent>
              <Sidebar.MenuLabel>New session</Sidebar.MenuLabel>
            </Sidebar.MenuItemContent>
          </Sidebar.MenuItem>
          <Sidebar.MenuItem onAction={onSessions}>
            <Sidebar.MenuIcon>
              <History />
            </Sidebar.MenuIcon>
            <Sidebar.MenuItemContent>
              <Sidebar.MenuLabel>Sessions</Sidebar.MenuLabel>
            </Sidebar.MenuItemContent>
          </Sidebar.MenuItem>
          <Sidebar.MenuItem href="/board" isCurrent={activeRoute === "/board"}>
            <Sidebar.MenuIcon>
              <SquareKanban />
            </Sidebar.MenuIcon>
            <Sidebar.MenuItemContent>
              <Sidebar.MenuLabel>Board</Sidebar.MenuLabel>
            </Sidebar.MenuItemContent>
          </Sidebar.MenuItem>
          <Sidebar.MenuItem href="/map" isCurrent={activeRoute === "/map"}>
            <Sidebar.MenuIcon>
              <MapIcon />
            </Sidebar.MenuIcon>
            <Sidebar.MenuItemContent>
              <Sidebar.MenuLabel>Map</Sidebar.MenuLabel>
            </Sidebar.MenuItemContent>
          </Sidebar.MenuItem>
        </Sidebar.Menu>
      </Sidebar.Content>
      <Sidebar.Footer>
        <Sidebar.Menu aria-label="Settings">
          <Sidebar.MenuItem onAction={onSettings}>
            <Sidebar.MenuIcon>
              <Settings />
            </Sidebar.MenuIcon>
            <Sidebar.MenuItemContent>
              <Sidebar.MenuLabel>Settings</Sidebar.MenuLabel>
            </Sidebar.MenuItemContent>
          </Sidebar.MenuItem>
        </Sidebar.Menu>
      </Sidebar.Footer>
    </Sidebar>
  );
}
