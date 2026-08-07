import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../hooks/useBrokerChat";
import { VoiceStage } from "./VoiceStage";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

const MESSAGES: ChatMessage[] = [
  { id: 1, role: "user", text: "ship it" },
  { id: 2, role: "broker", text: "Manuel: On it." },
];

function renderStage(overrides: Partial<Parameters<typeof VoiceStage>[0]> = {}) {
  const props = {
    micLive: false,
    onMicToggle: vi.fn(),
    messages: [] as ChatMessage[],
    brokerConnected: true,
    onSend: vi.fn(),
    soundOn: true,
    onSoundToggle: vi.fn(),
    ...overrides,
  };
  render(<VoiceStage {...props} />);
  return props;
}

describe("VoiceStage", () => {
  afterEach(() => {
    cleanup();
  });

  it("empty state: greeting and hero, no transcript", () => {
    renderStage();
    expect(screen.getByText(/the mic is yours/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Activate always listening" })).toBeTruthy();
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("chat state: transcript fills the stage, greeting and hero are gone", () => {
    renderStage({ messages: MESSAGES });
    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.getByText("Manuel")).toBeTruthy();
    expect(screen.queryByText(/the mic is yours/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Activate always listening" })).toBeNull();
  });

  it("chat state: composer voice toggle drives onMicToggle", async () => {
    const { onMicToggle } = renderStage({ messages: MESSAGES });
    await userEvent.click(screen.getByRole("button", { name: "Always listening" }));
    expect(onMicToggle).toHaveBeenCalledTimes(1);
  });

  it("speaker toggle in the composer drives onSoundToggle (stage-tools row is gone)", async () => {
    const { onSoundToggle } = renderStage({ messages: MESSAGES });
    const speakers = screen.getAllByRole("button", { name: "Mute agent voices" });
    expect(speakers.length).toBe(1);
    await userEvent.click(speakers[0]);
    expect(onSoundToggle).toHaveBeenCalledTimes(1);
  });

  it("sending flows through the composer in chat state", async () => {
    const { onSend } = renderStage({ messages: MESSAGES });
    await userEvent.type(screen.getByRole("textbox", { name: "Type a request" }), "hello{Enter}");
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("broker offline: composer disabled in the empty state too", () => {
    renderStage({ brokerConnected: false });
    const box = screen.getByRole("textbox", { name: "Type a request" }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Broker offline — start the broker to chat…");
  });

  it("sttEnabled false dims the mic hero and reroutes its click to onVoiceBlocked", async () => {
    const onVoiceBlocked = vi.fn();
    const { onMicToggle } = renderStage({ sttEnabled: false, onVoiceBlocked });
    const hero = screen.getByRole("button", { name: "Activate always listening" });
    expect(hero.className).toContain("is-voice-disabled");
    await userEvent.click(hero);
    expect(onMicToggle).not.toHaveBeenCalled();
    expect(onVoiceBlocked).toHaveBeenCalledTimes(1);
  });

  it("showMicHero false hides the mic hero and drops the composer's mic buttons entirely", () => {
    renderStage({ showMicHero: false });
    expect(screen.queryByRole("button", { name: "Activate always listening" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Always listening" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Hold to talk" })).toBeNull();
  });

  it("voiceNotice renders above the composer when set", () => {
    renderStage({ voiceNotice: "Add a Deepgram key in Settings → Integrations." });
    expect(screen.getByText("Add a Deepgram key in Settings → Integrations.")).toBeTruthy();
  });

  it("no voiceNotice renders nothing extra", () => {
    renderStage({ voiceNotice: null });
    expect(document.querySelector(".transcript__notice")).toBeNull();
  });
});
