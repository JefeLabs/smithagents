import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioFrame } from "./useBrokerChat";
import { useSpokenReplies } from "./useSpokenReplies";

/**
 * WKWebView-shaped AudioContext fake: starts suspended, and resume() only
 * succeeds after a user gesture has happened — the autoplay policy that
 * silently swallowed every frame in the Tauri app.
 */
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  started = 0;
  connect() {}
  start() {
    this.started += 1;
  }
  stop() {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static gestureHappened = false;
  state: "suspended" | "running" = "suspended";
  destination = {};
  sources: FakeSource[] = [];
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume() {
    if (FakeAudioContext.gestureHappened) {
      this.state = "running";
      return Promise.resolve();
    }
    return Promise.reject(new Error("NotAllowedError: user gesture required"));
  }
  decodeAudioData(_buf: ArrayBuffer) {
    return Promise.resolve({ duration: 1 } as AudioBuffer);
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

const FRAME: AudioFrame = { speaker: "Anderson", mime: "audio/mpeg", dataB64: btoa("mp3-bytes") };

const startedSources = () => FakeAudioContext.instances.flatMap((c) => c.sources).filter((s) => s.started > 0).length;

describe("useSpokenReplies — blocked AudioContext (WKWebView autoplay)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // This jsdom setup has no localStorage (opaque origin) and Node 26's own
    // globalThis.localStorage is undefined without a flag — stub a minimal one
    // so the hook's persisted-mute read works.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    });
    FakeAudioContext.instances = [];
    FakeAudioContext.gestureHappened = false;
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("never starts a source while the context is blocked, and reports audioBlocked", async () => {
    const { result } = renderHook(() => useSpokenReplies([], [], false));

    await act(async () => {
      await result.current.playAudioFrame(FRAME);
      await result.current.playAudioFrame(FRAME);
      await vi.advanceTimersByTimeAsync(2000);
    });

    // The old code started sources on a suspended context — they can never
    // fire onended, wedging the queue forever.
    expect(startedSources()).toBe(0);
    expect(result.current.audioBlocked).toBe(true);
  });

  it("a user gesture unblocks the context and drains the queued frames", async () => {
    const { result } = renderHook(() => useSpokenReplies([], [], false));

    await act(async () => {
      await result.current.playAudioFrame(FRAME);
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(startedSources()).toBe(0);

    FakeAudioContext.gestureHappened = true;
    await act(async () => {
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(startedSources()).toBe(1);
    expect(result.current.audioBlocked).toBe(false);
  });

  it("plays immediately when the context is already running", async () => {
    FakeAudioContext.gestureHappened = true;
    const { result } = renderHook(() => useSpokenReplies([], [], false));

    await act(async () => {
      await result.current.playAudioFrame(FRAME);
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(startedSources()).toBe(1);
    expect(result.current.audioBlocked).toBe(false);
  });
});
