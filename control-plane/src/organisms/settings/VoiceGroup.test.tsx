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

function seedBase(client: QueryClient, connectors = CONNECTORS) {
  client.setQueryData(qk.voiceSettings, { stt: null, tts: null, hideInactive: false });
  client.setQueryData(qk.connectorVendors, VENDORS);
  client.setQueryData(qk.myConnectors, connectors);
}

describe("VoiceGroup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pickers list only capability-matching instances plus Off", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    const stt = (await screen.findByLabelText("Speech-to-text")) as HTMLSelectElement;
    const labels = Array.from(stt.options).map((o) => o.textContent);
    expect(labels).toContain("Off");
    expect(labels).toContain("Deepgram — personal");
    expect(labels).not.toContain("GitHub — personal");
    expect(labels).not.toContain("ElevenLabs — personal");
  });

  it("selecting an instance saves the full record", async () => {
    const fn = stubSave({ stt: { instanceId: "dg1" }, tts: null, hideInactive: false });
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    await screen.findByLabelText("Speech-to-text");
    fireEvent.change(screen.getByLabelText("Speech-to-text"), { target: { value: "dg1" } });
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/me/voice"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ stt: { instanceId: "dg1" }, tts: null, hideInactive: false }),
        }),
      ),
    );
  });

  it("empty capability list shows vendor-naming guidance", async () => {
    stubNoNetwork();
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client, [CONNECTORS[2]!]); // only github connected
    await screen.findByText(/Connect a Deepgram key in Integrations first/);
    expect(screen.getByText(/Connect an ElevenLabs key in Integrations first/)).toBeDefined();
  });

  it("hide-inactive toggle persists", async () => {
    const fn = stubSave({ stt: null, tts: null, hideInactive: true });
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    await screen.findByLabelText("Hide inactive voice features");
    fireEvent.click(screen.getByLabelText("Hide inactive voice features"));
    await waitFor(() =>
      expect(fn).toHaveBeenCalledWith(
        expect.stringContaining("/me/voice"),
        expect.objectContaining({ body: JSON.stringify({ stt: null, tts: null, hideInactive: true }) }),
      ),
    );
  });

  it("keeps the prior selection and surfaces the error when save resolves with { error }", async () => {
    stubSave({ stt: null, tts: null, hideInactive: false, error: "save rejected by server" });
    const { client } = renderWithProviders(<VoiceGroup />);
    seedBase(client);
    await screen.findByLabelText("Speech-to-text");
    fireEvent.change(screen.getByLabelText("Speech-to-text"), { target: { value: "dg1" } });
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
    await screen.findByLabelText("Speech-to-text");
    fireEvent.change(screen.getByLabelText("Speech-to-text"), { target: { value: "dg1" } });
    await screen.findByText(/network down/);
    expect((screen.getByLabelText("Speech-to-text") as HTMLSelectElement).value).toBe("");
  });
});
