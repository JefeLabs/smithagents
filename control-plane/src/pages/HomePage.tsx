import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import * as api from "../api/broker";
import { BROKER_BASE } from "../api/broker";
import type { RosterAgent, SessionSummary } from "../api/types";
import { type AgentSeed, agentSeeds } from "../data/agents";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useSpokenReplies } from "../hooks/useSpokenReplies";
import { useTheme } from "../hooks/useTheme";
import { ALL_WORKSPACES } from "../lib/board-aggregate";
import { AlertMenu } from "../molecules/AlertMenu";
import { ConfirmSheet } from "../molecules/ConfirmSheet";
import { OperatorAvatar } from "../molecules/OperatorAvatar";
import { WorkspaceSelector } from "../molecules/WorkspaceSelector";
import { AddAgentModal } from "../organisms/AddAgentModal";
import { AgentRoster } from "../organisms/AgentRoster";
import { DotGridCanvas } from "../organisms/DotGridCanvas";
import { DotGridTuner } from "../organisms/DotGridTuner";
import { Navbar } from "../organisms/Navbar";
import { NewSessionScreen } from "../organisms/NewSessionScreen";
import { NewWorkspaceModal } from "../organisms/NewWorkspaceModal";
import { SessionsPanel } from "../organisms/SessionsPanel";
import { SettingsPanel } from "../organisms/SettingsPanel";
import { ToolRail } from "../organisms/ToolRail";
import { WorkspaceManagerModal } from "../organisms/WorkspaceManagerModal";
import { useEngineWarnings } from "../queries/health";
import { qk } from "../queries/keys";
import { useRoster, useSession, useSessions, useWorkspaces } from "../queries/pushed";
import { hasNativeFolderPicker, pickFolder } from "../services/nativeDialog";
import { useAudioStore } from "../stores/audioStore";
import { useSocketStore } from "../stores/socketStore";
import { useUiStore } from "../stores/uiStore";
import { ControlPlaneLayout } from "../templates/ControlPlaneLayout";

// Stable empties for the pushed queries' "frame hasn't landed yet" state. A
// fresh `[]` per render would re-run every effect downstream that lists one of
// these in its deps.
const NO_ROSTER: RosterAgent[] = [];
const NO_SESSIONS: SessionSummary[] = [];
const NO_WORKSPACES: string[] = [];

export function HomePage() {
  // The broker socket is opened here, at app scope, and closed with the page.
  // The cleanup MUST disconnect: connect() short-circuits while already active,
  // so a second connect() with a different QueryClient would silently keep
  // writing frames into the first one.
  const qc = useQueryClient();
  const connect = useSocketStore((s) => s.connect);
  const disconnect = useSocketStore((s) => s.disconnect);
  useEffect(() => {
    connect(qc);
    return () => disconnect();
  }, [qc, connect, disconnect]);

  const connected = useSocketStore((s) => s.connected);
  const micControl = useSocketStore((s) => s.micControl);
  const micAudio = useSocketStore((s) => s.micAudio);

  const { data: session = null, status: sessionStatus } = useSession();
  const { data: sessions = NO_SESSIONS } = useSessions();
  const { data: workspaces = NO_WORKSPACES } = useWorkspaces();
  const { data: rosterFrame } = useRoster();
  const roster = rosterFrame?.agents ?? NO_ROSTER;
  const identity = rosterFrame?.identity ?? null;

  // One field per selector, never the whole store: a whole-store selection
  // re-renders this page on every unrelated UI change.
  const modalOpen = useUiStore((s) => s.modalOpen);
  const editingId = useUiStore((s) => s.editingId);
  const tunerOpen = useUiStore((s) => s.tunerOpen);
  const gridParams = useUiStore((s) => s.gridParams);
  const sessionsOpen = useUiStore((s) => s.sessionsOpen);
  const composer = useUiStore((s) => s.composer);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const workspacesOpen = useUiStore((s) => s.workspacesOpen);
  const newWorkspaceOpen = useUiStore((s) => s.newWorkspaceOpen);
  const removing = useUiStore((s) => s.removing);
  const openAddAgent = useUiStore((s) => s.openAddAgent);
  const openEditAgent = useUiStore((s) => s.openEditAgent);
  const closeAgentModal = useUiStore((s) => s.closeAgentModal);
  const toggleTuner = useUiStore((s) => s.toggleTuner);
  const setGridParam = useUiStore((s) => s.setGridParam);
  const resetGrid = useUiStore((s) => s.resetGrid);
  const toggleSessions = useUiStore((s) => s.toggleSessions);
  const closeSessions = useUiStore((s) => s.closeSessions);
  const openComposer = useUiStore((s) => s.openComposer);
  const closeComposer = useUiStore((s) => s.closeComposer);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setWorkspacesOpen = useUiStore((s) => s.setWorkspacesOpen);
  const setNewWorkspaceOpen = useUiStore((s) => s.setNewWorkspaceOpen);
  const setRemoving = useUiStore((s) => s.setRemoving);
  const viewedWorkspaces = useUiStore((s) => s.viewedWorkspaces);

  // The audio hint is the page's only read of audio state — the mic and mute
  // controls themselves live in the voice route and read the store there.
  const soundOn = useAudioStore((s) => s.soundOn);
  const audioBlocked = useAudioStore((s) => s.audioBlocked);

  const { theme, setTheme } = useTheme();
  // Both mounted here, at app scope, and deliberately not below the router:
  // usePushToTalk holds a live MediaStream in refs (navigating with a hot mic
  // would orphan it), and useSpokenReplies must keep voicing broker replies on
  // every stage, not only /voice. Each reads its own data and publishes what
  // routes need through audioStore, so neither returns anything used here.
  useSpokenReplies();
  usePushToTalk({
    begin: () => micControl("mic-start"),
    audio: micAudio,
    end: () => micControl("mic-stop"),
  });
  const engineWarnings = useEngineWarnings();

  // Both the engine badges and the voice gate read `GET /agents`; one
  // invalidation refreshes them together. `/cli-tools` is the other half of
  // the badge join, and a key added in Settings can change either.
  const refreshMachineState = useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.agentRecords });
    void qc.invalidateQueries({ queryKey: qk.cliTools });
  }, [qc]);

  // A broker that has CONFIRMED zero sessions forces the composer open. "Not heard from yet"
  // must not: the session query stays `pending` until the first frame lands, and on every fresh
  // connect there is a beat where `connected` is already true. Reading `status` rather than
  // `data === null` is what keeps the composer from flashing open on each load.
  const knownZeroSessions = sessionStatus === "success" && session === null;
  const composerVisible = composer !== null || (connected && knownZeroSessions);

  // Picking another session backs out of an explicitly-opened composer (spec §3) — without
  // this, an explicit composer stays rendered with a possibly-stale locked workspace after
  // the activated session's frame lands.
  const onActivateSession = useCallback(
    (id: string) => {
      closeComposer();
      void api.activateSession(id);
    },
    [closeComposer],
  );

  const agents = agentSeeds(roster, identity, engineWarnings);

  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const callOn = (name: string) => void api.postUtterance(`Go ahead, ${name} — you have the floor.`);

  // A rejected fetch (broker down) and a resolved-but-{error} response (unknown agent,
  // swarm busy-lock) both need to surface — neither can leave the sheet silently stuck.
  const requestRemoval = async (entry: AgentSeed) => {
    const preview = await api
      .getRemovalPreview(entry.id)
      .catch((err: unknown): { outcome?: "delete" | "archive"; reasons?: string[]; error?: string } => ({
        error: String(err),
      }));
    setRemoving({ entry, outcome: preview.outcome, reasons: preview.reasons ?? [], error: preview.error });
  };

  const confirmRemoval = async () => {
    if (!removing?.outcome) return; // preview never resolved to a real outcome — nothing to confirm
    setRemoving((r) => (r ? { ...r, busy: true, error: undefined } : r));
    const result = await api.deleteAgent(removing.entry.id).catch((err: unknown): { error?: string } => ({
      error: String(err),
    }));
    if (result.error) {
      setRemoving((r) => (r ? { ...r, busy: false, error: result.error } : r));
      return;
    }
    setRemoving(null); // roster frame refresh arrives over WS
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "g" && !/input|textarea/i.test((e.target as HTMLElement).tagName)) toggleTuner();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [toggleTuner]);

  return (
    <ControlPlaneLayout
      topBar={
        <Navbar
          onHome={() => void navigate({ to: "/" })}
          workspaceSlot={<WorkspaceSelector />}
          alertSlot={<AlertMenu onNavigate={(t) => void navigate({ to: t })} />}
          avatarSlot={<OperatorAvatar />}
        />
      }
      background={<DotGridCanvas params={gridParams} />}
      leftRail={
        <ToolRail
          activeRoute={pathname}
          // Locks to the workspace already on screen (same rule SessionsPanel's
          // "new session" row uses) only while exactly one is in view — an
          // untouched `viewedWorkspaces` (size 0) still means "just the active
          // one", same default BoardStage falls back to. Several or "*" is
          // ambiguous, so the composer opens unlocked instead of guessing.
          onNewSession={() =>
            openComposer(
              viewedWorkspaces !== ALL_WORKSPACES && viewedWorkspaces.size <= 1 ? session?.workspace : undefined,
            )
          }
          onSessions={toggleSessions}
          onSettings={() => setSettingsOpen(true)}
        />
      }
      rightRail={
        <AgentRoster
          onEdit={(entry) => openEditAgent(entry.id)}
          agents={agents}
          onAdd={openAddAgent} // the + button always creates: openAddAgent clears editingId
          onCall={callOn}
          onCompose={(op) => void api.postCompose(op)}
          onInspect={(entry) => void navigate({ to: "/work/$agentId", params: { agentId: entry.id } })}
          onRemove={requestRemoval}
        />
      }
      stage={
        composerVisible ? (
          <NewSessionScreen
            lockedWorkspace={composer?.locked}
            forced={knownZeroSessions}
            onSend={async (ws, mode, prompt) => {
              const r = await api.postSession(BROKER_BASE, ws, mode, prompt);
              if (r.error) {
                // A mode that vanished since the probe is exactly what a 409 reports —
                // drop the cached answer so the picker re-reads it.
                if (r.status === 409) void qc.invalidateQueries({ queryKey: qk.executionModes });
                return r;
              }
              closeComposer();
              // Land in the conversation you just started. The broker has already
              // made the new session active (SessionManager.create sets activeId)
              // and replayed the prompt as an utterance, so the turn is in flight
              // before this navigation resolves — without it we would fall through
              // to whatever stage happened to be routed, and the reply would arrive
              // on a screen the user isn't looking at.
              void navigate({ to: "/" });
              return undefined;
            }}
            onCancel={closeComposer}
          />
        ) : (
          <Outlet />
        )
      }
      overlays={
        <>
          {audioBlocked && soundOn && (
            <div className="audio-blocked-hint">audio is blocked — click anywhere to enable sound</div>
          )}
          <ConfirmSheet
            open={removing !== null}
            title={`Remove ${removing?.entry.name}?`}
            body={
              removing?.outcome === "delete"
                ? `${removing.entry.name} has never worked or spoken — this removes them permanently.`
                : removing?.outcome === "archive"
                  ? `${removing.entry.name} has history (${removing.reasons.join(", ")}) — they will be archived.`
                  : `Could not check what happens to ${removing?.entry.name} yet.`
            }
            confirmLabel={
              removing?.outcome === "delete" ? "delete" : removing?.outcome === "archive" ? "archive" : undefined
            }
            error={removing?.error}
            busy={removing?.busy}
            onConfirm={() => void confirmRemoval()}
            onCancel={() => setRemoving(null)}
          />
          <SettingsPanel
            open={settingsOpen}
            onClose={() => {
              setSettingsOpen(false);
              refreshMachineState();
              void qc.invalidateQueries({ queryKey: qk.voiceSettings });
            }}
            onReset={api.resetSetup}
            theme={theme}
            onThemeChange={setTheme}
          />
          <SessionsPanel
            open={sessionsOpen}
            sessions={sessions}
            workspaces={workspaces}
            onClose={closeSessions}
            onActivate={onActivateSession}
            onCreate={(ws) => {
              closeSessions();
              openComposer(ws || undefined);
            }}
            onManage={() => setWorkspacesOpen(true)}
          />
          <WorkspaceManagerModal
            open={workspacesOpen}
            onClose={() => setWorkspacesOpen(false)}
            list={api.getWorkspaceRecords}
            save={api.saveWorkspace}
            remove={api.removeWorkspace}
            verifyAtlassian={api.verifyWorkspaceAtlassian}
            verifyRepoGithub={api.verifyRepoGithub}
            listMyConnectors={api.getMyConnectors}
          />
          <NewWorkspaceModal
            open={newWorkspaceOpen}
            onClose={() => setNewWorkspaceOpen(false)}
            save={api.saveWorkspace}
            listMyConnectors={api.getMyConnectors}
            activeWorkspace={session?.workspace}
            pickFolder={hasNativeFolderPicker() ? pickFolder : undefined}
            onCreated={(name) => openComposer(name)}
          />
          <DotGridTuner open={tunerOpen} params={gridParams} onChange={setGridParam} onReset={resetGrid} />
          <AddAgentModal
            open={modalOpen}
            editingId={editingId ?? undefined}
            onClose={() => {
              closeAgentModal();
              refreshMachineState();
            }}
            onCreated={(n) => {
              if (!editingId) void api.postUtterance(`${n} just joined the crew — welcome them in one short line.`);
            }}
          />
        </>
      }
    />
  );
}
