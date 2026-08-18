import { Button, Checkbox } from "@heroui/react";
import { useState } from "react";
import type { CliToolListing, LocalServer } from "../api/types";
import type { Setup, WizardSaveState } from "../lib/wizardSteps";
import { useApiKeys, useCliTools, useLocalModels } from "../queries/http";
import { ApiKeysGroup } from "./settings/ApiKeysGroup";

/**
 * The only two providers this step offers, and the user's ruling on Plan 2.
 *
 * The spec's own list was "Anthropic · OpenAI · Google · OpenRouter".
 * OpenRouter is not in the swarm's registry at all, and NOTHING in this
 * codebase consumes an OpenAI key — it cannot back a brain
 * (`API_BRAIN_PROVIDERS` is `{anthropic, gemini}`), research, or anything
 * else. Offering either would collect a credential that does nothing, and
 * would put an option into Step 2's dropdowns that the server then refuses —
 * the exact shape that trapped a codex-only user on the old brain step and
 * had to be rescued with a "Skip for now" escape.
 *
 * They come back the moment a consumer exists; the registry already has
 * `openai`, so that is a one-line change here and nothing else.
 */
export const WIZARD_KEY_PROVIDERS = ["anthropic", "google"] as const;

/** The three things Anderson can think with — `BrainEngine.kind`'s own trio, in the spec's words. */
type SourceKind = "logins" | "keys" | "local";

/**
 * One CLI's line under *Logins you already have*, in the spec's own shape:
 * `✓ claude — you're signed in` · `✗ codex — not installed`. Exported for
 * direct testing, the same way `pillFor`/`pillForApiKey` are.
 *
 * The mark tracks `active` and nothing else, so what the eye sees and what
 * the gate counts can never disagree. That is why a never-probed tool
 * (`status: null`) gets a ✓ despite saying so: `isActive(undefined)` is TRUE
 * in the swarm — block only confirmed negatives, never ignorance — and a ✗
 * beside a source that opens the gate would be the worse lie of the two.
 *
 * `authOk: "unknown"` is the case this exists for. `copilot` has no auth
 * probe beyond an OAuth browser flow and `agy` has no auth command at all,
 * so both are PERMANENTLY unknown; they are active, and the line says what
 * is actually known rather than claiming a login nobody confirmed.
 */
export function loginLine(t: CliToolListing): string {
  const s = t.status;
  const phrase = !s
    ? "I haven't checked this one yet"
    : !s.detected
      ? "not installed"
      : s.authOk === false
        ? "not signed in"
        : !s.enabled
          ? "turned off in settings"
          : s.authOk === "unknown"
            ? "installed — I can't tell whether you're signed in"
            : "you're signed in";
  return `${t.active ? "✓" : "✗"} ${t.cli} — ${phrase}`;
}

/**
 * A model's size, when the server actually reports one.
 *
 * Every real `sizeBytes` is `null` today — the OpenAI-compatible
 * `/v1/models` both Ollama and LM Studio expose does not carry a size, and
 * `detectLocalServers` refuses to guess one. Callers must therefore skip the
 * slot entirely for a null: rendering it through a formatter that turns
 * `null` into `0` would print "0 B" beside a 20GB model.
 */
export function formatSize(bytes: number): string {
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

/** A source counts only if this machine can genuinely use it — see each caller for the rule. */
function usableSources(tools: CliToolListing[], verifiedKey: boolean, servers: LocalServer[] | undefined) {
  return {
    // `active` already encodes the swarm's own gate rule (cli-tools.ts's
    // `isActive`), unknown-auth included. Re-deriving it here would be a
    // second, drifting copy of a rule that has one home.
    logins: tools.some((t) => t.active),
    // Reality before preference: a key sitting on this machine is not a key
    // that works. Only a broker-confirmed `verified === true` opens the gate.
    keys: verifiedKey,
    // A running server holding NO models is not a source: Step 2 asks which
    // model to think with, and passing this gate on the server's mere presence
    // walks the user into a dropdown with nothing in it.
    local: (servers ?? []).some((s) => s.models.length > 0),
  } satisfies Record<SourceKind, boolean>;
}

/** What the local probe found, or an honest account of why it has not said yet. */
function LocalFindings({
  servers,
  pending,
  onRecheck,
  rechecking,
}: {
  servers: LocalServer[] | undefined;
  pending: boolean;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  return (
    <div className="wizard-sources-step__findings">
      {/* Three DIFFERENT answers, never collapsed into one. `data ?? []` would
          report "nothing is running" while the probe is still in flight and
          again when it failed outright — an absence nothing ever established,
          and one the user would act on by installing something they may
          already have. */}
      {servers === undefined ? (
        pending ? (
          <p className="wizard__hint">Checking this machine for a model server…</p>
        ) : (
          <p className="wizard__hint">I couldn't check this machine for a model server just now.</p>
        )
      ) : servers.length === 0 ? (
        <p className="wizard__hint">
          I can't find a model server running on this machine — nothing answered on Ollama's port (11434) or LM Studio's
          (1234).
        </p>
      ) : (
        servers.map((s) => (
          <div key={s.id} className="wizard-sources-step__server">
            <b>{s.label}</b>
            {s.models.length === 0 ? (
              <p className="wizard__hint">{s.label} is running, but it isn't holding any models yet.</p>
            ) : (
              <ul className="wizard-sources-step__models">
                {s.models.map((m) => (
                  <li key={m.id}>
                    <span>{m.id}</span>
                    {/* Skipped entirely for a null — see `formatSize`. */}
                    {m.sizeBytes !== null && <em>{formatSize(m.sizeBytes)}</em>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
      {/* A probe answers about this instant, and the honest "nothing is
          running" above goes stale the moment someone starts LM Studio in the
          other window. Without this the only way to re-ask is a reload, which
          on the first step of first-run setup is a retreat out of the wizard —
          so this is the local section's escape, not a convenience. */}
      <button type="button" className="settings-btn" onClick={onRecheck} disabled={rechecking}>
        {rechecking ? "checking…" : "check again"}
      </button>
    </div>
  );
}

export interface WizardSourcesStepProps {
  onDone: (patch: { setup: Setup }) => void;
  /** Absent when there is nothing behind this step — same contract the step
      this replaces had: the host asks the step machine (`prevStep`) and simply
      does not pass one. */
  onBack?: () => void;
  /** For the heading, which Anderson addresses by name. Threaded from the host
      rather than re-fetched, so exactly one place reads it from the user
      record. Never the "You" placeholder — preflight has already collected a
      real name by the time this step is reachable. */
  name: string;
  /** What became of the host's own `PUT /me` for the patch it last sent — see
      `WizardSaveState` for the race it closes. */
  saveState?: WizardSaveState;
}

/**
 * Step 1 of the wizard — *Where I think*. Replaces the Subscriptions step,
 * and asks the spec's question instead of the old screen's: not "connect a
 * CLI or a key" but "where should I get my thinking from", over the three
 * source kinds `BrainEngine.kind` already names (`cli`, `api`, `local`).
 *
 * MULTI-SELECT, NOT A FORK. The three boxes accumulate; picking keys does not
 * un-pick logins. That is the spec's own wording ("Pick as many as you like")
 * and it is what lets Step 2 offer a mixed list.
 *
 * The gate is `chosen AND usable`, not either alone:
 *  - usable-but-unticked does not open it, or the checkboxes would be
 *    decoration and unticking every source would leave Continue live;
 *  - ticked-but-unusable does not open it either, which is the whole point of
 *    a gate that has to mean something.
 *
 * Logins arrive PRE-TICKED when this machine has a usable one, so the common
 * case is a single click. It is a default, not a mirror: once the user says
 * no, a later refetch of the same probe must not re-tick the box under their
 * hand, which is why the choice is an override map rather than state synced
 * from the query.
 *
 * The keys branch renders Settings' own `ApiKeysGroup` — save, verify, remove
 * and its error surfacing already work there, and a wizard-only clone would
 * duplicate that mutation wiring to reach the same route. It is filtered to
 * `WIZARD_KEY_PROVIDERS` (see there) and passed `headingLevel="h2"`, because
 * the page's single `<h1>` belongs to the host.
 *
 * NOT a dead end, and this needed saying twice already on this feature: Back
 * is never gated on Continue's condition, the local section can always be
 * re-probed, and a user with nothing usable can still paste a key inline.
 * What this step CANNOT rescue on its own is a machine with no CLI, no
 * reachable provider and no local server — that user must go Back, or take
 * the host's Skip. Both exist; neither is this component's to render.
 */
export function WizardSourcesStep({ onDone, onBack, saveState = "idle", name }: WizardSourcesStepProps) {
  const { data: tools = [] } = useCliTools();
  const { data: keys = [] } = useApiKeys();
  const { data: servers, isPending: localPending, isFetching: localFetching, refetch: recheckLocal } = useLocalModels();

  // Restricted to the providers this step actually OFFERS. A verified `openai`
  // key is real, but its card is filtered out of the section below, so counting
  // it would open the gate on a source the user cannot see here — and hand Step
  // 2 a provider the server refuses for every role.
  const verifiedKey = keys.some((k) => k.verified === true && WIZARD_KEY_PROVIDERS.some((p) => p === k.id));
  const usable = usableSources(tools, verifiedKey, servers);

  // The user's own answers, absent until they give one. Reading the default
  // through `??` rather than seeding state from the query keeps the pre-tick a
  // DEFAULT: it applies while the user has not spoken, and a later probe
  // result can never overwrite an answer they have.
  const [choice, setChoice] = useState<Partial<Record<SourceKind, boolean>>>({});
  const chosen: Record<SourceKind, boolean> = {
    logins: choice.logins ?? usable.logins,
    keys: choice.keys ?? false,
    local: choice.local ?? false,
  };
  const pick = (kind: SourceKind) => (on: boolean) => setChoice((c) => ({ ...c, [kind]: on }));

  const canContinue = (Object.keys(chosen) as SourceKind[]).some((k) => chosen[k] && usable[k]);

  return (
    <div className="wizard-sources-step">
      {/* `<h2>`: the panel's `<h1>` is the host's greeting, and ApiKeysGroup's
          own title below is this step's sibling, not its child. */}
      <h2 className="wizard-sources-step__title">Where should I get my thinking from, {name}?</h2>
      <p className="wizard-sources-step__lede">Pick as many as you like — I'll use whichever suits each job.</p>

      <div className="wizard-sources-step__source">
        <Checkbox isSelected={chosen.logins} onChange={pick("logins")}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <span>
              <strong>Logins you already have</strong> — nothing to paste
            </span>
          </Checkbox.Content>
        </Checkbox>
        {/* Always on screen, unlike the two branches below, and the spec's own
            wording is the reason: keys and local "expand", logins do not. It
            is also the only thing that explains a disabled Continue — hiding
            `✗ codex — not installed` behind a box the user has no reason to
            tick would put the diagnosis one click further away than the
            problem. Read-only, so there is nothing here to expand FOR.

            A sibling of the checkbox, never a descendant: HeroUI's Checkbox
            renders a `<label>`, and anything interactive nested inside one
            toggles it on every click — which is what the two branches below
            depend on. */}
        <ul className="wizard-sources-step__logins">
          {tools.map((t) => (
            <li key={t.cli}>{loginLine(t)}</li>
          ))}
        </ul>
      </div>

      <div className="wizard-sources-step__source">
        <Checkbox isSelected={chosen.keys} onChange={pick("keys")}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <span>
              <strong>Your own API keys</strong> — Anthropic · Google
            </span>
          </Checkbox.Content>
        </Checkbox>
        {chosen.keys && <ApiKeysGroup headingLevel="h2" only={WIZARD_KEY_PROVIDERS} />}
      </div>

      <div className="wizard-sources-step__source">
        <Checkbox isSelected={chosen.local} onChange={pick("local")}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            <span>
              <strong>Models on your machine</strong> — I'll download them, and nothing leaves your computer
            </span>
          </Checkbox.Content>
        </Checkbox>
        {chosen.local && (
          <LocalFindings
            servers={servers}
            pending={localPending}
            rechecking={localFetching}
            onRecheck={() => void recheckLocal()}
          />
        )}
      </div>

      {/* `setup: {}` is enough: the host stamps `step` itself and the broker
          merges setup, so nothing is cleared by omission. Which BOXES were
          ticked is deliberately not persisted — every consumer downstream
          (Step 2's dropdowns) reads the same three probes this step does, and
          a stored copy of the answer would be a second source of truth that
          goes stale the moment a CLI is logged out of. */}
      <div className="wizard-gate__footer">
        {/* Back leads the footer, in DOM and so in tab order, and is NEVER
            gated on Continue's condition — the user it matters for is the one
            Continue is disabled for. It is inert only while the host's own
            write is in flight (a Back clicked in that window races the
            `PUT {step}` that put this step on screen); `"failed"` deliberately
            stays live, because a write that is over and did not land is
            exactly when someone wants out.

            Continue is not guarded the same way, deliberately: the host's
            contract is that moving FORWARD never waits on the network, and a
            forward click unmounts this step anyway. */}
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
