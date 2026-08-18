import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WizardGateStep } from "./WizardGateStep";

const setup = (over = {}) => {
  const onDone = vi.fn();
  render(<WizardGateStep initialName="" onDone={onDone} {...over} />);
  return { onDone, user: userEvent.setup() };
};

describe("WizardGateStep", () => {
  it("Anderson introduces himself before asking for anything", () => {
    setup();
    expect(screen.getByText(/hello! my name is anderson/i)).toBeInTheDocument();
    expect(screen.getByText(/anderson smith, but anderson is fine/i)).toBeInTheDocument();
  });

  it("asks in the first person, not as a form", () => {
    setup();
    expect(screen.getByLabelText(/what shall i call you/i)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /where would you like me to live/i })).toBeInTheDocument();
  });

  it("names what each choice means, not just its label", () => {
    setup();
    expect(screen.getByText(/i run right here, and i can use logins you already have/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing to install, i'm ready right away/i)).toBeInTheDocument();
  });

  it("cannot continue without a name", async () => {
    const { user } = setup();
    const go = screen.getByRole("button", { name: /nice to meet you/i });
    expect(go).toBeDisabled();
    await user.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    expect(go).toBeEnabled();
  });

  it("the cloud option carries aria-disabled, not just native disabled", () => {
    // toBeDisabled() alone does NOT discriminate: react-aria forces
    // `disabled: isDisabled` onto the input OUTSIDE the filterDOMProps
    // allowlist that drops aria-disabled, so a wrong RadioButtonGroup.Item
    // passes identically. Only aria-disabled — which the stylesheet's dimming
    // and pointer-events:none key off — tells them apart.
    setup();
    expect(screen.getByRole("radio", { name: /in the cloud/i })).toHaveAttribute("aria-disabled", "true");
  });

  it("the cloud option cannot be reached with arrow keys", async () => {
    // react-aria's roving-focus walker filters on `input:not([disabled])`;
    // aria-disabled never enters it. Without native `disabled`, ArrowDown lands
    // here and react-aria reads the focused input's `.value` — which defaults
    // to "on" for a value-less radio, corrupting `mode`.
    const { onDone, user } = setup({ initialName: "Edwin" });
    const machine = screen.getByRole("radio", { name: /on your machine/i });
    const cloud = screen.getByRole("radio", { name: /in the cloud/i });
    machine.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).not.toBe(cloud);
    await user.click(screen.getByRole("button", { name: /nice to meet you/i }));
    expect(onDone.mock.calls[0][0].setup.mode).toBe("local");
  });

  it("emits the mode explicitly, never omitted", async () => {
    // Setup MERGES: an omitted field keeps its previous value.
    const { onDone, user } = setup();
    await user.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await user.click(screen.getByRole("button", { name: /nice to meet you/i }));
    expect(onDone).toHaveBeenCalledWith({ name: "Edwin", setup: { mode: "local" } });
  });

  it("shows the name already given when returning to the gate", () => {
    setup({ initialName: "Edwin", initialMode: "local" });
    expect(screen.getByLabelText(/what shall i call you/i)).toHaveValue("Edwin");
  });

  it("hands back the typed name and chosen mode — composing the actual patch stays with the host", async () => {
    const onPickForMe = vi.fn();
    const { user } = setup({ onPickForMe });
    await user.type(screen.getByLabelText(/what shall i call you/i), "Edwin");
    await user.click(screen.getByRole("button", { name: /just pick sensible things for me/i }));
    expect(onPickForMe).toHaveBeenCalledWith("Edwin", "local");
  });

  it("still needs a name — it picks the other things, not that one", () => {
    setup({ onPickForMe: vi.fn() });
    expect(screen.getByRole("button", { name: /just pick sensible things for me/i })).toBeDisabled();
  });
});
