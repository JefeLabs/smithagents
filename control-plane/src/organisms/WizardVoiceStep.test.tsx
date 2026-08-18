import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorInstanceRecord, ConnectorVendorMeta, VoiceOption, VoiceSettingsRecord } from "../api/types";
import type { WizardSaveState } from "../lib/wizardSteps";
import { qk } from "../queries/keys";
import { renderWithProviders } from "../test/renderWithProviders";
import { WizardVoiceStep } from "./WizardVoiceStep";

/**
 * One handler per `METHOD /path`, so a route this step must not call is a loud
 * failure rather than a silent default. Everything the step READS is seeded
 * into the query cache instead (same technique as WizardSourcesStep's suite),
 * which leaves this router carrying only the writes — the verifies, the
 * connector create, the voice save, the preview — i.e. exactly the calls these
 * tests are about.
 */
type Route = (body: unknown) => unknown;

function stubRoutes(routes: Record<string, Route>) {
  const calls: Array<{ key: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ key, body });
      const handler = routes[key];
      if (!handler) throw new Error(`no stub for ${key}`);
      const result = await handler(body);
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

function vendor(id: string, label: string, capabilities?: string[]): ConnectorVendorMeta {
  return {
    id,
    label,
    description: "",
    fields: [{ key: "apiKey", label: "API key", secret: true }],
    verifyExtraFields: [],
    capabilities,
  };
}

function instance(id: string, vendorId: string, label: string): ConnectorInstanceRecord {
  return { id, vendorId, label, fields: { hasApiKey: true } };
}

const VENDORS = [vendor("deepgram", "Deepgram", ["stt"]), vendor("elevenlabs", "ElevenLabs", ["tts"])];
const BOTH_KEYS = [instance("dg-1", "deepgram", "personal"), instance("el-1", "elevenlabs", "personal")];
const VOICES: VoiceOption[] = [
  { id: "voice-manuel", label: "Manuel" },
  { id: "voice-graciela", label: "Graciela" },
];
const NO_VOICE: VoiceSettingsRecord = { stt: null, tts: null, enabled: false };

/** Both keys check out — the ordinary happy path most cases start from. */
const BOTH_VERIFY_OK: Record<string, Route> = {
  "POST /me/connectors/dg-1/verify": () => ({ ok: true, detail: "Deepgram key valid" }),
  "POST /me/connectors/el-1/verify": () => ({ ok: true, detail: "ElevenLabs key valid" }),
};

function renderStep(
  opts: {
    routes?: Record<string, Route>;
    vendors?: ConnectorVendorMeta[];
    connectors?: ConnectorInstanceRecord[];
    voices?: VoiceOption[];
    voice?: VoiceSettingsRecord;
    onBack?: () => void;
    saveState?: WizardSaveState;
    initialVoice?: boolean;
  } = {},
) {
  const calls = stubRoutes(opts.routes ?? {});
  const onDone = vi.fn();
  const element = (saveState: WizardSaveState) => (
    <WizardVoiceStep initialVoice={opts.initialVoice} onDone={onDone} onBack={opts.onBack} saveState={saveState} />
  );
  const result = renderWithProviders(element(opts.saveState ?? "idle"));
  result.client.setQueryData<ConnectorVendorMeta[]>(qk.connectorVendors, opts.vendors ?? VENDORS);
  result.client.setQueryData<ConnectorInstanceRecord[]>(qk.myConnectors, opts.connectors ?? BOTH_KEYS);
  result.client.setQueryData<VoiceOption[]>(qk.voiceOptions, opts.voices ?? VOICES);
  result.client.setQueryData<VoiceSettingsRecord>(qk.voiceSettings, opts.voice ?? NO_VOICE);
  return {
    ...result,
    onDone,
    calls,
    reportSaveState: (saveState: WizardSaveState) => result.rerender(element(saveState)),
  };
}

const YES = { name: /yes, let's talk/i } as const;
const NOT_NOW = { name: /not right now/i } as const;
const CONTINUE = { name: /^continue$/i } as const;
const LISTEN = { name: /i'll listen with/i } as const;
const SPEAK = { name: /and speak with/i } as const;
const SAY = { name: /say something/i } as const;

/** Answers yes and waits for the hosted half of the step to exist. */
async function sayYes() {
  await userEvent.click(await screen.findByRole("radio", YES));
  await screen.findByRole("combobox", LISTEN);
}

/** Answers yes and assigns both slots — the state every gate assertion starts from. */
async function chooseBothKeys() {
  await sayYes();
  await userEvent.selectOptions(screen.getByRole("combobox", LISTEN), "dg-1");
  await userEvent.selectOptions(screen.getByRole("combobox", SPEAK), "el-1");
}

describe("WizardVoiceStep", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // --- Resumed answers ----------------------------------------------------

  it("a resumed 'yes' seeds the radio to yes — a prior answer is not discarded", async () => {
    // The discriminating wrong implementation is the one that SHIPPED before
    // this test: a hardcoded "no" default. It looks right for fresh runs and
    // for resumed voice:false — and silently resets a resumed voice:true,
    // which Continue (explicit send, by design) would then OVERWRITE with
    // false. Third appearance of the answer-flip class on this feature.
    renderStep({ initialVoice: true });
    expect(await screen.findByRole("radio", YES)).toBeChecked();
    // And the hosted half is already open, since yes is the standing answer.
    expect(await screen.findByRole("combobox", LISTEN)).toBeInTheDocument();
  });

  it("absent and false both seed to 'not right now' — declined is the default", async () => {
    renderStep({ initialVoice: false });
    expect(await screen.findByRole("radio", NOT_NOW)).toBeChecked();
  });

  // --- The spec's own copy -------------------------------------------------

  it("asks the spec's question as an <h2>, with no <h1> above it", async () => {
    // Wrong impls this catches: a paraphrase ("Enable voice?"), instructing
    // rather than asking, and the heading tier — setup steps carry no <h1> at
    // all (the gate's greeting is the panel's only one), so a component that
    // opened with one would fail here rather than only in the browser.
    renderStep();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Would you like to talk to me out loud?" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("offers the spec's two answers, with 'Not right now' the one already chosen", async () => {
    // Half the no-dead-end contract, and the ONLY test that pins the default.
    // A wrong impl that preselected "Yes, let's talk" would pass every other
    // case here — including the gate ones, which answer yes explicitly.
    renderStep();
    expect(await screen.findByRole("radio", YES)).not.toBeChecked();
    expect(screen.getByRole("radio", NOT_NOW)).toBeChecked();
  });

  it("asks nothing else until the answer is yes", async () => {
    // Wrong impl: rendering the whole hosted apparatus up front and merely
    // ignoring it — which would ask a declining user for two keys and a voice.
    renderStep();
    await screen.findByRole("radio", NOT_NOW);
    expect(screen.queryByRole("heading", { name: /how should i listen and speak/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", LISTEN)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /how should i sound/i })).not.toBeInTheDocument();
  });

  // --- The backend fork ----------------------------------------------------

  it("on yes, asks how it should listen and speak, with hosted already chosen", async () => {
    // Wrong impl: leaving the fork unanswered, which would make the two
    // choosers below it look optional when they are the whole step.
    renderStep();
    await sayYes();
    expect(screen.getByRole("heading", { level: 2, name: "How should I listen and speak?" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /hosted/i })).toBeChecked();
  });

  it("renders on-device disabled — natively AND with aria-disabled — naming the way forward", async () => {
    // Moved wholesale from WizardGateStep's Cloud option, including WHY both
    // attributes are needed: `aria-disabled` alone still lets react-aria's
    // arrow-key roving focus land here (its focusability check is literally
    // `input:not([disabled])`), and selecting a value-less radio would set the
    // backend to "on". A wrong impl carrying only `aria-disabled` passes the
    // dimming check and corrupts the answer; one carrying only `disabled`
    // renders undimmed with pointer-events live.
    renderStep();
    await sayYes();
    const here = screen.getByRole("radio", { name: /right here/i });
    expect(here).toBeDisabled();
    expect(here).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/needs a small download — coming soon/i)).toBeInTheDocument();
  });

  // --- The two per-slot choosers -------------------------------------------

  it("offers one chooser per slot, listing only the instances whose vendor declares that capability", async () => {
    // The user's 2026-08-18 ruling. Wrong impls this catches: two fixed key
    // fields (no `combobox` at all); one chooser for both slots; and — the
    // subtle one — listing every saved connector in both, which would offer an
    // ElevenLabs key as a microphone.
    renderStep();
    await sayYes();
    const listen = screen.getByRole("combobox", LISTEN);
    const speak = screen.getByRole("combobox", SPEAK);
    expect(within(listen).getByRole("option", { name: "Deepgram — personal" })).toBeInTheDocument();
    expect(within(listen).queryByRole("option", { name: "ElevenLabs — personal" })).not.toBeInTheDocument();
    expect(within(speak).getByRole("option", { name: "ElevenLabs — personal" })).toBeInTheDocument();
    expect(within(speak).queryByRole("option", { name: "Deepgram — personal" })).not.toBeInTheDocument();
  });

  it("offers 'Add a … key' inline in each chooser, and never punts to Integrations", async () => {
    // The gap VoiceGroup deliberately leaves ("Connect a Deepgram key in
    // Integrations first") and the wizard must not: a first-run user has no
    // Settings to go to yet. Rendered with NO saved keys, which is this
    // machine's real state — a wrong impl that only appends the add option to
    // a non-empty list would strand exactly the user who needs it.
    renderStep({ connectors: [] });
    await sayYes();
    expect(screen.getByRole("option", { name: "Add a Deepgram key…" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Add an ElevenLabs key…" })).toBeInTheDocument();
    expect(screen.queryByText(/in integrations/i)).not.toBeInTheDocument();
  });

  it("adding a key inline creates it through the connector machinery, and it becomes the selection", async () => {
    // Pins BOTH halves: the create goes through POST /me/connectors (the one
    // path key material may take — a wrong impl could have hand-rolled a
    // second key field writing somewhere else), and the created instance is
    // then selected rather than merely saved, so the user is not made to
    // re-pick the thing they just typed.
    const { calls } = renderStep({
      connectors: [instance("dg-1", "deepgram", "personal")],
      routes: {
        ...BOTH_VERIFY_OK,
        "POST /me/connectors": (body) => ({
          id: "el-new",
          vendorId: "elevenlabs",
          label: (body as { label: string }).label,
          fields: { hasApiKey: true },
        }),
        "POST /me/connectors/el-new/verify": () => ({ ok: true, detail: "ElevenLabs key valid" }),
      },
    });
    await sayYes();
    await userEvent.selectOptions(screen.getByRole("combobox", SPEAK), "add:elevenlabs");
    const dialog = await screen.findByRole("dialog", { name: /connect elevenlabs/i });
    await userEvent.type(within(dialog).getByPlaceholderText(/label/i), "mine");
    await userEvent.type(within(dialog).getByPlaceholderText("API key"), "sk-live");
    await userEvent.click(within(dialog).getByRole("button", { name: /connect/i }));
    await waitFor(() => expect(screen.getByRole("combobox", SPEAK)).toHaveValue("el-new"));
    expect(calls.find((c) => c.key === "POST /me/connectors")?.body).toEqual({
      vendorId: "elevenlabs",
      label: "mine",
      fields: { apiKey: "sk-live" },
    });
  });

  // --- The verification gate -----------------------------------------------

  it("checks a chosen key with the vendor, and opens Continue only once both come back good", async () => {
    // The positive half of the discriminating pair. On its own this would also
    // pass for an implementation that gated on `Boolean(instance)` and never
    // called verify at all — which is exactly what the next test rules out, so
    // the two must be read together.
    const { calls } = renderStep({ routes: BOTH_VERIFY_OK });
    await chooseBothKeys();
    await waitFor(() => expect(screen.getByRole("button", CONTINUE)).toBeEnabled());
    expect(calls.map((c) => c.key)).toContain("POST /me/connectors/dg-1/verify");
    expect(calls.map((c) => c.key)).toContain("POST /me/connectors/el-1/verify");
  });

  it("THE DISCRIMINATING CASE: a stored key the vendor refuses does not open the gate", async () => {
    // "A key was typed" and "the vendor confirmed it" are different facts, and
    // the swarm's invariant (users.ts:21) is about the second. A
    // ConnectorInstanceRecord carries NO verified flag — id, vendorId, label,
    // fields and nothing else — so an implementation gating on
    // `Boolean(instance)` looks identical to this one everywhere except right
    // here, and would send `enabled: true` for a key that cannot speak.
    // Mutation-checked: gating on selection alone fails this test and passes
    // every other one in this file.
    renderStep({
      routes: {
        "POST /me/connectors/dg-1/verify": () => ({ ok: true, detail: "Deepgram key valid" }),
        "POST /me/connectors/el-1/verify": () => ({ ok: false, detail: "ElevenLabs rejected that key (401)" }),
      },
    });
    await chooseBothKeys();
    expect(await screen.findByText(/elevenlabs rejected that key \(401\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
    // Never a dead end: the retreat is still there for the user who cannot
    // make a key work.
    expect(screen.getByRole("radio", NOT_NOW)).toBeEnabled();
  });

  it("a check that cannot be reached says so in a sentence of its own, and still does not open the gate", async () => {
    // `brokerFetch` never throws on a non-2xx, so a REJECTION is a network
    // failure — ambiguous, and never proof the key is good. Wrong impls: a
    // rejection treated as verified (the optimistic read that belongs to
    // WRITES, not to checks), and a raw "Failed to fetch" reaching the screen,
    // which the live walk already caught once on the roles path.
    renderStep({ routes: {} });
    await chooseBothKeys();
    expect(await screen.findAllByText(/couldn't reach/i)).not.toHaveLength(0);
    expect(screen.queryByText(/failed to fetch/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
  });

  it("a failed check can be asked again — the same key, without re-picking it", async () => {
    // Every check runs at most once per instance, which is right for the
    // ordinary path and a trap for a network blip: re-choosing the SAME option
    // fires no change event, so without this control the only way back from a
    // transient failure would be to add a second key for a vendor whose key
    // was fine. Wrong impl: a retry that re-runs the once-only guard and so
    // does nothing at all — hence the count assertion, not just the copy.
    let ok = false;
    const { calls } = renderStep({
      routes: {
        "POST /me/connectors/dg-1/verify": () =>
          ok ? { ok: true, detail: "Deepgram key valid" } : { ok: false, detail: "Deepgram is having a moment" },
        "POST /me/connectors/el-1/verify": () => ({ ok: true, detail: "ElevenLabs key valid" }),
      },
    });
    await chooseBothKeys();
    expect(await screen.findByText(/deepgram is having a moment/i)).toBeInTheDocument();
    ok = true;
    await userEvent.click(screen.getByRole("button", { name: /check it again/i }));
    await waitFor(() => expect(screen.getByRole("button", CONTINUE)).toBeEnabled());
    expect(calls.filter((c) => c.key === "POST /me/connectors/dg-1/verify")).toHaveLength(2);
  });

  // --- Saving --------------------------------------------------------------

  it("Continue on yes assigns both slots and turns voice on in ONE write", async () => {
    // Three things at once, all load-bearing: one PUT rather than two (a
    // half-written record behind a failure between them is the bug class this
    // codebase has already fixed once), `enabled: true` alongside the slots
    // (the swarm coerces it off otherwise), and an EXPLICIT `voice: true` in
    // the patch — setup merges, so an omission would keep whatever was there.
    const { calls, onDone } = renderStep({
      routes: {
        ...BOTH_VERIFY_OK,
        "PUT /me/voice": () => ({ stt: { instanceId: "dg-1" }, tts: { instanceId: "el-1" }, enabled: true }),
      },
    });
    await chooseBothKeys();
    await waitFor(() => expect(screen.getByRole("button", CONTINUE)).toBeEnabled());
    await userEvent.click(screen.getByRole("button", CONTINUE));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ setup: { voice: true } }));
    expect(calls.filter((c) => c.key === "PUT /me/voice").map((c) => c.body)).toEqual([
      { stt: { instanceId: "dg-1" }, tts: { instanceId: "el-1" }, enabled: true },
    ]);
  });

  it("a refused save shows the server's own sentence and does not advance", async () => {
    // A resolved `{error}` is a firm no, not a network blip: the step stays
    // put, with a way out still on screen. Wrong impl: treating a 200-with-
    // {error} as success, which advances past a voice that was never saved.
    const { onDone } = renderStep({
      routes: { ...BOTH_VERIFY_OK, "PUT /me/voice": () => ({ error: "That key is no longer valid." }) },
    });
    await chooseBothKeys();
    await waitFor(() => expect(screen.getByRole("button", CONTINUE)).toBeEnabled());
    await userEvent.click(screen.getByRole("button", CONTINUE));
    expect(await screen.findByText("That key is no longer valid.")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", NOT_NOW)).toBeEnabled();
  });

  // --- The retreat ---------------------------------------------------------

  it("Continue with 'Not right now' emits voice:false EXPLICITLY and writes no voice settings", async () => {
    // The other mutation-checked assertion. `toHaveBeenCalledWith` on the
    // WHOLE patch, not a property probe: `{setup:{}}` — the shape the roles
    // step legitimately sends — would satisfy any weaker check and leave a
    // stale `voice: true` standing, because the server merges setup rather
    // than replacing it. The route assertion is the second half: declining
    // must not touch /me/voice at all.
    const { onDone, calls } = renderStep();
    await userEvent.click(await screen.findByRole("button", CONTINUE));
    expect(onDone).toHaveBeenCalledWith({ setup: { voice: false } });
    expect(calls.map((c) => c.key)).not.toContain("PUT /me/voice");
  });

  it("'Not right now' can be answered from a half-configured yes, with Continue live again at once", async () => {
    // THE no-dead-end proof: a user who asked for voice, cannot verify a key,
    // and has no Settings to escape to must be able to answer No instead.
    renderStep({
      routes: {
        "POST /me/connectors/dg-1/verify": () => ({ ok: true, detail: "Deepgram key valid" }),
        "POST /me/connectors/el-1/verify": () => ({ ok: false, detail: "ElevenLabs rejected that key (401)" }),
      },
    });
    await chooseBothKeys();
    await waitFor(() => expect(screen.getByRole("button", CONTINUE)).toBeDisabled());
    await userEvent.click(screen.getByRole("radio", NOT_NOW));
    expect(screen.getByRole("button", CONTINUE)).toBeEnabled();
  });

  // --- How should I sound? -------------------------------------------------

  it("'How should I sound?' offers the broker's own voices", async () => {
    // Wrong impl: a second hardcoded list in the client. The fixture names are
    // deliberately only two of the nine the broker really returns, so a
    // component carrying its own cast fails rather than coincidentally
    // matching.
    renderStep();
    await sayYes();
    expect(screen.getByRole("heading", { level: 2, name: "How should I sound?" })).toBeInTheDocument();
    const voices = screen.getByRole("combobox", { name: /how should i sound/i });
    expect(within(voices).getByRole("option", { name: "Manuel" })).toBeInTheDocument();
    expect(within(voices).getByRole("option", { name: "Graciela" })).toBeInTheDocument();
  });

  it("says so in a sentence when it has no voices to offer, rather than showing an empty picker", async () => {
    // `/voice/options` is derived from a constant cast, so an empty list means
    // the broker did not answer — and a `<select>` with nothing in it beside a
    // ▶ that cannot fire reads as broken software rather than as a broker that
    // is down. Wrong impl: rendering the dead pair anyway and merely disabling
    // them, which says nothing about why.
    renderStep({ voices: [] });
    await sayYes();
    expect(screen.queryByRole("combobox", { name: /how should i sound/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", SAY)).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't reach my voices/i)).toBeInTheDocument();
  });

  it("▶ Say something asks the broker for the CHOSEN voice, and is inert while one is in flight", async () => {
    // Two wrong impls: sending a hardcoded (or always-first) voiceId, which no
    // single-option fixture could catch — hence picking the SECOND voice here;
    // and a button that stays live, letting a second preview stack on the
    // first.
    let release: (v: unknown) => void = () => {};
    const { calls } = renderStep({
      routes: { ...BOTH_VERIFY_OK, "POST /voice/preview": () => new Promise((resolve) => (release = resolve)) },
    });
    await chooseBothKeys();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: /how should i sound/i }), "voice-graciela");
    await userEvent.click(screen.getByRole("button", SAY));
    await waitFor(() => expect(screen.getByRole("button", SAY)).toBeDisabled());
    expect(calls.find((c) => c.key === "POST /voice/preview")?.body).toMatchObject({ voiceId: "voice-graciela" });
    release({ error: "no key" });
    await waitFor(() => expect(screen.getByRole("button", SAY)).toBeEnabled());
  });

  // THE discriminating case for the shipped defect. The wizard writes its slot
  // assignment only on Continue, so a preview resolved from the SAVED slot
  // refuses on every first pass — and refuses by sending a first-run user to a
  // Settings screen they have not reached. The chosen instance id has to
  // travel on the request for the preview to be able to work at all. Note the
  // fixture: `/me/voice` is NO_VOICE (both slots null), which is exactly the
  // state the broken build cannot preview from — a test that seeded a saved
  // slot would pass on that build.
  it("▶ Say something names the instance chosen ON THIS SCREEN, not the saved slot", async () => {
    const { calls } = renderStep({
      voice: NO_VOICE,
      routes: { ...BOTH_VERIFY_OK, "POST /voice/preview": () => ({ mime: "audio/mpeg", dataB64: "" }) },
    });
    await chooseBothKeys();
    await userEvent.click(screen.getByRole("button", SAY));
    await waitFor(() =>
      expect(calls.find((c) => c.key === "POST /voice/preview")?.body).toEqual({
        voiceId: "voice-manuel",
        ttsInstanceId: "el-1",
      }),
    );
  });

  // The key material itself never travels: only the instance id, which the
  // swarm resolves behind the broker. A wrong impl that read the key from the
  // connectors list and posted it would satisfy the id assertion above.
  it("▶ Say something sends an instance id and nothing resembling a key", async () => {
    const { calls } = renderStep({
      routes: { ...BOTH_VERIFY_OK, "POST /voice/preview": () => ({ mime: "audio/mpeg", dataB64: "" }) },
    });
    await chooseBothKeys();
    await userEvent.click(screen.getByRole("button", SAY));
    await waitFor(() => expect(calls.some((c) => c.key === "POST /voice/preview")).toBe(true));
    const body = calls.find((c) => c.key === "POST /voice/preview")?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ttsInstanceId", "voiceId"]);
  });

  // With nothing chosen there is no key to speak with, and a request sent
  // anyway is doomed — it comes back with the broker's Settings punt, which is
  // the sentence this whole step exists to remove. So ▶ waits, and says what
  // it is waiting for, in terms of the screen the user is on. A wrong impl
  // that leaves ▶ live (or that says nothing) fails here.
  it("▶ Say something waits for a speaking key, and names this screen rather than Settings", async () => {
    const { calls } = renderStep({ voice: NO_VOICE });
    await sayYes();
    expect(screen.getByRole("button", SAY)).toBeDisabled();
    const hint = screen.getByText(/choose a key above/i);
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).not.toMatch(/settings/i);
    expect(calls.some((c) => c.key === "POST /voice/preview")).toBe(false);
  });

  it("▶ Say something comes alive the moment a speaking key is chosen", async () => {
    // The other half of the gate: a disabled control that never enables is
    // just a broken one. Choosing ONLY the tts slot is what frees it — the
    // preview does not wait on the listening key, which powers nothing here.
    renderStep({ routes: BOTH_VERIFY_OK });
    await sayYes();
    await userEvent.selectOptions(screen.getByRole("combobox", SPEAK), "el-1");
    await waitFor(() => expect(screen.getByRole("button", SAY)).toBeEnabled());
    expect(screen.queryByText(/choose a key above/i)).not.toBeInTheDocument();
  });

  it("a preview refusal is rendered inline, in the broker's own words, and blocks nothing", async () => {
    // This machine's REAL answer (no ElevenLabs key), and it must read as a
    // sentence rather than a failure: the preview is a nicety, so a wrong impl
    // that gated Continue on a successful preview — or swallowed the refusal
    // into a console log — would strand a user whose keys are otherwise fine.
    const refusal =
      "No text-to-speech key — add an ElevenLabs key in Settings → Integrations, then select it under Settings → Voice.";
    renderStep({ routes: { ...BOTH_VERIFY_OK, "POST /voice/preview": () => ({ error: refusal }) } });
    await chooseBothKeys();
    await userEvent.click(screen.getByRole("button", SAY));
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", CONTINUE)).toBeEnabled());
  });

  // --- Obeying the host's save state ---------------------------------------

  it("stays inert after handing off, and comes back the moment the host reports the write failed", async () => {
    // `handedOff` alone would be a dead end rather than a guard — it exists to
    // stop a second write racing the host's, and that race lasts exactly as
    // long as the write does. Same fix, same reasoning, as the roles step.
    const { reportSaveState } = renderStep();
    const button = await screen.findByRole("button", CONTINUE);
    await userEvent.click(button);
    expect(button).toBeDisabled();
    reportSaveState("saving");
    expect(screen.getByRole("button", CONTINUE)).toBeDisabled();
    reportSaveState("failed");
    expect(screen.getByRole("button", CONTINUE)).toBeEnabled();
  });

  it("offers Back only when there is something behind this step", async () => {
    // Same contract as WizardSourcesStep's and WizardRolesStep's Back: the
    // prop's absence is what withholds the control, not a disabled one.
    const { unmount } = renderStep();
    await screen.findByRole("radio", NOT_NOW);
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    unmount();
    renderStep({ onBack: vi.fn() });
    expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();
  });
});
