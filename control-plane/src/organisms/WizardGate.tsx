import { Stepper } from "@heroui-pro/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import * as api from "../api/broker";
import type { MeRecord } from "../api/types";
import {
  isSetupComplete,
  nextStep,
  PREFLIGHT,
  prevStep,
  resumeStep,
  SETUP_DONE,
  type Setup,
  setupStepsFor,
  WIZARD_STEP_META,
  type WizardStep,
} from "../lib/wizardSteps";
import { useMe } from "../queries/http";
import { qk } from "../queries/keys";
import { WizardBrainStep } from "./WizardBrainStep";
import { WizardPreflightStep } from "./WizardPreflightStep";
import { WizardSubscriptionsStep } from "./WizardSubscriptionsStep";

/**
 * Mirrors the app shell's own mobile breakpoint (`components.css`'s 768px
 * sidebar collapse) rather than inventing a second one — phones and tablets
 * get the same "compact" line the rest of the shell already draws.
 */
const COMPACT_QUERY = "(max-width: 768px)";

/**
 * matchMedia, not a resize listener — this is a device-class question ("does
 * this viewport have room for a local machine's worth of chrome"), the same
 * kind of query `useTheme` already asks of the OS. Reactive past mount (a
 * tablet rotated mid-wizard) for the same reason `useTheme` keeps tracking
 * the OS after mount: a one-shot read would strand a resized window on a
 * stale answer.
 */
function useIsCompactViewport(): boolean {
  const [compact, setCompact] = useState(() => window.matchMedia(COMPACT_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY);
    const apply = () => setCompact(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return compact;
}

/**
 * Decides between the welcome wizard and the app.
 *
 * Mounted beside AuthGate: authentication first, then setup. First run is the
 * absence of a saved user record, which the swarm reports as `placeholder`
 * (GET /me fabricates a default record, so absence has to be stated).
 *
 * A failed /me is NOT a gate. Blocking the app behind an unreachable probe
 * would strand the user with no way forward, which the spec forbids — so an
 * error falls through to the app.
 */
export function WizardGate({ children }: { children: ReactNode }) {
  const { data: me, isLoading, isError } = useMe();
  const compact = useIsCompactViewport();

  if (isLoading) return <div className="wizard-gate__splash" aria-busy="true" />;
  if (isError || !me) return <>{children}</>;

  // A user with `setup` entirely absent predates this feature — never drag an
  // existing install into the wizard just because `isSetupComplete(undefined)`
  // reads false. Only a fresh install (`placeholder`) or a genuinely
  // half-finished setup (`setup` present but not `done`) opens it.
  const needsSetup = me.placeholder === true || (me.setup !== undefined && !isSetupComplete(me.setup));
  if (!needsSetup) return <>{children}</>;

  // The wizard's only working path is local mode, which needs a machine to
  // run CLIs on — a phone or tablet has none. Rather than walking a compact
  // viewport into that dead end, it sees what's coming instead of the wizard.
  if (compact) return <WizardComingSoon />;

  return <WelcomeWizard initialStep={resumeStep(me.setup)} me={me} />;
}

/** Stands in for the wizard on phones/tablets: says what's coming (hosted
 * mode) rather than leaving a compact viewport stranded on a blank gate. */
function WizardComingSoon() {
  return (
    <div className="wizard-gate__host">
      <div className="wizard-gate__panel wizard-gate__panel--compact">
        <h1 className="wizard-gate__title">Welcome</h1>
        <p className="wizard-gate__compact-message">
          This device has no local machine to run agents on. Hosted mode — works on any device, no CLI to install — is
          coming soon.
        </p>
        <a className="wizard-fork-step__notify" href="https://smithagents.com" target="_blank" rel="noreferrer">
          → notify me
        </a>
      </div>
    </div>
  );
}

/**
 * The step host. Owns the current step, its persistence, and the three
 * preflight answers that select which sequence follows — every step is a
 * controlled organism (props in, `onDone(patch)` out) with no fetch of its
 * own. `data-step` on the root names which step is showing without depending
 * on that step's own markup, so resume behaviour stays testable across a step
 * swap (the resume test asserts through this attribute, not any step's
 * internal markup — and it is the only hook the suite needs, which is why
 * there is no `data-testid` here).
 *
 * Advances the on-screen step immediately on `onDone` — the PUT and the cache
 * invalidation run in the background rather than gating the transition, so
 * moving between steps within one mounted wizard never waits on the network.
 * A reload before the PUT lands would resume one step behind, which is the
 * same "resume where you last landed" contract `resumeStep` already promises,
 * not a new failure mode.
 *
 * A *rejected* save is a different failure mode from that reload case — a
 * down broker fails every step's save, not just one, so the whole wizard's
 * worth of work would go unpersisted with nothing ever telling the user.
 * Still never blocks the transition on a network-level rejection (worse than
 * the silent case it replaces) — but `updateMe` mostly does NOT reject on
 * failure. `brokerFetch` never throws on a non-2xx, so a credential failure,
 * an origin block, or a swarm-side validation error all *resolve* with
 * `{error}` JSON rather than rejecting. Those are a firm "no" from the
 * server, not an ambiguous blip, so unlike the reject case the optimistic
 * step change is rolled back rather than kept: advancing past a write the
 * server just refused would let the gate loop forever (it reopens on any
 * incomplete setup, and a step that never actually persisted never becomes
 * complete) with no explanation, and it would throw away exactly the
 * validation text the swarm side writes for a human to read here.
 */
function WelcomeWizard({ initialStep, me }: { initialStep: WizardStep; me: MeRecord }) {
  const [step, setStep] = useState(initialStep);
  const [error, setError] = useState<string | null>(null);
  // The three preflight answers live here, not in `me`. Every save below is
  // optimistic, so a re-read of the refetched record would land a beat late
  // and both the greeting and the step indicator would trail one step behind
  // what is actually on screen. Seeded from the record, updated from the
  // PATCH — see `advance`.
  const [name, setName] = useState(me.placeholder ? "" : me.name);
  const [voice, setVoice] = useState(me.setup?.voice);
  const [mode, setMode] = useState(me.setup?.mode);
  // Whether the save for the patch a step last handed over failed — either
  // shape, refused or rejected. Distinct from `error`, which every write here
  // sets (`goBack`'s included) and which is only ever displayed: this one is
  // handed BACK to the step that did the handing off, and only the LAST step
  // has any use for it. Every earlier step is swapped out the moment it hands
  // off (`next` is a real step, so `setStep` moves on), so its own footer is
  // already gone by the time the write can fail. The last step is not: `next`
  // is null there, nothing swaps, and it is sitting inert behind a write it
  // cannot see the outcome of. Telling it is what keeps a refused final save
  // from being a dead end. Sole reader: WizardBrainStep's `handoffFailed`.
  const [handoffFailed, setHandoffFailed] = useState(false);
  const qc = useQueryClient();

  // What the SETUP sequence is computed from. Not a step-independent constant:
  // the mode selects the branch and (once the Voice plan lands) `voice` adds a
  // step, so every question this host asks the step machine is asked with the
  // user's own answers in hand.
  const answers: Setup = { mode, voice };
  const sequence = setupStepsFor(answers);

  const advance = (patch: { name?: string; setup?: Setup }) => {
    const current = step;
    // From the PATCH, never from state. The preflight patch carries the very
    // answers that SELECT the sequence being entered, and a `setMode` in this
    // same handler is not visible until the next render — reading `mode` here
    // would route by the PREVIOUS answer. On a fresh install that previous
    // answer is `undefined`, whose sequence is empty, so the wizard would
    // persist `done` and drop the user straight into the app.
    const next = nextStep(current, { mode: patch.setup?.mode ?? mode, voice: patch.setup?.voice ?? voice });
    setError(null);
    // Cleared as the write goes out, not only when it succeeds: a retry from
    // the last step hands off again, and until this one resolves that step
    // must be inert again — otherwise the second write is racing exactly what
    // the first one raced.
    setHandoffFailed(false);
    // Only what the patch actually carries: a step with nothing to say about
    // an answer (Subscriptions and Anderson both send `setup: {}`) must not
    // blank one out. Mirrors the server's own merge, which is why omitting a
    // field there keeps its old value too.
    if (patch.name !== undefined) setName(patch.name);
    if (patch.setup?.mode !== undefined) setMode(patch.setup.mode);
    if (patch.setup?.voice !== undefined) setVoice(patch.setup.voice);
    api
      .updateMe({ ...patch, setup: { ...patch.setup, step: next ?? SETUP_DONE } })
      .then((result) => {
        if (result.error) {
          // Only the STEP rolls back, never the answers: the server refused to
          // record them, but they are still what the user just typed, and
          // wiping the fields they are about to be shown again would be a
          // second failure on top of the first.
          setStep(current);
          setError(result.error);
          setHandoffFailed(true);
          return;
        }
        void qc.invalidateQueries({ queryKey: qk.me });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not save — check your connection and try again.");
        // Both shapes, not just the refusal: a rejection leaves the step just
        // as stuck, and `brokerFetch` never throws on a non-2xx — so this
        // branch is the NETWORK failure, and the resolved one above is the
        // server saying no. Neither may leave the last step inert.
        setHandoffFailed(true);
      });
    // Only a real next step moves the host's own view — the SETUP_DONE case
    // has no step of its own to show; the invalidated `me` query is what
    // makes WizardGate itself swap to the app.
    if (next) setStep(next);
  };

  /**
   * Back — `advance`'s sibling, deliberately the same shape rather than a
   * tidier one, because the two failure modes it has to tell apart are the
   * same two and they are not interchangeable. `brokerFetch` never throws on
   * a non-2xx: a network-level failure REJECTS (ambiguous — the write may
   * well have landed, so the step change is kept and only reported), while a
   * server refusal RESOLVES with `{error}` (a firm no, so the step rolls
   * back and the server's own sentence is shown). A `.catch` alone would see
   * only the first, and a Back that changes the screen without persisting is
   * worse than no Back at all: it looks right, then throws the user forward
   * again on the next reload, because `resumeStep` reads the step the server
   * still holds.
   *
   * `{ step: prev }` alone is the whole patch, and it clears nothing — the
   * server merges setup (`{...existing.setup, ...body.setup}`), so the mode
   * and voice already recorded survive untouched.
   */
  const goBack = () => {
    const current = step;
    const prev = prevStep(current, answers);
    if (!prev) return;
    setError(null);
    setStep(prev);
    api
      .updateMe({ setup: { step: prev } })
      .then((result) => {
        if (result.error) {
          setStep(current);
          setError(result.error);
          return;
        }
        void qc.invalidateQueries({ queryKey: qk.me });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not save — check your connection and try again.");
      });
  };

  // Every step behind which there is something to go back to gets a Back —
  // asked of the step machine rather than hardcoded, so a sequence that grows
  // a step needs nothing here.
  const onBack = prevStep(step, answers) ? goBack : undefined;

  return (
    <div className="wizard-gate__host" data-step={step}>
      <div className="wizard-gate__panel">
        {/* Never over preflight: an indicator there would assert an order that
            preflight's own answers have not chosen yet (its sequence is empty
            until the mode is known). Otherwise display-only — no
            `onStepChange`, so it never becomes a second way to navigate. The
            step machine (`advance`/`goBack`, above) is the only thing that
            moves `step`; the Stepper just reflects it, over exactly the
            sequence those answers selected. */}
        {step !== PREFLIGHT && sequence.length > 0 && (
          <Stepper currentStep={sequence.indexOf(step)}>
            {sequence.map((s) => (
              <Stepper.Step key={s}>
                <Stepper.Indicator />
                <Stepper.Content>
                  <Stepper.Title>{WIZARD_STEP_META[s].title}</Stepper.Title>
                  <Stepper.Description>{WIZARD_STEP_META[s].description}</Stepper.Description>
                </Stepper.Content>
                <Stepper.Separator />
              </Stepper.Step>
            ))}
          </Stepper>
        )}
        <div className="wizard-gate__body">
          {/* Greeted by name only once there is a name AND the screen is not
              the one asking for it. On preflight the greeting would be either
              empty (fresh install, no name yet) or — for someone who backed up
              into it — a redundant echo of the field directly below it. The
              bare "Welcome" stays in both cases: it is the panel's only `<h1>`,
              which is exactly what the steps' `headingLevel="h2"` assumes. */}
          <h1 className="wizard-gate__title">{step !== PREFLIGHT && name ? `Welcome, ${name}` : "Welcome"}</h1>
          {error && <p className="wizard-gate__error">{error}</p>}
          {step === PREFLIGHT && (
            // Seeded with the answers already given, so backing up into this
            // screen shows what the user said rather than a blank form.
            <WizardPreflightStep initialName={name} initialMode={mode} onDone={advance} />
          )}
          {step === "subscriptions" && <WizardSubscriptionsStep onDone={advance} onBack={onBack} />}
          {step === "anderson" && <WizardBrainStep onDone={advance} onBack={onBack} handoffFailed={handoffFailed} />}
        </div>
      </div>
    </div>
  );
}
