import { Button } from "@heroui/react";
import { RadioButtonGroup } from "@heroui-pro/react";
import { useState } from "react";
import type { Setup } from "../lib/wizardSteps";
import { useApiKeys, useBrainEngine, useCliTools, useSaveBrainEngine } from "../queries/http";

export interface WizardBrainStepProps {
  onDone: (patch: { setup: Setup }) => void;
}

/**
 * Providers `buildBrainEngineUpdate` accepts for an api-kind brain
 * (swarm/src/server.ts's `API_BRAIN_PROVIDERS`) — mirrored, not imported; no
 * shared package crosses the control-plane/swarm boundary, same as every
 * other wire-shape duplication in this app.
 */
const BRAIN_API_PROVIDERS = ["anthropic", "gemini"];

interface Candidate {
  /** Radio value — disambiguates a cli id from an api provider id sharing a name. */
  key: string;
  label: string;
  body: { kind: "cli" | "api"; provider: string };
}

/**
 * Welcome wizard, last step: what Anderson — the conversational brain —
 * replies with. Deliberately separate from the Subscriptions step (Task 3),
 * which asks what's *available*: this install can run coding agents on the
 * `claude` subscription while Anderson itself runs on a Gemini key, and the
 * spec wants that divergence representable.
 *
 * `buildBrainEngineUpdate` (swarm/src/server.ts) is the real gate: only
 * `claude` may be saved as a cli brain today (every other cli "accepts
 * --json-schema without enforcing it" per its own comment), while an
 * `api`-kind pick is only checked against `API_BRAIN_PROVIDERS` — no
 * verified-key check at save time. This component does NOT pre-filter cli
 * candidates down to that allowlist: every ACTIVE cli tool is offered (same
 * "reality before preference" cut CliToolsGroup and ResearchEngineGroup
 * already use), and a pick the server refuses surfaces the server's own
 * reason via `error` rather than being silently hidden from the list — a
 * user whose only working tool is refused deserves to know why, not stare at
 * an empty picker.
 */
export function WizardBrainStep({ onDone }: WizardBrainStepProps) {
  const { data: tools = [] } = useCliTools();
  const { data: keys = [] } = useApiKeys();
  const { data: current } = useBrainEngine();
  const saveEngine = useSaveBrainEngine();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // cli candidates first — a working subscription CLI beats a pasted key as
  // the "strongest validated option" default, the same route-order
  // preference WizardSubscriptionsStep's canContinue already expresses.
  const cliCandidates: Candidate[] = tools
    .filter((t) => t.active)
    .map((t) => ({ key: `cli:${t.cli}`, label: t.label, body: { kind: "cli" as const, provider: t.cli } }));

  // api candidates: only a provider the server's own API_BRAIN_PROVIDERS
  // would accept, AND only when this machine's stored key for it has
  // actually been verified — the server doesn't check that at save time for
  // an api kind, but offering an unverified key as if it worked would be a
  // step backwards from the "reality before preference" rule every other
  // engine picker here follows (ResearchEngineGroup, ApiKeysGroup).
  const apiCandidates: Candidate[] = BRAIN_API_PROVIDERS.flatMap((provider) => {
    const listing = keys.find((k) => k.id === provider && k.verified === true);
    return listing ? [{ key: `api:${provider}`, label: listing.label, body: { kind: "api" as const, provider } }] : [];
  });

  const candidates = [...cliCandidates, ...apiCandidates];

  // A previously saved choice (resuming this step) wins over the computed
  // default; an in-session pick wins over both. redactBrainEngine already
  // hides a stored cli whose gate has since failed (server-side), so `current`
  // here is never a known-dead choice — it just might not be among today's
  // candidates (e.g. its key was removed since), in which case nothing below
  // matches it and the group simply shows nothing checked.
  const currentKey = current ? `${current.kind}:${current.provider}` : undefined;
  const checkedKey = selected ?? currentKey ?? candidates[0]?.key;

  const proceed = async () => {
    const candidate = candidates.find((c) => c.key === checkedKey);
    if (!candidate) {
      // Nothing to pick, and nothing was — brainEngine stays unset, which
      // resolveBrainFactory (broker/src/brain-engine.ts) already treats as a
      // safe, working state (SMITH_BRAIN_PROVIDER, then the no-key default).
      // This step never needs to block progress the way Subscriptions does.
      onDone({ setup: {} });
      return;
    }
    setBusy(true);
    setError(null);
    let res: { kind?: string; provider?: string; model?: string; error?: string };
    try {
      res = await saveEngine.mutateAsync(candidate.body);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(false);
    if (res?.error) {
      // Surfaced, not swallowed — and note the save already durably
      // persisted nothing new, so a rollback of the *next* PUT (WizardGate's
      // own `advance`, which this step never even reaches on a refusal) has
      // nothing of this step's to lose.
      setError(res.error);
      return;
    }
    onDone({ setup: {} });
  };

  return (
    <div className="wizard-brain-step">
      <p className="wizard-brain-step__prompt" id="wizard-brain-prompt">
        What should Anderson — the conversational host — use to reply? This can differ from what backs your coding
        agents.
      </p>
      {error && <p className="wizard__error">{error}</p>}
      {candidates.length === 0 ? (
        <p className="wizard__hint">
          Nothing validated yet to pick from — Anderson falls back to a built-in default until you add a CLI or key.
        </p>
      ) : (
        <RadioButtonGroup
          aria-labelledby="wizard-brain-prompt"
          value={checkedKey}
          onChange={(value) => {
            if (typeof value === "string") setSelected(value);
          }}
          orientation="vertical"
        >
          {candidates.map((c) => (
            <RadioButtonGroup.Item key={c.key} value={c.key}>
              <RadioButtonGroup.Indicator />
              <RadioButtonGroup.ItemContent>
                <span className="wizard-brain-step__label">{c.label}</span>
              </RadioButtonGroup.ItemContent>
            </RadioButtonGroup.Item>
          ))}
        </RadioButtonGroup>
      )}
      <Button variant="primary" onPress={() => void proceed()} isDisabled={busy}>
        Continue
      </Button>
    </div>
  );
}
