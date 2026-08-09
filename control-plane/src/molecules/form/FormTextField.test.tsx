import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type RegisterOptions, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { FormTextField } from "./FormTextField";

interface Values {
  name: string;
  bio: string;
}

function Harness({ onValues }: { onValues: (v: Values) => void }) {
  const { control, handleSubmit } = useForm<Values>({
    mode: "onChange",
    defaultValues: { name: "", bio: "" },
  });
  return (
    <form onSubmit={handleSubmit(onValues)}>
      <FormTextField control={control} name="name" label="Workspace name" placeholder="acme" />
      <FormTextField control={control} name="bio" label="Description" multiline rows={3} />
      <button type="submit">save</button>
    </form>
  );
}

function HiddenLabelHarness() {
  const { control } = useForm<Values>({
    mode: "onChange",
    defaultValues: { name: "", bio: "" },
  });
  return <FormTextField control={control} name="name" label="Workspace name" placeholder="acme" labelHidden />;
}

function HarnessWithRule({ rules }: { rules: RegisterOptions<Values, "name"> }) {
  const { control, handleSubmit } = useForm<Values>({
    mode: "onChange",
    defaultValues: { name: "", bio: "" },
  });
  return (
    <form onSubmit={handleSubmit(vi.fn())}>
      <FormTextField control={control} name="name" label="Workspace name" rules={rules} />
      <button type="submit">save</button>
    </form>
  );
}

function HarnessWithReset() {
  const { control, reset } = useForm<Values>({
    mode: "onChange",
    defaultValues: { name: "", bio: "" },
  });
  return (
    <>
      <FormTextField control={control} name="name" label="Workspace name" />
      <button type="button" onClick={() => reset()}>
        reset
      </button>
    </>
  );
}

describe("FormTextField", () => {
  // This is the assertion the whole phase turns on. HeroUI's TextField calls
  // onChange with a STRING, not a DOM event. If RHF ever stops unwrapping a bare
  // value, this test fails and every migrated form is silently writing undefined.
  it("writes typed text into the form model, not undefined", async () => {
    const onValues = vi.fn();
    render(<Harness onValues={onValues} />);

    await userEvent.type(screen.getByLabelText("Workspace name"), "acme");
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(onValues).toHaveBeenCalledWith(expect.objectContaining({ name: "acme" }), expect.anything());
  });

  it("renders a textarea when multiline, an input otherwise", () => {
    render(<Harness onValues={vi.fn()} />);
    expect(screen.getByLabelText("Workspace name").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Description").tagName).toBe("TEXTAREA");
  });

  it("associates the label with the control so getByLabelText resolves", () => {
    render(<Harness onValues={vi.fn()} />);
    expect(screen.getByLabelText("Workspace name")).toHaveAttribute("placeholder", "acme");
  });

  it("labelHidden keeps the accessible name but renders no visible label", () => {
    render(<HiddenLabelHarness />);
    // getByLabelText matches aria-label too, so tests query the same way either mode.
    expect(screen.getByLabelText("Workspace name")).toBeDefined();
    expect(screen.queryByText("Workspace name")).toBeNull();
  });

  it("surfaces a validator's message, which react-aria's FieldError cannot derive on its own", async () => {
    render(
      <HarnessWithRule rules={{ validate: (v: string) => v.trim().length > 0 || "Workspace name is required" }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    expect(await screen.findByText("Workspace name is required")).toBeDefined();
  });

  it('reset() clears the input — the ?? "" guard keeps the field controlled', async () => {
    render(<HarnessWithReset />);
    await userEvent.type(screen.getByLabelText("Workspace name"), "acme");
    await userEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(screen.getByLabelText("Workspace name")).toHaveValue("");
  });
});
