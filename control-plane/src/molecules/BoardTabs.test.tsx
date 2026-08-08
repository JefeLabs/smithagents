import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_WORKSPACES } from "../lib/board-aggregate";
import { BoardTabs } from "./BoardTabs";

const TABS = [
  { key: "ideation", label: "Ideation", type: "ideation" as const, boardIds: ["a-ideation"], clustered: false },
  { key: "personal", label: "Personal", type: "personal" as const, boardIds: ["personal"], clustered: false },
];

const base = {
  scope: "acme",
  workspaces: ["acme", "globex"],
  tabs: TABS,
  activeKey: "ideation",
  addable: ["deliver" as const],
  onScope: () => {},
  onSelect: () => {},
  onAdd: () => {},
};

describe("BoardTabs", () => {
  // vitest.config.ts doesn't set test.globals, so RTL's auto-cleanup (which
  // feature-detects a *global* afterEach) never registers — without this,
  // each render() in this file leaks into the next test's queries.
  afterEach(() => {
    cleanup();
  });

  it("lists All workspaces plus each workspace, and never Personal, in the dropdown", () => {
    render(<BoardTabs {...base} />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["All workspaces", "acme", "globex"]);
  });

  it("marks the active tab and reports selection", async () => {
    const onSelect = vi.fn();
    render(<BoardTabs {...base} onSelect={onSelect} />);
    expect(screen.getByRole("tab", { name: "Ideation" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "Personal" }));
    expect(onSelect).toHaveBeenCalledWith("personal");
  });

  it("offers add for the missing types in workspace scope", async () => {
    const onAdd = vi.fn();
    render(<BoardTabs {...base} onAdd={onAdd} />);
    await userEvent.click(screen.getByRole("button", { name: /add board/i }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Deliver" }));
    expect(onAdd).toHaveBeenCalledWith("deliver");
  });

  it("hides add entirely in the aggregate scope, since there is no workspace to create into", () => {
    render(<BoardTabs {...base} scope={ALL_WORKSPACES} />);
    expect(screen.queryByRole("button", { name: /add board/i })).toBeNull();
  });

  it("closes the add menu on Escape", async () => {
    render(<BoardTabs {...base} />);
    await userEvent.click(screen.getByRole("button", { name: /add board/i }));
    expect(screen.getByRole("menu")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the add menu on a pointerdown outside it", async () => {
    render(
      <div>
        <BoardTabs {...base} />
        <div data-testid="outside">elsewhere on the page</div>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: /add board/i }));
    expect(screen.getByRole("menu")).toBeTruthy();
    await userEvent.click(screen.getByTestId("outside"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not close the add menu on a pointerdown inside it", async () => {
    render(<BoardTabs {...base} />);
    await userEvent.click(screen.getByRole("button", { name: /add board/i }));
    await userEvent.click(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("resets to closed when the scope changes away and back", async () => {
    const { rerender } = render(<BoardTabs {...base} />);
    await userEvent.click(screen.getByRole("button", { name: /add board/i }));
    expect(screen.getByRole("menu")).toBeTruthy();
    rerender(<BoardTabs {...base} scope={ALL_WORKSPACES} />);
    expect(screen.queryByRole("button", { name: /add board/i })).toBeNull();
    rerender(<BoardTabs {...base} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
