import { createContext, useContext } from "react";

/**
 * The last values the voice stage cannot read for itself.
 *
 * Everything else a stage route needs now comes from a query key or a store
 * selector. What remains here are the mic/sound/STT controls, and they remain
 * because their owners still hold React state:
 *
 * - `soundOn`/`onSoundToggle` come from `useSpokenReplies`' own `useState`
 *   (plus its speech/audio queue flush on mute). `audioStore.soundOn` exists
 *   but nothing writes it yet.
 * - `micLive`/`onMicToggle` come from `usePushToTalk`, which holds the live
 *   MediaStream and AudioContext in refs. It must stay mounted at app scope,
 *   or navigating away from the voice stage orphans a hot mic.
 * - `sttEnabled`/`showMicHero` derive from `useVoiceStatus`, whose `refresh`
 *   HomePage fires when Settings closes; a second copy in the route would
 *   never see that refresh.
 * - `onVoiceBlocked` owns the 6s dismiss timer, which must survive navigation.
 *   The notice text itself lives in `uiStore`, and the stage reads it there.
 *
 * This file disappears once those three hooks move onto the stores.
 */
export interface StageContextValue {
  micLive: boolean;
  onMicToggle: () => void;
  soundOn: boolean;
  onSoundToggle: () => void;
  sttEnabled: boolean;
  showMicHero: boolean;
  onVoiceBlocked: () => void;
}

const StageContext = createContext<StageContextValue | null>(null);

export const StageProvider = StageContext.Provider;

export function useStage(): StageContextValue {
  const value = useContext(StageContext);
  if (!value) throw new Error("useStage must be used inside HomePage's StageProvider");
  return value;
}
