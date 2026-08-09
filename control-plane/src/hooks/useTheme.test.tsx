import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

/** matchMedia is not implemented in jsdom; the hook needs a controllable stand-in. */
function stubPrefersLight(matches: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      // A getter, not a value: the hook re-reads `.matches` inside its change
      // handler, so a snapshot taken at construction would always look stale.
      get matches() {
        return matches;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    })),
  );
  return {
    set(next: boolean) {
      matches = next;
      for (const fn of listeners) fn();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

describe("useTheme drives HeroUI's dark palette", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-theme");
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["dark", true],
    ["midnight", true],
    ["light", false],
    ["sand", false],
  ] as const)("theme %s sets .dark to %s", (theme, expected) => {
    stubPrefersLight(false);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme(theme));
    expect(document.documentElement.classList.contains("dark")).toBe(expected);
    expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
  });

  it("system follows the OS and drops data-theme entirely", () => {
    stubPrefersLight(true);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("system"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("system keeps tracking the OS after mount", () => {
    const mq = stubPrefersLight(true);
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("system"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    // The user flips their OS to dark while the app is open.
    act(() => mq.set(false));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("detaches its media listener on unmount", () => {
    const mq = stubPrefersLight(false);
    const { unmount } = renderHook(() => useTheme());
    expect(mq.listenerCount).toBe(1);
    unmount();
    expect(mq.listenerCount).toBe(0);
  });
});
