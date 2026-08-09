// Bare `render` is DELIBERATE and load-bearing — do NOT swap it for
// `renderWithProviders` (src/test/renderWithProviders.tsx). The absence of a
// QueryClientProvider is the whole guard: it is what makes this file fail if anyone
// moves `useMe()` out of `SignedInAvatar` and up into `OperatorAvatar`. Wrap these
// renders in a provider and the hoisted shape renders `null` happily, the assertions
// pass, and the guard is silently gone. If this file ever fails with "No QueryClient
// set", the fix is in OperatorAvatar.tsx, not on this line.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMe } from "../queries/http";
import { OperatorAvatar } from "./OperatorAvatar";

describe("OperatorAvatar", () => {
  /**
   * CLOUD_MODE is deliberately not mocked to true: there is no login to exercise, so
   * asserting the signed-in rendering would encode a guess rather than the shipped
   * behaviour.
   *
   * On its own the absence assertion is thin — a component that always returns null
   * trivially renders no button. Two things give it teeth: the empty-container check
   * below, which catches ANY rendering rather than only a button; and the missing
   * provider (see the import note), which fails this test if a query hook ever runs
   * on the path the flag takes.
   */
  it("renders nothing while cloud mode is off", () => {
    const { container } = render(<OperatorAvatar />);
    expect(screen.queryByRole("button", { name: /account/i })).toBeNull();
    // The role query alone would also pass for a non-button avatar — `Avatar` with
    // `interactive={false}` renders `<span role="img">`, which it never sees.
    expect(container).toBeEmptyDOMElement();
  });

  /**
   * Pins the mechanism the guard above borrows. The guard only works because
   * `useMe()` THROWS without a provider rather than quietly returning an idle
   * result — if a future react-query stopped throwing, the guard would keep passing
   * while protecting nothing, and this is the test that would notice.
   */
  it("useMe throws without a QueryClientProvider — the guard's mechanism", () => {
    function Probe() {
      useMe();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/No QueryClient set/);
  });
});
