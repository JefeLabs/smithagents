import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

describe("SettingsPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens on the General group by default and renders reset options", () => {
    render(<SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /general/i })).toBeDefined();
    expect(screen.getByText(/kill running instances/i)).toBeDefined();
  });

  it("opens on Integrations directly when initialGroup is set (avatar deep-link)", () => {
    render(
      <SettingsPanel
        open
        onClose={() => {}}
        onReset={vi.fn()}
        theme="dark"
        onThemeChange={vi.fn()}
        initialGroup="integrations"
      />,
    );
    expect(screen.getByText(/not wired up yet/i)).toBeDefined();
  });

  it("clicking a nav group switches the visible content", async () => {
    render(<SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /themes/i }));
    expect(screen.getAllByText(/dark|light/i).length).toBeGreaterThan(0); // theme chips render
  });

  it("back to app calls onClose", async () => {
    const onClose = vi.fn();
    render(<SettingsPanel open onClose={onClose} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /back to app/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("re-opening the SAME instance with a different initialGroup switches groups (avatar deep-link, after Settings was opened via the rail button first)", async () => {
    // HomePage.tsx keeps SettingsPanel always mounted (open just toggles rendering, same
    // convention as every other overlay), so it never remounts between opens — a stale
    // `useState(initialGroup)` would only ever honor the FIRST open's value and silently
    // ignore every later one. This is the "rail Settings, then avatar" sequence exactly.
    const { rerender } = render(
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
    expect(await screen.findByText(/not wired up yet/i)).toBeDefined();
    expect(screen.queryByText(/kill running instances/i)).toBeNull(); // not stuck on General
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <SettingsPanel open={false} onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("groups the nav under App / Agents / Workspace headings with API Keys under Agents", () => {
    render(<SettingsPanel open onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />);
    for (const heading of ["App", "Agents", "Workspace"]) {
      expect(screen.getByText(heading)).toBeDefined();
    }
    expect(screen.getByRole("button", { name: /api keys/i })).toBeDefined();
  });

  it("opens the API Keys group and renders its cards when wired", async () => {
    render(
      <SettingsPanel
        open
        onClose={() => {}}
        onReset={vi.fn()}
        theme="dark"
        onThemeChange={vi.fn()}
        initialGroup="api-keys"
        listApiKeys={async () => []}
        saveApiKey={vi.fn()}
        verifyApiKey={vi.fn()}
        deleteApiKey={vi.fn()}
      />,
    );
    expect(await screen.findByRole("heading", { name: /api keys/i })).toBeDefined();
  });
});
