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
});
