import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import * as api from "../api/broker";
import type { MeRecord } from "../api/types";
import { isSetupComplete, nextStep, resumeStep, SETUP_DONE, type WizardStep } from "../lib/wizardSteps";
import { useMe } from "../queries/http";
import { qk } from "../queries/keys";
import { WizardForkStep } from "./WizardForkStep";
import { WizardNameStep } from "./WizardNameStep";

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
    <div className="wizard-gate__host wizard-gate__compact">
      <h1>Welcome</h1>
      <p className="wizard-gate__compact-message">
        This device has no local machine to run agents on. Hosted mode — works on any device, no CLI to install — is
        coming soon.
      </p>
      <a className="wizard-fork-step__notify" href="https://smithagents.com" target="_blank" rel="noreferrer">
        → notify me
      </a>
    </div>
  );
}

/**
 * The step host. Owns the current step and its persistence — every step is a
 * controlled organism (props in, `onDone(patch)` out) with no fetch of its
 * own. `data-step` on the root names which step is showing without depending
 * on that step's own markup, so resume behaviour stays testable across a step
 * swap (Task 2's resume test asserts through this attribute, not any step's
 * internal markup).
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
  const qc = useQueryClient();

  const advance = (patch: { name?: string; setup?: MeRecord["setup"] }) => {
    const current = step;
    const next = nextStep(current);
    setError(null);
    api
      .updateMe({ ...patch, setup: { ...patch.setup, step: next ?? SETUP_DONE } })
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
    // Only a real next step moves the host's own view — the SETUP_DONE case
    // has no step of its own to show; the invalidated `me` query is what
    // makes WizardGate itself swap to the app.
    if (next) setStep(next);
  };

  return (
    <div className="wizard-gate__host" data-step={step}>
      <h1>Welcome{me.placeholder ? "" : `, ${me.name}`}</h1>
      {error && <p className="wizard-gate__error">{error}</p>}
      {step === "name" && <WizardNameStep initialName={me.placeholder ? "" : me.name} onDone={advance} />}
      {step === "fork" && <WizardForkStep onDone={advance} />}
    </div>
  );
}
