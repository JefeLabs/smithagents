import { Button } from "@heroui/react";
import { RadioButtonGroup } from "@heroui-pro/react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import type { Setup, SetupMode, WizardSaveState } from "../lib/wizardSteps";
import { FormTextField } from "../molecules/form";

interface GateFormValues {
  name: string;
}

export interface WizardGateStepProps {
  /** The user's current name, if the record already carries one — never the
      "You" placeholder fallback; the host is responsible for that guard. */
  initialName: string;
  initialMode?: SetupMode;
  onDone: (patch: { name: string; setup: Setup }) => void;
  /** "Just pick sensible things for me" calls this when given, with the
      typed name and the chosen mode — this component's own answers so far.
      It does NOT compose the finishing patch itself: WizardGate reads the
      step registry (`stepsFor` in wizardSteps.ts) and merges every step's
      stated default, so there is exactly one place that reads that
      registry, never a second, hand-rolled set of defaults here that could
      drift from it. Absent for any caller that doesn't want the shortcut,
      which is what leaves the button unrendered rather than merely inert. */
  onPickForMe?: (name: string, mode: SetupMode) => void;
  /**
   * What became of the host's own last `PUT /me` — same prop, same meaning, as
   * `WizardBrainStepProps["saveState"]`.
   *
   * Needed here for the reason the LAST step needs it, and it is easy to miss
   * that this step has that shape too: "just pick sensible things for me"
   * FINISHES setup rather than advancing, and `advance`'s `finish` branch
   * computes no next step — so nothing swaps this component out, and both
   * controls below stay live behind a `PUT {step:"done"}` that is still in
   * flight. A click on the primary then sends `PUT {step:"subscriptions"}`
   * against it, and the landing order decides whether the app opens with the
   * screen still on the gate or setup reopens the moment it finished.
   */
  saveState?: WizardSaveState;
}

/** Non-blank after trimming — same rule NewContextModal's fields use. */
const filled = (v: string) => v.trim().length > 0;

/**
 * The wizard's opening screen: Anderson introduces himself, then asks the two
 * questions that decide *intent* — name, and where he'll live — together,
 * because they select which SETUP steps follow rather than belonging to a
 * sequence of their own (see wizardSteps.ts's file comment). Same merged
 * organism WizardPreflightStep was (itself a merge of WizardNameStep and
 * WizardForkStep): props in, `onDone(patch)` out, the host persists it. What
 * changed in the 2026-08-18 spec revision is the voice — first person
 * throughout, asking rather than instructing, opening with who's asking
 * before asking anything of the user.
 *
 * Voice used to be a third question here. It moved out entirely: what voice
 * REQUIRES depends on the mode chosen below (local voice needs
 * `deepgram`/`elevenlabs` on this machine, cloud voice plausibly needs
 * neither), so asking it before mode is settled asks a question whose
 * meaning is not yet decided. It is also secondary to the brain, so it
 * resurfaces after *Set up Anderson*, in its own gated step — see the
 * Voice-step plan.
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
export function WizardGateStep({
  initialName,
  initialMode = "local",
  onDone,
  onPickForMe,
  saveState = "idle",
}: WizardGateStepProps) {
  const { control, handleSubmit } = useForm<GateFormValues>({ defaultValues: { name: initialName } });
  // Watched, not read from formState.errors: errors only exist after a
  // validation run, so gating on them would leave Continue enabled on a
  // pristine blank form — the fourth test's exact case.
  const name = useWatch({ control, name: "name" });

  const [mode, setMode] = useState<SetupMode>(initialMode);
  // `=== "saving"` and never `!== "idle"`: a refused write rolls the host back
  // to THIS step with the server's reason on screen, and a gate whose only two
  // controls stayed shut past that would leave the opening screen of first-run
  // setup with nothing to click. Same reading, same reason, as every other
  // guard in this feature.
  const writing = saveState === "saving";

  const submit = handleSubmit(({ name }) => onDone({ name: name.trim(), setup: { mode } }));

  return (
    <form className="wizard-fork-step" onSubmit={submit}>
      {/* Anderson's own introduction, above the questions — and its first
          line is this screen's `<h1>`, the only one on it. The host used to
          render a generic "Welcome" above these two lines at 26px while they
          sat at 15px, the same weight as the field label directly below, so
          the largest words on the product's opening screen were a word
          nobody said and the introduction was typeset as though it were
          another form label. WizardGate now withholds its heading on this
          step precisely so this can be it (see the comment there); the
          promotion is a heading level and a type size, NOT a rewrite — the
          copy is the spec's own, and `36a5eb2` already settled that the
          second line is the spec's supporting line rather than a synthesis
          of it. That second line stays prose beneath the heading: it is
          Anderson still talking, not a subtitle for a form.

          Everything below this is still the steps' `<h2>` tier, so the
          `headingLevel="h2"` the reused Settings groups take keeps meaning
          what it meant. */}
      <div className="wizard-gate-step__intro">
        <h1 className="wizard-gate-step__greeting">Hello! My name is Anderson.</h1>
        <p className="wizard-gate-step__lede">
          Anderson Smith, but Anderson is fine. Let's get acquainted — a minute or so, and you can change your mind
          about any of it later.
        </p>
      </div>

      <FormTextField
        control={control}
        name="name"
        label="What shall I call you?"
        placeholder="e.g. Edwin"
        rules={{ validate: filled }}
      />

      {/*
       * Local vs Cloud — asked as where Anderson himself will live. Local is
       * enabled and default-selected; Cloud is visible but disabled, and
       * always carries a `notify me` link out to smithagents.com — a
       * disabled control someone actually wants, with no way forward, is the
       * exact frustration the spec calls out. The value this emits stays
       * `"hosted"` — that's the spec's own enum and matches `lib/cloud.ts`;
       * only the user-facing word changed to "In the cloud".
       *
       * "In the cloud" is hand-authored markup, not a `RadioButtonGroup.Item`
       * — verified against the installed source, not guessed. HeroUI's Radio
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
       * wants. So "In the cloud" is a plain native `<input type="radio">`
       * authored directly (its implicit role needs no `role` attribute, and
       * both attributes below are mine to set), wrapped in its own `<label>`
       * the same way HeroUI's own Radio does — as a sibling inside the same
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
       * native `disabled`, ArrowDown from "On your machine" lands right
       * here, and react-aria reads the focused input's `.value` to select
       * it — an input with no `value` attribute defaults to `"on"`,
       * corrupting `mode` to an off-type value. `disabled` closes that;
       * `aria-disabled` is kept for the CSS hook and for AT that renders the
       * two differently.
       *
       * The `notify me` link is a sibling of the whole group, never a
       * descendant of the Cloud node — nesting it there would put it under
       * the same `aria-disabled` element and inherit `pointer-events: none`
       * with it.
       *
       * The `.wizard-fork-step__*` class names below are carried over from
       * WizardPreflightStep (itself carried from the deleted WizardForkStep)
       * unchanged — see the plan's controller ruling: WizardComingSoon
       * (WizardGate.tsx, the compact/mobile screen) still depends on
       * `.wizard-fork-step__notify`, so those rules stay in components.css
       * even though this file replaces the component that used to be their
       * only reader.
       */}
      {/* `<fieldset>`/`<legend>` on the wrapper, not a `<div>` with an ARIA
          `role="group"` — biome's a11y lint (correctly) wants the native
          element here, and it also buys the group's accessible name for
          free: a fieldset's name is computed from its legend without a
          separate `aria-labelledby` on the fieldset itself. The name still
          has to cover the notify link, not just the radiogroup, which is why
          this wraps both rather than putting the labelling on
          RadioButtonGroup alone — and RadioButtonGroup keeps its own correct
          `role="radiogroup"`, pointed at the same legend by id, rather than
          having that role overridden. */}
      <fieldset className="wizard-fork-step">
        <legend className="wizard-fork-step__prompt" id="wizard-gate-step-mode-prompt">
          Where would you like me to live?
        </legend>
        <RadioButtonGroup
          aria-labelledby="wizard-gate-step-mode-prompt"
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
              <span className="wizard-fork-step__label">On your machine</span>
              <span className="wizard-fork-step__hint">I run right here, and I can use logins you already have.</span>
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
            <span className="wizard-fork-step__label">In the cloud</span>
            <span className="wizard-fork-step__hint">nothing to install, I'm ready right away.</span>
          </label>
        </RadioButtonGroup>

        <a className="wizard-fork-step__notify" href="https://smithagents.com" target="_blank" rel="noreferrer">
          → notify me
        </a>
      </fieldset>

      {/* `.wizard-gate__footer` is the wizard's shared footer band (see
          components.css) — the divider and spacing live on it, and on a step
          tall enough to scroll the panel it sticks to the panel's bottom edge
          so the primary action never drops below the fold. Pick-for-me
          first, primary last — the same "less-committal action first" order
          every other wizard footer in this file reads, and keeping that DOM
          order is what keeps the tab order agreeing with the visual one now
          that the two sit left-to-right in a row.

          `--gate` because these two are not two answers to one question, the
          way Back and Continue are on every later step. One is the path
          through setup and the other is the door out of it, and stacked as
          two identical full-width pills they read as a choice between
          equals — which weights a shortcut that silently accepts every
          remaining default exactly as heavily as walking the setup. So the
          shortcut drops to quiet text and the primary stays the only filled
          control on the screen; the ranking is legible before either label
          is read. Same hand-styled `<button>` as the per-step Skip, for the
          same reasons — see `.wizard-gate__skip` in components.css. */}
      <div className="wizard-gate__footer wizard-gate__footer--gate">
        {onPickForMe && (
          // Same rule as the primary beside it: the name still has to be
          // typed — this button picks the OTHER things, not that one. Mode
          // needs no equivalent guard; the field is pre-selected (Cloud is
          // disabled) so it always has a value to hand back.
          <button
            type="button"
            className="wizard-gate__shortcut"
            onClick={() => onPickForMe((name ?? "").trim(), mode)}
            disabled={!filled(name ?? "") || writing}
          >
            Just pick sensible things for me
          </button>
        )}
        <Button type="submit" variant="primary" isDisabled={!filled(name ?? "") || writing}>
          Nice to meet you →
        </Button>
      </div>
    </form>
  );
}
