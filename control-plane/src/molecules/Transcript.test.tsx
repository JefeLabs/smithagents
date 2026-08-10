import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Transcript } from "./Transcript";

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
});

describe("Transcript", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing while empty", () => {
    render(<Transcript messages={[]} />);
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("renders bubbles with speaker parsing intact", () => {
    render(
      <Transcript
        messages={[
          { id: 1, role: "user", text: "ship it" },
          { id: 2, role: "broker", text: "Manuel: On it." },
        ]}
      />,
    );
    expect(screen.getByRole("log")).toBeTruthy();
    expect(screen.getByText("ship it")).toBeTruthy();
    expect(screen.getByText("Manuel")).toBeTruthy();
    expect(screen.getByText("On it.")).toBeTruthy();
  });

  it("renders markdown in broker speech", () => {
    render(<Transcript messages={[{ id: 1, role: "broker", text: "Manuel: shipped **v2** today" }]} />);
    expect(screen.getByText("Manuel")).toBeTruthy();
    expect(screen.getByText("v2").tagName).toBe("STRONG");
  });

  // The no-redesign rule: a message with no markdown syntax must render as it
  // always did. This is the test that catches markdown "helpfully" reflowing
  // ordinary speech.
  it("leaves plain text exactly as plain text", () => {
    render(<Transcript messages={[{ id: 1, role: "broker", text: "Manuel: On it." }]} />);
    expect(screen.getByText("On it.")).toBeTruthy();
  });

  // Speaker extraction must run BEFORE markdown, or the "Manuel:" prefix becomes
  // part of the rendered body and the speaker label disappears.
  it("extracts the speaker before rendering the body as markdown", () => {
    render(<Transcript messages={[{ id: 1, role: "broker", text: "Ana: `deploy` is green" }]} />);
    expect(screen.getByText("Ana").tagName).toBe("B");
    expect(screen.getByText("deploy").tagName).toBe("CODE");
  });
});
