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
  progressFor,
  resumeStep,
  SETUP_DONE,
  type Setup,
  type SetupMode,
  setupStepsFor,
  stepsFor,
  type WizardSaveState,
  type WizardStep,
} from "../lib/wizardSteps";
import { WizardChip } from "../molecules/WizardChip";
import { useMe } from "../queries/http";
import { qk } from "../queries/keys";
import { WizardBrainStep } from "./WizardBrainStep";
import { WizardGateStep } from "./WizardGateStep";
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
 *
 * `finish` (set only by `pickForMe`, below) skips the one-step computation
 * entirely: "pick sensible things for me" already merged every remaining
 * step's default into `patch`, and its destination is the END of setup, not
 * whatever the first step of the sequence would be. Routing it through this
 * same function — rather than a second write of its own — is what keeps the
 * resolved/rejected handling above covering it too.
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
  // What became of this host's own last write. Distinct from `error`, which is
  // only ever displayed: this is handed BACK to the step on screen, because
  // every step's Back can race a write the step itself cannot see — the one
  // that brought it here, or (on the last step, which nothing swaps out) its
  // own handoff. Both `advance` and `goBack` maintain it, since both write.
  // Read by WizardSubscriptionsStep and WizardBrainStep through the same
  // `saveState` prop; see the type's comment in lib/wizardSteps.ts.
  const [saveState, setSaveState] = useState<WizardSaveState>("idle");
  const qc = useQueryClient();

  // What the SETUP sequence is computed from. Not a step-independent constant:
  // the mode selects the branch and (once the Voice plan lands) `voice` adds a
  // step, so every question this host asks the step machine is asked with the
  // user's own answers in hand.
  const answers: Setup = { mode, voice };
  const sequence = setupStepsFor(answers);
  // The same sequence, with each step's title/description/skip def attached
  // — `stepsFor` wraps `setupStepsFor`, so the two never disagree about which
  // ids are in play, only about how much each one carries.
  const defs = stepsFor(answers);
  // Null on the gate — no number, per the spec — and honest everywhere else:
  // `of` is `defs.length`, never a hardcoded total, so it can't lie for a
  // shorter sequence.
  const progress = progressFor(step, answers);

  const advance = (patch: { name?: string; setup?: Setup }, finish = false) => {
    const current = step;
    // From the PATCH, never from state. The preflight patch carries the very
    // answers that SELECT the sequence being entered, and a `setMode` in this
    // same handler is not visible until the next render — reading `mode` here
    // would route by the PREVIOUS answer. On a fresh install that previous
    // answer is `undefined`, whose sequence is empty, so the wizard would
    // persist `done` and drop the user straight into the app.
    //
    // `finish` overrides this outright: a patch that sets it already IS the
    // end of setup (see `pickForMe`), not one step of it.
    const next = finish
      ? null
      : nextStep(current, { mode: patch.setup?.mode ?? mode, voice: patch.setup?.voice ?? voice });
    setError(null);
    // Marked as the write goes out, not only when it settles: a retry from the
    // last step hands off again, and until this one resolves that step must be
    // inert again — otherwise the second write races exactly what the first
    // one raced.
    setSaveState("saving");
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
          setSaveState("failed");
          return;
        }
        setSaveState("idle");
        void qc.invalidateQueries({ queryKey: qk.me });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not save — check your connection and try again.");
        // Both shapes, not just the refusal: a rejection leaves the step just
        // as stuck, and `brokerFetch` never throws on a non-2xx — so this
        // branch is the NETWORK failure, and the resolved one above is the
        // server saying no. Neither may leave a step inert behind it.
        setSaveState("failed");
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
    setSaveState("saving");
    setStep(prev);
    api
      .updateMe({ setup: { step: prev } })
      .then((result) => {
        if (result.error) {
          setStep(current);
          setError(result.error);
          setSaveState("failed");
          return;
        }
        setSaveState("idle");
        void qc.invalidateQueries({ queryKey: qk.me });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not save — check your connection and try again.");
        setSaveState("failed");
      });
  };

  // Every step behind which there is something to go back to gets a Back —
  // asked of the step machine rather than hardcoded, so a sequence that grows
  // a step needs nothing here.
  const onBack = prevStep(step, answers) ? goBack : undefined;

  // The current step's own definition — undefined on the gate, which is
  // exactly when there is no Skip to show (it has its own "pick sensible
  // things for me" instead, a whole-gate action rather than a per-step one).
  const currentDef = defs.find((d) => d.id === step);

  /**
   * Applies the current step's stated default and moves on — routed through
   * `advance`, the SAME path a real answer takes, rather than a second write
   * of its own. That is what keeps `advance`'s two failure shapes (a
   * rejection stays optimistic, a resolved `{error}` rolls back and shows the
   * server's sentence) covering this control too, instead of a duplicate
   * that would have to reason about them a second time — which is exactly
   * what produced the dead-end bug this feature already hit once.
   */
  const skip = () => {
    if (!currentDef) return;
    advance({ setup: currentDef.skipDefault() });
  };

  /**
   * The gate's own shortcut, distinct from `skip` above (which applies only
   * the ONE step currently on screen): every step the chosen mode would ever
   * reach gets its own stated default, merged into a single patch and sent
   * as ONE write via `advance`'s `finish` flag — not stepped through each
   * screen in turn. `stepsFor(...)` is the exact registry `skip` already
   * reads, so a step's default changing follows this too, rather than a
   * second, hand-rolled list drifting from it.
   *
   * Takes `mode` as an argument rather than reading this host's own `mode`
   * state, for the same reason `advance`'s `next` does: that state is not
   * yet updated by the very preflight answer this call is delivering.
   */
  const pickForMe = (pickedName: string, pickedMode: SetupMode) => {
    const setup: Setup = { mode: pickedMode };
    for (const s of stepsFor({ mode: pickedMode })) Object.assign(setup, s.skipDefault());
    advance({ name: pickedName, setup }, true);
  };

  /**
   * The chip's own transition — confirmed (or, with nothing to lose, silent)
   * inside WizardChip itself, so by the time this runs the decision is
   * already made. Not routed through `goBack`: that function moves exactly
   * one step, using `prevStep`, and the chip can be clicked from ANY
   * post-preflight step straight back to preflight, which is not one step
   * back on the last one. Same resolved-vs-rejected handling as `goBack` and
   * for the same reason — `brokerFetch` never throws on a non-2xx, so a
   * server refusal must roll the step back while a network rejection may
   * well have landed and is left alone, just reported.
   */
  const editAnswers = () => {
    const current = step;
    setError(null);
    setSaveState("saving");
    setStep(PREFLIGHT);
    api
      .updateMe({ setup: { step: PREFLIGHT } })
      .then((result) => {
        if (result.error) {
          setStep(current);
          setError(result.error);
          setSaveState("failed");
          return;
        }
        setSaveState("idle");
        void qc.invalidateQueries({ queryKey: qk.me });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not save — check your connection and try again.");
        setSaveState("failed");
      });
  };

  // Titles of the steps THIS sequence position has already answered — never
  // the future "brain source / models / voice backend" wording the full spec
  // names, because those are Plan 2 screens that do not exist in this build.
  // A chip warning about a screen the user has never seen is worse than one
  // that warns about less (see the plan's controller ruling). Empty exactly
  // when `step` is the first entry in `sequence`, which is also exactly when
  // nothing past preflight has been answered yet.
  const clears = defs.slice(0, sequence.indexOf(step)).map((d) => d.title);

  return (
    <div className="wizard-gate__host" data-step={step}>
      <div className="wizard-gate__panel">
        {/* Never on the gate itself (PREFLIGHT) — the gate is where the
            chip's own contents are chosen; a chip above it would be a
            control that edits the screen you are already on. Rendered once
            `mode` is settled, which every step past preflight guarantees
            (a "hosted" answer's sequence is empty, so the host never lands
            on a post-preflight step without a "local" mode in hand). */}
        {step !== PREFLIGHT && (
          <WizardChip name={name} mode={mode ?? "local"} clears={clears} onEdit={editAnswers} saveState={saveState} />
        )}
        {/* Never over preflight: an indicator there would assert an order that
            preflight's own answers have not chosen yet (its sequence is empty
            until the mode is known). Otherwise display-only — no
            `onStepChange`, so it never becomes a second way to navigate. The
            step machine (`advance`/`goBack`, above) is the only thing that
            moves `step`; the Stepper just reflects it, over exactly the
            sequence those answers selected. */}
        {step !== PREFLIGHT && sequence.length > 0 && (
          <Stepper currentStep={sequence.indexOf(step)}>
            {defs.map((d) => (
              <Stepper.Step key={d.id}>
                <Stepper.Indicator />
                <Stepper.Content>
                  <Stepper.Title>{d.title}</Stepper.Title>
                  <Stepper.Description>{d.description}</Stepper.Description>
                </Stepper.Content>
                <Stepper.Separator />
              </Stepper.Step>
            ))}
          </Stepper>
        )}
        {/* Honest `Step n of N` — `progressFor` returns null on the gate, so
            this is inert there without a separate guard. Placed above the
            body, alongside the Stepper it numbers, rather than inside it:
            the step's own `.wizard-gate__footer` (Back/Continue) is a
            `position: sticky` band scoped to this same scrolling panel, and
            anything placed AFTER it in DOM order — Subscriptions is the one
            step tall enough to make this observable — ends up pinned behind
            it, unreachable while scrolled. Skip is a host control, not a
            per-step one (Task 4's brief modifies this file and
            `wizardSteps.ts` only, never the step components that own that
            footer), so it renders here rather than inside it.

            Skip shares that row rather than taking a line of its own beneath
            it. Below the body is not available for the reason just given, so
            the only question left was how it reads where it must live, and
            as a pill on its own line it read wrong: it was the first control
            on the step and the only one visible without scrolling past the
            question, so Anderson offered the exit before he finished asking.
            It was also the one accent-blue thing on screen besides the
            primary action, which pulled the eye to it over the question. On
            the progress line, right-aligned and at that line's own quiet
            type, it is what it actually is — a note about this step beside
            the other note about this step.

            A plain `<button>`, not HeroUI's: dressing a `Button` down to
            text means undoing its height, padding, border, radius and fill,
            and `.wizard-chip` already sets the precedent for a hand-styled
            control in this feature. It keeps the whole `skipLabel` as its
            accessible name — setup MERGES server-side, so a skip that does
            not state and send explicit values applies nothing — and the
            native `disabled` attribute keeps it inert mid-write, closing the
            pointer and the keyboard together rather than only dimming. */}
        {progress && currentDef && (
          <div className="wizard-gate__progress">
            <p className="wizard__hint">
              Step {progress.n} of {progress.of}
            </p>
            <button type="button" className="wizard-gate__skip" onClick={skip} disabled={saveState === "saving"}>
              {currentDef.skipLabel}
            </button>
          </div>
        )}
        <div className="wizard-gate__body">
          {/* Greeted by name on the setup steps, and given no host heading at
              all on the gate. An earlier pass already withheld the
              personalised greeting there — it would be either empty on a
              fresh install or a redundant echo of the field directly below
              it — but kept a bare "Welcome" so the panel still carried the
              one `<h1>` the steps' `headingLevel="h2"` assumes. That bare
              word is the problem this removes: on the single screen where
              the name is still being asked for it says nothing, and it said
              it at 26px directly above Anderson's own first words at 15px,
              so the largest thing on the product's opening screen was a word
              nobody said. WizardGateStep owns the gate's `<h1>` instead (see
              its intro comment). Exactly one `<h1>` per screen either way, so
              `headingLevel="h2"` on the reused Settings groups keeps meaning
              what it meant. */}
          {step !== PREFLIGHT && <h1 className="wizard-gate__title">{name ? `Welcome, ${name}` : "Welcome"}</h1>}
          {error && <p className="wizard-gate__error">{error}</p>}
          {step === PREFLIGHT && (
            // Seeded with the answers already given, so backing up into this
            // screen shows what the user said rather than a blank form.
            <WizardGateStep initialName={name} initialMode={mode} onDone={advance} onPickForMe={pickForMe} />
          )}
          {step === "subscriptions" && (
            <WizardSubscriptionsStep onDone={advance} onBack={onBack} saveState={saveState} name={name} />
          )}
          {/* `onSkip={skip}` is the host's own progress-row Skip, handed to
              the step verbatim — the step's escape and that button are then
              literally the same call, reading `skipDefault()` from the step
              registry in one place. The step has no value of its own to
              write, so a patch composed on its side would be a second answer
              to a question this file already answers. */}
          {step === "anderson" && (
            <WizardBrainStep onDone={advance} onSkip={skip} onBack={onBack} saveState={saveState} />
          )}
        </div>
      </div>
    </div>
  );
}
