import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Navbar } from "./Navbar";

describe("Navbar", () => {
  it("is a landmark distinct from the tool rail", () => {
    render(<Navbar />);
    // The rail is aria-label="Tools and activity"; two <nav>s with the same name
    // would be indistinguishable to a screen reader.
    expect(screen.getByRole("navigation", { name: /workspace and account/i })).toBeDefined();
  });

  it("the logo goes home", async () => {
    const onHome = vi.fn();
    render(<Navbar onHome={onHome} />);
    await userEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(onHome).toHaveBeenCalled();
  });

  it("renders the slots it is given and nothing when they are absent", () => {
    const { rerender } = render(<Navbar alertSlot={<span>alerts-here</span>} />);
    expect(screen.getByText("alerts-here")).toBeDefined();
    rerender(<Navbar />);
    expect(screen.queryByText("alerts-here")).toBeNull();
  });
});
