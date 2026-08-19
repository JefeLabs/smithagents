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

/** What Anderson may do without asking, per capability. */
export type PermissionStance = "ask" | "allow" | "never";

/**
 * Declared here rather than in the step, because `Setup` carries it on the
 * wire and two structurally-identical shapes for one field drift the moment
 * either is edited.
 */
export interface WizardPermissions {
  readFiles: PermissionStance;
  runCommands: PermissionStance;
  browseWeb: PermissionStance;
}

/** Every id the host can render, preflight included. */
export const WIZARD_STEPS = [PREFLIGHT, "sources", "roles", "voice", "talk", "memory", "ready"] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

export type Setup =
  | {
      mode?: SetupMode;
      /**
       * The voice step's own answer — `true` for "Yes, let's talk", `false`
       * for "Not right now" (both sent explicitly; WizardVoiceStep never
       * omits it, the same rule every other answer in this type follows).
       *
       * A record can carry this BEFORE the step itself does — voice used to
       * be a third preflight question (see WizardGateStep's file comment)
       * whose own skip default already wrote `false`, and this field never
       * changed shape across that move. Nothing here has to reconcile the
       * two histories: a pre-existing value is simply the answer the voice
       * step resumes with, "previously declined" rather than "never asked".
       */
      voice?: boolean;
      step?: string;
      /**
       * The stated default a skipped *Where I think* step applies: no source
       * was chosen here, so Anderson uses whatever this machine already has —
       * an active login (`CliToolListing.active`) or a verified key — and
       * nothing further is configured. Written only by a skip; the normal
       * Continue path never sets it, because it isn't declining anything.
       */
      sourcesSkipped?: boolean;
      /**
       * The stated default a skipped *What I think with* step applies: none
       * of the three roles is saved, which `resolveBrainFactory`
       * (broker/src/brain-engine.ts) already treats as a safe, working state
       * — the same one an empty candidate list falls back to today.
       *
       * Written by BOTH ways off that step that save nothing: the host's own
       * progress-row Skip, and the step's escape after a refused save. They
       * are the same outcome on the wire, so recording only one of them would
       * make the other indistinguishable from a user who answered.
       */
      rolesSkipped?: boolean;
      /**
       * *How I talk* — small talk, and whether Anderson keeps up with the
       * world. Both are sent EXPLICITLY by WizardTalkStep in both directions,
       * for the same reason `voice` is: the server merges setup, so an omitted
       * field leaves an earlier run's answer standing.
       */
      smallTalk?: boolean;
      worldAware?: boolean;
      /**
       * *Remembering, and what I may do.* All sent EXPLICITLY by
       * WizardMemoryStep, for the reason `voice` and `smallTalk` are: the
       * server merges setup, so an omitted field leaves an earlier answer
       * standing.
       */
      remember?: boolean;
      /**
       * Whether deeper recall is wanted, recorded ahead of the capability.
       * memory.ts is deliberately lexical and needs no embeddings today; this
       * is the answer a future backend reads, not a switch that does anything
       * now. No control offers a download while none exists.
       */
      deeperRecall?: boolean;
      permissions?: WizardPermissions;
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
 * `voice` after `roles` — secondary to the brain, the user's own ruling. Its
 * place in the local sequence is unconditional on the ANSWER: the step's
 * whole job is to ASK the question, so it has to render whether `setup.voice`
 * is `true`, `false`, or absent. Only `mode` decides whether it appears at
 * all — the same as `sources`/`roles` beside it.
 */
export function setupStepsFor(setup: Setup): readonly WizardStep[] {
  if (!setup?.mode) return [];
  if (setup.mode === "hosted") return [];
  return ["sources", "roles", "voice", "talk", "memory", "ready"];
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
 * Titles are the spec's own section names verbatim — `## Step 1 of 6 · Where
 * I think`, `## Step 2 of 6 · What I think with`, `## Step 3 of 6 · Talking
 * out loud`. The indicator is the only place a step is named to the user, so
 * a paraphrase here would be a second name for the same screen. (The ids
 * these replaced, `subscriptions` and `anderson`, named what the old screens
 * DID rather than what they ask; both screens are gone. The mode question is
 * still never titled "Location" — that is the geolocation step, still to
 * come.)
 */
const STEP_DEFS: Record<Exclude<WizardStep, typeof PREFLIGHT>, Omit<WizardStepDef, "id">> = {
  sources: {
    title: "Where I think",
    description: "Logins, keys, or local models",
    skipLabel: "Skip — I'll use whichever logins or keys already work",
    skipDefault: () => ({ sourcesSkipped: true }),
  },
  roles: {
    title: "What I think with",
    description: "One for each kind of job",
    skipLabel: "Skip — I'll reply using a built-in default",
    skipDefault: () => ({ rolesSkipped: true }),
  },
  voice: {
    title: "Talking out loud",
    description: "Hosted keys, or stay text-only",
    // States the default rather than the bare word — same rule as the other
    // two, and the one this step's own "Not right now" answer already applies
    // on its own footer; this is what the HOST's progress-row Skip applies
    // instead, for a user who leaves before reaching that footer.
    skipLabel: "Skip — I'll stay text-only",
    // Never `{}` — setup merges server-side, so an empty patch would leave a
    // stale `voice: true` standing from an earlier run rather than declining.
    skipDefault: () => ({ voice: false }),
  },
  talk: {
    title: "How I talk",
    description: "Small talk, and keeping up with the world",
    skipLabel: "Skip — I'll say hello properly and stick to what I know",
    // BOTH answers, always. Chatty is the product default — the personality is
    // the product, so small talk is opt-OUT — while news ingestion is opt-IN.
    // A partial patch here would leave one of the two standing from an earlier
    // run, which is the answer-flip class `voice` above already guards against.
    skipDefault: () => ({ smallTalk: true, worldAware: false }),
  },
  memory: {
    title: "Remembering, and what I may do",
    description: "What I keep, and what I may do without asking",
    skipLabel: "Skip — I'll remember, and ask before doing anything",
    // Every answer, always. Asking first is the safe stance and the one a user
    // who never reached this screen would expect; remembering is on because it
    // already works and costs nothing.
    skipDefault: () => ({
      remember: true,
      deeperRecall: false,
      permissions: { readFiles: "ask", runCommands: "ask", browseWeb: "ask" },
    }),
  },
  ready: {
    title: "Before we start",
    description: "What I understood, and what I checked",
    skipLabel: "Skip — take me straight in",
    // The ONLY entry here whose skip writes nothing. Every other one records a
    // stated default because an omitted field would leave an earlier run's
    // answer standing — but this screen asks no question, so a default would be
    // an answer to something never put.
    skipDefault: () => ({}),
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
 * Load-bearing rather than a convenience: the Voice step BLOCKS Continue on
 * two VERIFIED connectors while its own answer is "yes", so without a way
 * back, asking for voice without a working ElevenLabs key would be a gate
 * that can be neither passed nor retracted. Back into roles (and, from there,
 * further back) is what makes that retreat possible from the step machine's
 * side — "Not right now" on the step itself is the other way out, and unlike
 * this one it stays selectable in every state the step can reach, gate
 * included (see WizardVoiceStep's own doc comment).
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
 * a newer build, a hand-edited one, one saved before the mode was chosen, or
 * one left on a step a later build RETIRED (`subscriptions`/`anderson`, which
 * `sources`/`roles` replaced) — returns to preflight rather than stranding
 * the user on a step that the current answers cannot reach. Without that last
 * case a half-finished record from the previous build would resume onto an
 * empty panel, on every reload, with the gate reopening each time.
 */
export function resumeStep(setup: Setup): WizardStep {
  const step = setup?.step;
  if (!step || step === PREFLIGHT) return PREFLIGHT;
  return setupStepsFor(setup).includes(step as WizardStep) ? (step as WizardStep) : PREFLIGHT;
}

export function isSetupComplete(setup: Setup): boolean {
  return setup?.step === SETUP_DONE;
}
