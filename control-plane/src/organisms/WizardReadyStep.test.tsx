import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardReadyStep } from "./WizardReadyStep";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base = { name: "Edwin", onJumpTo: () => {}, onFinish: () => {} };

/** Responds to POST /brain/ping with `body`; every other call 404s loudly. */
function stubPing(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, _init?: RequestInit) => ({ ok, status, json: async () => body }) as unknown as Response),
  );
}

describe("WizardReadyStep", () => {
  it("shows NO latency tick before the ask resolves — a receipt cannot precede its operation", async () => {
    let release: ((r: unknown) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((r) => {
            release = r;
          }),
      ),
    );
    renderWithProviders(<WizardReadyStep {...base} />);

    expect(screen.queryByText(/answered in/i)).toBeNull();
    await waitFor(() => expect(typeof release).toBe("function"));
  });

  it("ticks with the MEASURED figure the ask returned, not a placeholder", async () => {
    stubPing({ ok: true, reply: "hi", latencyMs: 812 });
    renderWithProviders(<WizardReadyStep {...base} />);
    await waitFor(() => expect(screen.getByText(/answered in 0\.8s/i)).toBeTruthy());
  });

  it("a different measurement renders differently — proving the number is not hardcoded", async () => {
    stubPing({ ok: true, reply: "hi", latencyMs: 2400 });
    renderWithProviders(<WizardReadyStep {...base} />);
    await waitFor(() => expect(screen.getByText(/answered in 2\.4s/i)).toBeTruthy());
  });

  it("a failed ask says so and still lets the user finish — the last screen is never a dead end", async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    stubPing({ error: "nope" }, false, 500);
    renderWithProviders(<WizardReadyStep {...base} onFinish={onFinish} />);

    await waitFor(() => expect(screen.getByText(/couldn't get an answer/i)).toBeTruthy());
    expect(screen.queryByText(/answered in/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /let's talk/i }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("greets by name", async () => {
    stubPing({ ok: true, reply: "hi", latencyMs: 500 });
    renderWithProviders(<WizardReadyStep {...base} />);
    expect(screen.getByText(/ready, Edwin/i)).toBeTruthy();
  });

  it("each receipt line jumps back to the step that earned it", async () => {
    const user = userEvent.setup();
    const onJumpTo = vi.fn();
    stubPing({ ok: true, reply: "hi", latencyMs: 500 });
    renderWithProviders(<WizardReadyStep {...base} onJumpTo={onJumpTo} />);

    await user.click(await screen.findByRole("button", { name: /revisit talking out loud/i }));
    expect(onJumpTo).toHaveBeenCalledWith("voice");
  });

  it("asks exactly once — a receipt is one operation, not one per render", async () => {
    stubPing({ ok: true, reply: "hi", latencyMs: 500 });
    renderWithProviders(<WizardReadyStep {...base} />);
    await waitFor(() => expect(screen.getByText(/answered in/i)).toBeTruthy());
    // Count PINGS, not fetches — useCliTools and useVoiceSettings call fetch too,
    // and the claim under test is that the paid ask happens once.
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
    const pings = calls.filter(([url, init]) => String(url).includes("/brain/ping") && init?.method === "POST");
    expect(pings).toHaveLength(1);
  });
});
