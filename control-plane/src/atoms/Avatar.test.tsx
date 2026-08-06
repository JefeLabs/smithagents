import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  afterEach(cleanup);

  it("renders the initial when no image is given", () => {
    render(<Avatar initial="M" label="Minerva" />);
    expect(screen.getByRole("button", { name: "Minerva" }).textContent).toBe("M");
  });

  it("renders the portrait image when given", () => {
    render(<Avatar initial="M" label="Minerva" image="http://127.0.0.1:7790/avatars/minerva.png" />);
    const img = screen.getByRole("button", { name: "Minerva" }).querySelector("img");
    expect(img?.getAttribute("src")).toContain("minerva.png");
  });

  it("falls back to the initial when the image fails to load", () => {
    render(<Avatar initial="M" label="Minerva" image="http://127.0.0.1:7790/avatars/minerva.png" />);
    const img = screen.getByRole("button", { name: "Minerva" }).querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);
    expect(screen.getByRole("button", { name: "Minerva" }).querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Minerva" }).textContent).toBe("M");
  });
});
