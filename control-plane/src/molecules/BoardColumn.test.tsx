import { DndContext } from "@dnd-kit/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardColumn } from "./BoardColumn";

afterEach(cleanup);

const COL = { id: "queue", name: "Queue" };
const PROPS = {
  col: COL,
  clusters: [{ label: null, cards: [] }],
  colorFor: () => undefined,
  agentFor: () => undefined,
  onOpenCard: () => {},
};

describe("BoardColumn config gear", () => {
  it("renders the gear only when onConfigure is provided, labeled for the column", async () => {
    const { rerender } = render(
      <DndContext>
        <BoardColumn {...PROPS} />
      </DndContext>,
    );
    expect(screen.queryByRole("button", { name: "Configure Queue column" })).toBeNull();
    const onConfigure = vi.fn();
    rerender(
      <DndContext>
        <BoardColumn {...PROPS} onConfigure={onConfigure} />
      </DndContext>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Configure Queue column" }));
    expect(onConfigure).toHaveBeenCalledTimes(1);
  });
});
