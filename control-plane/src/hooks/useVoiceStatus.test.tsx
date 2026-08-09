import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVoiceStatus } from "./useVoiceStatus";

afterEach(() => vi.unstubAllGlobals());

function renderVoiceStatus() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useVoiceStatus(), { wrapper });
}

describe("useVoiceStatus", () => {
  it("reads the voice sibling from /agents", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ agents: [], voice: { stt: false, tts: true } }))),
    );
    const { result } = renderVoiceStatus();
    await waitFor(() => expect(result.current.voice).toEqual({ stt: false, tts: true }));
  });

  it("defaults to enabled when the broker is unreachable — no stale gating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const { result } = renderVoiceStatus();
    await waitFor(() => expect(result.current.voice).toEqual({ stt: true, tts: true }));
  });

  it("defaults to enabled when the broker answers WITHOUT a voice sibling", async () => {
    // An older broker, or one that has not wired the voice service yet. Absent
    // is not a confirmed negative, so the mic must stay usable — reading
    // `data.voice` without the fallback would hand `undefined` to the gate.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ agents: [] }))),
    );
    const { result } = renderVoiceStatus();
    await waitFor(() => expect(result.current.voice).toEqual({ stt: true, tts: true }));
  });
});
