import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WizardNameStep } from "./WizardNameStep";

describe("WizardNameStep", () => {
  it("creates the user record and advances", async () => {
    const onDone = vi.fn();
    render(<WizardNameStep initialName="" onDone={onDone} />);

    await userEvent.type(screen.getByLabelText(/name/i), "Edwin");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ name: "Edwin" }));
  });

  it("will not continue on a blank name", async () => {
    const onDone = vi.fn();
    render(<WizardNameStep initialName="" onDone={onDone} />);

    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(onDone).not.toHaveBeenCalled();
  });
});
