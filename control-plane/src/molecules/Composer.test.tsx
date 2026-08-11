import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RosterAgent } from "../api/types";
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

  it("always-listening toggle is disabled while holding", () => {
    const onMicToggle = vi.fn();
    render(<Composer onSend={() => {}} micLive={false} onMicToggle={onMicToggle} />);
    const hold = screen.getByRole("button", { name: "Hold to talk" });
    const alwaysListening = screen.getByRole("button", { name: "Always listening" }) as HTMLButtonElement;
    fireEvent.pointerDown(hold);
    expect(alwaysListening.disabled).toBe(true);
    fireEvent.pointerUp(hold);
    expect(alwaysListening.disabled).toBe(false);
  });

  it("blur while holding releases the hold", () => {
    const onMicToggle = vi.fn();
    render(<Composer onSend={() => {}} micLive={false} onMicToggle={onMicToggle} />);
    const hold = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(1);
    fireEvent.blur(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(2);
  });

  it("hold-to-talk: a canceled pointer (e.g. touch interrupted) also releases the hold", () => {
    const onMicToggle = vi.fn();
    render(<Composer onSend={() => {}} micLive={false} onMicToggle={onMicToggle} />);
    const hold = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.pointerDown(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(1);
    fireEvent.pointerCancel(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(2);
    fireEvent.pointerUp(hold);
    expect(onMicToggle).toHaveBeenCalledTimes(2);
  });

  it("hold-to-talk: Space starts listening on keydown, ends on keyup", () => {
    const onMicToggle = vi.fn();
    render(<Composer onSend={() => {}} micLive={false} onMicToggle={onMicToggle} />);
    const hold = screen.getByRole("button", { name: "Hold to talk" });
    fireEvent.keyDown(hold, { key: " " });
    expect(onMicToggle).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(hold, { key: " " });
    expect(onMicToggle).toHaveBeenCalledTimes(2);
  });
});

describe("Composer voice gating", () => {
  afterEach(() => {
    cleanup();
  });

  it("blocked hold-to-talk fires onVoiceBlocked instead of starting the mic", () => {
    const onMicToggle = vi.fn();
    const onVoiceBlocked = vi.fn();
    render(<Composer onSend={vi.fn()} onMicToggle={onMicToggle} sttEnabled={false} onVoiceBlocked={onVoiceBlocked} />);
    fireEvent.pointerDown(screen.getByLabelText("Hold to talk"));
    expect(onMicToggle).not.toHaveBeenCalled();
    expect(onVoiceBlocked).toHaveBeenCalled();
  });

  it("sttEnabled leaves the mic working", () => {
    const onMicToggle = vi.fn();
    render(<Composer onSend={vi.fn()} onMicToggle={onMicToggle} sttEnabled={true} />);
    fireEvent.pointerDown(screen.getByLabelText("Hold to talk"));
    expect(onMicToggle).toHaveBeenCalled();
  });

  it("blocked always-listening toggle fires onVoiceBlocked instead of toggling", async () => {
    const onMicToggle = vi.fn();
    const onVoiceBlocked = vi.fn();
    render(<Composer onSend={vi.fn()} onMicToggle={onMicToggle} sttEnabled={false} onVoiceBlocked={onVoiceBlocked} />);
    await userEvent.click(screen.getByRole("button", { name: "Always listening" }));
    expect(onMicToggle).not.toHaveBeenCalled();
    expect(onVoiceBlocked).toHaveBeenCalled();
  });

  it("blocked mic buttons are marked unavailable to assistive tech", () => {
    render(<Composer onSend={vi.fn()} onMicToggle={vi.fn()} sttEnabled={false} onVoiceBlocked={vi.fn()} />);
    // Still pressable — a press must reach onVoiceBlocked to raise the notice —
    // so this is aria-disabled, never the `disabled` attribute.
    expect(screen.getByRole("button", { name: /hold to talk/i })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /always listening/i })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("Composer polish", () => {
  afterEach(() => {
    cleanup();
  });

  it("polish replaces the draft with the rewrite and keeps it editable", async () => {
    const onPolish = vi.fn().mockResolvedValue("Please fix the login flow.");
    render(<Composer onSend={vi.fn()} onPolish={onPolish} />);
    const box = screen.getByRole("textbox", { name: /type a request/i });
    fireEvent.change(box, { target: { value: "plz fx login" } });
    fireEvent.click(screen.getByRole("button", { name: /polish/i }));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("Please fix the login flow."));
    expect(onPolish).toHaveBeenCalledWith("plz fx login");
  });

  it("a failed polish keeps the draft exactly and shows an error", async () => {
    const onPolish = vi.fn().mockResolvedValue(null);
    render(<Composer onSend={vi.fn()} onPolish={onPolish} />);
    const box = screen.getByRole("textbox", { name: /type a request/i });
    fireEvent.change(box, { target: { value: "my rough draft" } });
    fireEvent.click(screen.getByRole("button", { name: /polish/i }));
    expect(await screen.findByText(/polish failed/i)).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("my rough draft");
  });

  it("polish is absent without the prop and disabled on an empty draft", () => {
    const { rerender } = render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /polish/i })).toBeNull();
    rerender(<Composer onSend={vi.fn()} onPolish={vi.fn()} />);
    expect(screen.getByRole("button", { name: /polish/i }).getAttribute("aria-disabled")).toBe("true");
  });
  it("renders the kind row as a persistent third row (present without engaging)", () => {
    render(<Composer onSend={vi.fn()} onPickKind={vi.fn()} />);
    expect(screen.getByRole("group", { name: /artifact kind/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Diagrams" })).toBeInTheDocument();
  });

  it("clicking a kind calls onPickKind and never sends", async () => {
    const onPickKind = vi.fn();
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onPickKind={onPickKind} />);
    await userEvent.click(screen.getByRole("button", { name: "Diagrams" }));
    expect(onPickKind).toHaveBeenCalledWith("diagrams");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("the active kind button is marked current", () => {
    render(<Composer onSend={vi.fn()} onPickKind={vi.fn()} activeKind="map" />);
    expect(screen.getByRole("button", { name: "User Story Maps" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("no kind row without onPickKind", () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByRole("group", { name: /artifact kind/i })).not.toBeInTheDocument();
  });

  it("kindControl=select renders a kind picker that fires onPickKind", async () => {
    const onPickKind = vi.fn();
    render(<Composer onSend={vi.fn()} onPickKind={onPickKind} activeKind="documents" kindControl="select" />);
    await userEvent.click(screen.getByRole("button", { name: /artifact kind/i }));
    await userEvent.click(await screen.findByRole("option", { name: "Diagrams" }));
    expect(onPickKind).toHaveBeenCalledWith("diagrams");
  });

  it("kindControl=select replaces the button group (no group role)", () => {
    render(<Composer onSend={vi.fn()} onPickKind={vi.fn()} activeKind="documents" kindControl="select" />);
    expect(screen.queryByRole("group", { name: /artifact kind/i })).toBeNull();
    expect(screen.getByRole("button", { name: /artifact kind/i })).toBeInTheDocument();
  });
});

describe("target selector", () => {
  const TARGETS: RosterAgent[] = [
    { id: "osvaldo", name: "Osvaldo", role: "senior", status: "idle", kind: "agent" },
    {
      id: "squad-alpha",
      name: "Alpha",
      role: "Squad — led by Gabriel",
      status: "idle",
      kind: "squad",
      members: ["Gabriel"],
    },
    {
      id: "group-g1",
      name: "Delta",
      role: "Squad — led by Josefina",
      status: "idle",
      kind: "squad",
      members: ["Josefina", "Osvaldo"],
      leader: "josefina",
    },
  ];

  it("renders no selector at all when the caller passes no targets", () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /send to/i })).toBeNull();
  });

  it("defaults to the chief of staff", () => {
    render(<Composer onSend={vi.fn()} targets={TARGETS} />);
    expect(screen.getByRole("button", { name: /send to/i })).toHaveTextContent("Anderson");
  });

  it("sends to the chosen agent, decoding the key into a Target object", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} targets={TARGETS} />);
    await userEvent.click(screen.getByRole("button", { name: /send to/i }));
    await userEvent.click(await screen.findByRole("option", { name: /Osvaldo/ }));
    await userEvent.type(screen.getByRole("textbox"), "look at the auth bug");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(onSend).toHaveBeenCalledWith("look at the auth bug", { kind: "agent", id: "osvaldo" });
  });

  it("sends with NO target when the chief of staff is selected — the untouched brain path", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} targets={TARGETS} />);
    await userEvent.type(screen.getByRole("textbox"), "who is free?");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    // ONE argument, byte-identical to the pre-feature call shape.
    expect(onSend).toHaveBeenCalledWith("who is free?");
  });

  it("snaps back to Anderson after a send, so no message ever leaks to a CLI", async () => {
    render(<Composer onSend={vi.fn()} targets={TARGETS} />);
    await userEvent.click(screen.getByRole("button", { name: /send to/i }));
    await userEvent.click(await screen.findByRole("option", { name: /Osvaldo/ }));
    await userEvent.type(screen.getByRole("textbox"), "one");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(screen.getByRole("button", { name: /send to/i })).toHaveTextContent("Anderson");
  });

  it("shows a refusal and KEEPS the text when the target is busy", async () => {
    const onSend = vi.fn().mockResolvedValue("Osvaldo is busy with: refactor auth.");
    render(<Composer onSend={onSend} targets={TARGETS} />);
    await userEvent.click(screen.getByRole("button", { name: /send to/i }));
    await userEvent.click(await screen.findByRole("option", { name: /Osvaldo/ }));
    await userEvent.type(screen.getByRole("textbox"), "look at the auth bug");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(await screen.findByText(/busy with: refactor auth/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("look at the auth bug");
  });

  it("strips the freed- prefix a dragged-out squad member carries, or the broker 404s", async () => {
    const onSend = vi.fn();
    render(
      <Composer
        onSend={onSend}
        targets={[{ id: "freed-osvaldo", name: "Osvaldo", role: "senior", status: "idle", kind: "agent" }]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /send to/i }));
    await userEvent.click(await screen.findByRole("option", { name: /Osvaldo/ }));
    await userEvent.type(screen.getByRole("textbox"), "take a look");
    await userEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(onSend).toHaveBeenCalledWith("take a look", { kind: "agent", id: "osvaldo" });
  });

  it("names a group's elected leader so you know who actually receives it", async () => {
    render(<Composer onSend={vi.fn()} targets={TARGETS} />);
    await userEvent.click(screen.getByRole("button", { name: /send to/i }));
    expect(await screen.findByRole("option", { name: /Delta/ })).toHaveTextContent(/Josefina/);
  });

  it("shows the aimed-section chip and clears it on click; absent when unset", async () => {
    const onClearDocTarget = vi.fn();
    render(<Composer onSend={vi.fn()} docTarget={{ heading: "Approach" }} onClearDocTarget={onClearDocTarget} />);
    await userEvent.click(screen.getByRole("button", { name: /Targeting Approach/ }));
    expect(onClearDocTarget).toHaveBeenCalledTimes(1);
    cleanup();
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Targeting/ })).toBeNull();
  });
});
