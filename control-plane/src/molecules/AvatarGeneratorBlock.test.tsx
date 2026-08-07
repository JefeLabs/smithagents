import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AvatarGeneratorBlock } from "./AvatarGeneratorBlock";

const base = {
  base: "127.0.0.1:7790",
  name: "Test",
  gender: undefined as unknown as string,
  role: undefined as unknown as string,
  backstory: undefined as unknown as string,
  onGenerated: () => {},
};

describe("AvatarGeneratorBlock engines", () => {
  afterEach(() => cleanup());

  it("hidden when no engine", () => {
    render(<AvatarGeneratorBlock {...base} engine={null} />);
    expect(screen.queryByRole("button", { name: /portrait/i })).toBeNull();
  });

  it("api engine: plain generate copy", () => {
    render(<AvatarGeneratorBlock {...base} engine="api" />);
    expect(screen.getByRole("button", { name: /generate portrait/i })).toBeDefined();
  });

  it("agy engine: slow-path copy warns about brewing time", () => {
    render(<AvatarGeneratorBlock {...base} engine="agy" />);
    expect(screen.getByRole("button", { name: /generate portrait/i })).toBeDefined();
    expect(screen.getByText(/1–2 min/i)).toBeDefined();
  });
});
