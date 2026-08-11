import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import * as api from "../api/broker";
import { BROKER_BASE } from "../api/broker";
import type { BlueprintT, ChatMessage, DocT, RosterAgent, SessionSummary } from "../api/types";
import { type AgentSeed, agentSeeds } from "../data/agents";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useSpokenReplies } from "../hooks/useSpokenReplies";
import { useTheme } from "../hooks/useTheme";
import { useVoiceStatus } from "../hooks/useVoiceStatus";
import { ALL_WORKSPACES } from "../lib/board-aggregate";
import { isKindSurface, kindForPath, layoutForPath } from "../lib/composerLayout";
import { makePickKind, openDocByFamily } from "../lib/pickKind";
import { AlertMenu } from "../molecules/AlertMenu";
import { ArtifactShelf, shelfDocsFor } from "../molecules/ArtifactShelf";
import { ConfirmSheet } from "../molecules/ConfirmSheet";
import { OperatorAvatar } from "../molecules/OperatorAvatar";
import { WorkspaceSelector } from "../molecules/WorkspaceSelector";
import { AddAgentModal } from "../organisms/AddAgentModal";
import { AgentRoster } from "../organisms/AgentRoster";
import { ChatDock } from "../organisms/ChatDock";
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
import { useBlueprints, useVoiceSettings } from "../queries/http";
import { qk } from "../queries/keys";
import { useDocuments, useRoster, useSession, useSessions, useTranscript, useWorkspaces } from "../queries/pushed";
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
const NO_MESSAGES: ChatMessage[] = [];
const NO_DOCS: DocT[] = [];
const NO_BLUEPRINTS: BlueprintT[] = [];

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
  const focusMode = useUiStore((s) => s.focusMode);
  const toggleFocus = useUiStore((s) => s.toggleFocus);
  const exitFocus = useUiStore((s) => s.exitFocus);
  const docTarget = useUiStore((s) => s.docTarget);
  const clearDocTarget = useUiStore((s) => s.clearDocTarget);
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

  // The persistent ChatDock lives in this shell now, so its mic/sound controls
  // read audioStore here rather than in a route. `audioBlocked` still drives the
  // page's own "click to enable sound" hint.
  const soundOn = useAudioStore((s) => s.soundOn);
  const audioBlocked = useAudioStore((s) => s.audioBlocked);
  const micLive = useAudioStore((s) => s.micLive);
  const toggleMic = useAudioStore((s) => s.toggleMic);
  const toggleSound = useAudioStore((s) => s.toggleSound);

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

  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // ---- the one persistent ChatDock, wired once and repositioned by route ----
  // These are the props VoiceStage/DocRoute used to wire each for themselves.
  const { data: messages = NO_MESSAGES } = useTranscript();
  const { data: docs = NO_DOCS } = useDocuments();
  const { data: blueprints = NO_BLUEPRINTS } = useBlueprints();
  const { voice } = useVoiceStatus();
  const { data: voicePrefs } = useVoiceSettings();
  const voiceNotice = useUiStore((s) => s.voiceNotice);
  const showVoiceBlockedNotice = useUiStore((s) => s.showVoiceBlockedNotice);
  // Hide the mic hero only on a CONFIRMED no-STT broker the user asked to hide.
  const hideMic = Boolean(voicePrefs?.hideInactive) && !voice.stt;
  // The one view-dependent override (spec v5): arriving on the dashboards
  // LAUNCHER mid-thread keeps the conversation beside the stage instead of
  // burying it under the ask screen's center box. Presented dashboards are
  // ordinary doc canvases now (/dashboard/$docId), so no board-view override
  // remains. The URL stays the variant's source of truth everywhere else.
  const dockVariant = pathname === "/dashboards" && messages.length > 0 ? "dock" : layoutForPath(pathname);
  const shelfDocs = shelfDocsFor(session, docs);

  // Focus collapses chrome via CSS alone — a body-level stamp so every
  // surface's selectors see it without prop-drilling through HeroUI wrappers.
  useEffect(() => {
    document.body.toggleAttribute("data-focus", focusMode);
    return () => document.body.removeAttribute("data-focus");
  }, [focusMode]);

  // The dock variant, stamped the same way: stages whose boundary depends on
  // the ACTUAL variant (dashboards — docked by board view OR a live thread)
  // key their width reservation off this rather than re-deriving the rule.
  useEffect(() => {
    document.body.setAttribute("data-dock", dockVariant);
    return () => document.body.removeAttribute("data-dock");
  }, [dockVariant]);

  useEffect(() => {
    if (!focusMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode, exitFocus]);

  // Picking another session backs out of an explicitly-opened composer (spec §3) — without
  // this, an explicit composer stays rendered with a possibly-stale locked workspace after
  // the activated session's frame lands.
  const onActivateSession = useCallback(
    (id: string) => {
      closeComposer();
      void api.activateSession(id);
      // Every session is a conversation; its documents are entered through
      // their own affordances (panel chips, the shelf), never by activation.
      void navigate({ to: "/" });
    },
    [closeComposer, navigate],
  );

  const agents = agentSeeds(roster, identity, engineWarnings);

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
          // one", same default BoardStage falls back to. Several workspaces, or
          // the ALL_WORKSPACES sentinel, is ambiguous — so the composer opens
          // unlocked instead of guessing.
          onNewSession={() =>
            openComposer(
              viewedWorkspaces !== ALL_WORKSPACES && viewedWorkspaces.size <= 1 ? session?.workspace : undefined,
            )
          }
          onSessions={toggleSessions}
          onSettings={() => setSettingsOpen(true)}
          showFocus={isKindSurface(pathname)}
          focusActive={focusMode}
          onToggleFocus={toggleFocus}
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
      chatDock={
        // The one chat box — mounted once, repositioned by route. Hidden on
        // board/work and while the session-birth screen owns the stage.
        dockVariant !== "hidden" && !composerVisible ? (
          <ChatDock
            variant={dockVariant}
            messages={messages}
            onSend={(text, target) => {
              // On a doc canvas the send IS an instruction about the page
              // (spec: dock-sends-edit-artifact); the aimed section rides
              // along when it matches the doc on screen, and one send spends
              // the aim.
              const docId = /^\/(?:doc|diagram|dashboard)\/([^/]+)$/.exec(pathname)?.[1];
              if (!docId) return api.postUtterance(text, target);
              const sectionId = docTarget?.docId === docId ? docTarget.sectionId : undefined;
              clearDocTarget();
              return api.postUtterance(text, target, { docId, ...(sectionId ? { sectionId } : {}) });
            }}
            docTarget={docTarget}
            onClearDocTarget={clearDocTarget}
            targets={roster}
            brokerConnected={connected}
            micLive={micLive}
            onMicToggle={toggleMic}
            soundOn={soundOn}
            onSoundToggle={toggleSound}
            sttEnabled={voice.stt}
            onVoiceBlocked={showVoiceBlockedNotice}
            showMicHero={!hideMic}
            voiceNotice={voiceNotice}
            onPolish={api.polishDraft}
            onPickKind={makePickKind(navigate, qc, blueprints)}
            activeKind={kindForPath(pathname)}
            shelf={
              dockVariant === "full" ? (
                <ArtifactShelf
                  docs={shelfDocs}
                  onOpen={(docId) => openDocByFamily(navigate, blueprints, docs, docId)}
                />
              ) : undefined
            }
          />
        ) : null
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
            activeWorkspace={session?.workspace}
            onClose={closeSessions}
            onActivate={onActivateSession}
            onOpenArtifact={(sessionId, docId) => {
              closeComposer();
              void api.activateSession(sessionId);
              void navigate({ to: "/doc/$docId", params: { docId } });
            }}
            onCreate={(ws) => {
              closeSessions();
              openComposer(ws || undefined);
            }}
            onManage={() => setWorkspacesOpen(true)}
            // No local list surgery: the broker broadcasts the sessions frame
            // after a delete, so the row leaves the same way it arrived.
            onDelete={(id) => api.deleteSession(id)}
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
