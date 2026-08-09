import { Checkbox } from "@heroui/react";
import { type Control, type FieldPath, type FieldValues, useController } from "react-hook-form";

interface FormCheckboxProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  /** Same contract as FormTextField's — see Task 1. No current usage needs it
      (WorkspaceManagerModal's one checkbox keeps a visible label), but the
      seam should not be narrower than the other two adapters'. */
  labelHidden?: boolean;
}

/**
 * react-aria's Checkbox is `isSelected`/`onChange(boolean)` — note that unlike
 * TextField the handler already hands back the right primitive, so this
 * adapter is only here to keep organisms free of `useController` boilerplate.
 *
 * The anatomy is deeper than a single element: the clickable label lives in
 * `Checkbox.Content`, which wraps `Checkbox.Control`/`Checkbox.Indicator` (the
 * box itself) and the label text as a sibling. With `labelHidden` the text is
 * dropped and `aria-label` on the root carries the accessible name instead —
 * the checkbox docs' own recipe for a label-less checkbox.
 */
export function FormCheckbox<T extends FieldValues>({
  control,
  name,
  label,
  labelHidden = false,
}: FormCheckboxProps<T>) {
  const { field } = useController({ control, name });
  return (
    <Checkbox
      name={field.name}
      isSelected={Boolean(field.value)}
      onChange={field.onChange}
      onBlur={field.onBlur}
      aria-label={labelHidden ? label : undefined}
    >
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
        {!labelHidden && label}
      </Checkbox.Content>
    </Checkbox>
  );
}
