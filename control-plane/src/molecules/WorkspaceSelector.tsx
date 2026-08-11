import { Label, ListBox, Select, Separator } from "@heroui/react";
import * as api from "../api/broker";
import type { GroupT } from "../api/types";
import { useGroups, useSession, useSessions, useWorkspaces } from "../queries/pushed";
import { useUiStore } from "../stores/uiStore";

const NO_SESSIONS: never[] = [];
const NO_WORKSPACES: never[] = [];
const NO_GROUPS: GroupT[] = [];

// "New workspace…" is a COMMAND in the list, not a workspace. It is sentinel-keyed
// rather than matched on its rendered label so a workspace literally named "New
// workspace" can never shadow it — the same class of bug the colour picker's
// transparent sentinel avoids.
const NEW_WORKSPACE = "__new-workspace__";
const NEW_GROUP = "__new-group__";
// Group options are keyed disjointly from workspace names for the same reason:
// a workspace and a group may share a name without shadowing each other.
const GROUP_PREFIX = "__group__:";

/**
 * The app's one workspace control.
 *
 * It holds NO workspace state. The displayed workspace is the active session's,
 * straight off the session frame — the broker already treats that as
 * authoritative and dispatches work against it (`broker/src/main.ts:288-298`).
 * Selecting therefore cannot mean "set a variable"; it means "activate a session
 * there", and the frame that comes back moves every surface at once.
 *
 * GROUPS are the exception (spec 2026-08-11-workspace-groups): picking one
 * applies a view LENS — Board/Map filter to its member workspaces via
 * `viewedWorkspaces` and the trigger shows the group name — while the active
 * session stays put. Picking any workspace clears the lens.
 */
export function WorkspaceSelector() {
  const { data: session } = useSession();
  const { data: sessions = NO_SESSIONS } = useSessions();
  const { data: workspaces = NO_WORKSPACES } = useWorkspaces();
  const { data: groups = NO_GROUPS } = useGroups();
  const openComposer = useUiStore((s) => s.openComposer);
  const setNewWorkspaceOpen = useUiStore((s) => s.setNewWorkspaceOpen);
  const setWorkspacesOpen = useUiStore((s) => s.setWorkspacesOpen);
  const activeLens = useUiStore((s) => s.activeLens);
  const setLens = useUiStore((s) => s.setLens);
  const clearLens = useUiStore((s) => s.clearLens);

  const current = session?.workspace ?? null;

  const select = (name: string) => {
    if (name === NEW_WORKSPACE) {
      setNewWorkspaceOpen(true);
      return; // never falls through to session activation
    }
    if (name === NEW_GROUP) {
      setWorkspacesOpen(true); // groups are managed in the workspace manager
      return;
    }
    if (name.startsWith(GROUP_PREFIX)) {
      const group = groups.find((g) => g.name === name.slice(GROUP_PREFIX.length));
      if (group) setLens(group.name, group.expansion);
      return; // a lens, not a session move
    }
    // A workspace pick always drops the lens — you are navigating somewhere
    // specific now. Guarded so a manual Board multi-select survives ordinary
    // workspace switching when no lens is on.
    if (activeLens) clearLens();
    // No guard for "already selected" is needed here: <Select> is controlled
    // (`value={...}`), and react-stately's useControlledState only fires
    // onChange when the value actually changes (verified against its source —
    // it diffs with Object.is before calling onChange at all) — so `select()`
    // never runs with `name === current` unless a lens is displayed. The
    // lens-active case CAN re-select the current workspace, which is exactly
    // the "clear the lens, stay put" gesture and activates the newest session
    // there like any other pick.
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
      value={activeLens ? GROUP_PREFIX + activeLens.group : current}
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
          {groups.length > 0 && (
            <>
              {groups.map((g) => (
                <ListBox.Item key={GROUP_PREFIX + g.name} id={GROUP_PREFIX + g.name} textValue={g.name}>
                  {g.name}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
              <Separator />
            </>
          )}
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
          <ListBox.Item id={NEW_GROUP} textValue="New group…">
            New group…
          </ListBox.Item>
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
