/**
 * Sound/mic/audio-blocked flags. `soundOn` mirrors the persistence
 * `useSpokenReplies` currently owns directly (localStorage key "smith.sound",
 * absent key means on) so Task 12 can rewire that hook to read this store
 * without changing what users' saved preference means.
 */
import { create } from "zustand";
import { registerStoreReset } from "./reset";

const STORE_KEY = "smith.sound";

/** Same read `useSpokenReplies` performs today: absent key defaults to on. */
function readStoredSound(): boolean {
  return localStorage.getItem(STORE_KEY) !== "off";
}

interface AudioState {
  soundOn: boolean;
  micLive: boolean;
  audioBlocked: boolean;
  toggleSound: () => void;
  setMicLive: (live: boolean) => void;
  setAudioBlocked: (blocked: boolean) => void;
}

// The reset target, not just the creation-time value: resetting to `true`
// unconditionally is only correct because reset() below also clears the
// localStorage key, so "true" and "no key present" agree again afterward.
const initial = { soundOn: true, micLive: false, audioBlocked: false };

export const useAudioStore = create<AudioState>((set) => ({
  ...initial,
  soundOn: readStoredSound(),
  toggleSound: () =>
    set((s) => {
      const next = !s.soundOn;
      localStorage.setItem(STORE_KEY, next ? "on" : "off");
      return { soundOn: next };
    }),
  setMicLive: (micLive) => set({ micLive }),
  setAudioBlocked: (audioBlocked) => set({ audioBlocked }),
}));

registerStoreReset(() => {
  // Test isolation requires clearing BOTH sides of this store's persistence:
  // restoring only the in-memory state would still leave a prior test's
  // "off" write in localStorage for the next test (or a later real mount)
  // to pick up as if it were the user's saved preference.
  localStorage.removeItem(STORE_KEY);
  useAudioStore.setState(initial);
});
