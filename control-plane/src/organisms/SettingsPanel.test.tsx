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
    expect(screen.getByText(/coming in the next task/i)).toBeDefined();
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

  it("renders nothing when closed", () => {
    const { container } = render(
      <SettingsPanel open={false} onClose={() => {}} onReset={vi.fn()} theme="dark" onThemeChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
