import { useState } from "react";
import type { VoiceSettingsRecord } from "../../api/types";
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

  // The mutation's own onSuccess only writes `qk.voiceSettings` when the response carries no
  // `error` — same "commit only once the save actually succeeds" contract the old local
  // `setVoice(next)` call hand-rolled. A failed save, whether an `{ error }` response or a
  // rejected promise from the underlying fetch, leaves the cache (and every control reading
  // it) exactly as it was, with the failure surfaced via `error` instead.
  const save = async (next: VoiceSettingsRecord) => {
    let res: VoiceSettingsRecord & { error?: string };
    try {
      res = await saveVoice.mutateAsync({ stt: next.stt, tts: next.tts, hideInactive: next.hideInactive });
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

  const optionsFor = (slot: "stt" | "tts") => {
    const vendorIds = new Set(vendors.filter((v) => v.capabilities?.includes(slot)).map((v) => v.id));
    return connectors
      .filter((c) => vendorIds.has(c.vendorId))
      .map((c) => ({
        id: c.id,
        label: `${vendors.find((v) => v.id === c.vendorId)?.label ?? c.vendorId} — ${c.label}`,
      }));
  };

  if (!voice) {
    return (
      <>
        <h1>voice</h1>
        <p className="wizard__hint">Loading…</p>
      </>
    );
  }

  return (
    <>
      <h1>voice</h1>
      <p className="wizard__hint">Pick which connected key powers each capability. Keys live in Integrations.</p>
      {error && <p className="wizard__error">{error}</p>}
      <div className="account-panel__form">
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
                onChange={(e) =>
                  void save({ ...voice, [slot]: e.target.value ? { instanceId: e.target.value } : null })
                }
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
      </div>
      {/* Deliberately outside .account-panel__form: that wrapper's `label` rule (display:flex;
          flex-direction:column) outranks .settings-option's own row layout by specificity
          (0,1,1 vs 0,1,0), stacking the checkbox above its text instead of beside it. Mirrors
          GeneralGroup's own .settings-panel__options wrapper, which has no such competing rule. */}
      <div className="settings-panel__options">
        <label className="settings-option">
          <input
            type="checkbox"
            checked={voice.hideInactive}
            onChange={(e) => void save({ ...voice, hideInactive: e.target.checked })}
          />
          Hide inactive voice features
        </label>
      </div>
    </>
  );
}
