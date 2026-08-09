import { Sidebar } from "@heroui-pro/react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRail } from "./ToolRail";

// `Sidebar.MenuItem` reads sidebar context (open state, the Provider's `navigate`)
// via `useSidebar()` — it throws without an ancestor `Sidebar.Provider`, the same
// context ControlPlaneLayout supplies in the real app.
function renderRail(props: ComponentProps<typeof ToolRail> = {}, navigate = vi.fn()) {
  render(
    <Sidebar.Provider defaultOpen={false} collapsible="icon" navigate={navigate}>
      <ToolRail {...props} />
      <Sidebar.Main>stage</Sidebar.Main>
    </Sidebar.Provider>,
  );
  return { navigate };
}

describe("ToolRail", () => {
  afterEach(() => {
    cleanup();
  });

  it("New session tool fires onNewSession", async () => {
    const onNewSession = vi.fn();
    renderRail({ onNewSession });
    await userEvent.click(screen.getByRole("row", { name: "New session" }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
  });

  it("sessions tool fires onSessions", async () => {
    const onSessions = vi.fn();
    renderRail({ onSessions });
    await userEvent.click(screen.getByRole("row", { name: "Sessions" }));
    expect(onSessions).toHaveBeenCalledTimes(1);
  });

  // Board and Map are `Sidebar.MenuItem href`s, not onClick props — navigation runs
  // through the ancestor Provider's `navigate`, same as clicking any other href item.
  it("board tool navigates via the Provider", async () => {
    const { navigate } = renderRail();
    await userEvent.click(screen.getByRole("row", { name: "Board" }));
    expect(navigate).toHaveBeenCalledWith("/board");
  });

  it("map tool navigates via the Provider", async () => {
    const { navigate } = renderRail();
    await userEvent.click(screen.getByRole("row", { name: "Map" }));
    expect(navigate).toHaveBeenCalledWith("/map");
  });

  it("settings button still fires onSettings", async () => {
    const onSettings = vi.fn();
    renderRail({ onSettings });
    await userEvent.click(screen.getByRole("row", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  // `Sidebar.MenuItem` is RAC `TreeItem` — it renders `role="row"` (a treegrid row),
  // never `role="button"` or `<a>`, and marks the current item via `data-current`
  // rather than `aria-current` (confirmed against the rendered DOM, not the docs'
  // prose, which claims `aria-current="page"`).
  it("board tool is highlighted only when activeRoute is /board", () => {
    renderRail({ activeRoute: "/board" });
    expect(screen.getByRole("row", { name: "Board" }).getAttribute("data-current")).toBe("true");
    expect(screen.getByRole("row", { name: "Map" }).getAttribute("data-current")).toBeNull();
  });

  it("nothing is highlighted at the home route", () => {
    renderRail({ activeRoute: "/" });
    expect(screen.getByRole("row", { name: "Board" }).getAttribute("data-current")).toBeNull();
    expect(screen.getByRole("row", { name: "Map" }).getAttribute("data-current")).toBeNull();
  });

  // The logo (and its Home behaviour) moved to Navbar — see Navbar.test.tsx.
  it("renders no logo", () => {
    renderRail();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
  });
});
