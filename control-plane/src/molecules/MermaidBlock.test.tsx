import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.fn();
vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render: (...a: unknown[]) => renderMock(...a) },
}));

import { MermaidBlock, stripMermaidFence } from "./MermaidBlock";

afterEach(() => vi.clearAllMocks());

describe("MermaidBlock", () => {
  it("strips a ```mermaid fence", () => {
    expect(stripMermaidFence("```mermaid\nerDiagram\n```")).toBe("erDiagram");
    expect(stripMermaidFence("sequenceDiagram\n A->>B: x")).toBe("sequenceDiagram\n A->>B: x");
  });
  it("renders the compiled SVG", async () => {
    renderMock.mockResolvedValue({ svg: "<svg data-testid='diagram'></svg>" });
    render(<MermaidBlock code={"```mermaid\nerDiagram\n```"} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(renderMock).toHaveBeenCalledWith(expect.any(String), "erDiagram");
  });
  it("shows the source + error when Mermaid throws (never blank)", async () => {
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    render(<MermaidBlock code="not a diagram" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Parse error/));
    expect(screen.getByText(/not a diagram/)).toBeInTheDocument();
  });
  it("tells Mermaid not to drop its own 'Syntax error' graphic into the page", async () => {
    // MermaidBlock initializes Mermaid once per module, so load a fresh copy to
    // observe that one call. Without the flag, a failed render appends Mermaid's
    // own error SVG to <body> on top of the alert above (seen in a real browser).
    vi.resetModules();
    const mermaid = (await import("mermaid")).default;
    const { MermaidBlock: FreshBlock } = await import("./MermaidBlock");
    renderMock.mockRejectedValue(new Error("Parse error on line 2"));
    render(<FreshBlock code="not a diagram" />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ suppressErrorRendering: true }));
  });
});
