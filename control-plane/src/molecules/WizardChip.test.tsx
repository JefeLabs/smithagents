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
});
