import { useEffect, useRef, useState } from "react";
import { type AgentSeed, ringForIndex } from "../data/agents";
import { type AudioFrame, useBrokerChat } from "../hooks/useBrokerChat";
import { GRID_DEFAULTS, type GridParams } from "../hooks/useDotGrid";
import { usePushToTalk } from "../hooks/usePushToTalk";
import { useSpokenReplies } from "../hooks/useSpokenReplies";
import { AddAgentModal } from "../organisms/AddAgentModal";
import { AgentRoster } from "../organisms/AgentRoster";
import { DotGridCanvas } from "../organisms/DotGridCanvas";
import { DotGridTuner } from "../organisms/DotGridTuner";
import { SessionsPanel } from "../organisms/SessionsPanel";
import { SettingsPanel } from "../organisms/SettingsPanel";
import { ToolRail } from "../organisms/ToolRail";
import { VoiceStage } from "../organisms/VoiceStage";
import { WorkStage } from "../organisms/WorkStage";
import { ControlPlaneLayout } from "../templates/ControlPlaneLayout";

export function HomePage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [gridParams, setGridParams] = useState<GridParams>(GRID_DEFAULTS);
  /** A busy agent/squad being inspected — swaps the stage to their work view. */
  const [inspecting, setInspecting] = useState<AgentSeed | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The audio sink is a ref so useBrokerChat (which produces the frames) can be
  // declared before useSpokenReplies (which consumes them) without a cycle.
  const audioSink = useRef<(frame: AudioFrame) => void>(() => {});
  const {
    messages,
    roster,
    connected,
    audioMode,
    session,
    sessions,
    workspaces,
    send,
    compose,
    activity,
    workAction,
    micControl,
    micAudio,
    createSession,
    activateSession,
    resetSetup,
  } = useBrokerChat({ onAudio: (frame) => audioSink.current(frame) });
  const { soundOn, toggleSound, playAudioFrame } = useSpokenReplies(messages, roster, !audioMode);
  audioSink.current = (frame) => void playAudioFrame(frame);
  const { micLive, toggleMic } = usePushToTalk({
    begin: () => micControl("mic-start"),
    audio: micAudio,
    end: () => micControl("mic-stop"),
  });

  const agents: AgentSeed[] = [
    ...roster.map((a, i) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      ring: a.ring ?? ringForIndex(i),
      status: a.status,
      hand: a.hand,
      kind: a.kind,
      members: a.members,
    })),
  ];

  const callOn = (name: string) => send(`Go ahead, ${name} — you have the floor.`);

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
          onSessions={() => setSessionsOpen((open) => !open)}
          onSettings={() => setSettingsOpen((open) => !open)}
        />
      }
      rightRail={
        <AgentRoster
          agents={agents}
          onAdd={() => setModalOpen(true)}
          onCall={callOn}
          onCompose={compose}
          onInspect={setInspecting}
        />
      }
      stage={
        inspecting ? (
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
          />
        )
      }
      hint={
        <>
          {session ? `${session.title} · ${session.workspace} — ` : ""}agents raise ✋ when they have something to add —
          click their circle to give them the floor · press <kbd>g</kbd> to tune the grid
        </>
      }
      overlays={
        <>
          <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} onReset={resetSetup} />
          <SessionsPanel
            open={sessionsOpen}
            sessions={sessions}
            workspaces={workspaces}
            onClose={() => setSessionsOpen(false)}
            onActivate={activateSession}
            onCreate={createSession}
          />
          <DotGridTuner
            open={tunerOpen}
            params={gridParams}
            onChange={(key, value) => setGridParams((p) => ({ ...p, [key]: value }))}
            onReset={() => setGridParams(GRID_DEFAULTS)}
          />
          <AddAgentModal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            onCreated={(n) => send(`${n} just joined the crew — welcome them in one short line.`)}
          />
        </>
      }
    />
  );
}
