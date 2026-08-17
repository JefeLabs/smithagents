/**
 * The wizard's ordered steps and the pure logic over them.
 *
 * Kept out of the components so resume behaviour is testable without rendering,
 * and so later plans can insert their steps by editing one array. Every REQUIRED
 * step precedes every optional one (spec) — someone who abandons the wizard
 * after a required step still has a working app.
 */
export const WIZARD_STEPS = ["name", "fork"] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

/** Sentinel stored once the last step is done. */
export const SETUP_DONE = "done";

export type Setup = { mode?: "local" | "hosted"; step?: string } | undefined;

/**
 * Where to resume. An unknown step id — a record written by a newer build, or a
 * hand-edited one — restarts rather than stranding the user on a step that does
 * not exist.
 */
export function resumeStep(setup: Setup): WizardStep {
  const step = setup?.step;
  return (WIZARD_STEPS as readonly string[]).includes(step ?? "") ? (step as WizardStep) : WIZARD_STEPS[0];
}

/** The next step, or null at the end. */
export function nextStep(current: string): WizardStep | null {
  const i = (WIZARD_STEPS as readonly string[]).indexOf(current);
  return i >= 0 && i < WIZARD_STEPS.length - 1 ? WIZARD_STEPS[i + 1] : null;
}

export function isSetupComplete(setup: Setup): boolean {
  return setup?.step === SETUP_DONE;
}
