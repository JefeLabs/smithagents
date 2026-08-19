import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { Setup } from "../lib/wizardSteps";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardMemoryStep } from "./WizardMemoryStep";

afterEach(cleanup);

const PATH = "~/.smithagents";
const base = { storagePath: PATH, onDone: () => {} };

describe("WizardMemoryStep", () => {
  it("opens remembering, with every permission asking first", () => {
    renderWithProviders(<WizardMemoryStep {...base} />);
    expect(screen.getByRole("radio", { name: /remember me/i })).toBeChecked();
    for (const cap of [/read your files/i, /run commands/i, /browse the web/i]) {
      const group = screen.getByRole("group", { name: cap });
      expect(within(group).getByRole("radio", { name: /ask first/i })).toBeChecked();
    }
  });

  it("renders NO download control — the capability does not exist yet", () => {
    renderWithProviders(<WizardMemoryStep {...base} />);
    // Ruling 1: the question is asked, the capability is deferred. A button
    // that downloads nothing is a dead control.
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    expect(screen.queryByText(/90\s*MB/i)).toBeNull();
  });

  it("shows where things are kept, and does not offer to move them", () => {
    renderWithProviders(<WizardMemoryStep {...base} />);
    expect(screen.getByText(PATH)).toBeTruthy();
    // Ruling 3: relocating a live state root is not a wizard-sized change.
    expect(screen.queryByRole("textbox", { name: /where/i })).toBeNull();
  });

  it("sends every answer explicitly, even when all are the defaults", async () => {
    const user = userEvent.setup();
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardMemoryStep {...base} onDone={(p) => patches.push(p)} />);

    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].setup).toMatchObject({
      remember: true,
      deeperRecall: false,
      permissions: { readFiles: "ask", runCommands: "ask", browseWeb: "ask" },
    });
  });

  it("carries a changed stance through, per capability", async () => {
    const user = userEvent.setup();
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardMemoryStep {...base} onDone={(p) => patches.push(p)} />);

    const runGroup = screen.getByRole("group", { name: /run commands/i });
    await user.click(within(runGroup).getByRole("radio", { name: /never/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].setup.permissions).toEqual({
      readFiles: "ask",
      runCommands: "never",
      browseWeb: "ask",
    });
  });

  it("declining to remember still sends remember:false explicitly", async () => {
    const user = userEvent.setup();
    const patches: Array<{ setup: Setup }> = [];
    renderWithProviders(<WizardMemoryStep {...base} onDone={(p) => patches.push(p)} />);

    await user.click(screen.getByRole("radio", { name: /start fresh/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].setup).toMatchObject({ remember: false });
  });

  it("a resumed record seeds every answer", () => {
    renderWithProviders(
      <WizardMemoryStep
        {...base}
        initialRemember={false}
        initialDeeperRecall={true}
        initialPermissions={{ readFiles: "allow", runCommands: "never", browseWeb: "ask" }}
      />,
    );
    expect(screen.getByRole("radio", { name: /start fresh/i })).toBeChecked();
    const readGroup = screen.getByRole("group", { name: /read your files/i });
    expect(within(readGroup).getByRole("radio", { name: /go ahead/i })).toBeChecked();
  });
});
