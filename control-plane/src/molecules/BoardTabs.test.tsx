import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardTabs } from "./BoardTabs";

const TABS = [
  { key: "ideation", label: "Ideation", type: "ideation" as const, boardIds: ["a-ideation"], clustered: false },
  { key: "personal", label: "Active To-dos", type: "personal" as const, boardIds: ["personal"], clustered: false },
];

const base = {
  tabs: TABS,
  activeKey: "ideation",
  addable: ["deliver" as const],
  adding: false,
  onAddingChange: () => {},
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

  it("marks the active tab and reports selection", async () => {
    const onSelect = vi.fn();
    render(<BoardTabs {...base} onSelect={onSelect} />);
    expect(screen.getByRole("tab", { name: "Ideation" }).getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "Active To-dos" }));
    expect(onSelect).toHaveBeenCalledWith("personal");
  });

  it("offers add for the missing types", async () => {
    const onAdd = vi.fn();
    const onAddingChange = vi.fn();
    render(<BoardTabs {...base} onAdd={onAdd} onAddingChange={onAddingChange} />);
    await userEvent.click(screen.getByRole("button", { name: /add board/i }));
    // Opening is reported to the parent rather than shown directly — `adding`
    // is controlled, so re-render with it true to see the menu.
    expect(onAddingChange).toHaveBeenCalledWith(true);
  });

  it("shows the add menu when controlled open, and reports the picked type", async () => {
    const onAdd = vi.fn();
    render(<BoardTabs {...base} adding={true} onAdd={onAdd} />);
    expect(screen.getByRole("menu")).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: "Deliver" }));
    expect(onAdd).toHaveBeenCalledWith("deliver");
  });

  it("hides the add control entirely when nothing is addable — no workspace, or several in view", () => {
    render(<BoardTabs {...base} addable={[]} />);
    expect(screen.queryByRole("button", { name: /add board/i })).toBeNull();
  });

  it("reports Escape as a close request while the menu is open", async () => {
    const onAddingChange = vi.fn();
    render(<BoardTabs {...base} adding={true} onAddingChange={onAddingChange} />);
    expect(screen.getByRole("menu")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(onAddingChange).toHaveBeenCalledWith(false);
  });

  it("reports a pointerdown outside the menu as a close request", async () => {
    const onAddingChange = vi.fn();
    render(
      <div>
        <BoardTabs {...base} adding={true} onAddingChange={onAddingChange} />
        <div data-testid="outside">elsewhere on the page</div>
      </div>,
    );
    expect(screen.getByRole("menu")).toBeTruthy();
    await userEvent.click(screen.getByTestId("outside"));
    expect(onAddingChange).toHaveBeenCalledWith(false);
  });

  it("does not report a pointerdown inside the menu as a close request", async () => {
    const onAddingChange = vi.fn();
    render(<BoardTabs {...base} adding={true} onAddingChange={onAddingChange} />);
    await userEvent.click(screen.getByRole("menu"));
    expect(onAddingChange).not.toHaveBeenCalled();
  });
});
