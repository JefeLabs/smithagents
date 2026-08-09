import { Label, ListBox, Select, Separator } from "@heroui/react";
import * as api from "../api/broker";
import { useSession, useSessions, useWorkspaces } from "../queries/pushed";
import { useUiStore } from "../stores/uiStore";

const NO_SESSIONS: never[] = [];
const NO_WORKSPACES: never[] = [];

// "New workspace…" is a COMMAND in the list, not a workspace. It is sentinel-keyed
// rather than matched on its rendered label so a workspace literally named "New
// workspace" can never shadow it — the same class of bug the colour picker's
// transparent sentinel avoids.
const NEW_WORKSPACE = "__new-workspace__";

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
  const setNewWorkspaceOpen = useUiStore((s) => s.setNewWorkspaceOpen);

  const current = session?.workspace ?? null;

  const select = (name: string) => {
    if (name === NEW_WORKSPACE) {
      setNewWorkspaceOpen(true);
      return; // never falls through to session activation
    }
    // Re-activating the current session would reload brain history and
    // re-broadcast a frame for no gain.
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

  return (
    <Select
      className="workspace-selector min-w-36"
      variant="secondary"
      value={current}
      onChange={(key) => {
        if (key != null) select(String(key));
      }}
    >
      <Label className="sr-only">Workspace</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {workspaces.map((ws) => (
            <ListBox.Item key={ws} id={ws} textValue={ws}>
              {ws}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
          <Separator />
          <ListBox.Item id={NEW_WORKSPACE} textValue="New workspace…">
            New workspace…
          </ListBox.Item>
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
