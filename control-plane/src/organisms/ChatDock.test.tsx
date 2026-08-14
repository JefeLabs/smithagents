import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../api/types";
import { ChatDock } from "./ChatDock";

const base = {
  onSend: vi.fn(),
  brokerConnected: true,
  micLive: false,
  onMicToggle: vi.fn(),
  soundOn: true,
  onSoundToggle: vi.fn(),
  onPickKind: vi.fn(),
} as const;

const MSGS: ChatMessage[] = [{ id: 1, role: "user", text: "hi" }];

describe("ChatDock", () => {
  it("full + empty shows the mic hero", () => {
    render(<ChatDock variant="full" messages={[]} activeKind="chat" {...base} />);
    expect(screen.getByRole("region", { name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /the mic is yours/i })).toBeInTheDocument();
  });

  it("dock uses the select kind control, not the button group", () => {
    render(<ChatDock variant="dock" messages={MSGS} activeKind="documents" {...base} />);
    expect(screen.queryByRole("group", { name: /artifact kind/i })).toBeNull();
    expect(screen.getByRole("button", { name: /artifact kind/i })).toBeInTheDocument();
  });

  it("dock does not show the hero", () => {
    render(<ChatDock variant="dock" messages={[]} activeKind="documents" {...base} />);
    expect(screen.queryByRole("heading", { name: /the mic is yours/i })).toBeNull();
  });

  it("voice controls are all present by default (positive control for the disabled cases)", () => {
    render(<ChatDock variant="dock" messages={MSGS} activeKind="documents" {...base} />);
    expect(screen.getByRole("button", { name: /hold to talk/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /always listening/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mute agent voices/i })).toBeInTheDocument();
  });

  it("voiceEnabled=false: full-variant hero greets with Hello instead of the mic pitch, MicHero gone", () => {
    render(<ChatDock variant="full" messages={[]} activeKind="chat" {...base} voiceEnabled={false} />);
    expect(screen.getByRole("heading", { name: /hello,/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /the mic is yours/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /hold to talk/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /always listening/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /mute agent voices/i })).toBeNull();
  });

  it("voiceEnabled=false: mic, listener and speaker are gone from the right dock too", () => {
    render(<ChatDock variant="dock" messages={MSGS} activeKind="documents" {...base} voiceEnabled={false} />);
    expect(screen.queryByRole("button", { name: /hold to talk/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /always listening/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /mute agent voices/i })).toBeNull();
  });
});
