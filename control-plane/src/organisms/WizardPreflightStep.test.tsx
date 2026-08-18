import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WizardPreflightStep } from "./WizardPreflightStep";

const setup = (over = {}) => {
  const onDone = vi.fn();
  render(<WizardPreflightStep initialName="" onDone={onDone} {...over} />);
  return { onDone, user: userEvent.setup() };
};

describe("WizardPreflightStep", () => {
  it("asks all three questions on one screen", () => {
    setup();
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /voice/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /local/i })).toBeInTheDocument();
  });

  it("requires a name — the record cannot be created without one", async () => {
    const { user } = setup();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/your name/i), "Edwin");
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  it("offers Cloud but cannot let it be chosen", () => {
    setup();
    const cloud = screen.getByRole("radio", { name: /cloud/i });
    // Native `disabled`, not aria-disabled alone: react-aria's roving-focus
    // walker filters on input:not([disabled]), so aria-disabled alone would
    // leave this arrow-key reachable and selectable.
    expect(cloud).toBeDisabled();
  });

  it("emits voice explicitly as false when not chosen, never omitted", async () => {
    // Setup MERGES: an omitted field keeps its previous value, so a user who
    // goes back and turns voice OFF must send false, not nothing.
    const { onDone, user } = setup({ initialName: "Edwin", initialVoice: true });
    await user.click(screen.getByRole("radio", { name: /^no$/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ setup: expect.objectContaining({ voice: false }) }));
  });

  it("emits the name, the voice answer and the mode together", async () => {
    const { onDone, user } = setup();
    await user.type(screen.getByLabelText(/your name/i), "Edwin");
    await user.click(screen.getByRole("radio", { name: /^yes$/i }));
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onDone).toHaveBeenCalledWith({ name: "Edwin", setup: { voice: true, mode: "local" } });
  });

  it("seeds from prior answers so going back shows what was chosen", () => {
    setup({ initialName: "Edwin", initialVoice: true, initialMode: "local" });
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Edwin");
    expect(screen.getByRole("radio", { name: /^yes$/i })).toBeChecked();
  });
});
