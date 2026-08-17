import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WizardForkStep } from "./WizardForkStep";

describe("WizardForkStep", () => {
  it("offers local, and shows hosted as coming soon", async () => {
    render(<WizardForkStep onDone={vi.fn()} />);

    expect(screen.getByRole("radio", { name: /local/i })).toBeEnabled();
    const hosted = screen.getByRole("radio", { name: /hosted/i });
    expect(hosted).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it("the disabled hosted option still names the way forward", async () => {
    // aria-disabled implies pointer-events:none in this stylesheet, so a naive
    // implementation that disables the whole block would also kill this link —
    // and a disabled control that someone wants, with no way forward, is the
    // frustration the spec calls out.
    render(<WizardForkStep onDone={vi.fn()} />);

    const notify = screen.getByRole("link", { name: /notify me/i });
    expect(notify).toHaveAttribute("href", expect.stringContaining("smithagents.com"));
    expect(notify).not.toHaveAttribute("aria-disabled");
    // The two assertions above pass even if the link is NESTED inside the
    // aria-disabled node — checked directly: `not.toHaveAttribute` reads the
    // link's own attributes, not its ancestors', so it can't catch that on
    // its own. `closest` is what actually proves the link sits outside
    // whatever carries the attribute that makes this stylesheet cut off
    // pointer events.
    expect(notify.closest('[aria-disabled="true"]')).toBeNull();
  });

  it("choosing local advances with the mode recorded", async () => {
    const onDone = vi.fn();
    render(<WizardForkStep onDone={onDone} />);

    await userEvent.click(screen.getByRole("radio", { name: /local/i }));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ setup: expect.objectContaining({ mode: "local" }) }));
  });

  it("hosted cannot be chosen", async () => {
    const onDone = vi.fn();
    render(<WizardForkStep onDone={onDone} />);

    await userEvent.click(screen.getByRole("radio", { name: /hosted/i }));

    expect(onDone).not.toHaveBeenCalled();
  });

  it("hosted cannot be reached or selected with arrow-key navigation", async () => {
    // react-aria's own roving-focus walker (useRadioGroup's getNextElement)
    // accepts ANY `<input type="radio">` descendant of the group, keyed off
    // react-aria's `isFocusable` check — which excludes native `[disabled]`,
    // never `aria-disabled` (verified against the installed source, not
    // guessed). aria-disabled alone is advisory to that walker: pressing
    // ArrowDown from "local" would land it on "hosted" and read its `.value`
    // straight off the DOM — and an input with no `value` attribute defaults
    // to "on", which is exactly the off-type corruption this guards against.
    const onDone = vi.fn();
    render(<WizardForkStep onDone={onDone} />);

    const local = screen.getByRole("radio", { name: /local/i });
    const hosted = screen.getByRole("radio", { name: /hosted/i });

    local.focus();
    await userEvent.keyboard("{ArrowDown}");

    expect(document.activeElement).not.toBe(hosted);

    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    // Read the actual call directly rather than another matcher — the point
    // is to rule out ANY off-type value (like the DOM-default "on" the walker
    // would have read off a value-less radio), not just the literal "hosted".
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0][0].setup.mode).toBe("local");
  });
});
