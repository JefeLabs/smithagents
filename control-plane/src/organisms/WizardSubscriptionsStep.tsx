import { Button } from "@heroui/react";
import type { Setup } from "../lib/wizardSteps";
import { useApiKeys, useCliTools } from "../queries/http";
import { ApiKeysGroup } from "./settings/ApiKeysGroup";
import { CliToolsGroup } from "./settings/CliToolsGroup";

export interface WizardSubscriptionsStepProps {
  onDone: (patch: { setup: Setup }) => void;
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
export function WizardSubscriptionsStep({ onDone }: WizardSubscriptionsStepProps) {
  const { data: tools = [] } = useCliTools();
  const { data: keys = [] } = useApiKeys();

  const canContinue = tools.some((t) => t.active) || keys.some((k) => k.verified === true);

  return (
    <div className="wizard-subscriptions-step">
      <p className="wizard__hint">
        Install a CLI or paste an API key — Continue unlocks the moment one of your subscriptions actually works.
      </p>
      <CliToolsGroup />
      <ApiKeysGroup />
      {/* `setup: {}` is enough: the host (`WizardGate`'s `advance`) always
          stamps `step` itself, and the broker's own merge — buildUserUpdate,
          `{...existing?.setup, ...body.setup}` — preserves whatever the fork
          step already recorded (e.g. `mode`). Nothing here has data of its
          own to add. */}
      <Button variant="primary" onPress={() => onDone({ setup: {} })} isDisabled={!canContinue}>
        Continue
      </Button>
    </div>
  );
}
