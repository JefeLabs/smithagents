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

export type Setup =
  | {
      mode?: SetupMode;
      voice?: boolean;
      step?: string;
      /**
       * The stated default a skipped "Subscriptions" step applies: no CLI or
       * key was chosen here, so Anderson runs on whatever is already active
       * (`CliToolListing.active` / a verified key) and nothing further is
       * configured. Written only by a skip — the normal Continue path never
       * sets it, because it isn't declining anything.
       */
      subscriptionsSkipped?: boolean;
      /**
       * The stated default a skipped "Anderson" step applies: no brain engine
       * is saved, which `resolveBrainFactory` (broker/src/brain-engine.ts)
       * already treats as a safe, working state — the same one an empty
       * candidate list falls back to today.
       */
      brainSkipped?: boolean;
    }
  | undefined;

/**
 * The state of the HOST's own `PUT /me` for the patch a step last handed it.
 *
 * Not part of the step machine — it lives here because it is the other half of
 * the host/step vocabulary `Setup` belongs to, and both directions are needed:
 * the step says what changed (`onDone`), the host says what became of it.
 *
 * Every step's Back can race a write it cannot see. `advance` moves the
 * on-screen step immediately and lets its PUT run in the background, so the
 * step that just appeared is live while the write that put it there is still
 * unresolved; and on the LAST step nothing swaps at all, so the step that just
 * handed off is live while its own handoff is in flight. A Back clicked in
 * either window fires a competing `PUT {step}` whose landing order decides what
 * the server ends up holding — and a reload then contradicts the screen.
 *
 * `"saving"` is the window; `"failed"` is a write that is over and did not
 * land, which is precisely when a retreat or a retry must be possible again.
 * They are deliberately NOT one boolean: a guard that reads "not idle" would
 * hold the footer shut after a failure, which is the dead end this type exists
 * to keep closed.
 */
export type WizardSaveState = "idle" | "saving" | "failed";

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

export interface WizardStepDef {
  id: WizardStep;
  title: string;
  description: string;
  /** Shown ON the skip control: what skipping will do. Never bare "Skip". */
  skipLabel: string;
  /** The patch a skip applies. Explicit values only — setup merges. */
  skipDefault: () => Setup;
}

/**
 * One definition per step the SETUP sequence can ever select — keyed by
 * `Exclude<WizardStep, typeof PREFLIGHT>` rather than `WizardStep` itself, so
 * the gate (which has no per-step Skip; it has its own "pick sensible things
 * for me") never needs a placeholder entry. Adding an id to `WIZARD_STEPS`
 * without adding it here is still a type error, which is the property
 * `WIZARD_STEP_META` (this registry's predecessor) had and this preserves:
 * a step with no definition is a compile failure, not a lookup miss.
 *
 * Titles come from the spec's own flow map. Two had drifted and would have
 * collided with steps still to come: the mode question was titled "Location"
 * (which is the geolocation step) and Configure Anderson was titled "Brain".
 */
const STEP_DEFS: Record<Exclude<WizardStep, typeof PREFLIGHT>, Omit<WizardStepDef, "id">> = {
  subscriptions: {
    title: "Subscriptions",
    description: "Connect a CLI or key",
    skipLabel: "Skip — I'll use whatever CLI or key is already active",
    skipDefault: () => ({ subscriptionsSkipped: true }),
  },
  anderson: {
    title: "Anderson",
    description: "Pick a brain",
    skipLabel: "Skip — I'll reply using a built-in default",
    skipDefault: () => ({ brainSkipped: true }),
  },
};

/**
 * The sequence these answers select, with each step's full definition —
 * `setupStepsFor` plus what `WIZARD_STEP_META` used to hold, now including
 * what a Skip does. Never includes the gate: PREFLIGHT is not a step in this
 * sequence, the same way `setupStepsFor` never returns it.
 */
export function stepsFor(setup: Setup): readonly WizardStepDef[] {
  // `setupStepsFor`'s declared element type is `WizardStep` (PREFLIGHT
  // included, for the same reason `nextStep`/`prevStep` cast `current` to
  // it), but its actual values never contain PREFLIGHT — this narrows back
  // to what `STEP_DEFS` is actually keyed by.
  return setupStepsFor(setup).map((id) => ({ id, ...STEP_DEFS[id as Exclude<WizardStep, typeof PREFLIGHT>] }));
}

/**
 * `{ n, of }` within the sequence the answers actually selected, or `null`
 * for the gate — which has no number, per the spec ("the branch was settled
 * at the gate" is what makes `Step n of N` honest for every step after it).
 * `of` is always `stepsFor(setup).length`, never a hardcoded total, so a
 * shorter sequence (fewer answers, or "hosted") reports its own real count
 * rather than a total it does not contain.
 */
export function progressFor(step: string, setup: Setup): { n: number; of: number } | null {
  if (step === PREFLIGHT) return null;
  const steps = setupStepsFor(setup);
  const i = steps.indexOf(step as WizardStep);
  return i >= 0 ? { n: i + 1, of: steps.length } : null;
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
