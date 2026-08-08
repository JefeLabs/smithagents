import { describe, expect, it, vi } from "vitest";
import { useAudioStore } from "./audioStore";
import { resetAllStores } from "./reset";

// audioStore reads localStorage synchronously at module-eval time (the
// zustand `create()` call itself), which runs before any beforeEach/beforeAll
// hook could install a stub. This jsdom setup has no working localStorage of
// its own (opaque origin) and Node's own global is unconfigured here, so the
// stub has to be hoisted above the static imports above, the same way
// useSpokenReplies.test.ts and AgentRoster.test.tsx stub it — just earlier.
vi.hoisted(() => {
  const map = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
});

describe("audioStore", () => {
  it("defaults soundOn to true when no preference is persisted", () => {
    expect(localStorage.getItem("smith.sound")).toBeNull();
    expect(useAudioStore.getState().soundOn).toBe(true);
  });

  it("toggleSound flips soundOn and persists on/off under the smith.sound key", () => {
    useAudioStore.getState().toggleSound();
    expect(useAudioStore.getState().soundOn).toBe(false);
    expect(localStorage.getItem("smith.sound")).toBe("off");

    useAudioStore.getState().toggleSound();
    expect(useAudioStore.getState().soundOn).toBe(true);
    expect(localStorage.getItem("smith.sound")).toBe("on");
  });

  it("a fresh module instance reads soundOn from an already-persisted preference", async () => {
    // useAudioStore is a module singleton created once at import time, so the
    // only way to prove the *initial read* (not just toggleSound) consults
    // localStorage is to force a genuinely fresh module evaluation.
    localStorage.setItem("smith.sound", "off");
    vi.resetModules();
    const fresh = await import("./audioStore");
    expect(fresh.useAudioStore.getState().soundOn).toBe(false);
  });

  it("resetAllStores restores the default and clears the persisted preference", () => {
    useAudioStore.getState().toggleSound();
    expect(localStorage.getItem("smith.sound")).toBe("off");

    resetAllStores();

    expect(useAudioStore.getState().soundOn).toBe(true);
    expect(localStorage.getItem("smith.sound")).toBeNull();
  });

  it("setMicLive and setAudioBlocked set their flags independently of sound", () => {
    useAudioStore.getState().setMicLive(true);
    expect(useAudioStore.getState().micLive).toBe(true);
    expect(useAudioStore.getState().soundOn).toBe(true);

    useAudioStore.getState().setAudioBlocked(true);
    expect(useAudioStore.getState().audioBlocked).toBe(true);
  });

  it("state does not leak between tests", () => {
    expect(useAudioStore.getState()).toMatchObject({ soundOn: true, micLive: false, audioBlocked: false });
    expect(localStorage.getItem("smith.sound")).toBeNull();
  });
});
