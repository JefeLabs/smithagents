import { Button } from "@heroui/react";
import { RadioButtonGroup } from "@heroui-pro/react";
import { useState } from "react";
import type { Setup, WizardSaveState } from "../lib/wizardSteps";
import { useApiKeys, useBrainEngine, useCliTools, useSaveBrainEngine } from "../queries/http";

export interface WizardBrainStepProps {
  onDone: (patch: { setup: Setup }) => void;
  /**
   * Declines the step — on the host's terms, not this step's.
   *
   * A skip has to PERSIST something: `brainSkipped`, so "skipped" and "never
   * asked" stay distinguishable (see its comment in lib/wizardSteps.ts). This
   * step has no value of its own to write, so there is nothing here from which
   * that patch could be derived — and there are TWO skip controls on this
   * screen at once after a failed save, the host's own beside the progress
   * line and the escape in this footer. Composing `{setup: {brainSkipped:
   * true}}` here would be a second copy of an answer the step registry already
   * holds, and the first thing to drift out of it the next time a field is
   * added to `skipDefault()`. So this re-emits the host's skip, which reads
   * that registry once, for both controls.
   */
  onSkip: () => void;
  /** Same contract as `WizardSubscriptionsStepProps["onBack"]` — see there. */
  onBack?: () => void;
  /**
   * What became of the host's own save for the patch this step last handed
   * over. Same prop, same meaning, as `WizardSubscriptionsStepProps["saveState"]`.
   *
   * Only the host can know it — `onDone` is fire-and-forget and the write is
   * the host's, not this step's. It carries more weight here than anywhere
   * else because this is the LAST step: nothing swaps this component out when
   * it hands off (see `finish`), so a failed handoff finds it still on screen
   * and inert behind a write that is already over.
   */
  saveState?: WizardSaveState;
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
export function WizardBrainStep({ onDone, onSkip, onBack, saveState = "idle" }: WizardBrainStepProps) {
  const { data: tools = [] } = useCliTools();
  const { data: keys = [] } = useApiKeys();
  const { data: current } = useBrainEngine();
  const saveEngine = useSaveBrainEngine();
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Sticky once set, and never cleared by a later attempt: a save that has
  // failed even once is proof this user can be trapped here, and this is the
  // last step — Back only retreats into the sequence, it never reaches the
  // app, and RadioButtonGroup has no deselect. See the escape it unlocks in
  // the footer.
  const [saveFailed, setSaveFailed] = useState(false);
  // Set the moment the step hands off, and never cleared: a retry that hands
  // off a second time has to be guarded exactly like the first. What re-opens
  // the footer is the host's `saveState`, below — not un-setting this.
  const [handedOff, setHandedOff] = useState(false);
  /**
   * No footer button acts while a save is in flight, or after the handoff for
   * as long as that handoff is still open.
   *
   * `handedOff` alone is a dead end, not a guard. It exists to stop Back from
   * racing the host's `PUT {step:"done"}` (see `finish`), and that race lasts
   * exactly as long as the write does. `saveState === "failed"` is the host
   * saying the write is over and did not land — nothing left to race, and a
   * footer that stays inert past that point strands the user on the last
   * screen of first-run setup with an error, no Skip (the brain save is the
   * one thing that succeeded), and no way back or forward but a page reload.
   * Continue re-runs `proceed`, which re-runs the handoff; Back retreats into
   * the sequence. Both are safe again precisely because the write has already
   * resolved.
   *
   * Note which state is NOT consulted: `"idle"`. A handoff that SUCCEEDED
   * leaves this footer shut for good — the gate swaps to the app when the
   * refetched `me` lands, and until then there is a real window in which a
   * Back would fire `PUT {step:"subscriptions"}` after `{step:"done"}` had
   * already landed. That is what `handedOff` being sticky buys.
   */
  const inert = busy || (handedOff && saveState !== "failed");

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

  /**
   * Hands the step to the host and leaves the footer inert behind it.
   *
   * `advance` does NOT move the on-screen step on the last one — there is no
   * next step; the invalidated `me` query is what swaps the whole gate to the
   * app — so this component stays mounted, and until then every footer button
   * is still live while `PUT {step: "done"}` is in flight. A Back click in that
   * window fires `PUT {step: "subscriptions"}` against it, and if the two land
   * out of order the server keeps `done` while the screen shows Subscriptions.
   * The window is narrow and loses no data, but it exists only because Back is
   * new, so it closes here — for the length of that write, and no longer. Once
   * the host reports the write failed (`saveState`) there is nothing left to
   * race, and staying inert would be the worse bug: see `inert`.
   */
  const finish = () => {
    setHandedOff(true);
    onDone({ setup: {} });
  };

  /**
   * `finish`'s sibling for the two ways OFF this step that saved no brain.
   * Identical as far as this component is concerned — the host writes, nothing
   * swaps this step out, so it closes the same window `finish` does, for the
   * same reason. What differs is only what gets written, and that is the
   * host's to say: see `onSkip`.
   */
  const skipOut = () => {
    setHandedOff(true);
    onSkip();
  };

  const proceed = async () => {
    const candidate = candidates.find((c) => c.key === checkedKey);
    if (!candidate) {
      // Nothing to pick, and nothing was — brainEngine stays unset, which
      // resolveBrainFactory (broker/src/brain-engine.ts) already treats as a
      // safe, working state (SMITH_BRAIN_PROVIDER, then the no-key default).
      // This step never needs to block progress the way Subscriptions does.
      //
      // `skipOut`, not `finish`: that outcome is precisely what a skip states,
      // so it must be recorded as one. Handing back a bare `{setup: {}}` here
      // would leave this user indistinguishable on the wire from someone who
      // deliberately chose a brain.
      skipOut();
      return;
    }
    setBusy(true);
    setError(null);
    let res: { kind?: string; provider?: string; model?: string; error?: string };
    try {
      res = await saveEngine.mutateAsync(candidate.body);
    } catch (err) {
      // The REJECT shape: brokerFetch never throws on a non-2xx, so only a
      // network-level failure (or an unparseable body) lands here — the
      // server's own refusal takes the resolved branch below. Both are dead
      // ends without the escape, so both must set it.
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
      setSaveFailed(true);
      return;
    }
    setBusy(false);
    if (res?.error) {
      // Surfaced, not swallowed — and note the save already durably
      // persisted nothing new, so a rollback of the *next* PUT (WizardGate's
      // own `advance`, which this step never even reaches on a refusal) has
      // nothing of this step's to lose.
      setError(res.error);
      setSaveFailed(true);
      return;
    }
    finish();
  };

  return (
    <div className="wizard-brain-step">
      <h2 className="wizard-brain-step__title">Which of these should I use, and for what?</h2>
      <p className="wizard-brain-step__prompt" id="wizard-brain-prompt">
        This is what I'll think with — pick from what's already working on your machine.
      </p>
      {error && <p className="wizard__error">{error}</p>}
      {saveFailed && (
        <p className="wizard__hint">
          I'll still reply using a built-in default — you can set this later in Settings → Brain.
        </p>
      )}
      {candidates.length === 0 ? (
        <p className="wizard__hint">
          Nothing validated yet to pick from — I'll fall back to a built-in default until you add a CLI or key.
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
      <div className="wizard-gate__footer">
        {/* First, in DOM and therefore in tab order: a wizard footer leads with
            Back. Inert while a save is in flight and after the handoff, so it
            can never race the write it would navigate away from. */}
        {onBack && (
          <Button variant="secondary" onPress={onBack} isDisabled={inert}>
            Back
          </Button>
        )}
        <Button variant="primary" onPress={() => void proceed()} isDisabled={inert}>
          Continue
        </Button>
        {saveFailed && (
          // Appears only after a save has actually failed, so the step stays a
          // confirmation for everyone else. Leaves `brainEngine` unset, which
          // resolveBrainFactory (broker/src/brain-engine.ts) already treats as
          // a safe working state — the same state the no-candidates branch of
          // `proceed` above hands the wizard. Without it, a user whose only
          // installed CLI the server refuses (codex-only, no verified
          // anthropic/gemini key) can never leave this step, and since it is
          // the LAST step, never reaches the app at all.
          <Button variant="secondary" onPress={skipOut} isDisabled={inert}>
            Skip for now
          </Button>
        )}
      </div>
    </div>
  );
}
