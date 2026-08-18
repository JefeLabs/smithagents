import { Switch } from "@heroui/react";
import { useState } from "react";
import type { VoiceSettingsRecord } from "../../api/types";
import { voiceConnectorOptions } from "../../lib/voiceConnectors";
import { useConnectorVendors, useMyConnectors, useSaveVoiceSettings, useVoiceSettings } from "../../queries/http";

const SLOTS = [
  { slot: "stt" as const, label: "Speech-to-text", vendorHint: "a Deepgram" },
  { slot: "tts" as const, label: "Text-to-speech", vendorHint: "an ElevenLabs" },
];

/** Settings → Voice (spec §2): maps each voice capability to a connected connector
 * instance. Key entry/verify lives in Integrations — this group deals strictly in
 * instance ids and labels, never key material. */
export function VoiceGroup() {
  const { data: voice } = useVoiceSettings();
  const { data: vendors = [] } = useConnectorVendors();
  const { data: connectors = [] } = useMyConnectors();
  const saveVoice = useSaveVoiceSettings();
  const [error, setError] = useState<string | null>(null);
  // The switch is a DISCLOSURE, tracked locally: flipping it on with no keys
  // assigned must reveal the pickers without persisting anything (the server
  // coerces `enabled` off unless both slots are set, so a premature save would
  // just snap the switch back). Until first touched (null) it follows the record.
  const [expanded, setExpanded] = useState<boolean | null>(null);

  // The mutation's own onSuccess only writes `qk.voiceSettings` when the response carries no
  // `error` — same "commit only once the save actually succeeds" contract the old local
  // `setVoice(next)` call hand-rolled. A failed save, whether an `{ error }` response or a
  // rejected promise from the underlying fetch, leaves the cache (and every control reading
  // it) exactly as it was, with the failure surfaced via `error` instead.
  const save = async (next: VoiceSettingsRecord) => {
    let res: VoiceSettingsRecord & { error?: string };
    try {
      res = await saveVoice.mutateAsync({ stt: next.stt, tts: next.tts, enabled: next.enabled });
    } catch (err) {
      setError(String(err));
      return;
    }
    if (res.error) {
      setError(res.error);
      return;
    }
    setError(null);
  };

  // The filter itself now lives in `lib/voiceConnectors` — the wizard's voice
  // step offers the same per-slot list, and two copies would let a vendor show
  // up in one screen and not the other. What stays here is what this screen
  // does differently with an EMPTY list (point at Integrations, below); the
  // wizard adds the key inline instead.
  const optionsFor = (slot: "stt" | "tts") => voiceConnectorOptions(slot, vendors, connectors);

  if (!voice) {
    return (
      <>
        <h1>voice</h1>
        <p className="wizard__hint">Loading…</p>
      </>
    );
  }

  const bothSlotsSet = Boolean(voice.stt && voice.tts);
  const open = expanded ?? voice.enabled;

  const toggleMode = (on: boolean) => {
    setExpanded(on);
    // Flipping on with keys already assigned activates immediately; flipping on
    // without them is pure disclosure — nothing to persist until keys exist.
    if (on && bothSlotsSet && !voice.enabled) void save({ ...voice, enabled: true });
    else if (!on && voice.enabled) void save({ ...voice, enabled: false });
  };

  return (
    <>
      <h1>voice</h1>
      <p className="wizard__hint">Pick which connected key powers each capability. Keys live in Integrations.</p>
      {error && <p className="wizard__error">{error}</p>}
      <div className="connector-grid">
        <div className="connector-card">
          <div className="connector-card__head connector-card__head--row">
            <b>Voice Mode</b>
            {/* Label-less on purpose — the card title names it; aria-label keeps
                the accessible name (and the tests' switch query) intact. */}
            <Switch aria-label="Voice Mode" isSelected={open} onChange={toggleMode}>
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
          </div>
          <div className="connector-instance">
            {/* The pill reads the PERSISTED flag, not the disclosure: a flipped-on
                switch with keys still missing honestly shows "disabled". */}
            <span
              className={`connector-status ${voice.enabled ? "connector-status--connected" : "connector-status--unconnected"}`}
            >
              {voice.enabled ? "enabled" : "disabled"}
            </span>
            <span>speech-to-text &amp; text-to-speech</span>
          </div>
          {open && (
            <div className="account-panel__form settings-panel__suboptions">
              {SLOTS.map(({ slot, label, vendorHint }) => {
                const options = optionsFor(slot);
                return options.length === 0 ? (
                  <p key={slot} className="wizard__hint">
                    Connect {vendorHint} key in Integrations first.
                  </p>
                ) : (
                  <label key={slot}>
                    {label}
                    <select
                      value={voice[slot]?.instanceId ?? ""}
                      onChange={(e) => {
                        const next = { ...voice, [slot]: e.target.value ? { instanceId: e.target.value } : null };
                        // The switch is on while these pickers are visible, so the
                        // second key landing activates Voice Mode in the same save —
                        // and a cleared slot settles it off (mirrored server-side).
                        next.enabled = Boolean(next.stt && next.tts);
                        void save(next);
                      }}
                    >
                      <option value="">Off</option>
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
              {!bothSlotsSet && <p className="wizard__hint">Assign both keys to enable Voice Mode.</p>}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
