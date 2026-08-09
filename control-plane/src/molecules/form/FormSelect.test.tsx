import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { FormSelect } from "./FormSelect";

interface Values {
  connectorId: string;
}

const OPTIONS = [
  { id: "c1", label: "acme-gh" },
  { id: "c2", label: "personal-gh" },
];

function Harness({ onValues }: { onValues: (v: Values) => void }) {
  const { control, handleSubmit } = useForm<Values>({ defaultValues: { connectorId: "" } });
  return (
    <form onSubmit={handleSubmit(onValues)}>
      <FormSelect
        control={control}
        name="connectorId"
        label="GitHub connector"
        placeholder="pick a connector…"
        options={OPTIONS}
      />
      <button type="submit">save</button>
    </form>
  );
}

function HiddenLabelHarness() {
  const { control } = useForm<Values>({ defaultValues: { connectorId: "" } });
  return (
    <FormSelect
      control={control}
      name="connectorId"
      label="GitHub connector"
      placeholder="pick a connector…"
      options={OPTIONS}
      labelHidden
    />
  );
}

describe("FormSelect", () => {
  it("writes the chosen option's id into the form model", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} />);

    await userEvent.click(screen.getByRole("button", { name: /GitHub connector/i }));
    await userEvent.click(await screen.findByRole("option", { name: "personal-gh" }));
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(expect.objectContaining({ connectorId: "c2" }), expect.anything());
  });

  it("shows the placeholder while the field is empty", () => {
    render(<Harness onValues={vi.fn()} />);
    expect(screen.getByText("pick a connector…")).toBeDefined();
  });

  it("labelHidden keeps the accessible name but renders no visible label", () => {
    render(<HiddenLabelHarness />);
    // react-aria's trigger composes its name from the value span plus
    // aria-label, so the accessible name is "<value> GitHub connector" —
    // a regex match, same as the primary test above, not an exact string.
    expect(screen.getByRole("button", { name: /GitHub connector/i })).toBeDefined();
    expect(screen.queryByText("GitHub connector")).toBeNull();
  });
});
