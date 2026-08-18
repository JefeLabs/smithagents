import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./useTheme";

/** Reads the theme without offering a way to change it — the second consumer. */
function Readout({ label }: { label: string }) {
  const { theme } = useTheme();
  return <span>{`${label}:${theme}`}</span>;
}

function Switcher() {
  const { theme, setTheme } = useTheme();
  return (
    <button type="button" onClick={() => setTheme("midnight")}>
      {theme}
    </button>
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeProvider", () => {
  it("applies a stored theme even when nothing below it renders a switcher", () => {
    // The wizard case: WizardGate returns the wizard INSTEAD of children, so
    // HomePage never mounts. The theme must already be applied above it.
    localStorage.setItem("smith.theme", "midnight");
    render(
      <ThemeProvider>
        <div>the wizard, with no switcher anywhere beneath it</div>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
  });

  it("one instance owns the choice — a switcher below updates what the provider applied", async () => {
    // Two independent useState copies would diverge; this pins that they do not.
    localStorage.setItem("smith.theme", "light");
    render(
      <ThemeProvider>
        <Switcher />
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    await userEvent.click(screen.getByRole("button"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
    expect(screen.getByRole("button")).toHaveTextContent("midnight");
  });

  it("two consumers share ONE choice — a change in either is seen by the other", async () => {
    // The discriminating test for this provider, and the reason it is a
    // provider at all. A plausible wrong implementation — ThemeProvider
    // calling the plain hook itself, so every consumer keeps its own
    // useState — passes every other test in this file, because all the
    // copies write to the same singleton documentElement/localStorage and
    // only one consumer is ever mounted. Divergence is only observable with
    // TWO consumers alive at once: the reader must re-render with the
    // switcher's new value, which independent useState copies cannot do.
    localStorage.setItem("smith.theme", "light");
    render(
      <ThemeProvider>
        <Switcher />
        <Readout label="reader" />
      </ThemeProvider>,
    );
    expect(screen.getByText("reader:light")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button"));

    expect(screen.getByText("reader:midnight")).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-theme")).toBe("midnight");
  });

  it("system removes the attribute so the OS media query takes over", () => {
    localStorage.setItem("smith.theme", "system");
    render(
      <ThemeProvider>
        <div />
      </ThemeProvider>,
    );
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

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

function wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

// Predates the provider conversion (was against the bare hook via renderHook);
// carried forward against ThemeProvider so the .dark mirror effect and the
// OS-tracking/cleanup behaviour it depends on keep their coverage.
describe("ThemeProvider mirrors HeroUI's dark class", () => {
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
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setTheme(theme));
    expect(document.documentElement.classList.contains("dark")).toBe(expected);
    expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
  });

  it("system follows the OS and drops data-theme entirely", () => {
    stubPrefersLight(true);
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setTheme("system"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("system keeps tracking the OS after mount", () => {
    const mq = stubPrefersLight(true);
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setTheme("system"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    // The user flips their OS to dark while the app is open.
    act(() => mq.set(false));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("detaches its media listener on unmount", () => {
    const mq = stubPrefersLight(false);
    const { unmount } = renderHook(() => useTheme(), { wrapper });
    expect(mq.listenerCount).toBe(1);
    unmount();
    expect(mq.listenerCount).toBe(0);
  });
});
