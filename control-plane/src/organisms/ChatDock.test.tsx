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
});
