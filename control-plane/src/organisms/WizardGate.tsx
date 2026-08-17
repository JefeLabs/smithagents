import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useState } from "react";
import * as api from "../api/broker";
import type { MeRecord } from "../api/types";
import { isSetupComplete, nextStep, resumeStep, SETUP_DONE, type WizardStep } from "../lib/wizardSteps";
import { useMe } from "../queries/http";
import { qk } from "../queries/keys";
import { WizardForkStep } from "./WizardForkStep";
import { WizardNameStep } from "./WizardNameStep";

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

  if (isLoading) return <div className="wizard-gate__splash" aria-busy="true" />;
  if (isError || !me) return <>{children}</>;

  // A user with `setup` entirely absent predates this feature — never drag an
  // existing install into the wizard just because `isSetupComplete(undefined)`
  // reads false. Only a fresh install (`placeholder`) or a genuinely
  // half-finished setup (`setup` present but not `done`) opens it.
  const needsSetup = me.placeholder === true || (me.setup !== undefined && !isSetupComplete(me.setup));
  if (!needsSetup) return <>{children}</>;

  return <WelcomeWizard initialStep={resumeStep(me.setup)} me={me} />;
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
 */
function WelcomeWizard({ initialStep, me }: { initialStep: WizardStep; me: MeRecord }) {
  const [step, setStep] = useState(initialStep);
  const qc = useQueryClient();

  const advance = (patch: { name?: string; setup?: MeRecord["setup"] }) => {
    const next = nextStep(step);
    void api.updateMe({ ...patch, setup: { ...patch.setup, step: next ?? SETUP_DONE } }).then(() => {
      void qc.invalidateQueries({ queryKey: qk.me });
    });
    // Only a real next step moves the host's own view — the SETUP_DONE case
    // has no step of its own to show; the invalidated `me` query is what
    // makes WizardGate itself swap to the app.
    if (next) setStep(next);
  };

  return (
    <div className="wizard-gate__host" data-step={step}>
      <h1>Welcome{me.placeholder ? "" : `, ${me.name}`}</h1>
      {step === "name" && <WizardNameStep initialName={me.placeholder ? "" : me.name} onDone={advance} />}
      {step === "fork" && <WizardForkStep onDone={advance} />}
    </div>
  );
}
