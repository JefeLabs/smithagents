/**
 * The SHARED context-editor panes (Edwin, 2026-08-12: "a group is just a
 * workspace containing other workspaces or groups") — one component family
 * for the fields workspaces and groups have in common, so the two editors
 * cannot drift apart. The fork stays where it means something: repos make a
 * workspace, members make a group; neither lives here.
 *
 * Field-name contract (every consuming form declares these exact names):
 *   name, description, color            — ContextIdentityFields
 *   sprintEnabled, sprintWeekday, sprintLength — SprintFilterFields
 */
import type { Control, FieldValues, Path, PathValue } from "react-hook-form";
import { useWatch } from "react-hook-form";
import { WEEKDAYS, weekdayToAnchor } from "../../lib/dateRange";
import { FormCheckbox } from "./FormCheckbox";
import { FormColorSwatch } from "./FormColorSwatch";
import { FormSelect } from "./FormSelect";
import { FormTextField } from "./FormTextField";

/** Non-blank after trimming — the same gate every context form uses on `name`. */
const filled = (v: string) => v.trim().length > 0;

interface ContextIdentityFieldsProps<T extends FieldValues> {
  control: Control<T>;
  /** "Workspace name" / "Group name" — the one wording difference between the twins. */
  nameLabel: string;
  namePlaceholder: string;
  /** Names are file keys and pin/dispatch targets — immutable once created. */
  nameDisabled?: boolean;
  descriptionPlaceholder?: string;
}

/** Name, description, colour — a context's identity, identical for both kinds. */
export function ContextIdentityFields<T extends FieldValues>({
  control,
  nameLabel,
  namePlaceholder,
  nameDisabled,
  descriptionPlaceholder,
}: ContextIdentityFieldsProps<T>) {
  return (
    <>
      <FormTextField
        control={control}
        name={"name" as Path<T>}
        label={nameLabel}
        placeholder={namePlaceholder}
        rules={{ validate: filled as (v: PathValue<T, Path<T>>) => boolean }}
        isDisabled={nameDisabled}
      />
      <FormTextField
        control={control}
        name={"description" as Path<T>}
        label="Description"
        placeholder={descriptionPlaceholder ?? "What this context is for"}
      />
      <FormColorSwatch control={control} name={"color" as Path<T>} label="Colour" />
    </>
  );
}

/**
 * The Sprint Filter (date-range spec 2026-08-12): opt-in toggle revealing the
 * REQUIRED start weekday + length. Consumers enforce the requirement at
 * submit (refuse, don't silently drop) — this component only renders.
 */
export function SprintFilterFields<T extends FieldValues>({ control }: { control: Control<T> }) {
  const enabled = useWatch({ control, name: "sprintEnabled" as Path<T> });
  return (
    <div className="context-sprint">
      <FormCheckbox control={control} name={"sprintEnabled" as Path<T>} label="Sprint Filter" />
      {Boolean(enabled) && (
        <>
          <FormSelect
            control={control}
            name={"sprintWeekday" as Path<T>}
            label="Sprint starts on"
            placeholder="pick a day…"
            options={WEEKDAYS.map((w) => ({ id: String(w.iso), label: w.label }))}
          />
          <FormTextField
            control={control}
            name={"sprintLength" as Path<T>}
            label="Sprint length (days)"
            placeholder="14"
          />
        </>
      )}
    </div>
  );
}

/** The shared submit-side rule: ON requires both fields; OFF is no sprint. Returns undefined AND an error flag via null. */
export function sprintFromForm(v: {
  sprintEnabled: boolean;
  sprintWeekday: string;
  sprintLength: string;
}): { sprint?: { anchor: string; lengthDays: number } } | { error: string } {
  if (!v.sprintEnabled) return {};
  const weekday = Number.parseInt(v.sprintWeekday, 10);
  const lengthDays = Number.parseInt(v.sprintLength, 10);
  if (!Number.isInteger(weekday) || !Number.isInteger(lengthDays) || lengthDays <= 0) {
    return { error: "Sprint Filter needs a start day and a length in days" };
  }
  return { sprint: { anchor: weekdayToAnchor(weekday), lengthDays } };
}
