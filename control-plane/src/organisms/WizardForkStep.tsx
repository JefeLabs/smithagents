import { Button } from "@heroui/react";
import { RadioButtonGroup } from "@heroui-pro/react";
import { useState } from "react";
import type { Setup } from "../lib/wizardSteps";

export interface WizardForkStepProps {
  onDone: (patch: { setup: Setup }) => void;
}

/**
 * Local vs hosted. Local is enabled and default-selected; hosted is visible
 * but disabled and labelled "coming soon" — a disabled control someone
 * actually wants, with no way forward, is the exact frustration the spec
 * calls out, so it always carries a `notify me` link out to smithagents.com.
 *
 * "Hosted" is hand-authored markup, not a `RadioButtonGroup.Item` — verified
 * against the installed source, not guessed. HeroUI's Radio ultimately calls
 * react-aria's `useRadio()`, whose `inputProps` (the props that land on the
 * actual `role="radio"` `<input>`) come from `filterDOMProps(props,
 * {labelable: true})`. That allowlist only lets `aria-label`/`labelledby`/
 * `describedby`/`details` through — `aria-disabled` is in none of its
 * buckets (not the labelable set, not the global/data-* sets either), so it
 * is silently dropped no matter where in the compound API (`Radio`,
 * `RadioButtonGroup.Item`) it is passed. `isDisabled` only ever reaches the
 * native `disabled` attribute on that input — never `aria-disabled`. Since
 * this stylesheet's dimming and `pointer-events: none` are both keyed off
 * `aria-disabled` (not `disabled`), there is no prop combination on the real
 * component that produces the disabled hosted option the spec wants. So
 * "hosted" is a plain native `<input type="radio">` I author directly (its
 * implicit role needs no `role` attribute, and `aria-disabled` is mine to
 * set), wrapped in its own `<label>` the same way HeroUI's own Radio does —
 * as a sibling inside the same group. `RadioGroup` renders whatever children
 * it's given, so a hand-authored radio can sit right alongside the real
 * `RadioButtonGroup.Item` without a second, nested radiogroup. `onClick`
 * calls `preventDefault` as a backstop against ever toggling it — the same
 * guard react-aria's own `useRadio` puts on its label for exactly this
 * reason (see its `labelProps.onClick`) — pointer-events:none is the real
 * defense; this only covers a browser that ignores it.
 *
 * The `notify me` link is a sibling of the whole group, never a descendant
 * of the hosted node — nesting it there would put it under the same
 * `aria-disabled` element and inherit `pointer-events: none` with it.
 */
type Mode = NonNullable<Setup>["mode"];

export function WizardForkStep({ onDone }: WizardForkStepProps) {
  // "local" is the only value that can ever land here — the hosted option
  // below isn't wired to this state at all — but the group stays controlled
  // the normal HeroUI way so a later plan can widen it without a rewrite.
  const [mode, setMode] = useState<Mode>("local");

  const submit = () => onDone({ setup: { mode } });

  return (
    <div className="wizard-fork-step">
      <p className="wizard-fork-step__prompt" id="wizard-fork-prompt">
        Where do you want to run this?
      </p>
      <RadioButtonGroup
        aria-labelledby="wizard-fork-prompt"
        value={mode}
        onChange={(value) => setMode(value as Mode)}
        orientation="vertical"
      >
        <RadioButtonGroup.Item value="local">
          <RadioButtonGroup.Indicator />
          <RadioButtonGroup.ItemContent>
            <span className="wizard-fork-step__label">Local</span>
            <span className="wizard-fork-step__hint">Runs on this machine, using the CLIs you already have.</span>
          </RadioButtonGroup.ItemContent>
        </RadioButtonGroup.Item>

        {/* Hand-authored — see the file comment above for why. `aria-disabled`
            is repeated on the label purely as a CSS hook: it's what actually
            dims the row and cuts pointer-events on the whole clickable area,
            not just the tiny input. It adds no role of its own — a <label>
            has none — so the input stays the only "radio" in the group. */}
        <label className="wizard-fork-step__hosted" aria-disabled="true">
          <input
            type="radio"
            aria-disabled="true"
            tabIndex={-1}
            onClick={(e) => e.preventDefault()}
            className="wizard-fork-step__hosted-input"
          />
          <span className="wizard-fork-step__label">
            Hosted <span className="wizard-fork-step__badge">Coming soon</span>
          </span>
          <span className="wizard-fork-step__hint">no CLI to install, works on any device</span>
        </label>
      </RadioButtonGroup>

      <a className="wizard-fork-step__notify" href="https://smithagents.com" target="_blank" rel="noreferrer">
        → notify me
      </a>

      <Button variant="primary" onPress={submit}>
        Continue
      </Button>
    </div>
  );
}
