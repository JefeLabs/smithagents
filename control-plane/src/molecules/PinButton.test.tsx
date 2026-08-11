import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinButton } from "./PinButton";

describe("PinButton", () => {
  afterEach(() => cleanup());

  it("renders nothing without a workspace to pin to", () => {
    const { container } = render(<PinButton pins={[]} onPin={vi.fn()} onUnpin={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("pins when unpinned, unpins when pinned, and reflects the state", async () => {
    const onPin = vi.fn().mockResolvedValue(null);
    const onUnpin = vi.fn().mockResolvedValue(null);
    render(<PinButton pins={[]} workspace="acme" onPin={onPin} onUnpin={onUnpin} />);
    const btn = screen.getByRole("button", { name: "Pin to acme" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(onPin).toHaveBeenCalledWith("acme");
    cleanup();
    render(<PinButton pins={["acme", "globex"]} workspace="acme" onPin={onPin} onUnpin={onUnpin} />);
    const pinned = screen.getByRole("button", { name: "Pinned to acme" });
    expect(pinned.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pinned);
    expect(onUnpin).toHaveBeenCalledWith("acme");
  });

  it("surfaces the broker's refusal", async () => {
    const onPin = vi.fn().mockResolvedValue("unknown document: d9");
    render(<PinButton pins={[]} workspace="acme" onPin={onPin} onUnpin={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Pin to acme" }));
    expect(await screen.findByText(/unknown document/)).toBeInTheDocument();
  });
});
