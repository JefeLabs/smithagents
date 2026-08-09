import { Description, FieldError, Input, Label, TextArea, TextField } from "@heroui/react";
import type { ReactNode } from "react";
import { type Control, type FieldPath, type FieldValues, type RegisterOptions, useController } from "react-hook-form";

interface FormTextFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  placeholder?: string;
  /** Renders a TextArea instead of an Input. */
  multiline?: boolean;
  rows?: number;
  /** Secondary text under the label — the old `.wizard__hint` span. */
  hint?: ReactNode;
  rules?: RegisterOptions<T, FieldPath<T>>;
  /**
   * Renders the accessible name without a visible <Label>. The dense rows this
   * adapter has to serve — repo rows, Atlassian keys — name their fields by
   * placeholder today and have no visible label. Rendering one would change
   * their layout, which Task 6 is screenshot-gated against.
   */
  labelHidden?: boolean;
}

/**
 * The react-hook-form ↔ react-aria seam.
 *
 * HeroUI's TextField is a react-aria controlled component: `onChange` is
 * `(value: string) => void`, NOT a DOM event handler. That is why `register()`
 * cannot be spread onto it — `register().onChange` reads `event.target.value`
 * and would receive a bare string.
 *
 * `useController`'s `field.onChange` accepts either shape: RHF checks
 * `isObject(event) && event.target` before unwrapping, so a plain string passes
 * straight through. `FormTextField.test.tsx` asserts exactly that, so a future
 * RHF release that tightened the check would fail loudly here rather than
 * silently writing `undefined` into every migrated form.
 */
export function FormTextField<T extends FieldValues>({
  control,
  name,
  label,
  placeholder,
  multiline = false,
  rows,
  hint,
  rules,
  labelHidden = false,
}: FormTextFieldProps<T>) {
  const { field, fieldState } = useController({ control, name, rules });
  return (
    <TextField
      name={field.name}
      // `?? ""` keeps the field controlled from the first render. An undefined
      // value flips react-aria to uncontrolled mode and it never flips back —
      // the input then ignores `reset()` for the life of the mount.
      value={(field.value as string | undefined) ?? ""}
      onChange={field.onChange}
      onBlur={field.onBlur}
      isInvalid={fieldState.invalid}
      aria-label={labelHidden ? label : undefined}
    >
      {!labelHidden && <Label>{label}</Label>}
      {multiline ? (
        <TextArea ref={field.ref} placeholder={placeholder} rows={rows} />
      ) : (
        <Input ref={field.ref} placeholder={placeholder} />
      )}
      {hint != null && <Description>{hint}</Description>}
      {/* Children are REQUIRED. react-aria's FieldError renders its own validation
          context, and RHF's errors are invisible to it — a bare <FieldError /> is a
          permanently empty error region. Passing the message explicitly is the only
          thing that connects the two validation systems. */}
      <FieldError>{fieldState.error?.message}</FieldError>
    </TextField>
  );
}
