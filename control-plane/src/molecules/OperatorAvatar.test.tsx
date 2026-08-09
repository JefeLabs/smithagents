import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OperatorAvatar } from "./OperatorAvatar";

describe("OperatorAvatar", () => {
  /**
   * CLOUD_MODE is deliberately not mocked to true: there is no login to exercise, so
   * asserting the signed-in rendering would encode a guess rather than the shipped
   * behaviour.
   *
   * The absence assertion is thin on its own — a component that always returns null
   * trivially renders no button. What carries weight is the missing
   * QueryClientProvider: `useMe()` throws without one, so this render only survives
   * while no query hook runs. Hoisting the hook above the flag guard (the shape that
   * would fire GET /me on every app load) fails this test.
   */
  it("renders nothing while cloud mode is off", () => {
    render(<OperatorAvatar />);
    expect(screen.queryByRole("button", { name: /account/i })).toBeNull();
  });
});
