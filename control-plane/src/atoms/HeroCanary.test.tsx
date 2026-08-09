import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HeroCanary } from "./HeroCanary";

describe("HeroCanary", () => {
  it("renders an OSS HeroUI Button as an accessible button", () => {
    render(<HeroCanary />);
    expect(screen.getByRole("button", { name: "Canary" })).toBeDefined();
  });

  it("carries HeroUI's BEM class, proving the package resolved", () => {
    const { container } = render(<HeroCanary />);
    expect(container.querySelector(".button")).not.toBeNull();
  });

  it("renders a Pro component, proving the licensed payload downloaded", () => {
    // @heroui-pro/react ships as a 20KB stub until its postinstall authenticates
    // and pulls the real package. If allowBuilds is missing, this import resolves
    // to nothing and the render throws — which is the whole point of the canary.
    render(<HeroCanary />);
    expect(screen.getByText("42")).toBeDefined();
  });
});
