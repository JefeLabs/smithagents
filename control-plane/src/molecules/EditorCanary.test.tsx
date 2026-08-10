import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorCanary } from "./EditorCanary";

describe("EditorCanary", () => {
  // Proves three things before anything depends on them: the subpath import
  // resolves, the optional @tiptap/* peers are installed, and a custom
  // extension reaches the editor through Pro's `extensions` prop — which is
  // how the markdown serializer gets registered in the next task.
  it("mounts the Pro editor and registers a custom extension", async () => {
    render(<EditorCanary />);
    expect(await screen.findByTestId("canary-extension-present")).toHaveTextContent("yes");
  });
});
