import { createContext, useContext } from "react";
import type { AgentSeed } from "../data/agents";
import type { ChatMessage, RosterAgent } from "./useBrokerChat";

/**
 * The slice of broker state the stage routes need. Provided by HomePage (the
 * root layout, which owns the single useBrokerChat WebSocket) and consumed by
 * the thin route components in src/router.tsx. Never fetched via route
 * loaders — the connection lives above the router.
 */
export interface StageContextValue {
  // voice stage
  messages: ChatMessage[];
  micLive: boolean;
  onMicToggle: () => void;
  brokerConnected: boolean;
  send: (text: string) => void;
  soundOn: boolean;
  onSoundToggle: () => void;
  sttEnabled: boolean;
  onVoiceBlocked: () => void;
  showMicHero: boolean;
  voiceNotice: string | null;
  // board stage
  roster: RosterAgent[];
  lastBoardUpdate: { boardId: string; seq: number } | null;
  // map stage
  lastCapabilityUpdate: { capabilityId: string; seq: number } | null;
  // work stage
  agents: AgentSeed[];
  activity: (name: string) => Promise<{ busy: boolean; label?: string; output?: string }>;
  workAction: (name: string, action: "steer" | "cancel", message?: string) => Promise<string | null>;
}

const StageContext = createContext<StageContextValue | null>(null);

export const StageProvider = StageContext.Provider;

export function useStage(): StageContextValue {
  const value = useContext(StageContext);
  if (!value) throw new Error("useStage must be used inside HomePage's StageProvider");
  return value;
}
