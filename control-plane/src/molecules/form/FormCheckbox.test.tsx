import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { FormCheckbox } from "./FormCheckbox";

interface Values {
  default: boolean;
}

function Harness({ onValues }: { onValues: (v: Values) => void }) {
  const { control, handleSubmit } = useForm<Values>({ defaultValues: { default: false } });
  return (
    <form onSubmit={handleSubmit(onValues)}>
      <FormCheckbox control={control} name="default" label="Default workspace" />
      <button type="submit">save</button>
    </form>
  );
}

function HiddenLabelHarness() {
  const { control } = useForm<Values>({ defaultValues: { default: false } });
  return <FormCheckbox control={control} name="default" label="Default workspace" labelHidden />;
}

describe("FormCheckbox", () => {
  it("writes a boolean, not a string or an event", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Default workspace" }));
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(expect.objectContaining({ default: true }), expect.anything());
  });

  it("labelHidden keeps the accessible name but renders no visible label", () => {
    render(<HiddenLabelHarness />);
    expect(screen.getByRole("checkbox", { name: "Default workspace" })).toBeDefined();
    expect(screen.queryByText("Default workspace")).toBeNull();
  });
});
