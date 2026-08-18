import { Button } from "@heroui/react";
import { RadioButtonGroup } from "@heroui-pro/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ConnectorInstanceRecord, ConnectorVendorMeta, VoicePreviewResult } from "../api/types";
import { classifySave } from "../lib/saveOutcome";
import { type VoiceSlot, voiceConnectorOptions, voiceVendorsFor } from "../lib/voiceConnectors";
import type { Setup, WizardSaveState } from "../lib/wizardSteps";
import {
  useAddConnector,
  useConnectorVendors,
  useMyConnectors,
  usePreviewVoice,
  useSaveVoiceSettings,
  useVerifyConnector,
  useVoiceOptions,
  useVoiceSettings,
} from "../queries/http";
import { qk } from "../queries/keys";
import { ConnectorFormModal } from "./settings/ConnectorFormModal";

/**
 * The two slots, in the order the spec's own sentence reads them: *"I'll
 * listen with [ … ] and speak with [ … ]"*. The labels are the two halves of
 * that sentence rather than the capability names ("Speech-to-text") Settings
 * uses — Settings is a control panel, this is Anderson saying what he'll do.
 */
const SLOTS: { slot: VoiceSlot; label: string }[] = [
  { slot: "stt", label: "I'll listen with" },
  { slot: "tts", label: "and speak with" },
];

/** Prefix marking a chooser entry that OPENS the connect form rather than being an answer. */
const ADD = "add:";

/**
 * A rejected promise is a network failure, never a verdict — `brokerFetch`
 * resolves non-2xx responses, so nothing that reaches this sentence has told us
 * anything about the key. Said in a sentence rather than surfacing the thrown
 * `Error`, whose text is "Failed to fetch": the live walk already caught that
 * string reaching the screen once on the roles path.
 */
const CHECK_UNREACHABLE = "I couldn't reach that check — check your connection and try again.";
const SAVE_UNREACHABLE = "I couldn't tell whether that saved — check your connection and try again.";
const PREVIEW_UNREACHABLE = "I couldn't reach my voice just then — check your connection and try again.";
const AUDIO_BLOCKED = "I made the sound, but the browser wouldn't play it — click anywhere and try again.";

/**
 * "a Deepgram key" / "an ElevenLabs key".
 *
 * A vowel-initial vendor LABEL is the whole rule, which is wrong for the
 * "a university" class of word and right for every vendor label that exists or
 * plausibly will. The alternative is what Settings does — hardcode the article
 * per slot (`vendorHint: "an ElevenLabs"`, VoiceGroup.tsx) — which is exactly
 * correct today and silently wrong for the first vendor added after it.
 */
const article = (label: string) => (/^[aeiou]/i.test(label) ? "an" : "a");

/** What the vendor said about one saved instance, live. Absent = not asked yet. */
type Check = { state: "checking" } | { state: "ok" } | { state: "failed"; detail: string };

export interface WizardVoiceStepProps {
  /**
   * Seeds the Yes/No answer for a RESUMED record. Without this, a user who
   * said yes, left mid-wizard, and returned would find the radio reset to
   * "no" — and because Continue sends the answer EXPLICITLY (see onDone),
   * continuing would overwrite their recorded `voice: true` with false. The
   * third appearance of the answer-flip bug class on this feature; seeding
   * is the other half of the explicit-send guarantee, same as the gate's
   * `initialMode`.
   */
  initialVoice?: boolean;
  /**
   * Always sends `voice` EXPLICITLY, in both directions. The server merges
   * setup (`{...existing.setup, ...body.setup}`), so a declined answer that
   * merely omitted the field would leave a `voice: true` from an earlier run
   * standing — the same class as the voice-flip bug this codebase has already
   * fixed once, and the reason the roles step sends all three of its answers
   * on every save.
   */
  onDone: (patch: { setup: Setup }) => void;
  /** Absent when there is nothing behind this step — same contract as WizardRolesStep's. */
  onBack?: () => void;
  /** What became of the HOST's own `PUT /me` for the patch it last sent — see `WizardSaveState`. */
  saveState?: WizardSaveState;
}

/**
 * The wizard's voice step — *"Would you like to talk to me out loud?"*
 *
 * **"Not right now" is the answer it opens on, and it can never stop being
 * selectable.** Everything else here — two keys, two live checks, a gate on
 * both of them — is machinery a user might not get through, and a screen that
 * demands a working ElevenLabs key to leave is a dead end in the middle of
 * first-run setup. So the both-slots gate applies only while "yes" is the
 * answer, and answering No is always one click away from any state this step
 * can reach.
 *
 * **On-device is named, not offered.** The spec preselected it; the user ruled
 * otherwise once the ground was measured — no local STT exists anywhere in
 * this repo, and the local TTS shell needs a Piper binary that is neither
 * installed nor installable from here. Preselecting it would preselect a thing
 * that cannot work, so it renders disabled with the way forward named, exactly
 * the treatment Cloud gets at the gate. The download subsystem is its own
 * later plan, shared with Plan 5's embeddings.
 *
 * **Hosted is two per-slot CHOOSERS, not two key fields** (the user's
 * 2026-08-18 ruling). Each lists the connector instances whose VENDOR declares
 * the capability — `voiceConnectorOptions`, the same helper Settings → Voice
 * reads — so a future STT or TTS vendor appears here with no change to this
 * file. Today that resolves to Deepgram and ElevenLabs, which is why the
 * spec's mockup names them.
 *
 * **What VoiceGroup punts, this step must not.** Settings can say "Connect a
 * Deepgram key in Integrations first" because Integrations is one click away;
 * a first-run user has no Settings to go to yet. So each chooser also offers
 * "Add a … key", which opens the SAME `ConnectorFormModal` Integrations uses
 * and creates through the same `POST /me/connectors`. Key material never grows
 * a second path.
 *
 * **The gate reads a live check, never the record.** A `ConnectorInstance`
 * carries id, vendorId, label and fields — and no verified flag at all
 * (swarm/src/users.ts). So "there is a key here" is the only thing the record
 * can say, and the swarm's invariant (`enabled` may only be true while both
 * slots are assigned, and the slots are meant to WORK) is about something
 * else. This step therefore asks the vendor itself, per chosen instance, via
 * the connectors' own verify route, and Continue waits on that answer.
 */
export function WizardVoiceStep({ initialVoice = false, onDone, onBack, saveState = "idle" }: WizardVoiceStepProps) {
  const qc = useQueryClient();
  const { data: vendors = [] } = useConnectorVendors();
  const { data: connectors = [] } = useMyConnectors();
  const { data: stored } = useVoiceSettings();
  const { data: voices = [] } = useVoiceOptions();
  const saveVoice = useSaveVoiceSettings();
  const addConnector = useAddConnector();
  const verifyConnector = useVerifyConnector();
  const previewVoice = usePreviewVoice();

  const [answer, setAnswer] = useState<"yes" | "no">(initialVoice ? "yes" : "no");
  const [choice, setChoice] = useState<Partial<Record<VoiceSlot, string>>>({});
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<{ slot: VoiceSlot; vendor: ConnectorVendorMeta } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set the moment the step hands off and never cleared — see `inert`.
  const [handedOff, setHandedOff] = useState(false);

  const optionsFor = (slot: VoiceSlot) => voiceConnectorOptions(slot, vendors, connectors);

  /** A resumed assignment counts only if it is still on offer — a key deleted since is simply not there. */
  const storedSlot = (slot: VoiceSlot): string => {
    const id = stored?.[slot]?.instanceId;
    return id && optionsFor(slot).some((o) => o.id === id) ? id : "";
  };

  // An in-session pick wins over a resumed assignment. Read through `??`
  // rather than seeded into state, the same way the roles step reads its
  // stored answers: a `/me/voice` response that lands a beat late can fill an
  // untouched slot, but can never overwrite one the user just chose.
  const selected: Record<VoiceSlot, string> = {
    stt: choice.stt ?? storedSlot("stt"),
    tts: choice.tts ?? storedSlot("tts"),
  };

  const runCheck = async (id: string) => {
    setChecks((c) => ({ ...c, [id]: { state: "checking" } }));
    let r: { ok?: boolean; detail?: string; error?: string };
    try {
      r = await verifyConnector.mutateAsync({ id });
    } catch {
      setChecks((c) => ({ ...c, [id]: { state: "failed", detail: CHECK_UNREACHABLE } }));
      return;
    }
    setChecks((c) => ({
      ...c,
      // The vendor's own words on a refusal — it knows why (expired, wrong
      // scope, out of credit) and this step does not.
      [id]: r.ok ? { state: "ok" } : { state: "failed", detail: r.detail ?? r.error ?? CHECK_UNREACHABLE },
    }));
  };

  /**
   * Every instance this step ends up pointing at gets checked exactly once,
   * whichever way it got there — picked from the chooser, created inline, or
   * resumed from `/me/voice` on a reload. One effect rather than a call in
   * each of those three handlers, so there is one answer to "when does a key
   * get checked" instead of three that can disagree.
   *
   * Guarded by a ref, not by `checks`: the guard has to hold from the moment
   * the call STARTS, and state set inside an async function is not readable by
   * the render that scheduled it. Nothing fires while the answer is "not right
   * now" — a declining user's keys are not this step's business.
   */
  const started = useRef(new Set<string>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: runCheck is re-created every render; the two ids ARE the trigger, and the ref guard makes a re-run a no-op
  useEffect(() => {
    if (answer !== "yes") return;
    for (const id of [selected.stt, selected.tts]) {
      if (!id || started.current.has(id)) continue;
      started.current.add(id);
      void runCheck(id);
    }
  }, [answer, selected.stt, selected.tts]);

  /**
   * Both slots hold an instance the VENDOR confirmed — never merely one the
   * record contains. Gating on `Boolean(selected[slot])` would look identical
   * on every screen except the one that matters: a key that was typed and
   * saved but no longer works would send `enabled: true` and leave Anderson
   * mute on his first turn.
   */
  const verified = (slot: VoiceSlot) => {
    const id = selected[slot];
    return Boolean(id) && checks[id]?.state === "ok";
  };
  const bothVerified = verified("stt") && verified("tts");

  /**
   * No control that can start a write acts while this step's own save is in
   * flight, nor after the handoff for as long as that handoff is still open.
   * `saveState === "failed"` is the host saying the write is over and did not
   * land — nothing left to race, and a footer that stayed shut past that point
   * would strand the user. Same guard, same reasoning, as the roles step's.
   */
  const inert = busy || (handedOff && saveState !== "failed");

  const finish = (voice: boolean) => {
    setHandedOff(true);
    onDone({ setup: { voice } });
  };

  const proceed = async () => {
    if (answer === "no") {
      // Nothing to save: declining assigns no slots, and writing `enabled:
      // false` here would clear a voice a returning user had already set up
      // from Settings.
      finish(false);
      return;
    }
    setBusy(true);
    setError(null);
    // ONE write for both slots plus the switch. Two writes would leave a
    // half-assigned record behind any failure between them, and the swarm
    // coerces `enabled` off unless both slots arrive together anyway.
    const outcome = await classifySave(() =>
      saveVoice.mutateAsync({
        stt: { instanceId: selected.stt },
        tts: { instanceId: selected.tts },
        enabled: true,
      }),
    );
    setBusy(false);
    if (outcome.kind === "refused") {
      // The server's own sentence, written for a human.
      setError(outcome.message);
      return;
    }
    if (outcome.kind === "rejected") {
      setError(SAVE_UNREACHABLE);
      return;
    }
    finish(true);
  };

  const handleAddSave = async (body: { vendorId: string; label: string; fields: Record<string, string> }) => {
    const slot = addFor?.slot;
    let created: ConnectorInstanceRecord & { error?: string };
    try {
      created = await addConnector.mutateAsync(body);
    } catch {
      return { error: CHECK_UNREACHABLE };
    }
    // The swarm verifies a self-contained vendor's key BEFORE it saves
    // (`verifyBeforeSave`), so a refusal here is usually the key itself being
    // rejected — the modal renders this sentence in place and stays open.
    if (created.error) return { error: created.error };
    // The POST's response IS the new instance. Written straight into the list
    // cache so its `<option>` exists in the same commit the selection points
    // at it; `useAddConnector`'s own invalidation confirms it a beat later.
    qc.setQueryData<ConnectorInstanceRecord[]>(qk.myConnectors, (prev) =>
      prev?.some((c) => c.id === created.id) ? prev : [...(prev ?? []), created],
    );
    // The key someone just typed becomes the answer — being made to re-pick it
    // from a dropdown is the punt this whole affordance exists to remove.
    if (slot) setChoice((c) => ({ ...c, [slot]: created.id }));
    return {};
  };

  const onSlotChange = (slot: VoiceSlot, value: string) => {
    if (value.startsWith(ADD)) {
      const vendor = vendors.find((v) => v.id === value.slice(ADD.length));
      if (vendor) setAddFor({ slot, vendor });
      // Deliberately no `setChoice`: this entry is a door, not an answer, so
      // the controlled `<select>` snaps back to whatever was chosen before.
      return;
    }
    setChoice((c) => ({ ...c, [slot]: value }));
  };

  const chosenVoice = voiceId ?? voices[0]?.id ?? "";

  const sayIt = async () => {
    setPreviewing(true);
    setPreviewNote(null);
    let result: VoicePreviewResult;
    try {
      result = await previewVoice.mutateAsync({ voiceId: chosenVoice });
    } catch {
      setPreviewing(false);
      setPreviewNote(PREVIEW_UNREACHABLE);
      return;
    }
    setPreviewing(false);
    // The route always answers 200: "I have no text-to-speech key" is a
    // RESOLVED sentence, so the result has to be read rather than the promise
    // merely awaited. It is shown as a hint, not an error, and gates nothing —
    // the preview is a nicety, and a user whose two keys check out must not be
    // held on this screen because a third thing could not speak.
    if ("error" in result) {
      setPreviewNote(result.error);
      return;
    }
    // No `text`: the broker holds Anderson's own preview line, and a copy here
    // would be a second place his words are written. jsdom has neither audio
    // nor a promise from `play()`, hence the `?.` — the sound itself is the
    // live walk's to confirm.
    void new Audio(`data:${result.mime};base64,${result.dataB64}`).play()?.catch(() => {
      setPreviewNote(AUDIO_BLOCKED);
    });
  };

  return (
    <div className="wizard-voice-step">
      {/* `<h2>`: setup steps carry no `<h1>` at all — the gate's greeting is
          the panel's only one. */}
      <h2 className="wizard-voice-step__title" id="wizard-voice-step-answer">
        Would you like to talk to me out loud?
      </h2>
      {error && <p className="wizard__error">{error}</p>}

      {/* Never disabled, in any state this step can reach — including while a
          save is in flight and after one has been refused. It is the retreat,
          and a retreat that can be closed is not one. */}
      <RadioButtonGroup
        aria-labelledby="wizard-voice-step-answer"
        value={answer}
        onChange={(value) => {
          if (value === "yes" || value === "no") setAnswer(value);
        }}
        orientation="vertical"
      >
        <RadioButtonGroup.Item value="yes">
          <RadioButtonGroup.Indicator />
          <RadioButtonGroup.ItemContent>
            <span className="wizard-fork-step__label">Yes, let's talk</span>
          </RadioButtonGroup.ItemContent>
        </RadioButtonGroup.Item>
        <RadioButtonGroup.Item value="no">
          <RadioButtonGroup.Indicator />
          <RadioButtonGroup.ItemContent>
            <span className="wizard-fork-step__label">Not right now</span>
          </RadioButtonGroup.ItemContent>
        </RadioButtonGroup.Item>
      </RadioButtonGroup>

      {answer === "yes" && (
        <>
          <h2 className="wizard-voice-step__title" id="wizard-voice-step-backend">
            How should I listen and speak?
          </h2>
          <RadioButtonGroup
            aria-labelledby="wizard-voice-step-backend"
            value="hosted"
            // Hosted is the only selectable option, so this can only ever be
            // called with "hosted" — narrowed rather than left off, because a
            // group with no onChange is uncontrolled in react-aria's reading
            // and would drift from `value` the moment a second option lands.
            onChange={() => {}}
            orientation="vertical"
          >
            {/*
             * "Right here" is hand-authored markup, not a `RadioButtonGroup.Item`
             * — this is the pattern (and the reasoning) moved from
             * WizardGateStep's Cloud option, which needs a disabled radio for
             * exactly the same reason. HeroUI's Radio ultimately calls
             * react-aria's `useRadio()`, whose `inputProps` come from
             * `filterDOMProps(props, {labelable: true})`; that allowlist lets
             * `aria-label`/`labelledby`/`describedby`/`details` through and
             * `aria-disabled` through none of its buckets, so it is silently
             * dropped wherever in the compound API it is passed. `isDisabled`
             * only ever reaches the native `disabled` attribute. Since this
             * stylesheet's dimming and `pointer-events: none` are both keyed off
             * `aria-disabled`, no prop combination on the real component
             * produces this row.
             *
             * It carries BOTH `disabled` and `aria-disabled`, and that is not
             * redundant. `aria-disabled` alone is advisory: react-aria's own
             * arrow-key navigation (`useRadioGroup`'s `getNextElement`) walks the
             * DOM for ANY `<input type="radio">` in the group and accepts it if
             * `isFocusable()` says so — and that check's selector is literally
             * `input:not([disabled])`, which `aria-disabled` never enters.
             * Without native `disabled`, an arrow key would land here and
             * react-aria would read the focused input's `.value` to select it; an
             * input with no `value` attribute defaults to `"on"`. `disabled`
             * closes that; `aria-disabled` is kept for the CSS hook and for AT
             * that renders the two differently.
             *
             * What differs from the gate is only the reason it is shut. Cloud is
             * a product that does not exist yet, and links out to be notified.
             * This one is a download that has no downloader: no local STT exists
             * anywhere in the repo, and the local TTS shell needs a Piper binary
             * that is neither installed nor installable from here. So it names
             * the way forward in place, and there is nothing to sign up for.
             */}
            <label className="wizard-voice-step__ondevice" aria-disabled="true">
              <input
                type="radio"
                disabled
                aria-disabled="true"
                tabIndex={-1}
                className="wizard-voice-step__ondevice-input"
              />
              <span className="wizard-fork-step__label">Right here</span>
              <span className="wizard-fork-step__hint">
                a small listening model and a voice, nothing leaves your computer
              </span>
              <span className="wizard-fork-step__hint">needs a small download — coming soon</span>
            </label>

            <RadioButtonGroup.Item value="hosted">
              <RadioButtonGroup.Indicator />
              <RadioButtonGroup.ItemContent>
                <span className="wizard-fork-step__label">Hosted</span>
                <span className="wizard-fork-step__hint">I'll listen and speak with keys you hold.</span>
              </RadioButtonGroup.ItemContent>
            </RadioButtonGroup.Item>
          </RadioButtonGroup>

          <div className="wizard-voice-step__slots">
            {SLOTS.map(({ slot, label }) => {
              const options = optionsFor(slot);
              const id = selected[slot];
              const check = id ? checks[id] : undefined;
              return (
                <div className="wizard-voice-step__slot" key={slot}>
                  {/* Explicitly associated rather than wrapped: a `<label>`
                      that CONTAINS its control computes its accessible name
                      with the control's own value substituted in, so the name
                      would drift with the selection. */}
                  <label htmlFor={`wizard-voice-${slot}`}>{label}</label>
                  <select
                    id={`wizard-voice-${slot}`}
                    value={id}
                    disabled={inert}
                    onChange={(e) => onSlotChange(slot, e.target.value)}
                  >
                    <option value="">Choose one…</option>
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                    {/* One per capability-matching vendor, whether or not that
                        vendor already has a key — the user who most needs this
                        is the one whose list is empty. */}
                    {voiceVendorsFor(slot, vendors).map((v) => (
                      <option key={v.id} value={`${ADD}${v.id}`}>
                        {`Add ${article(v.label)} ${v.label} key…`}
                      </option>
                    ))}
                  </select>
                  {check && (
                    <p className={check.state === "failed" ? "wizard__error" : "wizard__hint"}>
                      {check.state === "checking"
                        ? "Checking that key…"
                        : check.state === "ok"
                          ? "That one works."
                          : check.detail}
                      {check.state === "failed" && (
                        // The way back from a network blip. Re-choosing the
                        // same option fires no change event, so without this
                        // the only route out of a transient failure would be
                        // adding a second key for a vendor whose key is fine.
                        // Quiet text, like every other control here that
                        // declines rather than answers.
                        <button
                          type="button"
                          className="wizard-gate__quiet"
                          onClick={() => void runCheck(id)}
                          disabled={inert}
                        >
                          Check it again
                        </button>
                      )}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <h2 className="wizard-voice-step__title" id="wizard-voice-step-sound">
            How should I sound?
          </h2>
          {/* The list is derived from a constant cast on the broker, so an
              EMPTY one never means "no voices exist" — it means the broker did
              not answer. A picker with nothing in it beside a ▶ that cannot
              fire reads as broken software rather than as a service that is
              down, so the pair is withheld and the reason said instead. It
              gates nothing either way: the voice is a preference, and Settings
              → Voice asks the same question later. */}
          {voices.length === 0 ? (
            <p className="wizard__hint">
              I couldn't reach my voices just now — you can carry on, and pick how I sound later in Settings → Voice.
            </p>
          ) : (
            <div className="wizard-voice-step__preview">
              {/* Labelled by the question itself — the heading IS this
                  control's label, and a second visible one would say it
                  twice. */}
              <select
                aria-labelledby="wizard-voice-step-sound"
                value={chosenVoice}
                disabled={inert}
                onChange={(e) => setVoiceId(e.target.value)}
              >
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              {/* The label never changes while a preview is in flight: the
                  button is identified by its words, and swapping them for a
                  spinner renames the control mid-press for anyone listening to
                  it. Inertness is the `disabled` attribute's job. */}
              <button
                type="button"
                className="settings-btn"
                onClick={() => void sayIt()}
                disabled={inert || previewing}
              >
                ▶ Say something
              </button>
            </div>
          )}
          {/* A hint, never an error: this is the sentence a machine with no
              ElevenLabs key gets, and it is a statement of fact rather than a
              failure of the user's. */}
          {previewNote && <p className="wizard__hint">{previewNote}</p>}
        </>
      )}

      <div className="wizard-gate__footer">
        {onBack && (
          <button
            type="button"
            className="wizard-gate__quiet"
            onClick={onBack}
            disabled={inert || saveState === "saving"}
          >
            Back
          </button>
        )}
        <Button
          variant="primary"
          onPress={() => void proceed()}
          // The gate applies only while "yes" is the answer — see this
          // component's own doc comment.
          isDisabled={inert || (answer === "yes" && !bothVerified)}
        >
          Continue
        </Button>
      </div>

      {/* The SAME modal Integrations opens, wired to the SAME create route.
          A second key-entry form here would be a second path key material can
          take, which is the one thing this step is not allowed to add. */}
      <ConnectorFormModal
        open={addFor !== null}
        vendor={addFor?.vendor ?? null}
        onClose={() => setAddFor(null)}
        onSave={handleAddSave}
      />
    </div>
  );
}
