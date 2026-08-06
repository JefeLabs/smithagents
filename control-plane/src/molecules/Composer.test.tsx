import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

describe("Composer", () => {
  afterEach(() => {
    cleanup();
  });

  it("Enter sends the trimmed draft and clears it", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Type a request" });
    await userEvent.type(box, "  ship it  {Enter}");
    expect(onSend).toHaveBeenCalledWith("ship it");
    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Type a request" });
    await userEvent.type(box, "a{Shift>}{Enter}{/Shift}b");
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe("a\nb");
  });

  it("send button submits and is disabled while the draft is empty", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const send = screen.getByRole("button", { name: "Send" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByRole("textbox", { name: "Type a request" }), "hello");
    expect((send as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledWith("hello");
  });

  it("voice and speaker buttons render only when wired, and fire their handlers", async () => {
    const onMicToggle = vi.fn();
    const onSoundToggle = vi.fn();
    const { rerender } = render(<Composer onSend={() => {}} />);
    expect(screen.queryByRole("button", { name: "Always listening" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mute agent voices" })).toBeNull();

    rerender(
      <Composer
        onSend={() => {}}
        micLive={false}
        onMicToggle={onMicToggle}
        soundOn={true}
        onSoundToggle={onSoundToggle}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Always listening" }));
    expect(onMicToggle).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Mute agent voices" }));
    expect(onSoundToggle).toHaveBeenCalledTimes(1);
  });

  it("offline: textarea and send are disabled with the offline placeholder", () => {
    render(<Composer onSend={() => {}} disabled />);
    const box = screen.getByRole("textbox", { name: "Type a request" }) as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Broker offline — start the broker to chat…");
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("textarea height resets after sending a multi-line draft", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} />);
    const box = screen.getByRole("textbox", { name: "Type a request" }) as HTMLTextAreaElement;
    // Type a multi-line draft: onChange sets inline height
    await userEvent.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    const heightBeforeSend = box.style.height;
    expect(heightBeforeSend).not.toBe("auto");
    expect(heightBeforeSend).not.toBe("");
    // Send via Enter key, which should reset height
    await userEvent.type(box, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("line1\nline2");
    expect(box.style.height).toBe("auto");
  });

  it("hold-to-talk renders only when onMicToggle is wired", () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.queryByRole("button", { name: "Hold to talk" })).toBeNull();
  });

  it("hold-to-talk: press starts listening, release stops it", () => {
    const onMicToggle = vi.fn();
    render(<Composer onSend={() => {}} micLive={false} onMicToggle={onMicToggle} />);
    const hold = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(2);
  });

  it("hold-to-talk: pointer leaving while held also stops it", () => {
    const onMicToggle = vi.fn();
    render(<Composer onSend={() => {}} micLive={false} onMicToggle={onMicToggle} />);
    const hold = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(hold);
    fireEvent.pointerLeave(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(2);
  });

  it("hold-to-talk is inert while always-listening is latched", () => {
    const onMicToggle = vi.fn();
    render(<Composer onSend={() => {}} micLive={true} onMicToggle={onMicToggle} />);
    const hold = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(hold);
    fireEvent.pointerUp(hold);
    expect(onMicToggle).not.toHaveBeenCalled();
  });
});
