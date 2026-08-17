import type { ReactNode } from "react";
import type { MeRecord } from "../api/types";
import { isSetupComplete, resumeStep, type WizardStep } from "../lib/wizardSteps";
import { useMe } from "../queries/http";

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
 * The step host. For this plan it renders a heading and a placeholder for the
 * current step — Task 3 fills in the real step components. `data-step` on the
 * root names which step is showing without depending on that step's own
 * markup, so resume behaviour stays testable across the swap.
 */
function WelcomeWizard({ initialStep, me }: { initialStep: WizardStep; me: MeRecord }) {
  return (
    <div className="wizard-gate__host" data-step={initialStep}>
      <h1>Welcome{me.placeholder ? "" : `, ${me.name}`}</h1>
      <p>Step: {initialStep}</p>
    </div>
  );
}
