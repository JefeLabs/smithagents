import { useEffect, useRef, useState } from "react";
import { type AgentSeed, hostSeed, ringForIndex } from "../data/agents";
import { type AudioFrame, useBrokerChat, type VoiceSettingsRecord } from "../hooks/useBrokerChat";
import { useCliToolHealth } from "../hooks/useCliToolHealth";
import { GRID_DEFAULTS, type GridParams } from "../hooks/useDotGrid";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useSpokenReplies } from "../hooks/useSpokenReplies";
import { useTheme } from "../hooks/useTheme";
import { useVoiceStatus } from "../hooks/useVoiceStatus";
import { ConfirmSheet } from "../molecules/ConfirmSheet";
import { AddAgentModal } from "../organisms/AddAgentModal";
import { AgentRoster } from "../organisms/AgentRoster";
import { BoardStage } from "../organisms/BoardStage";
import { DotGridCanvas } from "../organisms/DotGridCanvas";
import { DotGridTuner } from "../organisms/DotGridTuner";
import { MapStage } from "../organisms/MapStage";
import { NewWorkspaceModal } from "../organisms/NewWorkspaceModal";
import { SessionsPanel } from "../organisms/SessionsPanel";
import { SettingsPanel } from "../organisms/SettingsPanel";
import { ToolRail } from "../organisms/ToolRail";
import { VoiceStage } from "../organisms/VoiceStage";
import { WorkStage } from "../organisms/WorkStage";
import { WorkspaceManagerModal } from "../organisms/WorkspaceManagerModal";
import { hasNativeFolderPicker, pickFolder } from "../services/nativeDialog";
import { ControlPlaneLayout } from "../templates/ControlPlaneLayout";

export function HomePage() {
  const [modalOpen, setModalOpen] = useState(false);
  /** Agent being edited via edit mode; null means the wizard creates a new one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [gridParams, setGridParams] = useState<GridParams>(GRID_DEFAULTS);
  /** A busy agent/squad being inspected — swaps the stage to their work view. */
  const [inspecting, setInspecting] = useState<AgentSeed | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [newWorkspaceOpen, setNewWorkspaceOpen] = useState(false);
  /**
   * Agent slated for removal — the outcome preview drives the confirm sheet's copy.
   * `error` holds the last preview/removal failure text; `outcome` stays unset until
   * a preview succeeds, so the sheet only offers to confirm once it knows what will happen.
   */
  const [removing, setRemoving] = useState<{
    entry: AgentSeed;
    outcome?: "delete" | "archive";
    reasons: string[];
    error?: string;
    busy?: boolean;
  } | null>(null);
  const { theme, setTheme } = useTheme();
  // The audio sink is a ref so useBrokerChat (which produces the frames) can be
  // declared before useSpokenReplies (which consumes them) without a cycle.
  const audioSink = useRef<(frame: AudioFrame) => void>(() => {});
  const {
    messages,
    roster,
    identity,
    connected,
    audioMode,
    session,
    sessions,
    workspaces,
    lastBoardUpdate,
    lastCapabilityUpdate,
    send,
    compose,
    activity,
    removalPreview,
    removeAgent,
    workAction,
    micControl,
    micAudio,
    createSession,
    activateSession,
    resetSetup,
    listWorkspaceRecords,
    saveWorkspace,
    removeWorkspace,
    verifyWorkspaceAtlassian,
    verifyRepoGithub,
    listConnectorVendors,
    listMyConnectors,
    getVoiceSettings,
    saveVoiceSettings,
    addConnector,
    updateConnector,
    deleteConnector,
    verifyConnector,
    listCliTools,
    refreshCliTools,
    setCliToolEnabled,
    listApiKeys,
    saveApiKey,
    verifyApiKey,
    deleteApiKey,
    getWorkspaceChannels,
    saveWorkspaceChannels,
    verifyWorkspaceDiscord,
  } = useBrokerChat({ onAudio: (frame) => audioSink.current(frame) });
  const { soundOn, toggleSound, playAudioFrame, audioBlocked } = useSpokenReplies(messages, roster, !audioMode);
  audioSink.current = (frame) => void playAudioFrame(frame);
  const { micLive, toggleMic } = usePushToTalk({
    begin: () => micControl("mic-start"),
    audio: micAudio,
    end: () => micControl("mic-stop"),
  });
  const { warnings: engineWarnings, refresh: refreshEngineWarnings } = useCliToolHealth();

  const { voice, refresh: refreshVoiceStatus } = useVoiceStatus();
  const [voicePrefs, setVoicePrefs] = useState<VoiceSettingsRecord | null>(null);
  // Load voice prefs on mount and again whenever Settings closes — hideInactive may have
  // changed while the panel was open.
  useEffect(() => {
    if (!settingsOpen)
      void getVoiceSettings()
        .then(setVoicePrefs)
        .catch(() => setVoicePrefs(null));
  }, [settingsOpen, getVoiceSettings]);

  const hideMic = Boolean(voicePrefs?.hideInactive) && !voice.stt;
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  // A ref (not state) for the pending dismiss timer: rapid presses must restart the 6s window
  // rather than letting an earlier press's timer cut the latest notice short.
  const voiceNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (voiceNoticeTimer.current) clearTimeout(voiceNoticeTimer.current);
    },
    [],
  );
  const onVoiceBlocked = () => {
    setVoiceNotice("Add a Deepgram key in Settings → Integrations, then select it under Settings → Voice.");
    if (voiceNoticeTimer.current) clearTimeout(voiceNoticeTimer.current);
    voiceNoticeTimer.current = setTimeout(() => setVoiceNotice(null), 6000);
  };

  const host = hostSeed(identity);
  const agents: AgentSeed[] = [
    ...(host ? [host] : []),
    ...roster.map((a, i) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      ring: a.ring ?? ringForIndex(i),
      status: a.status,
      hand: a.hand,
      listening: a.listening,
      kind: a.kind,
      members: a.members,
      avatar: a.avatar,
      engineWarning: engineWarnings[a.id],
    })),
  ];

  const callOn = (name: string) => send(`Go ahead, ${name} — you have the floor.`);

  // A rejected fetch (broker down) and a resolved-but-{error} response (unknown agent,
  // swarm busy-lock) both need to surface — neither can leave the sheet silently stuck.
  const requestRemoval = async (entry: AgentSeed) => {
    const preview = await removalPreview(entry.id).catch(
      (err: unknown): { outcome?: "delete" | "archive"; reasons?: string[]; error?: string } => ({
        error: String(err),
      }),
    );
    setRemoving({ entry, outcome: preview.outcome, reasons: preview.reasons ?? [], error: preview.error });
  };

  const confirmRemoval = async () => {
    if (!removing?.outcome) return; // preview never resolved to a real outcome — nothing to confirm
    setRemoving((r) => (r ? { ...r, busy: true, error: undefined } : r));
    const result = await removeAgent(removing.entry.id).catch((err: unknown): { outcome?: string; error?: string } => ({
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
      if (e.key === "g" && !/input|textarea/i.test((e.target as HTMLElement).tagName)) {
        setTunerOpen((open) => !open);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  return (
    <ControlPlaneLayout
      background={<DotGridCanvas params={gridParams} />}
      leftRail={
        <ToolRail
          onNewWorkspace={() => setNewWorkspaceOpen(true)}
          onSessions={() => setSessionsOpen((open) => !open)}
          onBoard={() => setBoardOpen((v) => !v)}
          onMap={() => setMapOpen((v) => !v)}
          onSettings={() => setSettingsOpen(true)}
        />
      }
      rightRail={
        <AgentRoster
          onEdit={(entry) => {
            setEditingId(entry.id);
            setModalOpen(true);
          }}
          agents={agents}
          onAdd={() => {
            setEditingId(null); // the + button always creates
            setModalOpen(true);
          }}
          onCall={callOn}
          onCompose={compose}
          onInspect={setInspecting}
          onRemove={requestRemoval}
        />
      }
      stage={
        mapOpen ? (
          <MapStage lastCapabilityUpdate={lastCapabilityUpdate} />
        ) : boardOpen ? (
          <BoardStage roster={roster} lastBoardUpdate={lastBoardUpdate} />
        ) : inspecting ? (
          <WorkStage
            name={inspecting.name}
            ring={inspecting.ring}
            onBack={() => setInspecting(null)}
            fetchActivity={activity}
            onWorkAction={workAction}
          />
        ) : (
          <VoiceStage
            micLive={micLive}
            onMicToggle={() => void toggleMic()}
            messages={messages}
            brokerConnected={connected}
            onSend={send}
            soundOn={soundOn}
            onSoundToggle={toggleSound}
            sttEnabled={voice.stt}
            onVoiceBlocked={onVoiceBlocked}
            showMicHero={!hideMic}
            voiceNotice={voiceNotice}
          />
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
            }}
            onReset={resetSetup}
            theme={theme}
            onThemeChange={setTheme}
            listConnectorVendors={listConnectorVendors}
            listMyConnectors={listMyConnectors}
            getVoiceSettings={getVoiceSettings}
            saveVoiceSettings={saveVoiceSettings}
            addConnector={addConnector}
            updateConnector={updateConnector}
            deleteConnector={deleteConnector}
            verifyConnector={verifyConnector}
            listCliTools={listCliTools}
            refreshCliTools={refreshCliTools}
            setCliToolEnabled={setCliToolEnabled}
            listApiKeys={listApiKeys}
            saveApiKey={saveApiKey}
            verifyApiKey={verifyApiKey}
            deleteApiKey={deleteApiKey}
            listWorkspaceRecords={listWorkspaceRecords}
            getWorkspaceChannels={getWorkspaceChannels}
            saveWorkspaceChannels={saveWorkspaceChannels}
            verifyWorkspaceDiscord={verifyWorkspaceDiscord}
          />
          <SessionsPanel
            open={sessionsOpen}
            sessions={sessions}
            workspaces={workspaces}
            onClose={() => setSessionsOpen(false)}
            onActivate={activateSession}
            onCreate={createSession}
            onManage={() => setWorkspacesOpen(true)}
          />
          <WorkspaceManagerModal
            open={workspacesOpen}
            onClose={() => setWorkspacesOpen(false)}
            list={listWorkspaceRecords}
            save={saveWorkspace}
            remove={removeWorkspace}
            verifyAtlassian={verifyWorkspaceAtlassian}
            verifyRepoGithub={verifyRepoGithub}
            listMyConnectors={listMyConnectors}
          />
          <NewWorkspaceModal
            open={newWorkspaceOpen}
            onClose={() => setNewWorkspaceOpen(false)}
            save={saveWorkspace}
            list={listWorkspaceRecords}
            listMyConnectors={listMyConnectors}
            activeWorkspace={session?.workspace}
            pickFolder={hasNativeFolderPicker() ? pickFolder : undefined}
            onCreated={(name) => createSession(name)}
          />
          <DotGridTuner
            open={tunerOpen}
            params={gridParams}
            onChange={(key, value) => setGridParams((p) => ({ ...p, [key]: value }))}
            onReset={() => setGridParams(GRID_DEFAULTS)}
          />
          <AddAgentModal
            open={modalOpen}
            editingId={editingId ?? undefined}
            onClose={() => {
              setModalOpen(false);
              setEditingId(null);
              void refreshEngineWarnings();
            }}
            onCreated={(n) =>
              editingId ? undefined : send(`${n} just joined the crew — welcome them in one short line.`)
            }
          />
        </>
      }
    />
  );
}
