import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WizardChip } from "./WizardChip";

describe("WizardChip", () => {
  it("shows who I am and where I live", () => {
    render(<WizardChip name="Edwin" mode="local" clears={[]} onEdit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /anderson/i })).toHaveTextContent(/on your machine/i);
  });

  it("switches silently when nothing has been answered yet", async () => {
    const onEdit = vi.fn();
    render(<WizardChip name="Edwin" mode="local" clears={[]} onEdit={onEdit} />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    expect(onEdit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says specifically what changing it would clear, and does not clear until confirmed", async () => {
    const onEdit = vi.fn();
    render(<WizardChip name="Edwin" mode="local" clears={["where I think", "what I think with"]} onEdit={onEdit} />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    const dialog = await screen.findByRole("dialog");
    // "and says so specifically" — the named things, not a generic warning.
    expect(within(dialog).getByText(/where I think/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/what I think with/i)).toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: /change it/i }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("a generic warning is not enough — it names them", async () => {
    // Discriminates against a plausible wrong implementation that shows a
    // count or a blanket "you will lose your answers".
    render(<WizardChip name="Edwin" mode="local" clears={["voice"]} onEdit={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    expect(within(await screen.findByRole("dialog")).getByText(/voice/i)).toBeInTheDocument();
  });

  it("cannot start a change while the host's own write is still in flight", async () => {
    // The window `WizardSaveState` exists to close, and the chip is the one
    // control that can reach preflight from ANY step. With `clears` empty
    // there is no confirm dialog to slow the click down — `requestEdit` calls
    // `onEdit` straight through — so a live chip mid-write means two `PUT /me`
    // disagreeing about `step` in flight together, and whichever lands last
    // decides what the next reload resumes to.
    const onEdit = vi.fn();
    render(<WizardChip name="Edwin" mode="local" clears={[]} onEdit={onEdit} saveState="saving" />);

    const chip = screen.getByRole("button", { name: /anderson/i });
    expect(chip).toBeDisabled();
    // Disabled-looking is not the same as inert in this codebase — the click
    // has to actually not land.
    await userEvent.click(chip);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("is live again the moment that write is over, however it ended", async () => {
    // The other half, and the reason the guard reads `=== "saving"` rather
    // than `!== "idle"`: a write that FAILED is over, there is nothing left to
    // race, and a chip held shut past it strands the user with the same dead
    // end `WizardSaveState`'s own comment names. Both states asserted, because
    // a chip that is simply never disabled passes the "idle" half alone.
    const onEdit = vi.fn();
    const { rerender } = render(<WizardChip name="Edwin" mode="local" clears={[]} onEdit={onEdit} saveState="idle" />);
    expect(screen.getByRole("button", { name: /anderson/i })).toBeEnabled();

    rerender(<WizardChip name="Edwin" mode="local" clears={[]} onEdit={onEdit} saveState="failed" />);
    await userEvent.click(screen.getByRole("button", { name: /anderson/i }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("defaults to live when no host says otherwise", () => {
    // `saveState` is optional so a host with nothing in flight need not say
    // so — but the default has to be the permissive one, or every chip
    // rendered without it is dead.
    render(<WizardChip name="Edwin" mode="local" clears={[]} onEdit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /anderson/i })).toBeEnabled();
  });
});
