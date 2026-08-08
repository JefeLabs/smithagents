import { useQueryClient } from "@tanstack/react-query";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import * as api from "../api/broker";
import { BROKER_BASE } from "../api/broker";
import type { AudioFrame, ChatMessage, RosterAgent, SessionSummary } from "../api/types";
import { type AgentSeed, agentSeeds } from "../data/agents";
import { type StageContextValue, StageProvider } from "../hooks/StageContext";
import { useCliToolHealth } from "../hooks/useCliToolHealth";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useSpokenReplies } from "../hooks/useSpokenReplies";
import { useTheme } from "../hooks/useTheme";
import { useVoiceStatus } from "../hooks/useVoiceStatus";
import { ConfirmSheet } from "../molecules/ConfirmSheet";
import { AddAgentModal } from "../organisms/AddAgentModal";
import { AgentRoster } from "../organisms/AgentRoster";
import { DotGridCanvas } from "../organisms/DotGridCanvas";
import { DotGridTuner } from "../organisms/DotGridTuner";
import { NewSessionScreen } from "../organisms/NewSessionScreen";
import { NewWorkspaceModal } from "../organisms/NewWorkspaceModal";
import { SessionsPanel } from "../organisms/SessionsPanel";
import { SettingsPanel } from "../organisms/SettingsPanel";
import { ToolRail } from "../organisms/ToolRail";
import { WorkspaceManagerModal } from "../organisms/WorkspaceManagerModal";
import { useExecutionModes, useVoiceSettings, useWorkspaceRecords } from "../queries/http";
import { qk } from "../queries/keys";
import { useRoster, useSession, useSessions, useTranscript, useWorkspaces } from "../queries/pushed";
import { hasNativeFolderPicker, pickFolder } from "../services/nativeDialog";
import { useSocketStore } from "../stores/socketStore";
import { useUiStore } from "../stores/uiStore";
import { ControlPlaneLayout } from "../templates/ControlPlaneLayout";

// Stable empties for the pushed queries' "frame hasn't landed yet" state. A
// fresh `[]` per render would re-run every effect downstream that lists one of
// these in its deps (useSpokenReplies' transcript pass, chiefly).
const NO_MESSAGES: ChatMessage[] = [];
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
  // True when the BROKER is producing the audio itself; the browser's Web
  // Speech fallback must stay off in that case or every reply is spoken twice.
  const audioMode = useSocketStore((s) => s.audioMode);
  const micControl = useSocketStore((s) => s.micControl);
  const micAudio = useSocketStore((s) => s.micAudio);
  const onAudioFrame = useSocketStore((s) => s.onAudioFrame);

  const { data: session = null, status: sessionStatus } = useSession();
  const { data: sessions = NO_SESSIONS } = useSessions();
  const { data: workspaces = NO_WORKSPACES } = useWorkspaces();
  const { data: messages = NO_MESSAGES } = useTranscript();
  const { data: rosterFrame } = useRoster();
  const roster = rosterFrame?.agents ?? NO_ROSTER;
  const identity = rosterFrame?.identity ?? null;
  const { data: modes } = useExecutionModes();
  const { data: wsRecords } = useWorkspaceRecords();

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
  const setVoiceNotice = useUiStore((s) => s.setVoiceNotice);

  const { theme, setTheme } = useTheme();
  // The audio sink is a ref so the frame subscription below can be declared
  // before useSpokenReplies (which produces the player) without a cycle.
  const audioSink = useRef<(frame: AudioFrame) => void>(() => {});
  const { soundOn, toggleSound, playAudioFrame, audioBlocked } = useSpokenReplies(messages, roster, !audioMode);
  audioSink.current = (frame) => void playAudioFrame(frame);
  // Audio frames are a stream, not cached state — the socket store fans them
  // out to subscribers. Subscribing through the ref keeps this effect off
  // playAudioFrame's identity, which changes on every render.
  useEffect(() => onAudioFrame((frame) => audioSink.current(frame)), [onAudioFrame]);

  const { micLive, toggleMic } = usePushToTalk({
    begin: () => micControl("mic-start"),
    audio: micAudio,
    end: () => micControl("mic-stop"),
  });
  const { warnings: engineWarnings, refresh: refreshEngineWarnings } = useCliToolHealth();

  const { voice, refresh: refreshVoiceStatus } = useVoiceStatus();
  // Fetched on mount and invalidated when Settings closes — hideInactive may
  // have changed while the panel was open.
  const { data: voicePrefs } = useVoiceSettings();
  const hideMic = Boolean(voicePrefs?.hideInactive) && !voice.stt;

  // A ref (not state) for the pending dismiss timer: rapid presses must restart the 6s window
  // rather than letting an earlier press's timer cut the latest notice short.
  const voiceNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (voiceNoticeTimer.current) clearTimeout(voiceNoticeTimer.current);
    },
    [],
  );
  const onVoiceBlocked = useCallback(() => {
    setVoiceNotice("Add a Deepgram key in Settings → Integrations, then select it under Settings → Voice.");
    if (voiceNoticeTimer.current) clearTimeout(voiceNoticeTimer.current);
    voiceNoticeTimer.current = setTimeout(() => setVoiceNotice(null), 6000);
  }, [setVoiceNotice]);

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

  const stageValue: StageContextValue = {
    micLive,
    onMicToggle: () => void toggleMic(),
    soundOn,
    onSoundToggle: toggleSound,
    sttEnabled: voice.stt,
    showMicHero: !hideMic,
    onVoiceBlocked,
  };

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
    <StageProvider value={stageValue}>
      <ControlPlaneLayout
        background={<DotGridCanvas params={gridParams} />}
        leftRail={
          <ToolRail
            activeRoute={pathname}
            onHome={() => void navigate({ to: "/" })}
            onNewWorkspace={() => setNewWorkspaceOpen(true)}
            onSessions={toggleSessions}
            onBoard={() => void navigate({ to: "/board" })}
            onMap={() => void navigate({ to: "/map" })}
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
              workspaces={workspaces}
              records={wsRecords ?? null}
              sessions={sessions}
              modes={modes ?? null}
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
                void refreshEngineWarnings();
                refreshVoiceStatus();
                void qc.invalidateQueries({ queryKey: qk.voiceSettings });
              }}
              onReset={api.resetSetup}
              theme={theme}
              onThemeChange={setTheme}
              listConnectorVendors={api.getConnectorVendors}
              listMyConnectors={api.getMyConnectors}
              getVoiceSettings={api.getVoiceSettings}
              saveVoiceSettings={api.saveVoiceSettings}
              addConnector={api.addConnector}
              updateConnector={api.updateConnector}
              deleteConnector={api.deleteConnector}
              verifyConnector={api.verifyConnector}
              listCliTools={api.getCliTools}
              refreshCliTools={api.refreshCliTools}
              setCliToolEnabled={api.setCliToolEnabled}
              listApiKeys={api.getApiKeys}
              saveApiKey={api.saveApiKey}
              verifyApiKey={api.verifyApiKey}
              deleteApiKey={api.deleteApiKey}
              listWorkspaceRecords={api.getWorkspaceRecords}
              getWorkspaceChannels={api.getWorkspaceChannels}
              saveWorkspaceChannels={api.saveWorkspaceChannels}
              verifyWorkspaceDiscord={api.verifyWorkspaceDiscord}
              getContainers={api.getContainers}
              setDockerEnabled={api.setDockerEnabled}
              verifyContainers={api.verifyContainers}
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
                void refreshEngineWarnings();
              }}
              onCreated={(n) => {
                if (!editingId) void api.postUtterance(`${n} just joined the crew — welcome them in one short line.`);
              }}
            />
          </>
        }
      />
    </StageProvider>
  );
}
