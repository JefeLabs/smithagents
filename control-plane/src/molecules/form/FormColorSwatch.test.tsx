import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_PALETTE } from "../../lib/workspace-color";
import { FormColorSwatch } from "./FormColorSwatch";

interface Values {
  color: string;
}

function Harness({ onValues, initial = "" }: { onValues: (v: Values) => void; initial?: string }) {
  const { control, handleSubmit } = useForm<Values>({ defaultValues: { color: initial } });
  return (
    <form onSubmit={handleSubmit(onValues)}>
      <FormColorSwatch control={control} name="color" label="Colour" />
      <button type="submit">save</button>
    </form>
  );
}

describe("FormColorSwatch", () => {
  it("writes the picked palette colour as a plain hex string", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} />);

    // ColorSwatchPicker is a react-aria ListBox in single-select mode, not a
    // radio group — items render with role="option", not role="radio".
    await userEvent.click(screen.getByRole("option", { name: "Colour 1" }));
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(expect.objectContaining({ color: WORKSPACE_PALETTE[0] }), expect.anything());
  });

  // The behaviour NewWorkspaceModal.tsx:165 defends: a picked swatch must be
  // un-pickable. The sentinel must never reach the form model.
  it("maps the transparent sentinel back to an empty string, so a colour can be unpicked", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} initial={WORKSPACE_PALETTE[2]} />);

    await userEvent.click(screen.getByRole("option", { name: "No colour" }));
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(expect.objectContaining({ color: "" }), expect.anything());
  });

  it("selects the stored colour when the form is seeded from a record", () => {
    render(<Harness onValues={vi.fn()} initial={WORKSPACE_PALETTE[3]} />);
    // The listbox/option pattern marks selection with aria-selected, not
    // aria-checked — .toBeChecked() only recognizes the latter and throws.
    expect(screen.getByRole("option", { name: "Colour 4" })).toHaveAttribute("aria-selected", "true");
  });
});
