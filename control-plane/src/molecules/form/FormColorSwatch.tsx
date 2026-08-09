import { ColorSwatchPicker, Label, parseColor } from "@heroui/react";
import { type Control, type FieldPath, type FieldValues, useController } from "react-hook-form";
import { NO_COLOR_SENTINEL, WORKSPACE_PALETTE } from "../../lib/workspace-color";

interface FormColorSwatchProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
}

/**
 * Workspace identity colour.
 *
 * The form model stores a plain hex string, `""` meaning "no colour" — that is
 * what `toRecord` and `PUT /workspaces/:name` expect, and it is unchanged here.
 * react-aria controls this component with a `Color` object instead, and has no
 * representation for "nothing picked", so the empty string is carried across the
 * seam as a fully transparent swatch (`NO_COLOR_SENTINEL`) and converted back on
 * the way in. Nothing outside this file ever sees the sentinel.
 *
 * `Color#toString("hex" | "hexa")` renders uppercase (`"#5FD0B0"`), but
 * `WORKSPACE_PALETTE` and the stored form value are lowercase — `.toLowerCase()`
 * on the way out keeps the round trip byte-identical with what was picked.
 */
export function FormColorSwatch<T extends FieldValues>({ control, name, label }: FormColorSwatchProps<T>) {
  const { field } = useController({ control, name });
  const stored = (field.value as string | undefined) ?? "";

  return (
    <>
      <Label>{label}</Label>
      <ColorSwatchPicker
        aria-label={label}
        value={parseColor(stored === "" ? NO_COLOR_SENTINEL : stored)}
        onChange={(color) => {
          const hexa = color.toString("hexa").toLowerCase();
          field.onChange(hexa === NO_COLOR_SENTINEL ? "" : color.toString("hex").toLowerCase());
        }}
      >
        <ColorSwatchPicker.Item color={NO_COLOR_SENTINEL} aria-label="No colour">
          <ColorSwatchPicker.Swatch />
          <ColorSwatchPicker.Indicator />
        </ColorSwatchPicker.Item>
        {WORKSPACE_PALETTE.map((c, i) => (
          <ColorSwatchPicker.Item key={c} color={c} aria-label={`Colour ${i + 1}`}>
            <ColorSwatchPicker.Swatch />
            <ColorSwatchPicker.Indicator />
          </ColorSwatchPicker.Item>
        ))}
      </ColorSwatchPicker>
    </>
  );
}
