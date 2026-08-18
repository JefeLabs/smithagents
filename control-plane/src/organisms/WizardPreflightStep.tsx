import { Button } from "@heroui/react";
import { RadioButtonGroup } from "@heroui-pro/react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import type { Setup, SetupMode } from "../lib/wizardSteps";
import { FormTextField } from "../molecules/form";

interface PreflightFormValues {
  name: string;
}

export interface WizardPreflightStepProps {
  /** The user's current name, if the record already carries one — never the
      "You" placeholder fallback; the host is responsible for that guard. */
  initialName: string;
  initialMode?: SetupMode;
  onDone: (patch: { name: string; setup: Setup }) => void;
}

/** Non-blank after trimming — same rule NewContextModal's fields use. */
const filled = (v: string) => v.trim().length > 0;

/**
 * The wizard's one preflight screen: name and where this runs — the two
 * questions that decide *intent*, asked together because they select which
 * SETUP steps follow rather than belonging to a sequence of their own (see
 * wizardSteps.ts's file comment). This merges what used to be WizardNameStep
 * and WizardForkStep into a single controlled organism: props in,
 * `onDone(patch)` out, the host persists it.
 *
 * Voice used to be a third question here. The 2026-08-17 spec revision moves
 * it out entirely: what voice REQUIRES depends on the mode chosen below
 * (local voice needs `deepgram`/`elevenlabs` on this machine, cloud voice
 * plausibly needs neither), so asking it before mode is settled asks a
 * question whose meaning is not yet decided. It is also secondary to the
 * brain, so it resurfaces after *Set up Anderson*, in its own gated step —
 * see the Voice-step plan.
 *
 * The spec has the CLI probe start here, in the background, so the next
 * screen (Plan 2's subscriptions step) arrives already populated. NOT built
 * in this plan — that probe belongs with Plan 2's subscriptions step. This is
 * the seam it will hang off: kick it off beside `submit`, keyed on the typed
 * name, and hand its result forward via a second field on `onDone`'s patch.
 *
 * `onDone` always sends an explicit `mode`, never omits it — the server
 * persists setup by merging (`{...existing.setup, ...body.setup}`), so an
 * omitted field would keep whatever was recorded before rather than clearing
 * it.
 */
export function WizardPreflightStep({ initialName, initialMode = "local", onDone }: WizardPreflightStepProps) {
  const { control, handleSubmit } = useForm<PreflightFormValues>({ defaultValues: { name: initialName } });
  // Watched, not read from formState.errors: errors only exist after a
  // validation run, so gating on them would leave Continue enabled on a
  // pristine blank form — the second test's exact case.
  const name = useWatch({ control, name: "name" });

  const [mode, setMode] = useState<SetupMode>(initialMode);

  const submit = handleSubmit(({ name }) => onDone({ name: name.trim(), setup: { mode } }));

  return (
    <form className="wizard-fork-step" onSubmit={submit}>
      <FormTextField
        control={control}
        name="name"
        label="Your name"
        placeholder="e.g. Edwin"
        rules={{ validate: filled }}
      />

      {/*
       * Local vs Cloud. Local is enabled and default-selected; Cloud is
       * visible but disabled and labelled "coming soon" — a disabled control
       * someone actually wants, with no way forward, is the exact
       * frustration the spec calls out, so it always carries a `notify me`
       * link out to smithagents.com. The user-facing word is "Cloud"; the
       * value this emits stays `"hosted"` — that's the spec's own enum and
       * matches `lib/cloud.ts`.
       *
       * "Cloud" is hand-authored markup, not a `RadioButtonGroup.Item` —
       * verified against the installed source, not guessed. HeroUI's Radio
       * ultimately calls react-aria's `useRadio()`, whose `inputProps` (the
       * props that land on the actual `role="radio"` `<input>`) come from
       * `filterDOMProps(props, {labelable: true})`. That allowlist only lets
       * `aria-label`/`labelledby`/`describedby`/`details` through —
       * `aria-disabled` is in none of its buckets (not the labelable set, not
       * the global/data-* sets either), so it is silently dropped no matter
       * where in the compound API (`Radio`, `RadioButtonGroup.Item`) it is
       * passed. `isDisabled` only ever reaches the native `disabled`
       * attribute on that input — never `aria-disabled`. Since this
       * stylesheet's dimming and `pointer-events: none` are both keyed off
       * `aria-disabled` (not `disabled`), there is no prop combination on the
       * real component that produces the disabled Cloud option the spec
       * wants. So "Cloud" is a plain native `<input type="radio">` authored
       * directly (its implicit role needs no `role` attribute, and both
       * attributes below are mine to set), wrapped in its own `<label>` the
       * same way HeroUI's own Radio does — as a sibling inside the same
       * group. `RadioGroup` renders whatever children it's given, so a
       * hand-authored radio can sit right alongside the real
       * `RadioButtonGroup.Item` without a second, nested radiogroup.
       *
       * It carries BOTH `disabled` and `aria-disabled`, and this is not
       * redundant. `aria-disabled` alone is advisory: react-aria's own
       * arrow-key navigation (`useRadioGroup`'s `getNextElement`) walks the
       * DOM for ANY `<input type="radio">` inside the group and accepts it
       * if react-aria's `isFocusable()` says so — and that check's selector
       * is literally `input:not([disabled])`, `aria-disabled` never enters
       * it (verified against the installed source, not guessed). Without
       * native `disabled`, ArrowDown from "local" lands right here, and
       * react-aria reads the focused input's `.value` to select it — an
       * input with no `value` attribute defaults to `"on"`, corrupting
       * `mode` to an off-type value. `disabled` closes that; `aria-disabled`
       * is kept for the CSS hook and for AT that renders the two
       * differently.
       *
       * The `notify me` link is a sibling of the whole group, never a
       * descendant of the Cloud node — nesting it there would put it under
       * the same `aria-disabled` element and inherit `pointer-events: none`
       * with it.
       *
       * The `.wizard-fork-step__*` class names below are carried over from
       * the deleted WizardForkStep unchanged — see the plan's controller
       * ruling: WizardComingSoon (WizardGate.tsx, the compact/mobile screen)
       * still depends on `.wizard-fork-step__notify`, so those rules stay in
       * components.css even though this file replaces the component that
       * used to be their only reader.
       */}
      <div className="wizard-fork-step">
        <p className="wizard-fork-step__prompt" id="wizard-preflight-mode-prompt">
          Where do you want to run this?
        </p>
        <RadioButtonGroup
          aria-labelledby="wizard-preflight-mode-prompt"
          value={mode}
          // Narrowed, not cast: `disabled` on the Cloud input is the real
          // defense against ever getting here with an off-type value, but a
          // cast would be the seam that lets one slip past `mode`'s own type
          // — an unrecognized value is dropped rather than trusted.
          onChange={(value) => {
            if (value === "local" || value === "hosted") setMode(value);
          }}
          orientation="vertical"
        >
          <RadioButtonGroup.Item value="local">
            <RadioButtonGroup.Indicator />
            <RadioButtonGroup.ItemContent>
              <span className="wizard-fork-step__label">Local</span>
              <span className="wizard-fork-step__hint">Runs on this machine, using the CLIs you already have.</span>
            </RadioButtonGroup.ItemContent>
          </RadioButtonGroup.Item>

          {/* Hand-authored — see the file comment above for why.
              `aria-disabled` is repeated on the label purely as a CSS hook:
              it's what actually dims the row and cuts pointer-events on the
              whole clickable area, not just the tiny input. It adds no role
              of its own — a <label> has none — so the input stays the only
              "radio" in the group. */}
          <label className="wizard-fork-step__hosted" aria-disabled="true">
            <input
              type="radio"
              disabled
              aria-disabled="true"
              tabIndex={-1}
              className="wizard-fork-step__hosted-input"
            />
            <span className="wizard-fork-step__label">
              Cloud <span className="wizard-fork-step__badge">Coming soon</span>
            </span>
            <span className="wizard-fork-step__hint">no CLI to install, works on any device</span>
          </label>
        </RadioButtonGroup>

        <a className="wizard-fork-step__notify" href="https://smithagents.com" target="_blank" rel="noreferrer">
          → notify me
        </a>
      </div>

      {/* `.wizard-gate__footer` is the wizard's shared footer band (see
          components.css) — the divider and spacing live on it, and on a step
          tall enough to scroll the panel it sticks to the panel's bottom edge
          so Continue never drops below the fold. */}
      <div className="wizard-gate__footer">
        <Button type="submit" variant="primary" isDisabled={!filled(name ?? "")}>
          Continue
        </Button>
      </div>
    </form>
  );
}
