import { Button } from "@heroui/react";
import type { Setup, WizardSaveState } from "../lib/wizardSteps";
import { useApiKeys, useCliTools } from "../queries/http";
import { ApiKeysGroup } from "./settings/ApiKeysGroup";
import { CliToolsGroup } from "./settings/CliToolsGroup";

export interface WizardSubscriptionsStepProps {
  onDone: (patch: { setup: Setup }) => void;
  /** Absent when there is nothing behind this step — the host asks the step
      machine (`prevStep`) and simply does not pass one, so this component
      never has to know where it sits in a sequence it does not own. */
  onBack?: () => void;
  /**
   * What became of the host's own save for the patch it last sent. Same prop,
   * same meaning, as `WizardBrainStepProps["saveState"]` — one mechanism, not
   * a second one invented per step. See the type's own comment for the race
   * it closes; the only thing this step does with it is refuse to retreat
   * while a write it cannot see is still in flight.
   */
  saveState?: WizardSaveState;
}

/**
 * "The whole safety net in v1" (spec: 2026-08-15-welcome-wizard-design.md).
 * Renders the two PERMANENT Settings screens rather than a wizard-only
 * clone — CliToolsGroup already carries the class-aware guidance (this
 * task's Step 1: install/login/billing/policy, each named instead of one
 * collapsed "unavailable"). This step only adds the gate on top.
 *
 * Rendered in full, not a bespoke "verify affordance": `ApiKeysGroup`
 * already implements save/verify/remove/error-surfacing correctly, and a
 * second, thinner component would have to duplicate that mutation wiring to
 * cover the exact same route the spec asks for ("paste an API key"). The one
 * divergence from the spec's mockup is scope, not behaviour — this shows
 * every registered provider, not just anthropic/gemini, because CliToolsGroup
 * and ApiKeysGroup are the SAME two screens Settings uses and neither
 * filters by context.
 *
 * Continue unblocks on either route the spec offers: one CLI the registry
 * confirms is active, or one API key the broker has actually verified.
 * `active` on `CliToolListing` already encodes "block only confirmed
 * negatives" (cli-tools.ts's `isActive`) — `authOk: "unknown"` counts as
 * active, so copilot's and agy's PERMANENT unknown-auth state (Task 2: no
 * probe exists for either) never strands anyone here.
 *
 * NOT implemented: the spec's "validate live … the step completes on one
 * real turn." Nothing in this codebase owns running a CLI turn outside a
 * real task dispatch, and a fake one would be worse than none — this gates
 * on PROBE validity only. Live-turn validation belongs with whatever plan
 * owns turn execution.
 */
export function WizardSubscriptionsStep({ onDone, onBack, saveState = "idle" }: WizardSubscriptionsStepProps) {
  const { data: tools = [] } = useCliTools();
  const { data: keys = [] } = useApiKeys();

  const canContinue = tools.some((t) => t.active) || keys.some((k) => k.verified === true);

  return (
    <div className="wizard-subscriptions-step">
      <p className="wizard__hint">
        Install a CLI or paste an API key — Continue unlocks the moment one of your subscriptions actually works.
      </p>
      {/* `headingLevel` is the ONLY reason these two take a prop at all. Each
          group titles itself with an `<h1>`, which is right in Settings —
          SettingsPanel renders exactly one group at a time and has no heading
          of its own, so that `<h1>` is the page's only one. Here two groups
          render at once *inside* a panel that already owns the `<h1>`
          ("Welcome, …"), so left alone this screen ships three. Passing the
          nested level fixes the document outline without demoting the ten
          other Settings groups that share the `<h1>` pattern. */}
      <CliToolsGroup headingLevel="h2" />
      <ApiKeysGroup headingLevel="h2" />
      {/* `setup: {}` is enough: the host (`WizardGate`'s `advance`) always
          stamps `step` itself, and the broker's own merge — buildUserUpdate,
          `{...existing?.setup, ...body.setup}` — preserves whatever the fork
          step already recorded (e.g. `mode`). Nothing here has data of its
          own to add. */}
      <div className="wizard-gate__footer">
        {/* Back lives in the step's own footer, not in a second band of the
            host's — this step owns the only `.wizard-gate__footer` on screen,
            and a host-rendered one would stack a second sticky bar under it.
            First in DOM and therefore in tab order, the way a wizard footer
            conventionally reads. Never disabled by `canContinue`: retracting an
            answer is exactly what someone stuck on this gate needs.

            Inert only while the host's own write is in flight. This step is on
            screen from the instant `advance` moves it, which is BEFORE the
            `PUT {mode, step:"subscriptions"}` that brought the user here has
            resolved; a Back clicked in that window fires `PUT {step:"preflight"}`
            against it, and if the two land out of order the server keeps
            `subscriptions` while the screen shows preflight — so the next
            reload silently undoes the Back. `"failed"` deliberately does NOT
            disable it: a write that is over and did not land is exactly when
            someone wants out.

            Continue is not guarded the same way, and that is deliberate: the
            host's contract is that moving FORWARD never waits on the network
            (see WelcomeWizard's comment), and a forward click unmounts this
            step anyway, so the worst it can do is what a reload already
            reconciles. */}
        {onBack && (
          <Button variant="secondary" onPress={onBack} isDisabled={saveState === "saving"}>
            Back
          </Button>
        )}
        <Button variant="primary" onPress={() => onDone({ setup: {} })} isDisabled={!canContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
