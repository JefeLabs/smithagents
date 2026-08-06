import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityTile } from "./IdentityTile";

describe("IdentityTile", () => {
  // vitest.config.ts doesn't set test.globals, so RTL's auto-cleanup never
  // registers — without this, each render() leaks into the next test.
  afterEach(() => {
    cleanup();
  });

  it("renders the host name and role", () => {
    // biome-ignore lint/a11y/useValidAriaRole: `role` is the host's job title (a domain prop), not an ARIA role.
    render(<IdentityTile name="Anderson" role="Chief of Staff" ring="#8a93a6" />);
    expect(screen.getByText("Anderson")).toBeDefined();
    expect(screen.getByText("Chief of Staff")).toBeDefined();
  });
});
