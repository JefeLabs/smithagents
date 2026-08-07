import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceGroup } from "./VoiceGroup";

const vendors = [
  { id: "deepgram", label: "Deepgram", description: "", fields: [], verifyExtraFields: [], capabilities: ["stt"] },
  { id: "elevenlabs", label: "ElevenLabs", description: "", fields: [], verifyExtraFields: [], capabilities: ["tts"] },
  { id: "github", label: "GitHub", description: "", fields: [], verifyExtraFields: [], capabilities: [] },
];
const connectors = [
  { id: "dg1", vendorId: "deepgram", label: "personal", fields: {} },
  { id: "el1", vendorId: "elevenlabs", label: "personal", fields: {} },
  { id: "gh1", vendorId: "github", label: "personal", fields: {} },
];

function make(overrides: Partial<Parameters<typeof VoiceGroup>[0]> = {}) {
  return {
    getVoice: vi.fn(async () => ({ stt: null, tts: null, hideInactive: false })),
    saveVoice: vi.fn(async (b: unknown) => ({ ...(b as object), error: undefined }) as never),
    listVendors: vi.fn(async () => vendors),
    listConnectors: vi.fn(async () => connectors),
    ...overrides,
  };
}

describe("VoiceGroup", () => {
  afterEach(() => {
    cleanup();
  });

  it("pickers list only capability-matching instances plus Off", async () => {
    render(<VoiceGroup {...make()} />);
    const stt = (await screen.findByLabelText("Speech-to-text")) as HTMLSelectElement;
    const labels = Array.from(stt.options).map((o) => o.textContent);
    expect(labels).toContain("Off");
    expect(labels).toContain("Deepgram — personal");
    expect(labels).not.toContain("GitHub — personal");
    expect(labels).not.toContain("ElevenLabs — personal");
  });

  it("selecting an instance saves the full record", async () => {
    const props = make();
    render(<VoiceGroup {...props} />);
    await screen.findByLabelText("Speech-to-text");
    fireEvent.change(screen.getByLabelText("Speech-to-text"), { target: { value: "dg1" } });
    await waitFor(() =>
      expect(props.saveVoice).toHaveBeenCalledWith({ stt: { instanceId: "dg1" }, tts: null, hideInactive: false }),
    );
  });

  it("empty capability list shows vendor-naming guidance", async () => {
    const props = make({ listConnectors: vi.fn(async () => [connectors[2]]) }); // only github connected
    render(<VoiceGroup {...props} />);
    await screen.findByText(/Connect a Deepgram key in Integrations first/);
    expect(screen.getByText(/Connect an ElevenLabs key in Integrations first/)).toBeDefined();
  });

  it("hide-inactive toggle persists", async () => {
    const props = make();
    render(<VoiceGroup {...props} />);
    await screen.findByLabelText("Hide inactive voice features");
    fireEvent.click(screen.getByLabelText("Hide inactive voice features"));
    await waitFor(() => expect(props.saveVoice).toHaveBeenCalledWith({ stt: null, tts: null, hideInactive: true }));
  });

  it("keeps the prior selection and surfaces the error when save resolves with { error }", async () => {
    const props = make({
      saveVoice: vi.fn(async () => ({ stt: null, tts: null, hideInactive: false, error: "save rejected by server" })),
    });
    render(<VoiceGroup {...props} />);
    await screen.findByLabelText("Speech-to-text");
    fireEvent.change(screen.getByLabelText("Speech-to-text"), { target: { value: "dg1" } });
    await screen.findByText("save rejected by server");
    expect((screen.getByLabelText("Speech-to-text") as HTMLSelectElement).value).toBe("");
  });

  it("keeps the prior selection and surfaces the error when save rejects", async () => {
    const props = make({
      saveVoice: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<VoiceGroup {...props} />);
    await screen.findByLabelText("Speech-to-text");
    fireEvent.change(screen.getByLabelText("Speech-to-text"), { target: { value: "dg1" } });
    await screen.findByText(/network down/);
    expect((screen.getByLabelText("Speech-to-text") as HTMLSelectElement).value).toBe("");
  });
});
