import { Button } from "@heroui/react";
import { useState } from "react";
import type { ApiKeyListing, BrainEngineRecord, CliToolListing, LocalServer } from "../api/types";
import { classifySave } from "../lib/saveOutcome";
import type { Setup, WizardSaveState } from "../lib/wizardSteps";
import { useApiKeys, useCliTools, useEngines, useLocalModels, useMachineFacts, useSaveEngines } from "../queries/http";
import { formatSize } from "./WizardSourcesStep";

/**
 * Which CLIs the swarm will actually accept as an engine — mirrored from
 * `BRAIN_CLI_ALLOWLIST` (swarm/src/server.ts), not imported; no shared package
 * crosses this boundary. Its own comment carries the reason: *"a brain cli must
 * ENFORCE `--json-schema` for tool calls, not merely accept the flag"*, and
 * only claude has been verified to.
 *
 * Mirroring the allowlist here rather than offering every active CLI is the
 * whole point of this screen's filtering. The step this replaces offered them
 * all and let the server refuse, which trapped a codex-only user on the last
 * screen of first-run setup and had to be rescued with a bolted-on escape.
 */
const BRAIN_CLIS = ["claude"];

/**
 * API-key provider id → the brain provider the swarm names for it.
 *
 * These two vocabularies genuinely differ and the gap has already cost one
 * dead option: the key registry's ids are `anthropic` / `openai` / `google`
 * (swarm/src/api-keys.ts), while `API_BRAIN_PROVIDERS` is
 * `{anthropic, gemini}`. The step this replaces looked for a key whose id was
 * `"gemini"` — a key the registry has never had — so a verified Google key
 * silently offered nothing at all. The broker resolves that same key by its
 * registry id (`swarm.getApiKeyCredential("google")` in broker/src/main.ts),
 * which is what makes this mapping the true one rather than a convenience.
 *
 * `openai` is deliberately absent: nothing in this codebase consumes an OpenAI
 * key, so the server refuses it for every role.
 */
const KEY_PROVIDER_TO_BRAIN: Record<string, string> = { anthropic: "anthropic", google: "gemini" };

/** The three roles, in the order the spec asks them. */
const ROLES = ["main", "quick", "fallback"] as const;
type Role = (typeof ROLES)[number];

const ROLE_LABELS: Record<Role, string> = {
  main: "My main brain",
  quick: "Quick little things",
  fallback: "If something's unavailable",
};

/** The fallback's own answer, and a real value — see `bodyFor`. */
const NOTHING = "none";
const NOTHING_LABEL = "nothing — I'll just tell you";

interface Candidate {
  /** The `<option>` value. Opaque — never parsed back apart, since a model id may itself contain a colon. */
  key: string;
  label: string;
  body: BrainEngineRecord;
}

/** GiB, which is what every OS means when it says a machine has "32GB". */
const gigabytes = (bytes: number) => Math.round(bytes / 1024 ** 3);

/** The key a stored engine would have had, so a resumed answer can find itself in the list. */
function keyFor(engine: BrainEngineRecord): string {
  return engine.kind === "local"
    ? `local:${engine.provider}:${engine.model ?? ""}`
    : `${engine.kind}:${engine.provider}`;
}

/**
 * Everything this machine has that the server would accept for a role, in ONE
 * list.
 *
 * Flat and ungrouped, per the spec: no `<optgroup>`, no per-origin headings —
 * a login, a key and a local model sit side by side, each saying where it came
 * from in its own label. The ORDER is a preference ranking rather than a
 * grouping: a working subscription CLI beats a pasted key beats a local model
 * as the thing to default to, which is the same "strongest validated option"
 * order the brain step already expressed. It decides only what sits at the top
 * of the list, not what the list contains.
 */
function candidatesFrom(
  tools: CliToolListing[],
  keys: ApiKeyListing[],
  servers: LocalServer[] | undefined,
): Candidate[] {
  const cli: Candidate[] = tools
    .filter((t) => t.active && BRAIN_CLIS.includes(t.cli))
    // `t.cli`, not `t.label` — the spec's own example reads `claude (login)`,
    // and Step 1 listed the same tools by id one screen earlier.
    .map((t) => ({ key: `cli:${t.cli}`, label: `${t.cli} (login)`, body: { kind: "cli", provider: t.cli } }));

  // Reality before preference, the same cut every other engine picker here
  // makes: a key sitting on this machine is not a key that works. The swarm
  // does NOT check this at save time for an api kind, so offering an
  // unverified key would produce a brain that fails on its first turn rather
  // than a refusal anyone could read.
  const api: Candidate[] = keys.flatMap((k) => {
    const provider = KEY_PROVIDER_TO_BRAIN[k.id];
    if (!provider || k.verified !== true) return [];
    return [{ key: `api:${provider}`, label: `${k.label} (key)`, body: { kind: "api", provider } }];
  });

  const local: Candidate[] = (servers ?? []).flatMap((s) =>
    s.models.map((m) => ({
      key: `local:${s.id}:${m.id}`,
      // The spec asks local picks to show size. Every real `sizeBytes` is
      // null today — the OpenAI-compatible `/v1/models` both Ollama and LM
      // Studio expose does not report one — so the slot is SKIPPED rather
      // than filled: a formatter fed a null prints "0 MB" beside a 20GB
      // model, which is worse than saying nothing.
      label: m.sizeBytes === null ? `${m.id} (local)` : `${m.id} — ${formatSize(m.sizeBytes)} (local)`,
      body: { kind: "local", provider: s.id, baseUrl: s.baseUrl, model: m.id },
    })),
  );

  return [...cli, ...api, ...local];
}

export interface WizardRolesStepProps {
  onDone: (patch: { setup: Setup }) => void;
  /**
   * Declines the step — on the host's terms, not this step's.
   *
   * A way off this screen that saved nothing has to PERSIST something:
   * `rolesSkipped`, so "skipped" and "never asked" stay distinguishable (see
   * its comment in lib/wizardSteps.ts). The three answers live on the user
   * record proper, via `PUT /me/engines`, so this step has no value of its own
   * from which such a patch could be derived — and after a refused save there
   * are TWO such controls on screen at once, the host's Skip beside the
   * progress line and the escape in this footer. Composing
   * `{setup: {rolesSkipped: true}}` here would be a second copy of an answer
   * the step registry already holds, and the first thing to drift out of it
   * the next time a field is added to `skipDefault()`. So this re-emits the
   * host's own skip, which reads that registry once, for both controls.
   */
  onSkip: () => void;
  /** Absent when there is nothing behind this step — same contract as WizardSourcesStep's. */
  onBack?: () => void;
  /** What became of the HOST's own `PUT /me` for the patch it last sent — see `WizardSaveState`. */
  saveState?: WizardSaveState;
}

/**
 * Step 2 of the wizard — *What I think with*. Replaces the brain step, and
 * asks the spec's question instead of the old screen's: not "which one engine
 * backs Anderson" but which of the sources Step 1 collected should play each
 * of three roles.
 *
 * EVERY DROPDOWN OFFERS ONLY WHAT THE SERVER WILL ACCEPT FOR THAT ROLE, and
 * that is the design rather than a nicety. The step this replaces listed every
 * active CLI and let `buildEnginesUpdate` refuse the ones it must; a user whose
 * only installed tool was codex therefore met a refusal on the last screen of
 * first-run setup, with no way past it until a "Skip for now" button was bolted
 * on to rescue them. Filtering removes the cause. It does not remove the need
 * for an escape — a server can still refuse at save time, a CLI can log out
 * between the probe and the click — so the footer still grows one after a
 * failure, and that is the only condition under which it appears.
 *
 * All three roles save in ONE write (`PUT /me/engines`), because the screen
 * asks all three questions at once: three sequential writes would leave a
 * half-answered record behind any failure between them. Every role is sent
 * EXPLICITLY on every save, including the fallback's `null`, because the swarm
 * merges — a role recorded as an omitted field silently keeps the answer the
 * user just changed. That is the same class as the voice-flip bug this
 * codebase has already fixed once.
 */
export function WizardRolesStep({ onDone, onSkip, onBack, saveState = "idle" }: WizardRolesStepProps) {
  const { data: tools = [] } = useCliTools();
  const { data: keys = [] } = useApiKeys();
  const { data: servers } = useLocalModels();
  const { data: machine } = useMachineFacts();
  const { data: stored } = useEngines();
  const saveEngines = useSaveEngines();

  const [choice, setChoice] = useState<Partial<Record<Role, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Sticky once set, and never cleared by a later attempt: a save that has
  // failed even once is proof this user can be stuck here, and the escape it
  // unlocks must not vanish the moment they try again.
  const [saveFailed, setSaveFailed] = useState(false);
  // Set the moment the step hands off and never cleared — a retry that hands
  // off a second time races exactly what the first one raced. What re-opens
  // the footer is the host's `saveState`, not un-setting this.
  const [handedOff, setHandedOff] = useState(false);

  const candidates = candidatesFrom(tools, keys, servers);

  /** A stored answer counts only if it is still on offer — a key removed since is simply not there. */
  const storedKey = (engine: BrainEngineRecord | null | undefined): string | undefined => {
    if (!engine) return undefined;
    const key = keyFor(engine);
    return candidates.some((c) => c.key === key) ? key : undefined;
  };

  // An in-session pick wins over a resumed answer, which wins over the
  // computed default. Read through `??` rather than seeded into state so the
  // defaults stay DEFAULTS: a probe that lands a beat later can refine what an
  // unanswered role shows, but can never overwrite an answer the user gave.
  // The trailing `?? NOTHING` on the first two is unreachable in practice:
  // it is only taken when the candidate list is empty, and an empty list
  // renders no dropdowns and returns early from `proceed`. It is there so
  // these are total rather than possibly-undefined, not as a real answer.
  const mainKey = choice.main ?? storedKey(stored?.main) ?? candidates[0]?.key ?? NOTHING;
  const selected: Record<Role, string> = {
    main: mainKey,
    // Quick follows the main brain until it is answered in its own right —
    // the only default that is true without size data to reason about — and
    // it is still SENT explicitly, so "follows" never becomes "omitted".
    quick: choice.quick ?? storedKey(stored?.quick) ?? mainKey,
    fallback: choice.fallback ?? storedKey(stored?.fallback) ?? NOTHING,
  };

  // Every role offers the same list, because the server applies the same
  // rules to all three (`buildEngineSetting`, swarm/src/server.ts). The
  // fallback's extra entry is a VALUE, not a fourth kind of source.
  const bodyFor = (key: string): BrainEngineRecord | null => candidates.find((c) => c.key === key)?.body ?? null;

  /**
   * No footer button acts while this step's own save is in flight, nor after
   * the handoff for as long as that handoff is still open.
   *
   * `handedOff` alone would be a dead end rather than a guard: it exists to
   * stop a second write racing the host's, and that race lasts exactly as long
   * as the write does. `saveState === "failed"` is the host saying the write
   * is over and did not land — nothing left to race, and a footer that stays
   * shut past that point strands the user with an error and no control. That
   * exact fix had to be made once already on the step this replaces.
   */
  const inert = busy || (handedOff && saveState !== "failed");

  const finish = () => {
    setHandedOff(true);
    // `setup: {}` is the whole patch — the host stamps `step` itself, and the
    // three answers live on the user record proper (via PUT /me/engines), not
    // in `setup`.
    onDone({ setup: {} });
  };

  /**
   * `finish`'s sibling for the two ways off this step that saved NOTHING.
   * Identical as far as this component is concerned — the host writes, nothing
   * swaps this step out on the last step, so it closes the same handoff window
   * `finish` does, for the same reason. What differs is only what gets
   * written, and that is the host's to say: see `onSkip`. A bare `{setup: {}}`
   * here would leave a user whose save the server refused indistinguishable on
   * the wire from one who deliberately picked three engines.
   */
  const skipOut = () => {
    setHandedOff(true);
    onSkip();
  };

  const proceed = async () => {
    if (candidates.length === 0) {
      // Nothing to pick and nothing was. `brainEngine` stays unset, which
      // resolveBrainFactory (broker/src/brain-engine.ts) already treats as a
      // working state — SMITH_BRAIN_PROVIDER, then the no-key default. Sending
      // three nulls instead would CLEAR whatever a previous run had stored.
      //
      // `skipOut`, not `finish`: that outcome is precisely what a skip states,
      // so it is recorded as one.
      skipOut();
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await classifySave(() =>
      saveEngines.mutateAsync({
        // Every role, every time — see this component's own doc comment.
        main: bodyFor(selected.main),
        quick: bodyFor(selected.quick),
        fallback: selected.fallback === NOTHING ? null : bodyFor(selected.fallback),
      }),
    );
    setBusy(false);
    if (outcome.kind !== "ok") {
      setError(outcome.message);
      setSaveFailed(true);
      return;
    }
    finish();
  };

  return (
    <div className="wizard-roles-step">
      {/* `<h2>`: the panel's `<h1>` is the host's greeting. */}
      <h2 className="wizard-roles-step__title">Which of these should I use, and for what?</h2>
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
        <div className="wizard-roles-step__roles">
          {ROLES.map((role) => (
            <div className="wizard-roles-step__role" key={role}>
              {/* Explicitly associated rather than wrapped: a `<label>` that
                  CONTAINS its control has its accessible name computed from the
                  label's text with the control's own value substituted in, so
                  the name would drift with the selection. */}
              <label htmlFor={`wizard-role-${role}`}>{ROLE_LABELS[role]}</label>
              <select
                id={`wizard-role-${role}`}
                value={selected[role]}
                disabled={inert}
                onChange={(e) => setChoice((c) => ({ ...c, [role]: e.target.value }))}
              >
                {/* A VALUE, not the absence of one, and only the fallback has
                    it: "nothing — I'll just tell you" is an answer the user
                    can give, and it persists as an explicit null. */}
                {role === "fallback" && <option value={NOTHING}>{NOTHING_LABEL}</option>}
                {candidates.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {/* Advice, never a gate — nothing here blocks a choice, and an
          unavailable probe omits the sentence rather than guessing a number.
          The second half of the spec's paragraph ("I'll say something if you
          pick one I'd struggle to hold") is deliberately not rendered: no
          model server on this machine reports a size, so that promise could
          never be kept and would be false on every install. */}
      {machine && (
        <p className="wizard-roles-step__ram">
          You've got {gigabytes(machine.totalMemBytes)}GB of RAM, so I've leaned toward models that'll feel quick.
        </p>
      )}

      <div className="wizard-gate__footer">
        {/* Back leads the footer, in DOM and so in tab order. Inert while
            EITHER write is in flight — this step's own, or the host's `PUT
            {step}` that put this screen here — and live again the moment the
            host reports one over and failed. */}
        {onBack && (
          // Quiet text, not a second pill — see WizardSourcesStep's own Back
          // for the finding and `.wizard-gate__quiet` for the mechanics. A
          // plain `<button>` also keeps the native `disabled` attribute this
          // guard depends on, which stops the pointer and the keyboard
          // together.
          <button
            type="button"
            className="wizard-gate__quiet"
            onClick={onBack}
            disabled={inert || saveState === "saving"}
          >
            Back
          </button>
        )}
        {saveFailed && (
          // Only after a save has actually failed, so this stays a
          // three-question screen for everyone else. Says what it does rather
          // than the bare word "skip": it leaves the three roles unset, which
          // resolveBrainFactory already treats as a working state.
          //
          // Quiet too, and for the same reason Back is: it declines the
          // question rather than answering it, so it must not read as heavy as
          // the primary it sits beside. Rendered AFTER Back so the two group
          // where they belong — the retreat at the far left of the row, this
          // one beside the action it is an alternative to.
          <button type="button" className="wizard-gate__quiet" onClick={skipOut} disabled={inert}>
            Continue without setting these
          </button>
        )}
        <Button variant="primary" onPress={() => void proceed()} isDisabled={inert}>
          Continue
        </Button>
      </div>
    </div>
  );
}
