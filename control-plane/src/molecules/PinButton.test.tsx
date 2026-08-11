import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinButton } from "./PinButton";

describe("PinButton", () => {
  afterEach(() => cleanup());

  const open = () => fireEvent.click(screen.getByRole("button", { name: "Pin to…" }));

  it("renders nothing without a workspace to pin to", () => {
    const { container } = render(<PinButton pins={[]} onPin={vi.fn()} onUnpin={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("the workspace row pins when off, unpins when on", () => {
    const onPin = vi.fn().mockResolvedValue(null);
    const onUnpin = vi.fn().mockResolvedValue(null);
    render(<PinButton pins={[]} workspace="acme" onPin={onPin} onUnpin={onUnpin} />);
    open();
    const row = screen.getByRole("menuitemcheckbox", { name: "acme" });
    expect(row.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(row);
    expect(onPin).toHaveBeenCalledExactlyOnceWith("acme");
    cleanup();
    render(<PinButton pins={["acme"]} workspace="acme" onPin={onPin} onUnpin={onUnpin} />);
    open();
    const pinned = screen.getByRole("menuitemcheckbox", { name: "acme" });
    expect(pinned.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(pinned);
    expect(onUnpin).toHaveBeenCalledExactlyOnceWith("acme");
  });

  it("a group row pins the group: namespaced target", () => {
    const onPin = vi.fn().mockResolvedValue(null);
    render(<PinButton pins={[]} workspace="acme" groups={["frontend", "core"]} onPin={onPin} onUnpin={vi.fn()} />);
    open();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "frontend" }));
    expect(onPin).toHaveBeenCalledExactlyOnceWith("group:frontend");
  });

  it("the trigger badge counts current pin targets", () => {
    render(
      <PinButton pins={["acme", "group:core"]} workspace="acme" groups={["core"]} onPin={vi.fn()} onUnpin={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Pin to…" }).textContent).toContain("2");
  });

  it("a pin naming a deleted group shows as stale and can only be unpinned", () => {
    const onUnpin = vi.fn().mockResolvedValue(null);
    render(<PinButton pins={["group:gone"]} workspace="acme" groups={["core"]} onPin={vi.fn()} onUnpin={onUnpin} />);
    open();
    const stale = screen.getByRole("menuitemcheckbox", { name: "gone (gone)" });
    fireEvent.click(stale);
    expect(onUnpin).toHaveBeenCalledExactlyOnceWith("group:gone");
  });

  it("another workspace's pin is NOT listed — you see those in that workspace (spec decision 5)", () => {
    render(<PinButton pins={["globex"]} workspace="acme" groups={[]} onPin={vi.fn()} onUnpin={vi.fn()} />);
    open();
    expect(screen.queryByRole("menuitemcheckbox", { name: /globex/ })).toBeNull();
  });

  it("surfaces the broker's refusal", async () => {
    const onPin = vi.fn().mockResolvedValue("unknown document: d9");
    render(<PinButton pins={[]} workspace="acme" onPin={onPin} onUnpin={vi.fn()} />);
    open();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "acme" }));
    expect(await screen.findByRole("status")).toHaveTextContent("unknown document: d9");
  });

  it("Escape closes the popover", () => {
    render(<PinButton pins={[]} workspace="acme" onPin={vi.fn()} onUnpin={vi.fn()} />);
    open();
    expect(screen.getByRole("menu", { name: "Pin targets" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu", { name: "Pin targets" }), { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Pin targets" })).toBeNull();
  });
});
