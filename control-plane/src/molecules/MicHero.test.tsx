import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicHero } from "./MicHero";

describe("MicHero", () => {
  afterEach(() => {
    cleanup();
  });

  it("idle: reads as the always-listening activator and fires onToggle", async () => {
    const onToggle = vi.fn();
    render(<MicHero live={false} onToggle={onToggle} />);
    const hero = screen.getByRole("button", { name: "Activate always listening" });
    expect(screen.getByText("Activate always listening")).toBeTruthy();
    await userEvent.click(hero);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("live: shows the listening caption", () => {
    render(<MicHero live={true} onToggle={() => {}} />);
    expect(screen.getByText("Listening…")).toBeTruthy();
    expect(screen.queryByText("Activate always listening")).toBeNull();
  });

  it("blocked: click fires onVoiceBlocked instead of onToggle, and dims the button", async () => {
    const onToggle = vi.fn();
    const onVoiceBlocked = vi.fn();
    render(<MicHero live={false} onToggle={onToggle} sttEnabled={false} onVoiceBlocked={onVoiceBlocked} />);
    const hero = screen.getByRole("button", { name: "Activate always listening" });
    expect(hero.className).toContain("is-voice-disabled");
    await userEvent.click(hero);
    expect(onToggle).not.toHaveBeenCalled();
    expect(onVoiceBlocked).toHaveBeenCalledTimes(1);
  });

  it("sttEnabled leaves the button working and undimmed", async () => {
    const onToggle = vi.fn();
    render(<MicHero live={false} onToggle={onToggle} sttEnabled={true} />);
    const hero = screen.getByRole("button", { name: "Activate always listening" });
    expect(hero.className).not.toContain("is-voice-disabled");
    await userEvent.click(hero);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
