/**
 * The wizard has two phases, and only the second is a sequence.
 *
 * PREFLIGHT is one screen asking three questions about intent — name, voice,
 * mode. It never appears in the step indicator, because an indicator over it
 * would assert an order that its own answers have not yet chosen. It never
 * blocks: none of its answers can be wrong.
 *
 * The SETUP sequence is computed from those answers. It is a function, not a
 * constant, because the spec makes voice add a step and mode select a branch —
 * neither is expressible as one flat array (which is what this file used to
 * hold, and what shipped the defects this rewrite fixes).
 */
export const PREFLIGHT = "preflight";

export type SetupMode = "local" | "hosted";

/** Every id the host can render, preflight included. */
export const WIZARD_STEPS = [PREFLIGHT, "subscriptions", "anderson"] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

export type Setup = { mode?: SetupMode; voice?: boolean; step?: string } | undefined;

/**
 * Titles come from the spec's own flow map. Two had drifted and would have
 * collided with steps still to come: the mode question was titled "Location"
 * (which is the geolocation step) and Configure Anderson was titled "Brain".
 */
export const WIZARD_STEP_META: Record<WizardStep, { title: string; description: string }> = {
  [PREFLIGHT]: { title: "Welcome", description: "Tell us about you" },
  subscriptions: { title: "Subscriptions", description: "Connect a CLI or key" },
  anderson: { title: "Anderson", description: "Pick a brain" },
};

/**
 * The sequence these answers select.
 *
 * An absent mode yields NOTHING rather than defaulting to local: the mode
 * question is what establishes it, and assuming local would walk someone into
 * CLI installation on the strength of a missing field.
 *
 * `voice` is carried in `Setup` and persisted, but adds no step yet — the
 * Voice screen is a later plan, and an entry here for a screen that does not
 * exist would be a dead route. When that plan lands it inserts "voice" after
 * "subscriptions" here, and nothing else in this file changes.
 */
export function setupStepsFor(setup: Setup): readonly WizardStep[] {
  if (!setup?.mode) return [];
  if (setup.mode === "hosted") return [];
  return ["subscriptions", "anderson"];
}

/** The next step, or null at the end of the selected sequence. */
export function nextStep(current: string, setup: Setup): WizardStep | null {
  const steps = setupStepsFor(setup);
  if (current === PREFLIGHT) return steps[0] ?? null;
  const i = steps.indexOf(current as WizardStep);
  return i >= 0 && i < steps.length - 1 ? steps[i + 1] : null;
}

/**
 * The previous step, or null at the beginning.
 *
 * Load-bearing rather than a convenience: a later plan's Voice step BLOCKS on
 * two connectors, so without a way back, asking for voice without an
 * elevenlabs key is a gate that can be neither passed nor retracted. Back into
 * preflight is what makes that answer retractable.
 */
export function prevStep(current: string, setup: Setup): WizardStep | null {
  if (current === PREFLIGHT) return null;
  const steps = setupStepsFor(setup);
  const i = steps.indexOf(current as WizardStep);
  if (i > 0) return steps[i - 1];
  return PREFLIGHT;
}

/** Sentinel stored once the last step is done. */
export const SETUP_DONE = "done";

/**
 * Where to resume. A step the recorded answers do not contain — a record from
 * a newer build, a hand-edited one, or one saved before the mode was chosen —
 * returns to preflight rather than stranding the user on a step that the
 * current answers cannot reach.
 */
export function resumeStep(setup: Setup): WizardStep {
  const step = setup?.step;
  if (!step || step === PREFLIGHT) return PREFLIGHT;
  return setupStepsFor(setup).includes(step as WizardStep) ? (step as WizardStep) : PREFLIGHT;
}

export function isSetupComplete(setup: Setup): boolean {
  return setup?.step === SETUP_DONE;
}
