import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/broker";
import { WIZARD_STEPS } from "../lib/wizardSteps";
import { qk } from "../queries/keys";
import { renderWithProviders } from "../test/renderWithProviders";
import { SettingsPanel } from "./SettingsPanel";

// Only `updateMe` is overridden — every other export keeps its real
// implementation, so groups this file doesn't otherwise stub (Themes,
// General's reset) are unaffected.
vi.mock("../api/broker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/broker")>();
  return { ...actual, updateMe: vi.fn() };
});

function renderSettings({ updateMe = vi.fn().mockResolvedValue({}) }: { updateMe?: ReturnType<typeof vi.fn> } = {}) {
  (api.updateMe as ReturnType<typeof vi.fn>).mockImplementation(updateMe);
  return renderWithProviders(
    <SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />,
  );
}

/**
 * A live broker really is listening on 127.0.0.1:7790 on dev machines — every group now
 * fetches its own data via query hooks the moment it's the active one, so any test that lands
 * on a non-General/Themes group needs this stubbed.
 */
function stubNoNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
}

describe("SettingsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens on the General group by default and renders reset options", () => {
    renderWithProviders(
      <SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: /general/i })).toBeDefined();
    expect(screen.getByText(/kill running instances/i)).toBeDefined();
  });

  it("opens on Integrations directly when initialGroup is set (avatar deep-link)", async () => {
    stubNoNetwork();
    renderWithProviders(
      <SettingsPanel
        open
        onClose={() => {}}
        onReset={vi.fn()}
        theme="dark"
        onThemeChange={vi.fn()}
        initialGroup="integrations"
      />,
    );
    expect(await screen.findByRole("heading", { name: /integrations/i })).toBeDefined();
  });

  it("clicking a nav group switches the visible content", async () => {
    renderWithProviders(
      <SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /themes/i }));
    expect(screen.getAllByText(/dark|light/i).length).toBeGreaterThan(0); // theme chips render
  });

  it("back to app calls onClose", async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <SettingsPanel open onClose={onClose} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /back to app/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("re-opening the SAME instance with a different initialGroup switches groups (avatar deep-link, after Settings was opened via the rail button first)", async () => {
    // HomePage.tsx keeps SettingsPanel always mounted (open just toggles rendering, same
    // convention as every other overlay), so it never remounts between opens — a stale
    // `useState(initialGroup)` would only ever honor the FIRST open's value and silently
    // ignore every later one. This is the "rail Settings, then avatar" sequence exactly.
    stubNoNetwork();
    const { rerender } = renderWithProviders(
      <SettingsPanel
        open={false}
        onClose={() => {}}
        onReset={vi.fn()}
        theme="dark"
        onThemeChange={vi.fn()}
        initialGroup="general"
      />,
    );
    rerender(
      <SettingsPanel
        open
        onClose={() => {}}
        onReset={vi.fn()}
        theme="dark"
        onThemeChange={vi.fn()}
        initialGroup="integrations"
      />,
    );
    expect(await screen.findByRole("heading", { name: /integrations/i })).toBeDefined();
    expect(screen.queryByText(/kill running instances/i)).toBeNull(); // not stuck on General
  });

  it("renders nothing when closed", () => {
    const { container } = renderWithProviders(
      <SettingsPanel open={false} onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("groups the nav under App / Agents / Workspace headings with API Keys under Agents", () => {
    renderWithProviders(
      <SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />,
    );
    for (const heading of ["App", "Agents", "Workspace"]) {
      expect(screen.getByText(heading)).toBeDefined();
    }
    expect(screen.getByRole("button", { name: /api keys/i })).toBeDefined();
  });

  it("opens the API Keys group and renders its cards when wired", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(
      <SettingsPanel
        open
        onClose={() => {}}
        onReset={vi.fn()}
        theme="dark"
        onThemeChange={vi.fn()}
        initialGroup="api-keys"
      />,
    );
    client.setQueryData(qk.apiKeys, []);
    expect(await screen.findByRole("heading", { name: /api keys/i })).toBeDefined();
  });

  it("settings: re-running setup reopens the wizard without destroying the user", async () => {
    const updateMe = vi.fn().mockResolvedValue({});
    renderSettings({ updateMe });

    await userEvent.click(screen.getByRole("button", { name: /re-run setup|run setup again/i }));

    // Asserted against WIZARD_STEPS[0] rather than a literal, because
    // GeneralGroup writes WIZARD_STEPS[0] — a literal here goes stale the next
    // time the first step is renamed, which is exactly what happened when
    // "name" became "preflight".
    expect(updateMe).toHaveBeenCalledWith(
      expect.objectContaining({ setup: expect.objectContaining({ step: WIZARD_STEPS[0] }) }),
    );
    // The name is NOT cleared — this is a re-run, not a factory reset.
    expect(updateMe).not.toHaveBeenCalledWith(expect.objectContaining({ name: "" }));
  });
});
