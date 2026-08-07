import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type StageContextValue, StageProvider, useStage } from "./StageContext";

const VALUE: StageContextValue = {
  messages: [],
  micLive: false,
  onMicToggle: vi.fn(),
  brokerConnected: true,
  send: vi.fn(),
  soundOn: false,
  onSoundToggle: vi.fn(),
  sttEnabled: false,
  onVoiceBlocked: vi.fn(),
  showMicHero: true,
  voiceNotice: null,
  roster: [],
  lastBoardUpdate: null,
  lastCapabilityUpdate: null,
  agents: [],
  activity: vi.fn(async () => ({ busy: false })),
  workAction: vi.fn(async () => null),
};

function Probe() {
  const { brokerConnected } = useStage();
  return <span>{brokerConnected ? "connected" : "offline"}</span>;
}

describe("StageContext", () => {
  it("useStage returns the provided value", () => {
    render(
      <StageProvider value={VALUE}>
        <Probe />
      </StageProvider>,
    );
    expect(screen.getByText("connected")).toBeTruthy();
  });

  it("useStage throws outside a provider", () => {
    // React logs the thrown error; silence the noise for this one render.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/StageProvider/);
    spy.mockRestore();
  });
});
