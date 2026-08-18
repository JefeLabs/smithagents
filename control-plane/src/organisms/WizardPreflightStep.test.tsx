import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WizardPreflightStep } from "./WizardPreflightStep";

const setup = (over = {}) => {
  const onDone = vi.fn();
  render(<WizardPreflightStep initialName="" onDone={onDone} {...over} />);
  return { onDone, user: userEvent.setup() };
};

describe("WizardPreflightStep", () => {
  it("asks both questions on one screen", () => {
    setup();
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /local/i })).toBeInTheDocument();
  });

  it("requires a name — the record cannot be created without one", async () => {
    const { user } = setup();
    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    await user.type(screen.getByLabelText(/your name/i), "Edwin");
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });

  // These two tests came across from the deleted WizardForkStep.test.tsx.
  // Without them, `toBeDisabled()` below does NOT discriminate: react-aria
  // forces `disabled: isDisabled` onto the input OUTSIDE the filterDOMProps
  // allowlist, so a plausible-but-wrong `RadioButtonGroup.Item isDisabled`
  // sets native `disabled` too and passes identically. Only `aria-disabled`
  // — which filterDOMProps DROPS, and which this stylesheet's dimming and
  // pointer-events:none key off — tells the two apart. Verified against the
  // installed react-aria source, not assumed.
  it("the disabled Cloud option carries aria-disabled, not just native disabled", () => {
    setup();
    const cloud = screen.getByRole("radio", { name: /cloud/i });
    expect(cloud).toHaveAttribute("aria-disabled", "true");
  });

  it("Cloud cannot be reached or selected with arrow-key navigation", async () => {
    // react-aria's roving-focus walker (useRadioGroup's getNextElement) accepts
    // ANY `<input type="radio">` in the group and filters on its `isFocusable`
    // check, whose selector is literally `input:not([disabled])` — aria-disabled
    // never enters it. Without native `disabled`, ArrowDown from Local lands
    // here and react-aria reads the focused input's `.value` off the DOM; an
    // input with no `value` attribute defaults to "on", which is exactly the
    // off-type corruption of `mode` this guards against.
    const { onDone, user } = setup({ initialName: "Edwin" });
    const local = screen.getByRole("radio", { name: /local/i });
    const cloud = screen.getByRole("radio", { name: /cloud/i });

    local.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).not.toBe(cloud);

    await user.click(screen.getByRole("button", { name: /continue/i }));
    // Read the call directly rather than through a matcher: the point is to
    // rule out ANY off-type value (like the DOM-default "on"), not just the
    // literal "hosted".
    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0][0].setup.mode).toBe("local");
  });

  it("offers Cloud but cannot let it be chosen", () => {
    setup();
    const cloud = screen.getByRole("radio", { name: /cloud/i });
    // Native `disabled`, not aria-disabled alone: react-aria's roving-focus
    // walker filters on input:not([disabled]), so aria-disabled alone would
    // leave this arrow-key reachable and selectable.
    expect(cloud).toBeDisabled();
  });

  it("emits the name and the mode together", async () => {
    const { onDone, user } = setup();
    await user.type(screen.getByLabelText(/your name/i), "Edwin");
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onDone).toHaveBeenCalledWith({ name: "Edwin", setup: { mode: "local" } });
  });

  // Both seeding tests below pass a mode the DEFAULT IS NOT. Seeded with
  // "local" — which is `initialMode`'s own default — neither assertion could
  // fail: replacing `useState(initialMode)` with `useState("local")` left the
  // whole suite green, so nothing here was guarding the prop at all. "hosted"
  // is genuinely reachable on this screen (`resumeStep` sends a record whose
  // mode is hosted back to preflight, since its sequence is empty), and it is
  // the only value that can tell a seeded state apart from the default one.
  it("seeds from prior answers so going back shows what was chosen", () => {
    setup({ initialName: "Edwin", initialMode: "hosted" });
    expect(screen.getByLabelText(/your name/i)).toHaveValue("Edwin");
    expect(screen.getByRole("radio", { name: /local/i })).not.toBeChecked();
  });

  it("re-submits the mode it was seeded with, rather than overwriting it with the default", async () => {
    // The consequence of dropping the seed, asserted where it does damage:
    // `onDone` always sends `mode` EXPLICITLY (the server merges setup, so an
    // omitted field would keep the old value), which means an unseeded screen
    // does not leave a recorded answer alone — it overwrites it with "local"
    // the moment the user presses Continue on a form they only backed into.
    const { onDone, user } = setup({ initialName: "Edwin", initialMode: "hosted" });
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(onDone).toHaveBeenCalledWith({ name: "Edwin", setup: { mode: "hosted" } });
  });
});
