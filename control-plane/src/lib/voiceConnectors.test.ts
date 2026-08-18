import { describe, expect, it } from "vitest";
import type { ConnectorInstanceRecord, ConnectorVendorMeta } from "../api/types";
import { voiceConnectorOptions, voiceVendorsFor } from "./voiceConnectors";

function vendor(id: string, label: string, capabilities?: string[]): ConnectorVendorMeta {
  return { id, label, description: "", fields: [], verifyExtraFields: [], capabilities };
}

function instance(id: string, vendorId: string, label: string): ConnectorInstanceRecord {
  return { id, vendorId, label, fields: {} };
}

const VENDORS = [
  vendor("deepgram", "Deepgram", ["stt"]),
  vendor("elevenlabs", "ElevenLabs", ["tts"]),
  vendor("github", "GitHub"),
];

describe("voiceVendorsFor", () => {
  it("keeps only the vendors that declare the slot", () => {
    // Wrong impls this catches: filtering on vendor id rather than the
    // declared capability (which is what makes a future STT vendor appear
    // with no code change), and returning every vendor for every slot.
    expect(voiceVendorsFor("stt", VENDORS).map((v) => v.id)).toEqual(["deepgram"]);
    expect(voiceVendorsFor("tts", VENDORS).map((v) => v.id)).toEqual(["elevenlabs"]);
  });

  it("reads an absent capabilities list as 'not a voice vendor', never as 'any slot'", () => {
    // `capabilities` is optional on the wire. Wrong impl: `v.capabilities ?
    // v.capabilities.includes(slot) : true`, which would offer a GitHub token
    // as a microphone.
    expect(voiceVendorsFor("stt", [vendor("github", "GitHub")])).toEqual([]);
    expect(voiceVendorsFor("tts", [vendor("github", "GitHub")])).toEqual([]);
  });
});

describe("voiceConnectorOptions", () => {
  it("crosses the capability-matching vendors with the saved instances, labelled 'Vendor — instance'", () => {
    // Wrong impls this catches: returning every instance regardless of vendor
    // (the elevenlabs one would appear under `stt`), or labelling by vendor id
    // instead of the vendor's display label.
    const connectors = [
      instance("dg-1", "deepgram", "personal"),
      instance("el-1", "elevenlabs", "personal"),
      instance("gh-1", "github", "work"),
    ];
    expect(voiceConnectorOptions("stt", VENDORS, connectors)).toEqual([{ id: "dg-1", label: "Deepgram — personal" }]);
    expect(voiceConnectorOptions("tts", VENDORS, connectors)).toEqual([{ id: "el-1", label: "ElevenLabs — personal" }]);
  });

  it("offers every instance of a matching vendor, not just the first", () => {
    // Wrong impl: a `find` where a `filter` belongs — invisible while each
    // vendor has exactly one key, which is the common case.
    const connectors = [instance("dg-1", "deepgram", "personal"), instance("dg-2", "deepgram", "acme")];
    expect(voiceConnectorOptions("stt", VENDORS, connectors).map((o) => o.id)).toEqual(["dg-1", "dg-2"]);
  });

  it("is empty when nothing is saved, and empty when nothing saved matches", () => {
    // The wizard's inline-add path and Settings' "connect a key first" hint
    // both hang off this being an honest empty rather than a throw.
    expect(voiceConnectorOptions("stt", VENDORS, [])).toEqual([]);
    expect(voiceConnectorOptions("stt", VENDORS, [instance("el-1", "elevenlabs", "personal")])).toEqual([]);
  });
});
