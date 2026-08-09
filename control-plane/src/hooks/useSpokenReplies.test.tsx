import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioFrame } from "../api/types";
import { qk } from "../queries/keys";
import { useAudioStore } from "../stores/audioStore";
import { useSocketStore } from "../stores/socketStore";
import { useSpokenReplies } from "./useSpokenReplies";

// `audioStore` reads localStorage synchronously at module-eval time (inside
// the zustand `create()` call), which runs when the static imports above are
// resolved — earlier than any beforeEach could reach. This jsdom setup has no
// working localStorage of its own (opaque origin), so the stub has to be
// hoisted above those imports, exactly as audioStore.test.ts does it. A plain
// beforeEach stub would leave the store's initial read throwing.
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

/** Only what the socket store touches: it assigns the four handlers and calls close(). */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send() {}
  close() {}
}

const FRAME: AudioFrame = { speaker: "Anderson", mime: "audio/mpeg", dataB64: btoa("mp3-bytes") };

const startedSources = () => FakeAudioContext.instances.flatMap((c) => c.sources).filter((s) => s.started > 0).length;
const blocked = () => useAudioStore.getState().audioBlocked;

/** Renders the hook over a QueryClient the caller can seed with pushed-query data. */
function renderSpokenReplies(seed?: (c: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  seed?.(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useSpokenReplies(), { wrapper }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  FakeAudioContext.gestureHappened = false;
  FakeSocket.last = null;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  useSocketStore.getState().disconnect();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSpokenReplies — blocked AudioContext (WKWebView autoplay)", () => {
  it("never starts a source while the context is blocked, and reports audioBlocked", async () => {
    const { result } = renderSpokenReplies();

    await act(async () => {
      await result.current.playAudioFrame(FRAME);
      await result.current.playAudioFrame(FRAME);
      await vi.advanceTimersByTimeAsync(2000);
    });

    // The old code started sources on a suspended context — they can never
    // fire onended, wedging the queue forever.
    expect(startedSources()).toBe(0);
    expect(blocked()).toBe(true);
  });

  it("a user gesture unblocks the context and drains the queued frames", async () => {
    const { result } = renderSpokenReplies();

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
    expect(blocked()).toBe(false);
  });

  it("plays immediately when the context is already running", async () => {
    FakeAudioContext.gestureHappened = true;
    const { result } = renderSpokenReplies();

    await act(async () => {
      await result.current.playAudioFrame(FRAME);
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(startedSources()).toBe(1);
    expect(blocked()).toBe(false);
  });
});

describe("useSpokenReplies — broker audio frames", () => {
  it("plays an audio frame that arrives on the socket, with nobody wiring the subscription up", async () => {
    // This is the whole point of the hook subscribing for itself: the page no
    // longer relays frames into it. Drop the subscription effect and every
    // other test here still passes — broker speech just never plays.
    FakeAudioContext.gestureHappened = true;
    const { client } = renderSpokenReplies();
    useSocketStore.getState().connect(client);

    await act(async () => {
      FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: "audio", ...FRAME }) });
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(startedSources()).toBe(1);
  });

  it("drops broker audio while muted instead of queueing it for the unmute", async () => {
    FakeAudioContext.gestureHappened = true;
    act(() => useAudioStore.getState().toggleSound()); // -> off
    const { client } = renderSpokenReplies();
    useSocketStore.getState().connect(client);

    await act(async () => {
      FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: "audio", ...FRAME }) });
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(startedSources()).toBe(0);

    // Unmuting must not replay what arrived while muted.
    await act(async () => {
      useAudioStore.getState().toggleSound();
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(startedSources()).toBe(0);
  });
});

describe("useSpokenReplies — the Web Speech fallback", () => {
  const speak = vi.fn();
  const cancel = vi.fn();

  beforeEach(() => {
    speak.mockClear();
    cancel.mockClear();
    vi.stubGlobal("speechSynthesis", { speak, cancel, getVoices: () => [] });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        voice: unknown = null;
        rate = 1;
        pitch = 1;
        constructor(readonly text: string) {}
      },
    );
  });

  const transcript = (c: QueryClient) =>
    c.setQueryData(qk.transcript, [{ id: 0, role: "broker", text: "Anderson: all set" }]);

  it("speaks a broker reply when the broker has no audio of its own", async () => {
    const { client } = renderSpokenReplies(transcript);
    useSocketStore.getState().connect(client);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("stays silent once the broker's config frame says it produces audio itself", async () => {
    // Replaces an assertion on the `webSpeechEnabled` ARGUMENT the page used to
    // pass. Getting this wrong is not silence — it is every reply spoken twice,
    // once by the browser and once by the broker.
    const { client } = renderSpokenReplies();
    useSocketStore.getState().connect(client);

    await act(() => {
      FakeSocket.last?.onmessage?.({ data: JSON.stringify({ type: "config", audio: true }) });
    });
    await act(async () => {
      transcript(client);
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(speak).not.toHaveBeenCalled();
  });

  it("muting from the store cancels speech already in flight", async () => {
    // The flush used to live inside the hook's own toggleSound. The mute button
    // is in a stage route now and calls audioStore.toggleSound directly, so a
    // flush attached to one caller would never run for the real one.
    const { client } = renderSpokenReplies(transcript);
    useSocketStore.getState().connect(client);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(speak).toHaveBeenCalledTimes(1);

    await act(async () => {
      useAudioStore.getState().toggleSound(); // -> off
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(cancel).toHaveBeenCalled();
  });
});
