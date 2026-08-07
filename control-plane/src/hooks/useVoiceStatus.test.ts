import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVoiceStatus } from "./useVoiceStatus";

afterEach(() => vi.unstubAllGlobals());

describe("useVoiceStatus", () => {
  it("reads the voice sibling from /agents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: true } }))),
    );
    const { result } = renderHook(() => useVoiceStatus());
    await waitFor(() => expect(result.current.voice).toEqual({ stt: false, tts: true }));
  });

  it("defaults to enabled when the broker is unreachable — no stale gating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { result } = renderHook(() => useVoiceStatus());
    await waitFor(() => expect(result.current.voice).toEqual({ stt: true, tts: true }));
  });
});
