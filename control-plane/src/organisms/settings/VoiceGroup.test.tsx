import type { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "../../queries/keys";
import { renderWithProviders } from "../../test/renderWithProviders";
import { VoiceGroup } from "./VoiceGroup";

const VENDORS = [
  { id: "deepgram", label: "Deepgram", description: "", fields: [], verifyExtraFields: [], capabilities: ["stt"] },
  { id: "elevenlabs", label: "ElevenLabs", description: "", fields: [], verifyExtraFields: [], capabilities: ["tts"] },
  { id: "github", label: "GitHub", description: "", fields: [], verifyExtraFields: [], capabilities: [] },
];
const CONNECTORS = [
  { id: "dg1", vendorId: "deepgram", label: "personal", fields: {} },
  { id: "el1", vendorId: "elevenlabs", label: "personal", fields: {} },
  { id: "gh1", vendorId: "github", label: "personal", fields: {} },
];

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

function stubNoNetwork() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("no network in this test");
    }),
  );
}

/** Stubs the one PUT /me/voice route this component's saves ever hit. */
function stubSave(respond: unknown) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/me/voice") && init?.method === "PUT") return jsonResponse(respond);
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function seedBase(
  client: QueryClient,
  connectors = CONNECTORS,
  voice: unknown = { stt: null, tts: null, enabled: false },
) {
  client.setQueryData(qk.voiceSettings, voice);
  client.setQueryData(qk.connectorVendors, VENDORS);
  client.setQueryData(qk.myConnectors, connectors);
}

const voiceModeSwitch = async () => (await screen.findByRole("switch", { name: "Voice Mode" })) as HTMLInputElement;

describe("VoiceGroup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides the slot pickers while Voice Mode is off — only the switch shows", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    const mode = await voiceModeSwitch();
    expect(mode.checked).toBe(false);
    expect(screen.queryByLabelText("Speech-to-text")).toBeNull();
    expect(screen.queryByLabelText("Text-to-speech")).toBeNull();
  });

  it("a persisted-on record reads 'enabled' on the pill", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client, CONNECTORS, { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: true });
    expect(await screen.findByText("enabled")).toBeDefined();
    expect(screen.queryByText("disabled")).toBeNull();
  });

  // The pill tracks the PERSISTED flag while the switch tracks local disclosure, so the two
  // legitimately disagree here. Pinning both halves is what catches a record whose `enabled`
  // never made it back from the server — the switch alone looks fine in that case.
  it("keeps the pill honest at 'disabled' while the switch is flipped on without keys", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    fireEvent.click(await voiceModeSwitch());
    await screen.findByLabelText("Speech-to-text");
    expect(screen.getByText("disabled")).toBeDefined();
    expect(screen.queryByText("enabled")).toBeNull();
  });

  it("flipping on with no keys reveals the sub-options and hint without persisting anything", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    fireEvent.click(await voiceModeSwitch());
    await screen.findByLabelText("Speech-to-text");
    expect(screen.getByLabelText("Text-to-speech")).toBeDefined();
    expect(screen.getByText(/Assign both keys to enable Voice Mode/)).toBeDefined();
    // A save against the no-network stub would have surfaced its error.
    expect(screen.queryByText(/no network in this test/)).toBeNull();
  });

  it("pickers list only capability-matching instances plus Off", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    fireEvent.click(await voiceModeSwitch());
    const stt = (await screen.findByLabelText("Speech-to-text")) as HTMLSelectElement;
    const labels = Array.from(stt.options).map((o) => o.textContent);
    expect(labels).toContain("Off");
    expect(labels).toContain("Deepgram — personal");
    expect(labels).not.toContain("GitHub — personal");
    expect(labels).not.toContain("ElevenLabs — personal");
  });

  it("selecting the first instance saves the full record, still disabled", async () => {
    const fn = stubSave({ stt: { instanceId: "dg1" }, tts: null, enabled: false });
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    fireEvent.click(await voiceModeSwitch());
    fireEvent.change(await screen.findByLabelText("Speech-to-text"), { target: { value: "dg1" } });
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/me/voice"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ stt: { instanceId: "dg1" }, tts: null, enabled: false }),
        }),
      ),
    );
  });

  it("assigning the second key while the switch is on activates Voice Mode in the same save", async () => {
    const fn = stubSave({ stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: true });
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client, CONNECTORS, { stt: { instanceId: "dg1" }, tts: null, enabled: false });
    fireEvent.click(await voiceModeSwitch());
    fireEvent.change(await screen.findByLabelText("Text-to-speech"), { target: { value: "el1" } });
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/me/voice"),
        expect.objectContaining({
          body: JSON.stringify({ stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: true }),
        }),
      ),
    );
  });

  it("an enabled record opens with pickers showing; flipping off persists and collapses them", async () => {
    const fn = stubSave({ stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: false });
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client, CONNECTORS, { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: true });
    const mode = await voiceModeSwitch();
    expect(mode.checked).toBe(true);
    expect(await screen.findByLabelText("Speech-to-text")).toBeDefined();
    fireEvent.click(mode);
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/me/voice"),
        expect.objectContaining({
          body: JSON.stringify({ stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: false }),
        }),
      ),
    );
    expect(screen.queryByLabelText("Speech-to-text")).toBeNull();
  });

  it("clearing a slot while enabled turns Voice Mode off in the same save", async () => {
    const fn = stubSave({ stt: null, tts: { instanceId: "el1" }, enabled: false });
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client, CONNECTORS, { stt: { instanceId: "dg1" }, tts: { instanceId: "el1" }, enabled: true });
    fireEvent.change(await screen.findByLabelText("Speech-to-text"), { target: { value: "" } });
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/me/voice"),
        expect.objectContaining({
          body: JSON.stringify({ stt: null, tts: { instanceId: "el1" }, enabled: false }),
        }),
      ),
    );
  });

  it("empty capability list shows vendor-naming guidance", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client, [CONNECTORS[2]!]); // only github connected
    fireEvent.click(await voiceModeSwitch());
    await screen.findByText(/Connect a Deepgram key in Integrations first/);
    expect(screen.getByText(/Connect an ElevenLabs key in Integrations first/)).toBeDefined();
  });

  it("keeps the prior selection and surfaces the error when save resolves with { error }", async () => {
    stubSave({ stt: null, tts: null, enabled: false, error: "save rejected by server" });
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    fireEvent.click(await voiceModeSwitch());
    fireEvent.change(await screen.findByLabelText("Speech-to-text"), { target: { value: "dg1" } });
    await screen.findByText("save rejected by server");
    expect((screen.getByLabelText("Speech-to-text") as HTMLSelectElement).value).toBe("");
  });

  it("keeps the prior selection and surfaces the error when save rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/me/voice") && init?.method === "PUT") throw new Error("network down");
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    fireEvent.click(await voiceModeSwitch());
    fireEvent.change(await screen.findByLabelText("Speech-to-text"), { target: { value: "dg1" } });
    await screen.findByText(/network down/);
    expect((screen.getByLabelText("Speech-to-text") as HTMLSelectElement).value).toBe("");
  });
});
