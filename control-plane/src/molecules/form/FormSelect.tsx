import { Label, ListBox, Select } from "@heroui/react";
import { type Control, type FieldPath, type FieldValues, type RegisterOptions, useController } from "react-hook-form";

interface FormSelectProps<T extends FieldValues, TName extends FieldPath<T> = FieldPath<T>> {
  control: Control<T>;
  name: TName;
  label: string;
  /** Same contract as FormTextField's — see Task 1. Both GitHub-connector selects
      use a bare aria-label today (NewWorkspaceModal.tsx:205,
      WorkspaceManagerModal.tsx:472), so both pass this. */
  labelHidden?: boolean;
  /** Shown while the field is `""`. The old markup's disabled first <option>. */
  placeholder: string;
  options: Array<{ id: string; label: string }>;
  /** Parameterized over `TName` — see `FormTextField`'s `rules` doc for why. */
  rules?: RegisterOptions<T, TName>;
}

/**
 * Same seam as FormTextField. Three differences worth knowing:
 *
 * 1. react-aria's Select is also `value`/`onChange`, but `value` is a `Key`
 *    (string | number) or `null` in single-selection mode, not a bare string.
 *    The `String()` coercion on the way back into the form keeps the model
 *    all-strings, which is what `toRecord` assumes.
 * 2. `""` is not a valid Key — react-aria treats it as "nothing selected". So
 *    the empty form value maps to `null`, and the placeholder renders. That is
 *    the same behaviour the old disabled `<option value="">` produced.
 * 3. Options render through `ListBox`/`ListBox.Item`, not a `Select`-owned
 *    list — `Select.Popover` just hosts a `ListBox` like any other picker.
 */
export function FormSelect<T extends FieldValues, TName extends FieldPath<T> = FieldPath<T>>({
  control,
  name,
  label,
  labelHidden = false,
  placeholder,
  options,
  rules,
}: FormSelectProps<T, TName>) {
  const { field, fieldState } = useController({ control, name, rules });
  const current = (field.value as string | undefined) ?? "";
  return (
    <Select
      name={field.name}
      value={current === "" ? null : current}
      onChange={(key) => field.onChange(key == null ? "" : String(key))}
      onBlur={field.onBlur}
      isInvalid={fieldState.invalid}
      placeholder={placeholder}
      aria-label={labelHidden ? label : undefined}
    >
      {!labelHidden && <Label>{label}</Label>}
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((o) => (
            <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
              {o.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
