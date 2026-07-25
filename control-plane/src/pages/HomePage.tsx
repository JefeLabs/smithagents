import { useEffect, useState } from "react";
import { AGENTS, type AgentSeed, ringForIndex } from "../data/agents";
import { GRID_DEFAULTS, type GridParams } from "../hooks/useDotGrid";
import { AddAgentModal } from "../organisms/AddAgentModal";
import { AgentRoster } from "../organisms/AgentRoster";
import { DotGridCanvas } from "../organisms/DotGridCanvas";
import { DotGridTuner } from "../organisms/DotGridTuner";
import { ToolRail } from "../organisms/ToolRail";
import { VoiceStage } from "../organisms/VoiceStage";
import { ControlPlaneLayout } from "../templates/ControlPlaneLayout";

export function HomePage() {
  const [agents, setAgents] = useState<AgentSeed[]>(AGENTS);
  const [micLive, setMicLive] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [gridParams, setGridParams] = useState<GridParams>(GRID_DEFAULTS);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "g" && !/input|textarea/i.test((e.target as HTMLElement).tagName)) {
        setTunerOpen((open) => !open);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const createAgent = (name: string, role: string) => {
    setAgents((list) => [
      ...list,
      {
        id: `${name.toLowerCase().replace(/\s+/g, "-")}-${list.length}`,
        name,
        role,
        ring: ringForIndex(list.length),
      },
    ]);
    setModalOpen(false);
  };

  return (
    <ControlPlaneLayout
      background={<DotGridCanvas params={gridParams} />}
      leftRail={<ToolRail />}
      rightRail={<AgentRoster agents={agents} onAdd={() => setModalOpen(true)} />}
      stage={<VoiceStage micLive={micLive} onMicToggle={() => setMicLive((live) => !live)} />}
      hint={
        <>
          endless canvas · press <kbd>g</kbd> to tune the grid
        </>
      }
      overlays={
        <>
          <DotGridTuner
            open={tunerOpen}
            params={gridParams}
            onChange={(key, value) => setGridParams((p) => ({ ...p, [key]: value }))}
            onReset={() => setGridParams(GRID_DEFAULTS)}
          />
          <AddAgentModal open={modalOpen} onClose={() => setModalOpen(false)} onCreate={createAgent} />
        </>
      }
    />
  );
}
