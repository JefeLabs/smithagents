import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownCanary } from "./MarkdownCanary";

describe("MarkdownCanary", () => {
  // Proves the subpath import and its four optional peers resolve at build time.
  // Without this, a broken install surfaces halfway through Task 4, where a
  // pipeline failure and a migration bug look identical.
  it("renders markdown as real elements, not literal text", () => {
    render(<MarkdownCanary source={"**bold** and `code`"} />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
  });
});
