import { Button } from "@heroui/react";
import { useForm, useWatch } from "react-hook-form";
import { FormTextField } from "../molecules/form";

interface NameFormValues {
  name: string;
}

export interface WizardNameStepProps {
  /** The user's current name, if the record already carries one — never the
      "You" placeholder fallback; the host is responsible for that guard. */
  initialName: string;
  onDone: (patch: { name: string }) => void;
}

/** Non-blank after trimming — same rule NewContextModal's fields use. */
const filled = (v: string) => v.trim().length > 0;

/**
 * The wizard's first step: just a name. Controlled organism — props in,
 * `onDone(patch)` out; the host persists it.
 *
 * The spec has the CLI probe start here, in the background, so the next
 * screen (Plan 2's subscriptions step) arrives already populated. NOT built
 * in this plan — that probe belongs with Plan 2's subscriptions step. This is
 * the seam it will hang off: kick it off beside `submit`, keyed on the typed
 * name, and hand its result forward via a second field on `onDone`'s patch.
 */
export function WizardNameStep({ initialName, onDone }: WizardNameStepProps) {
  const { control, handleSubmit } = useForm<NameFormValues>({ defaultValues: { name: initialName } });
  // Watched, not read from formState.errors: errors only exist after a
  // validation run, so gating on them would leave Continue enabled on a
  // pristine blank form — the second test's exact case.
  const name = useWatch({ control, name: "name" });

  const submit = handleSubmit(({ name }) => onDone({ name: name.trim() }));

  return (
    <form className="wizard-name-step" onSubmit={submit}>
      <FormTextField
        control={control}
        name="name"
        label="Your name"
        placeholder="e.g. Edwin"
        rules={{ validate: filled }}
      />
      <Button type="submit" variant="primary" isDisabled={!filled(name ?? "")}>
        Continue
      </Button>
    </form>
  );
}
