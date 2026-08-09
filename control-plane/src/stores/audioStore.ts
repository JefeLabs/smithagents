/**
 * Sound/mic/audio-blocked flags — the app-scope audio state that stage routes
 * read. `soundOn` owns the persistence `useSpokenReplies` used to hold
 * directly (localStorage key "smith.sound", absent key means on); that hook
 * now subscribes here instead, so a toggle from anywhere reaches its queues.
 *
 * `toggleMic` is a registration slot rather than an implementation: the mic
 * hardware lives in `usePushToTalk`, which holds a live MediaStream and
 * AudioContext in refs and must stay mounted at app scope or navigating away
 * orphans a hot mic. A stage route can only ask for the toggle, never own it.
 */
import { create } from "zustand";
import { registerStoreReset } from "./reset";

const STORE_KEY = "smith.sound";

/** Same read `useSpokenReplies` performed before this store existed: absent key defaults to on. */
function readStoredSound(): boolean {
  return localStorage.getItem(STORE_KEY) !== "off";
}

const NO_MIC = () => {};

interface AudioState {
  soundOn: boolean;
  micLive: boolean;
  audioBlocked: boolean;
  toggleSound: () => void;
  setMicLive: (live: boolean) => void;
  setAudioBlocked: (blocked: boolean) => void;
  /** No-op until `usePushToTalk` mounts and registers the real one. */
  toggleMic: () => void;
  setToggleMic: (fn: () => void) => void;
}

// The reset target, not just the creation-time value: resetting to `true`
// unconditionally is only correct because reset() below also clears the
// localStorage key, so "true" and "no key present" agree again afterward.
const initial = { soundOn: true, micLive: false, audioBlocked: false, toggleMic: NO_MIC };

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
  setToggleMic: (toggleMic) => set({ toggleMic }),
}));

registerStoreReset(() => {
  // Test isolation requires clearing BOTH sides of this store's persistence:
  // restoring only the in-memory state would still leave a prior test's
  // "off" write in localStorage for the next test (or a later real mount)
  // to pick up as if it were the user's saved preference.
  localStorage.removeItem(STORE_KEY);
  useAudioStore.setState(initial);
});
