import type { ConnectorInstanceRecord, ConnectorVendorMeta } from "../api/types";

/** The two voice capabilities a connector vendor can declare — mirrors `ConnectorVendorDef["capabilities"]` (swarm/src/connectors.ts). */
export type VoiceSlot = "stt" | "tts";

/**
 * Which vendors can power this slot, by their OWN declaration.
 *
 * `capabilities` is optional on the wire (absent = not a voice vendor at all),
 * so this is the one place the absent case is read as "no", and every caller
 * gets the same answer. Today it resolves to Deepgram for `stt` and ElevenLabs
 * for `tts`; a future vendor that declares the capability appears in both the
 * wizard and Settings with no change to either.
 */
export function voiceVendorsFor(slot: VoiceSlot, vendors: ConnectorVendorMeta[]): ConnectorVendorMeta[] {
  return vendors.filter((v) => v.capabilities?.includes(slot));
}

/**
 * Every saved connector instance that could power this slot, labelled
 * "Vendor — instance".
 *
 * Lifted out of `VoiceGroup.optionsFor` unchanged so the wizard's per-slot
 * choosers and the Settings → Voice pickers offer the SAME set: the wizard
 * exists to set up what Settings later edits, and two copies of this filter
 * would let a vendor appear in one screen and not the other. What the two
 * screens do differently is what happens when the list is empty — Settings
 * points at Integrations, the wizard adds the key inline — and that difference
 * stays at the call sites, where it belongs.
 *
 * The label falls back to the raw `vendorId` when the vendor list has not
 * arrived (or no longer carries that vendor): an instance whose vendor cannot
 * be named is still a real, selectable instance, and dropping it would hide a
 * working key.
 */
export function voiceConnectorOptions(
  slot: VoiceSlot,
  vendors: ConnectorVendorMeta[],
  connectors: ConnectorInstanceRecord[],
): { id: string; label: string }[] {
  const vendorIds = new Set(voiceVendorsFor(slot, vendors).map((v) => v.id));
  return connectors
    .filter((c) => vendorIds.has(c.vendorId))
    .map((c) => ({
      id: c.id,
      label: `${vendors.find((v) => v.id === c.vendorId)?.label ?? c.vendorId} — ${c.label}`,
    }));
}
